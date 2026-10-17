"""Cycleways map view: own Overpass fetch, line overlay, hex scores."""

from __future__ import annotations

import json
import shutil

import pandas as pd

from pipeline import config
from pipeline.city import CityContext
from pipeline.factors import cycleways
from pipeline.grid_store import bind_grid
from services.runtime import json_number

STEP = "cycleways"


def write_scores(ctx: CityContext) -> None:
    frame = pd.read_parquet(ctx.cache(config.CYCLEWAYS_FILE))
    scores = {}
    for _, row in frame.iterrows():
        h3 = str(row["h3_index"])
        scores[h3] = {"s_cycleways": json_number(row.get("s_cycleways"))}
    dest = ctx.base_dir / "scores.json"
    dest.write_text(
        json.dumps({"slug": ctx.slug, "scores": scores}, separators=(",", ":")),
        encoding="utf-8",
    )


def run(ctx: CityContext) -> None:
    bind_grid(ctx)
    cycleways.main(ctx)
    cycleways.write_overlay_geojson(ctx)
    lines = ctx.base_dir / "lines.geojson"
    overlay = ctx.base_dir / config.CYCLEWAYS_GEOJSON_FILE
    if overlay.is_file():
        shutil.copyfile(overlay, lines)
    else:
        lines.write_text('{"type":"FeatureCollection","features":[]}', encoding="utf-8")
    write_scores(ctx)
