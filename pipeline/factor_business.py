"""Factor - business density.

Counts businesses (broad OSM set: shops, offices, food, banks, services, ...)
within ``BUSINESS_RADIUS_M`` of each hex centroid. Implemented as a buffered
spatial join in a metric CRS.

Because it is a *local* density, this factor naturally lights up every cluster
of economic activity - the main centre as well as secondary centres in other
districts - which is exactly the poly-centric behaviour we want.
"""
from __future__ import annotations

import geopandas as gpd

from . import config
from .city import CityContext, munich_context
from .common import log
from .osm_data import load_business

STEP = "factor_business"


def compute(ctx: CityContext) -> gpd.GeoDataFrame:
    grid = gpd.read_parquet(ctx.cache(config.GRID_FILE))
    biz = load_business(ctx)

    grid_m = grid.to_crs(ctx.metric_crs)
    out = grid[["h3_index"]].copy()

    if len(biz) == 0:
        out["business_count"] = 0
        log(STEP, "no businesses found; business_count = 0")
        return out

    biz_m = biz.to_crs(ctx.metric_crs)

    centroids = grid_m.copy()
    centroids["geometry"] = centroids.geometry.centroid
    centroids["buffer"] = centroids.geometry.buffer(config.BUSINESS_RADIUS_M)

    buffers = centroids.set_geometry("buffer")[["h3_index", "buffer"]]
    joined = gpd.sjoin(biz_m, buffers, predicate="within", how="inner")
    counts = joined.groupby("h3_index").size().rename("business_count")

    out = out.merge(counts, on="h3_index", how="left")
    out["business_count"] = out["business_count"].fillna(0).astype(int)
    out["urban_activity"] = out["business_count"]
    log(
        STEP,
        f"urban activity computed (max={out['urban_activity'].max()}, "
        f"mean={out['urban_activity'].mean():.1f})",
    )
    return out


def main(ctx: CityContext | None = None) -> None:
    ctx = ctx or munich_context()
    out = compute(ctx)
    dest = ctx.cache(config.BUSINESS_FILE)
    out.to_parquet(dest)
    log(STEP, f"saved -> {dest}")


if __name__ == "__main__":
    main()
