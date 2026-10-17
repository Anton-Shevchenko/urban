"""Walkability inputs fetched into this service's own cache.

Roads, stops, land use, population and parks are read from Overpass or the
local Zensus/OSM fallback. Nothing here opens another map-view directory.
"""

from __future__ import annotations

import geopandas as gpd
import pandas as pd

from pipeline import config
from pipeline.city import CityContext
from pipeline.common import log, nearest_polygon_distance
from pipeline.export.score_scales import walkability_index
from pipeline.factors.green import compute as green_compute
from pipeline.factors.transit_service import _dist_score
from pipeline.factors.urban_form import _landuse_shares
from pipeline.factors.walking_quality import _intersection_density, _mean_block_length
from pipeline.grid_store import bind_grid
from pipeline.ingest.osm_data import fetch_landuse, load_green, load_roads, load_stations
from pipeline.ingest.zensus_loader import osm_housing_proxy

STEP = "walkability"


def _landuse(ctx: CityContext) -> gpd.GeoDataFrame:
    cache = ctx.cache(config.OSM_LANDUSE_FILE)
    if cache.exists():
        cached = gpd.read_parquet(cache)
        if len(cached) > 0:
            return cached
        cache.unlink(missing_ok=True)
    gdf = fetch_landuse(ctx.bbox_str)
    if len(gdf) > 0:
        gdf.to_parquet(cache)
    return gdf


def _transit_distance(ctx: CityContext, hexes: gpd.GeoDataFrame) -> pd.Series:
    try:
        stations = load_stations(ctx)
    except Exception:  # noqa: BLE001
        log(STEP, "station fetch failed; transit distance 0")
        return pd.Series(0.0, index=hexes.index)
    if stations is None or len(stations) == 0:
        return pd.Series(0.0, index=hexes.index)
    dist = nearest_polygon_distance(hexes, stations.to_crs(hexes.crs), "transit_m")
    filled = dist.reindex(hexes.index).fillna(9_999.0)
    return filled.map(lambda metres: _dist_score(float(metres))).astype(float)


def compute(ctx: CityContext) -> pd.DataFrame:
    bind_grid(ctx)
    grid = gpd.read_parquet(ctx.cache(config.GRID_FILE)).to_crs(ctx.metric_crs)
    hexes = grid[["h3_index", "geometry"]].copy().reset_index(drop=True)

    try:
        roads = load_roads(ctx).to_crs(ctx.metric_crs)
    except Exception:  # noqa: BLE001
        log(STEP, "road fetch failed; connectivity 0")
        roads = gpd.GeoDataFrame(columns=["geometry", "highway"], crs=ctx.metric_crs)

    landuse = _landuse(ctx)
    if len(landuse):
        landuse = landuse.to_crs(ctx.metric_crs)
    residential, commercial = _landuse_shares(hexes, landuse)

    try:
        load_green(ctx)
    except Exception:  # noqa: BLE001
        log(STEP, "park fetch failed; green floor empty")
    parks = green_compute(ctx)

    housing = osm_housing_proxy(ctx)
    pop = housing.set_index("h3_index")["population_density"] if "population_density" in housing.columns else pd.Series(dtype=float)
    park_by_h3 = parks.set_index("h3_index") if "h3_index" in parks.columns else pd.DataFrame()

    frame = pd.DataFrame({"h3_index": hexes["h3_index"].values})
    frame["intersection_density"] = _intersection_density(roads, hexes).to_numpy()
    frame["mean_block_length_m"] = _mean_block_length(roads, hexes).to_numpy()
    frame["transit_distance_score"] = _transit_distance(ctx, hexes).to_numpy()
    frame["landuse_residential_share"] = residential.to_numpy()
    frame["landuse_commercial_share"] = commercial.to_numpy()
    frame["population_density"] = frame["h3_index"].map(pop).fillna(0.0)
    if "green_share_inside_500m" in park_by_h3.columns:
        frame["green_share_inside_500m"] = frame["h3_index"].map(park_by_h3["green_share_inside_500m"]).fillna(0.0)
    if "nearest_park_dist_m" in park_by_h3.columns:
        frame["nearest_park_dist_m"] = frame["h3_index"].map(park_by_h3["nearest_park_dist_m"]).fillna(2000.0)
    if "nearest_park_area_ha" in park_by_h3.columns:
        frame["nearest_park_area_ha"] = frame["h3_index"].map(park_by_h3["nearest_park_area_ha"]).fillna(0.0)

    scored = walkability_index(frame)
    out = frame[["h3_index"]].copy()
    out["s_walkability"] = scored["s_walkability"].to_numpy()
    log(STEP, f"walkability mean={pd.to_numeric(out['s_walkability'], errors='coerce').mean():.1f}")
    return out


def run(ctx: CityContext) -> None:
    import json

    out = compute(ctx)
    dest = ctx.base_dir / "scores.json"
    scores = {}
    for _, row in out.iterrows():
        value = row["s_walkability"]
        number = None if pd.isna(value) else round(float(value), 1)
        scores[str(row["h3_index"])] = {"s_walkability": number}
    dest.write_text(
        json.dumps({"slug": ctx.slug, "scores": scores}, separators=(",", ":")),
        encoding="utf-8",
    )
    out.to_parquet(ctx.cache("factor_walkability.parquet"))
