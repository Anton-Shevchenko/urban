"""Factor 2 - green access (polygon distance + weighted components).

Uses hex polygon boundaries (not centroids) for distance to parks/water.
Exports raw metrics for absolute scoring in :mod:`pipeline.score_scales`.
"""

from __future__ import annotations

import geopandas as gpd
import numpy as np
import pandas as pd

from pipeline import config
from pipeline.city import CityContext, munich_context
from pipeline.common import empty_gdf, green_share_within_buffer, log, nearest_polygon_distance

STEP = "factor_green"

LARGE_M2 = 50_000
MEDIUM_M2 = 10_000
# Pocket parks still count as accessible green. 1 ha used to drop every
# neighbourhood garden in smaller cities, so nearest_park_dist_m collapsed
# to the 2000 m fill-in and s_green became a city-wide constant (3.6).
GREEN_DIST_MIN_AREA_M2 = 2_000
GREEN_BUFFER_M = 500
GREEN_SHARE_MIN_AREA_M2 = 2_000
GREEN_LANDUSE_TYPES = {
    "forest",
    "grass",
    "meadow",
    "recreation_ground",
    "allotments",
    "village_green",
    "cemetery",
    "orchard",
}


def _quality_weight(area_m2: float, kind: str) -> float:
    if kind == "riverbank":
        return config.GREEN_QUALITY_WEIGHTS["riverbank"]
    if kind == "water":
        return config.GREEN_QUALITY_WEIGHTS["water_inaccessible"]
    if area_m2 >= LARGE_M2:
        return config.GREEN_QUALITY_WEIGHTS["large_park"]
    if area_m2 >= MEDIUM_M2:
        return config.GREEN_QUALITY_WEIGHTS["medium_park"]
    return config.GREEN_QUALITY_WEIGHTS["small_green"]


def _tree_canopy_pct(grid: gpd.GeoDataFrame, hexes: gpd.GeoDataFrame, ctx: CityContext) -> pd.Series:
    try:
        trees = gpd.read_parquet(ctx.cache("osm_trees.parquet")).to_crs(ctx.metric_crs)
        joined = gpd.sjoin(trees, grid[["h3_index", "geometry"]], predicate="within", how="inner")
        tree_counts = joined.groupby("h3_index").size()
        hex_area = grid.set_index("h3_index").geometry.area
        pct = hexes["h3_index"].map(tree_counts).fillna(0) / (hexes["h3_index"].map(hex_area) / 10_000).clip(
            lower=1
        )
        return (pct.clip(0, 40) / 40 * 100).round(1)
    except Exception:  # noqa: BLE001
        return pd.Series(15.0, index=hexes.index)


def _read_layer(path) -> gpd.GeoDataFrame:
    if not path.exists():
        return empty_gdf()
    gdf = gpd.read_parquet(path)
    return gdf if len(gdf) else empty_gdf()


def _landuse_green(ctx: CityContext, metric_crs: str) -> gpd.GeoDataFrame:
    """Parks are often missing from osm_green; landuse forest/grass still is not."""
    lu = _read_layer(ctx.cache(config.OSM_LANDUSE_FILE))
    if len(lu) == 0 or "landuse" not in lu.columns:
        return empty_gdf()
    greenish = lu[lu["landuse"].isin(GREEN_LANDUSE_TYPES)]
    if len(greenish) == 0:
        return empty_gdf()
    return greenish[["geometry"]].to_crs(metric_crs)


def _green_polygons(ctx: CityContext, metric_crs: str) -> gpd.GeoDataFrame:
    parts: list[gpd.GeoDataFrame] = []
    osm = _read_layer(ctx.cache(config.OSM_GREEN_FILE))
    if len(osm):
        parts.append(osm.to_crs(metric_crs)[["geometry"]])
    landuse = _landuse_green(ctx, metric_crs)
    if len(landuse):
        parts.append(landuse)
    if not parts:
        return empty_gdf()
    out = pd.concat(parts, ignore_index=True)
    out = gpd.GeoDataFrame(out, geometry="geometry", crs=metric_crs)
    out = out[~out.geometry.is_empty & out.geometry.notna()]
    return out


