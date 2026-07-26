"""Recompute Living Score foundation factors from cached OSM layers.

Skips grid + full OSM download; refreshes centers + rewritten factors + export.
Needs network only if a required OSM cache is missing (e.g. pedestrian ways).

Usage:
    python -m pipeline.backfill_foundation muenchen
    python -m pipeline.backfill_foundation rosenheim
    python -m pipeline.backfill_foundation          # both common cities
"""
from __future__ import annotations

import shutil
import sys

from . import (
    centers,
    config,
    factor_center,
    factor_daily_needs,
    factor_green,
    factor_noise,
    factor_transit_service,
    factor_urban_form,
    factor_walking_quality,
    normalize_export,
    rents,
)
from .backfill_rents import _ctx_from_cache
from .common import log

STEP = "backfill_foundation"

FOUNDATION_STEPS = [
    ("centers", centers.main),
    ("factor: daily needs", factor_daily_needs.main),
    ("factor: transit service", factor_transit_service.main),
    ("factor: walking quality", factor_walking_quality.main),
    ("factor: urban form", factor_urban_form.main),
    ("factor: center (centrality)", factor_center.main),
    ("factor: green", factor_green.main),
    ("factor: noise", factor_noise.main),
    ("rents", rents.main),
    ("normalize + export", normalize_export.main),
]


def _sync_munich_bundle(slug: str) -> None:
    if slug not in {"muenchen", "munich"}:
        return
    src = config.CITIES_DIR / slug / "hexes.geojson"
    targets = [
        config.FRONTEND_PUBLIC_DIR / "data" / "hexes.geojson",
        config.WEB_DIR / "data" / "hexes.geojson",
    ]
    for dst in targets:
        if src.exists() and dst.parent.exists():
            shutil.copyfile(src, dst)
            log(STEP, f"synced bundled map -> {dst}")


def backfill_city(slug: str) -> bool:
    ctx = _ctx_from_cache(slug)
    if ctx is None:
        return False
    try:
        for name, fn in FOUNDATION_STEPS:
            log(STEP, f"{slug}: {name} (city_type={ctx.city_type} pop={ctx.population})")
            fn(ctx)
    except Exception as exc:  # noqa: BLE001
        log(STEP, f"FAILED {slug}: {type(exc).__name__}: {exc}")
        return False
    _sync_munich_bundle(slug)
    log(STEP, f"backfilled foundation -> {ctx.out_geojson}")
    return True


def main() -> None:
    if len(sys.argv) > 1:
        slugs = sys.argv[1:]
    else:
        slugs = ["muenchen", "rosenheim"]
    ok = sum(backfill_city(slug) for slug in slugs)
    log(STEP, f"done: {ok}/{len(slugs)} cities")
    if ok != len(slugs):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
