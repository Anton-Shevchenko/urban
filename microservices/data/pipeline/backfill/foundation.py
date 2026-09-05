"""Recompute Living Score foundation factors from cached OSM layers.

Skips grid + full OSM download; refreshes centres, rewritten factors, and export.
Needs network only if a required OSM cache is missing.

Usage:
    python -m pipeline.backfill.foundation muenchen
    python -m pipeline.backfill.foundation rosenheim
    python -m pipeline.backfill.foundation          # both common cities
"""

from __future__ import annotations

import sys

from pipeline import rents
from pipeline.city import ctx_from_cache, sync_munich_bundle
from pipeline.common import log
from pipeline.export import normalize_export
from pipeline.factors import (
    center,
    daily_needs,
    green,
    noise,
    transit_service,
    urban_form,
    walking_quality,
)
from pipeline.ingest import centers

STEP = "backfill_foundation"

FOUNDATION_STEPS = [
    ("centers", centers.main),
    ("factor: daily needs", daily_needs.main),
    ("factor: transit service", transit_service.main),
    ("factor: walking quality", walking_quality.main),
    ("factor: urban form", urban_form.main),
    ("factor: center (centrality)", center.main),
    ("factor: green", green.main),
    ("factor: noise", noise.main),
    ("rents", rents.main),
    ("normalize + export", normalize_export.main),
]


def backfill_city(slug: str) -> bool:
    ctx = ctx_from_cache(slug)
    if ctx is None:
        return False
    try:
        for name, fn in FOUNDATION_STEPS:
            log(STEP, f"{slug}: {name} (city_type={ctx.city_type} pop={ctx.population})")
            fn(ctx)
    except Exception as exc:  # noqa: BLE001
        log(STEP, f"FAILED {slug}: {type(exc).__name__}: {exc}")
        return False
    sync_munich_bundle(ctx)
    log(STEP, f"backfilled foundation -> {ctx.out_geojson}")
    return True


def main() -> None:
    slugs = sys.argv[1:] or ["muenchen", "rosenheim"]
    ok = sum(backfill_city(slug) for slug in slugs)
    log(STEP, f"done: {ok}/{len(slugs)} cities")
    if ok != len(slugs):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
