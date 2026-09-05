"""Factor 4 - ambient noise level (dB).

Acoustic proxy from proximity to major roads and railways.
Distance measured from hex polygon boundary (not centroid).
"""

from __future__ import annotations

import math

import geopandas as gpd
import pandas as pd
from shapely.geometry import LineString

from pipeline import config
from pipeline.city import CityContext, munich_context
from pipeline.common import empty_gdf, log, nearest_polygon_distance, overpass_elements

STEP = "factor_noise"

D_REF = 25.0
MAX_INFLUENCE = 1500
BACKGROUND_DB = 42.0

SOURCE_LEVELS = {
    "motorway": 78.0,
    "trunk": 76.0,
    "primary": 72.0,
    "secondary": 67.0,
    "tertiary": 62.0,
    "rail": 74.0,
}


def _line_from_way(el: dict):
    coords = [(nd["lon"], nd["lat"]) for nd in el.get("geometry", [])]
    return LineString(coords) if len(coords) >= 2 else None


def fetch_roads(ctx: CityContext) -> gpd.GeoDataFrame:
    road_cache = ctx.cache(config.OSM_ROADS_FILE)
    if road_cache.exists():
        cached = gpd.read_parquet(road_cache)
        if len(cached) > 0:
            log(STEP, f"using cached roads {road_cache.name} ({len(cached)})")
            return cached
        # Empty file is usually a transient Overpass miss — do not keep it forever.
        log(STEP, f"discarding empty roads cache {road_cache.name}")
        road_cache.unlink(missing_ok=True)

    bbox_str = ctx.bbox_str
    query = f"""
    [out:json][timeout:180];
    (
      way["highway"~"^(motorway|trunk|primary|secondary|tertiary)$"]({bbox_str});
      way["railway"="rail"]({bbox_str});
    );
    out geom;
    """
    try:
        els = overpass_elements(query, STEP)
    except RuntimeError as exc:
        log(STEP, f"Overpass failed ({exc}); trying safety-roads fallback")
        els = []
    rows = []
    for el in els:
        geom = _line_from_way(el)
        if geom is None:
            continue
        tags = el.get("tags", {})
        cls = "rail" if "railway" in tags else tags.get("highway")
        if cls not in SOURCE_LEVELS:
            continue
        rows.append({"cls": cls, "geometry": geom})
    gdf = empty_gdf(["cls"]) if not rows else gpd.GeoDataFrame(rows, crs=config.WGS84)

    # If noise Overpass returned nothing, derive major roads from the broader
    # safety-roads cache (often already fetched successfully).
    if len(gdf) == 0:
        safety_path = ctx.cache("osm_roads_safety.parquet")
        if safety_path.exists():
            try:
                safety = gpd.read_parquet(safety_path)
                if len(safety) and "highway" in safety.columns:
                    subset = safety[safety["highway"].isin(SOURCE_LEVELS)].copy()
                    if len(subset):
                        subset = subset.rename(columns={"highway": "cls"})
                        gdf = subset[["cls", "geometry"]].copy()
                        gdf = gpd.GeoDataFrame(gdf, crs=safety.crs or config.WGS84)
                        log(STEP, f"noise sources from safety roads: {len(gdf)}")
            except Exception as exc:  # noqa: BLE001
                log(STEP, f"safety-roads fallback failed: {exc}")

    log(
        STEP, f"noise sources fetched: {len(gdf)} ({gdf['cls'].value_counts().to_dict() if len(gdf) else {}})"
    )
    # Never persist an empty roads cache — next run should retry Overpass.
    if len(gdf) > 0:
        gdf.to_parquet(road_cache)
    else:
        log(STEP, "skipping empty roads cache write (will retry next run)")
    return gdf


def compute(ctx: CityContext) -> gpd.GeoDataFrame:
    grid = gpd.read_parquet(ctx.cache(config.GRID_FILE)).to_crs(ctx.metric_crs)
    hexes = grid[["h3_index", "geometry"]].copy()
    roads = fetch_roads(ctx).to_crs(ctx.metric_crs)

    energy = pd.Series(0.0, index=hexes.index)

    for cls, level in SOURCE_LEVELS.items():
        subset = roads[roads["cls"] == cls]
        if subset.empty:
            continue
        d = nearest_polygon_distance(hexes, subset, "d").reindex(hexes.index)
        d = d.clip(lower=D_REF)
        li = level - 10.0 * (d / D_REF).apply(math.log10)
        li = li.where(d <= MAX_INFLUENCE, other=float("-inf"))
        energy = energy.add((10.0 ** (li / 10.0)).fillna(0.0), fill_value=0.0)

    energy = energy + 10.0 ** (BACKGROUND_DB / 10.0)
    noise_db = 10.0 * energy.apply(math.log10)

    out = hexes[["h3_index"]].copy()
    out["noise_db"] = noise_db.round(1).values
    out["noise_source"] = "osm_proxy"
    out["noise_confidence"] = 0.5
    log(
        STEP,
        f"noise computed (min={out['noise_db'].min():.1f} dB, "
        f"max={out['noise_db'].max():.1f} dB, mean={out['noise_db'].mean():.1f} dB)",
    )
    return out


def main(ctx: CityContext | None = None) -> None:
    ctx = ctx or munich_context()
    out = compute(ctx)
    dest = ctx.cache(config.NOISE_FILE)
    out.to_parquet(dest)
    log(STEP, f"saved -> {dest}")


if __name__ == "__main__":
    main()
