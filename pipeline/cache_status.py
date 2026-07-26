"""Detect whether a cached city directory matches the current pipeline schema."""
from __future__ import annotations

import json
from pathlib import Path

from . import config

_REQUIRED_CACHE = {
    config.GRID_FILE,
    config.BUSINESS_FILE,
    config.TRANSPORT_FILE,
    config.CENTER_FILE,
    config.GREEN_FILE,
    config.NOISE_FILE,
    config.CENTERS_FILE,
    config.RENTS_FILE,
    config.DAILY_NEEDS_FILE,
    config.TRANSIT_SERVICE_FILE,
    config.HEAT_FILE,
    config.TRAFFIC_SAFETY_FILE,
    config.HOUSING_FILE,
}

_LEGACY_CACHE = {
    "factor_poi.parquet",
    "factor_transit.parquet",
}


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

    try:
        with open(geojson, encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, json.JSONDecodeError) as exc:
        return False, f"unreadable geojson: {exc}"

    meta = data.get("meta") or {}

    if not meta.get("has_rent"):
        return False, "has_rent is false"

    if not meta.get("rent_source"):
        return False, "missing rent_source"

    version = meta.get("pipeline_version")
    if version is not None and version < config.PIPELINE_SCHEMA_VERSION:
        return False, f"stale pipeline_version ({version})"

    features = data.get("features") or []
    if not features:
        return False, "empty feature collection"

    props = features[0].get("properties") or {}
    if "rent_eur_m2" not in props:
        return False, "geojson missing rent_eur_m2"

    if "s_urban_activity" not in props and "s_business" not in props:
        return False, "geojson missing urban_activity scores"

    if "green_access" not in props:
        return False, "geojson missing green_access"

    if "s_daily_needs" not in props and "s_daily_life" not in props:
        return False, "geojson missing s_daily_needs/s_daily_life"

    if "s_transit_service" not in props and "s_transit" not in props:
        return False, "geojson missing s_transit_service/s_transit"

    if version is not None and int(version) >= 11:
        if "s_living" not in props:
            return False, "geojson missing s_living"
        if "s_walking_quality" not in props:
            return False, "geojson missing s_walking_quality"
        if "s_urban_form" not in props:
            return False, "geojson missing s_urban_form"

    if version is not None and int(version) >= 13:
        for key in (
            "s_living",
            "s_daily_life",
            "s_walk",
            "s_green",
            "s_transit",
            "s_center",
            "s_quiet",
            "s_housing_value",
        ):
            if key not in props:
                return False, f"geojson missing {key}"
        if not meta.get("city_type"):
            return False, "meta missing city_type"

    if version is not None and int(version) >= 14:
        if "s_value_opportunity" not in props:
            return False, "geojson missing s_value_opportunity"
        if "voi_class" not in props:
            return False, "geojson missing voi_class"
        if "voi_confidence" not in props:
            return False, "geojson missing voi_confidence"

    if "s_rent_relative_city" not in props:
        return False, "geojson missing s_rent_relative_city"

    if "s_rent_absolute" not in props:
        return False, "geojson missing s_rent_absolute"

    if "data_quality" not in props:
        return False, "geojson missing data_quality"

    # Flat noise across the whole city usually means roads never loaded.
    noise_spread = meta.get("noise_db_spread")
    if noise_spread is not None and float(noise_spread) < 0.5:
        return False, "noise proxy has no variation"

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
    return True
