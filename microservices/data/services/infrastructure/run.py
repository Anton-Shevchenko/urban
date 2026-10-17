"""Infrastructure map view: daily-life access, own OSM fetch, hex polygons."""

from __future__ import annotations

import json

import geopandas as gpd
import pandas as pd

from pipeline import config
from pipeline.city import CityContext
from pipeline.common import log
from pipeline.export.score_scales import living_score_composite
from pipeline.factors import daily_needs
from pipeline.grid_store import bind_grid
from services.runtime import json_number

STEP = "infrastructure"


def export_hexes(ctx: CityContext) -> None:
    grid = gpd.read_parquet(ctx.cache(config.GRID_FILE))
    if grid.crs is not None:
        grid = grid.to_crs(config.WGS84)
    scores = pd.read_parquet(ctx.cache(config.DAILY_NEEDS_FILE))
    merged = grid.merge(scores, on="h3_index", how="left")
    living = living_score_composite({"daily_life": merged["s_daily_life"]})
    features = []
    for pos, (_, row) in enumerate(merged.iterrows()):
        props: dict = {
            "h3": row["h3_index"],
            "s_daily_life": json_number(row.get("s_daily_life")),
            "s_living": json_number(living.iloc[pos]),
            "s_objective": json_number(living.iloc[pos]),
        }
        for column in merged.columns:
            if column.startswith(("dn_", "dl_")):
                props[column] = json_number(row[column])
        features.append(
            {
                "type": "Feature",
                "geometry": row.geometry.__geo_interface__,
                "properties": props,
            }
        )
    meta = {
        **ctx.to_meta(),
        "count": len(features),
        "has_rent": False,
        "pipeline_version": int(config.PIPELINE_SCHEMA_VERSION),
        "score_method_version": config.SCORE_METHOD_VERSION,
        "product": "infrastructure",
    }
    dest = ctx.base_dir / "hexes.geojson"
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(
        json.dumps({"type": "FeatureCollection", "meta": meta, "features": features}, separators=(",", ":")),
        encoding="utf-8",
    )
    (ctx.base_dir / "meta.json").write_text(json.dumps(meta), encoding="utf-8")
    log(STEP, f"exported {len(features)} hexes -> {dest}")


def run(ctx: CityContext) -> None:
    bind_grid(ctx)
    daily_needs.main(ctx)
    export_hexes(ctx)
