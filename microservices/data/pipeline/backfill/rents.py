"""Recompute the rent layer for already-generated cities — offline.

Existing cities under ``data/cities/<slug>/`` can refresh ``rent_eur_m2``
without Overpass or Nominatim: only ``rents`` and ``normalize + export``
rerun from the cached grid / factor parquets.

Usage:
    python -m pipeline.backfill.rents            # all cached cities
    python -m pipeline.backfill.rents rosenheim  # one slug
"""

from __future__ import annotations

import sys

from pipeline import rents
from pipeline.city import ctx_from_cache, sync_munich_bundle
from pipeline.common import log
from pipeline.config import CITIES_DIR
from pipeline.export import normalize_export

STEP = "backfill"


def backfill_city(slug: str) -> bool:
    ctx = ctx_from_cache(slug)
    if ctx is None:
        return False
    try:
        rents.main(ctx)
        normalize_export.main(ctx)
    except Exception as exc:  # noqa: BLE001
        log(STEP, f"FAILED {slug}: {type(exc).__name__}: {exc}")
        return False
    sync_munich_bundle(ctx)
    log(STEP, f"backfilled {slug} ({ctx.name})")
    return True


def main() -> None:
    if len(sys.argv) > 1:
        slugs = sys.argv[1:]
    else:
        slugs = sorted(d.name for d in CITIES_DIR.iterdir() if d.is_dir() and (d / "meta.json").exists())

    ok = sum(1 for slug in slugs if backfill_city(slug))
    log(STEP, f"done: {ok}/{len(slugs)} cities backfilled")
    if ok != len(slugs):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
