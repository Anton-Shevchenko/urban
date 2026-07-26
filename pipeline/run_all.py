"""Run the full pipeline end to end for a given city."""
from __future__ import annotations

import shutil
import sys
from typing import Callable

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
    factor_traffic_safety,
    factor_transit_service,
    factor_transport,
    factor_urban_form,
    factor_walking_quality,
    grid,
    normalize_export,
    osm_data,
    rents,
)
from .city import CityContext, munich_context, resolve_city
from .common import log

STEPS = [
    ("grid", grid.main),
    ("osm download", osm_data.main),
    ("centers", centers.main),
    ("factor: business", factor_business.main),
    ("factor: green", factor_green.main),
    ("factor: noise", factor_noise.main),
    ("factor: center", factor_center.main),
    ("factor: transport", factor_transport.main),
    ("factor: daily needs", factor_daily_needs.main),
    ("factor: transit service", factor_transit_service.main),
    ("factor: heat", factor_heat.main),
    ("factor: traffic safety", factor_traffic_safety.main),
    ("factor: housing", factor_housing.main),
    ("factor: walking quality", factor_walking_quality.main),
    ("factor: urban form", factor_urban_form.main),
    ("rents", rents.main),
    ("normalize + export", normalize_export.main),
]

StepCallback = Callable[[int, int, str], None]


def _sync_munich_bundle(ctx: CityContext) -> None:
    if ctx.slug not in {"muenchen", "munich"}:
        return
    targets = [
        config.FRONTEND_PUBLIC_DIR / "data" / "hexes.geojson",
        config.WEB_DIR / "data" / "hexes.geojson",  # legacy path
    ]
    for dst in targets:
        if ctx.out_geojson.exists() and dst.parent.exists():
            shutil.copyfile(ctx.out_geojson, dst)
            log("run_all", f"synced bundled map -> {dst}")


def generate_city(ctx: CityContext, on_step: StepCallback | None = None) -> CityContext:
    total = len(STEPS)
    for i, (name, fn) in enumerate(STEPS, start=1):
        log("run_all", f"===== {i}/{total} {name} ({ctx.name}) =====")
        if on_step:
            on_step(i, total, name)
        fn(ctx)
    _sync_munich_bundle(ctx)
    log("run_all", f"DONE -> {ctx.out_geojson}")
    return ctx


def main() -> None:
    query = sys.argv[1] if len(sys.argv) > 1 else None
    ctx = resolve_city(query) if query else munich_context()
    generate_city(ctx)


if __name__ == "__main__":
    main()
