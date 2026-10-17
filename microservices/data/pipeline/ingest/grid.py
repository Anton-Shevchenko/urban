"""Step 1 - build the H3 grid covering the target city.

Uses the admin boundary polygon carried on the CityContext (resolved via
Nominatim in :func:`pipeline.city.resolve_city`, falling back to the cached
boundary file or the bounding box), fills it with H3 cells at the configured
resolution, and stores one row per cell with its centroid and polygon geometry.
"""

from __future__ import annotations

import json

import geopandas as gpd
import h3
from shapely.geometry import Polygon, shape

from pipeline import config
from pipeline.city import CityContext, munich_context
from pipeline.common import log

STEP = "grid"


def fetch_boundary(ctx: CityContext) -> shape:
    """Return a shapely (multi)polygon of the city boundary."""
    if ctx.boundary_geojson is not None:
        return shape(ctx.boundary_geojson)

    boundary_path = ctx.cache(config.BOUNDARY_FILE)
    if boundary_path.exists():
        log(STEP, f"using cached boundary {boundary_path.name}")
        with open(boundary_path, encoding="utf-8") as fh:
            geom = json.load(fh)
            ctx.boundary_geojson = geom
            return shape(geom)

    log(STEP, f"no boundary for {ctx.name}; falling back to bounding box")
    south, west, north, east = ctx.bbox
    return Polygon([(west, south), (east, south), (east, north), (west, north)])


def build_grid(ctx: CityContext) -> gpd.GeoDataFrame:
    from shapely.geometry import Point

    boundary = fetch_boundary(ctx)
    log(STEP, f"filling {ctx.name} boundary with H3 res {config.H3_RES} cells")

    # h3.geo_to_cells accepts a GeoJSON-like mapping (lng, lat order).
    cells = set(h3.geo_to_cells(boundary.__geo_interface__, config.H3_RES))
    log(STEP, f"{len(cells)} candidate cells")

    rows = []
    dropped = 0
    for cell in cells:
        lat, lng = h3.cell_to_latlng(cell)
        # Keep only cells whose centre is inside the admin polygon. Older caches
        # sometimes filled the bounding box; without this filter the map paints
        # neighbouring Gemeinden (Karlsfeld, Unterhaching, …).
        if not boundary.covers(Point(lng, lat)):
            dropped += 1
            continue
        boundary_latlng = h3.cell_to_boundary(cell)
        poly = Polygon([(lo, la) for la, lo in boundary_latlng])
        rows.append(
            {
                "h3_index": cell,
                "lat": lat,
                "lng": lng,
                "geometry": poly,
            }
        )

    if dropped:
        log(STEP, f"dropped {dropped} cells outside admin boundary")
    gdf = gpd.GeoDataFrame(rows, crs=config.WGS84)
    log(STEP, f"grid built: {len(gdf)} cells")
    return gdf


def main(ctx: CityContext | None = None) -> None:
    ctx = ctx or munich_context()
    gdf = build_grid(ctx)
    out = ctx.cache(config.GRID_FILE)
    gdf.to_parquet(out)
    log(STEP, f"saved -> {out}")


if __name__ == "__main__":
    main()
