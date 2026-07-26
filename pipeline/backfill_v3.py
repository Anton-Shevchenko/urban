"""Backfill schema-v3 factors for cities with an existing v2 cache.

Runs only the new OSM layers + v3 factor steps + export, reusing the cached
grid and legacy factor parquets where possible. Needs network for Overpass.

Usage:
    python -m pipeline.backfill_v3 rosenheim
    python -m pipeline.backfill_v3          # all cached cities
"""
from __future__ import annotations

import sys

from . import (
    centers,
    config,
    factor_business,
    factor_center,
    factor_daily_needs,
    factor_green,
    factor_heat,
    factor_housing,
    factor_noise,
    factor_transit_service,
    factor_traffic_safety,
    factor_urban_form,
    factor_walking_quality,
    normalize_export,
    osm_data,
    rents,
)
from .backfill_rents import _ctx_from_cache
from .common import log

STEP = "backfill_v3"

V3_STEPS = [
    ("osm download (v3 layers)", osm_data.main),
    ("centers", centers.main),
    ("factor: business (urban_activity)", factor_business.main),
    ("factor: green (green_access)", factor_green.main),
    ("factor: noise", factor_noise.main),
    ("factor: daily needs", factor_daily_needs.main),
    ("factor: transit service", factor_transit_service.main),
    ("factor: heat", factor_heat.main),
    ("factor: traffic safety", factor_traffic_safety.main),
    ("factor: housing", factor_housing.main),
    ("factor: walking quality", factor_walking_quality.main),
    ("factor: urban form", factor_urban_form.main),
    ("factor: center (centrality)", factor_center.main),
    ("rents", rents.main),
    ("normalize + export", normalize_export.main),
]


def backfill_city(slug: str) -> bool:
    ctx = _ctx_from_cache(slug)
    if ctx is None:
        return False
    try:
        for name, fn in V3_STEPS:
            log(STEP, f"{slug}: {name}")
            fn(ctx)
    except Exception as exc:  # noqa: BLE001
        log(STEP, f"FAILED {slug}: {type(exc).__name__}: {exc}")
        return False
    log(STEP, f"backfilled v3 -> {ctx.out_geojson}")
    return True


def main() -> None:
    if len(sys.argv) > 1:
        slugs = sys.argv[1:]
    else:
        slugs = sorted(
            d.name for d in config.CITIES_DIR.iterdir()
            if d.is_dir() and (d / "meta.json").exists()
        )
    ok = sum(backfill_city(slug) for slug in slugs)
    log(STEP, f"done: {ok}/{len(slugs)} cities")


if __name__ == "__main__":
    main()
