"""OSM admin polygons for cited district tables. Failures yield no geography."""

from __future__ import annotations

import geopandas as gpd
import pandas as pd
from shapely.geometry import LineString, MultiLineString
from shapely.ops import linemerge, polygonize, unary_union

from pipeline import config
from pipeline.city import CityContext
from pipeline.common import log, overpass_elements

STEP = "rent_admin"


def _relation_to_polygon(element: dict):
    lines: list[LineString] = []
    for member in element.get("members", []):
        if member.get("type") != "way" or member.get("role") not in ("outer", "", None):
            continue
        geom = member.get("geometry")
        if not geom:
            continue
        coords = [(point["lon"], point["lat"]) for point in geom if "lon" in point and "lat" in point]
        if len(coords) >= 2:
            lines.append(LineString(coords))
    if not lines:
        return None
    try:
        merged = linemerge(lines)
        if merged.geom_type == "LineString":
            merged = MultiLineString([merged])
        polygons = list(polygonize(merged))
        if not polygons:
            return None
        return unary_union(polygons)
    except Exception:  # noqa: BLE001 - a broken relation is skipped, not filled
        return None


def _fetch_level(ctx: CityContext, admin_level: str) -> gpd.GeoDataFrame | None:
    query = f"""
    [out:json][timeout:120];
    rel["boundary"="administrative"]["admin_level"="{admin_level}"]({ctx.bbox_str});
    out geom;
    """
    try:
        elements = overpass_elements(query, STEP)
    except Exception as exc:  # noqa: BLE001
        log(STEP, f"admin level {admin_level} unavailable ({type(exc).__name__}: {exc})")
        return None
    rows = []
    for element in elements:
        if element.get("type") != "relation":
            continue
        name = (element.get("tags") or {}).get("name")
        geom = _relation_to_polygon(element)
        if name and geom is not None and not geom.is_empty:
            rows.append({"name": name, "geometry": geom})
    if not rows:
        return None
    return gpd.GeoDataFrame(rows, crs=config.WGS84)


def admin_polygons(ctx: CityContext) -> gpd.GeoDataFrame | None:
    """Admin levels 9 and 10. ``None`` when neither level can be fetched."""
    frames = [frame for level in ("9", "10") if (frame := _fetch_level(ctx, level)) is not None]
    if not frames:
        return None
    return gpd.GeoDataFrame(pd.concat(frames, ignore_index=True), crs=config.WGS84)
