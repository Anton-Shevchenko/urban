"""Factor - heat resilience (OSM MVP).

Combines tree canopy proxy, impervious surface share, and proximity to
large cooling green areas into a 0..100 heat_resilience_score.
"""

from __future__ import annotations

import geopandas as gpd
import pandas as pd

from pipeline import config
from pipeline.city import CityContext, munich_context
from pipeline.common import log, nearest_polygon_distance
from pipeline.ingest.osm_data import load_green, load_landuse

STEP = "factor_heat"

LARGE_GREEN_M2 = 50_000  # 5 ha


def _pct(series: pd.Series, cap: float = 100.0) -> pd.Series:
    return (series.clip(0, cap) / cap * 100).round(1)


def compute(ctx: CityContext) -> gpd.GeoDataFrame:
    grid = gpd.read_parquet(ctx.cache(config.GRID_FILE)).to_crs(ctx.metric_crs)
    hexes = grid[["h3_index", "geometry"]].copy()
    out = grid[["h3_index"]].copy()
    hex_area = grid.geometry.area

    # Tree canopy proxy: intersect tree points / small tree polygons.
    try:
        trees = gpd.read_parquet(ctx.cache("osm_trees.parquet")).to_crs(ctx.metric_crs)
        joined = gpd.sjoin(trees, grid[["h3_index", "geometry"]], predicate="within", how="inner")
        tree_counts = joined.groupby("h3_index").size()
    except Exception:  # noqa: BLE001
        tree_counts = pd.Series(dtype=int)

    out["tree_canopy_pct"] = _pct(
        out["h3_index"].map(tree_counts).fillna(0) / (hex_area / 10_000).clip(lower=1),
        cap=40,
    )

    # Impervious: residential + industrial + commercial landuse in hex.
    try:
        landuse = load_landuse(ctx).to_crs(ctx.metric_crs)
        impervious_tags = {"residential", "industrial", "commercial", "retail"}
        landuse["imperv"] = landuse.get("landuse", "other").isin(impervious_tags)
        inter = gpd.overlay(
            grid[["h3_index", "geometry"]],
            landuse[landuse["imperv"]][["geometry"]],
            how="intersection",
        )
        imperv_area = inter.groupby("h3_index").geometry.area
        out["impervious_pct"] = _pct(
            out["h3_index"].map(imperv_area).fillna(0) / hex_area * 100,
            cap=100,
        )
    except Exception:  # noqa: BLE001
        out["impervious_pct"] = 50.0

    # Surface temp proxy: higher impervious + fewer trees -> worse.
    out["surface_temp_score"] = (
        (100 - out["impervious_pct"] * 0.6 - (40 - out["tree_canopy_pct"]).clip(lower=0) * 0.4)
        .clip(0, 100)
        .round(1)
    )

    # Cooling proximity: distance to large green.
    try:
        green = load_green(ctx).to_crs(ctx.metric_crs)
        green["area_m2"] = green.geometry.area
        large = green[green["area_m2"] >= LARGE_GREEN_M2]
        if len(large):
            cool_dist = nearest_polygon_distance(hexes, large, "cool_dist_m")
            out["cooling_dist_m"] = (
                hexes["h3_index"].map(cool_dist.reindex(hexes.index)).fillna(2000).round(0).values
            )
            out["cooling_score"] = (100 - (out["cooling_dist_m"] / 20).clip(0, 100)).round(1)
        else:
            out["cooling_dist_m"] = 2000
            out["cooling_score"] = 0.0
    except Exception:  # noqa: BLE001
        out["cooling_dist_m"] = 2000
        out["cooling_score"] = 0.0

    out["heat_resilience_score"] = (
        0.40 * out["tree_canopy_pct"]
        + 0.30 * out["surface_temp_score"]
        + 0.20 * (100 - out["impervious_pct"])
        + 0.10 * out["cooling_score"]
    ).round(1)
    out["heat_source"] = "osm_proxy"
    out["heat_confidence"] = 0.35

    log(STEP, f"heat resilience mean={out['heat_resilience_score'].mean():.1f}")
    return out


def main(ctx: CityContext | None = None) -> None:
    ctx = ctx or munich_context()
    out = compute(ctx)
    dest = ctx.cache(config.HEAT_FILE)
    out.to_parquet(dest)
    log(STEP, f"saved -> {dest}")


if __name__ == "__main__":
    main()
