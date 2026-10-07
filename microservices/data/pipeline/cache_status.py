"""Detect whether a cached city directory matches the current pipeline schema."""

from __future__ import annotations

import json
from pathlib import Path

from pipeline import config, contract
from pipeline.generated import contract as generated

_REQUIRED_CACHE = set(generated.REQUIRED_CACHE_FILES)

_LEGACY_CACHE = {
    "factor_poi.parquet",
    "factor_transit.parquet",
}

# Meta keys a served city must carry regardless of pipeline version.
_REQUIRED_META = ("rent_source", "city_type")

# data_quality is written for every hex. Rent and VOI are omitted where no
# Kaltmiete was published, so they are not required on the first feature.
_SERVED_CITY_PROPERTIES = ("data_quality",)


def _parquet_nrows(path: Path) -> int | None:
    try:
        import pyarrow.parquet as pq

        return int(pq.ParquetFile(path).metadata.num_rows)
    except Exception:  # noqa: BLE001
        try:
            import pandas as pd

            return int(len(pd.read_parquet(path)))
        except Exception:  # noqa: BLE001
            return None


def _empty_roads_cache(cache: Path) -> str | None:
    """Empty road parquets freeze noise/safety at defaults — force a refetch."""
    for name in (config.OSM_ROADS_FILE, "osm_roads_safety.parquet"):
        path = cache / name
        if not path.exists():
            continue
        nrows = _parquet_nrows(path)
        if nrows == 0:
            return f"empty {name} cache"
    return None


def _empty_daily_needs_cache(cache: Path) -> str | None:
    """Empty daily-needs OSM freeze every hex at the 99-minute sentinel."""
    path = cache / config.OSM_DAILY_NEEDS_FILE
    if not path.exists():
        return None
    nrows = _parquet_nrows(path)
    if nrows == 0:
        return f"empty {config.OSM_DAILY_NEEDS_FILE} cache"
    return None


def _geojson_reason(data: dict) -> str | None:
    """Contract + freshness checks on an already parsed hexes.geojson."""
    meta = data.get("meta") or {}

    if "has_rent" not in meta:
        return "meta missing has_rent"
    for key in _REQUIRED_META:
        if not meta.get(key):
            return f"meta missing {key}"

    version = meta.get("pipeline_version")
    if version is not None and int(version) < contract.PIPELINE_VERSION:
        return f"stale pipeline_version ({version} < {contract.PIPELINE_VERSION})"

    method = meta.get("score_method_version")
    if method is not None and method != contract.SCORE_METHOD_VERSION:
        return f"stale score_method_version ({method} != {contract.SCORE_METHOD_VERSION})"

    product = meta.get("product")
    if product is not None and product != config.LIVING_SCORE_PRODUCT:
        return f"stale product ({product} != {config.LIVING_SCORE_PRODUCT})"

    features = data.get("features") or []
    if not features:
        return "empty feature collection"

    # One schema, one check: the contract owns which properties must exist.
    errors = contract.validate_features(features, sample=5)
    if errors:
        return f"geojson violates hex contract: {errors[0]}"

    props = features[0].get("properties") or {}
    for key in _SERVED_CITY_PROPERTIES:
        if key not in props:
            return f"geojson missing {key}"
    if meta.get("has_rent"):
        observed = any((feature.get("properties") or {}).get("rent_eur_m2") not in (None, "") for feature in features)
        if not observed:
            return "has_rent but no rent_eur_m2"

    # Flat noise across the whole city usually means roads never loaded.
    noise_spread = meta.get("noise_db_spread")
    if noise_spread is not None and float(noise_spread) < 0.5:
        return "noise proxy has no variation"

    # 99 minutes is the missing-POI sentinel. If a sample of hexes is stuck
    # there, daily-needs OSM was empty when the city was exported.
    sample = features[:24]
    supermarket_mins = [(f.get("properties") or {}).get("dn_supermarket_min") for f in sample]
    known = [m for m in supermarket_mins if m is not None]
    if known and all(float(m) >= 99 for m in known):
        return "daily-needs walk minutes are the 99 sentinel"

    return None


def is_cache_current(city_dir: Path) -> tuple[bool, str]:
    geojson = city_dir / "hexes.geojson"
    if not geojson.exists():
        return False, "missing hexes.geojson"

    cache = city_dir / "cache"
    if not cache.is_dir():
        return False, "missing cache/"

    for name in _LEGACY_CACHE:
        if (cache / name).exists():
            return False, f"legacy cache file {name}"

    for name in _REQUIRED_CACHE:
        if not (cache / name).exists():
            return False, f"missing {name}"

    empty_roads = _empty_roads_cache(cache)
    if empty_roads:
        return False, empty_roads

    empty_daily = _empty_daily_needs_cache(cache)
    if empty_daily:
        return False, empty_daily

    try:
        with open(geojson, encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, json.JSONDecodeError) as exc:
        return False, f"unreadable geojson: {exc}"

    reason = _geojson_reason(data)
    if reason:
        return False, reason
    return True, "ok"


def has_factor_cache(city_dir: Path) -> bool:
    """True when all factor parquet inputs exist (geojson may still be stale)."""
    cache = city_dir / "cache"
    if not cache.is_dir():
        return False
    for name in _LEGACY_CACHE:
        if (cache / name).exists():
            return False
    for name in _REQUIRED_CACHE:
        if not (cache / name).exists():
            return False
    if _empty_roads_cache(cache):
        return False
    if _empty_daily_needs_cache(cache):
        return False
    return True
