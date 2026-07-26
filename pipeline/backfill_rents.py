"""Backfill the rent layer for already-generated cities - offline.

Existing cities under ``data/cities/<slug>/`` were exported before rent became a
universal comfort factor, so their ``hexes.geojson`` has no ``rent_eur_m2``.
This script recomputes ONLY the ``rents`` and ``normalize + export`` steps from
the cached parquet files (grid + factors + centers), so it needs no Overpass /
Nominatim network access.

Usage:
    python -m pipeline.backfill_rents            # all cached cities
    python -m pipeline.backfill_rents rosenheim  # one slug
"""
from __future__ import annotations

import shutil
import sys

from . import config, normalize_export, rents
from .city import CityContext, _RENT_SLUGS, load_meta
from .common import log

STEP = "backfill"


def _ctx_from_cache(slug: str) -> CityContext | None:
    from .city_context import attach_city_context

    base = config.CITIES_DIR / slug
    meta = load_meta(base)
    if not meta:
        log(STEP, f"skip {slug}: no meta.json")
        return None
    if not (base / "cache" / config.GRID_FILE).exists():
        log(STEP, f"skip {slug}: no cached grid (needs full regeneration)")
        return None
    ctx = CityContext(
        slug=meta["slug"],
        name=meta.get("name", slug),
        center=tuple(meta.get("center", (0.0, 0.0))),
        bbox=tuple(meta.get("bbox", (0.0, 0.0, 0.0, 0.0))),
        has_rent=True,
        rent_estimated=meta.get("rent_estimated", meta["slug"] not in _RENT_SLUGS),
        centers=meta.get("centers", []),
        population=meta.get("population"),
        city_type=meta.get("city_type"),
        city_context=meta.get("city_context") or {},
    )
    return attach_city_context(ctx)


def backfill_city(slug: str) -> bool:
    ctx = _ctx_from_cache(slug)
    if ctx is None:
        return False
    try:
        rents.main(ctx)
        normalize_export.main(ctx)
    except Exception as exc:  # noqa: BLE001
        log(STEP, f"FAILED {slug}: {type(exc).__name__}: {exc}")
        return False
    log(STEP, f"backfilled {slug} ({ctx.name})")
    return True


def _sync_munich_bundle() -> None:
    """Refresh bundled Munich GeoJSON in frontend (and legacy web/)."""
    src = config.CITIES_DIR / "muenchen" / "hexes.geojson"
    targets = [
        config.FRONTEND_PUBLIC_DIR / "data" / "hexes.geojson",
        config.WEB_DIR / "data" / "hexes.geojson",
    ]
    for dst in targets:
        if src.exists() and dst.parent.exists():
            shutil.copyfile(src, dst)
            log(STEP, f"synced bundled map -> {dst}")


def main() -> None:
    if len(sys.argv) > 1:
        slugs = sys.argv[1:]
    else:
        slugs = sorted(
            d.name for d in config.CITIES_DIR.iterdir()
            if d.is_dir() and (d / "meta.json").exists()
        )

    ok = 0
    for slug in slugs:
        if backfill_city(slug):
            ok += 1
    log(STEP, f"done: {ok}/{len(slugs)} cities backfilled")

    if "muenchen" in slugs:
        _sync_munich_bundle()


if __name__ == "__main__":
    main()