def compute(ctx: CityContext) -> gpd.GeoDataFrame:
    grid = gpd.read_parquet(ctx.cache(config.GRID_FILE)).to_crs(ctx.metric_crs)
    hexes = grid[["h3_index", "geometry"]].copy()

    green = _green_polygons(ctx, ctx.metric_crs)
    water = _read_layer(ctx.cache(config.OSM_WATER_FILE))
    if len(water):
        water = water.to_crs(ctx.metric_crs)
    else:
        water = empty_gdf()

    if len(green):
        green["area_m2"] = green.geometry.area
        green["kind"] = "park"
    else:
        green = gpd.GeoDataFrame(columns=["geometry", "area_m2", "kind"], crs=ctx.metric_crs)

    green_accessible = green[green["area_m2"] >= GREEN_DIST_MIN_AREA_M2] if len(green) else green
    green_for_share = green[green["area_m2"] >= GREEN_SHARE_MIN_AREA_M2] if len(green) else green

    d_green = nearest_polygon_distance(hexes, green_accessible, "dist_green")
    d_water = nearest_polygon_distance(hexes, water, "dist_water")

    out = hexes[["h3_index"]].copy()
    out["nearest_park_dist_m"] = d_green.reindex(hexes.index).fillna(2000).round(0)
    out["dist_water_m"] = d_water.reindex(hexes.index).fillna(2000).round(0)
    # Legacy alias: min park/water (kept for tooltips; scoring uses nearest_park_dist_m).
    out["green_dist_m"] = out[["nearest_park_dist_m", "dist_water_m"]].min(axis=1).round(0)

    if len(green):
        joined = gpd.sjoin_nearest(
            hexes, green_accessible if len(green_accessible) else green, how="left", distance_col="d"
        )
        best = joined.groupby(joined.index).first()
        out["green_area_m2"] = hexes.index.map(best["area_m2"]).fillna(0).values
        out["nearest_park_area_ha"] = (out["green_area_m2"] / 10_000).round(2)
        out["green_quality"] = [
            _quality_weight(a if pd.notna(a) else 0, "park") for a in out["green_area_m2"]
        ]
    else:
        out["green_area_m2"] = 0.0
        out["nearest_park_area_ha"] = 0.0
        out["green_quality"] = 0.4

    out.loc[out["dist_water_m"] < out["nearest_park_dist_m"], "green_quality"] = _quality_weight(
        0, "riverbank"
    )

    green_union = (
        green_for_share
        if len(green_for_share)
        else (green if len(green) else gpd.GeoDataFrame(geometry=[], crs=ctx.metric_crs))
    )
    out["green_share_inside_500m"] = (
        green_share_within_buffer(
            hexes,
            green_union,
            buffer_m=GREEN_BUFFER_M,
        )
        .round(1)
        .values
    )

    out["tree_canopy_pct"] = _tree_canopy_pct(grid, hexes, ctx).values

    # Legacy composite (informational; s_green uses score_scales in normalize_export).
    dist_score = (100 - (out["nearest_park_dist_m"] / 15).clip(0, 100)).round(1)
    area_score = (np.log1p(out["green_area_m2"] / 1000) / np.log1p(50)).clip(0, 1) * 100
    quality_score = (out["green_quality"].clip(0, 1) * 100).round(1)
    out["green_access"] = (0.50 * dist_score + 0.30 * area_score + 0.20 * quality_score).round(1)

    log(
        STEP,
        f"green metrics (park dist mean={out['nearest_park_dist_m'].mean():.0f}m, "
        f"share500m mean={out['green_share_inside_500m'].mean():.0f}%, "
        f"canopy mean={out['tree_canopy_pct'].mean():.0f})",
    )
    return out[
        [
            "h3_index",
            "green_dist_m",
            "nearest_park_dist_m",
            "dist_water_m",
            "green_access",
            "green_area_m2",
            "nearest_park_area_ha",
            "green_quality",
            "green_share_inside_500m",
            "tree_canopy_pct",
        ]
    ]


def main(ctx: CityContext | None = None) -> None:
    ctx = ctx or munich_context()
    out = compute(ctx)
    dest = ctx.cache(config.GREEN_FILE)
    out.to_parquet(dest)
    log(STEP, f"saved -> {dest}")


if __name__ == "__main__":
    main()
