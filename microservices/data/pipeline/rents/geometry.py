"""Spatial joins that never fill a hex from a neighbour."""

from __future__ import annotations

import geopandas as gpd
import numpy as np
import pandas as pd
from shapely.geometry import box

from pipeline import config


def join_cell_rents(hexes: gpd.GeoDataFrame, cells: gpd.GeoDataFrame | None) -> pd.DataFrame:
    """Unweighted mean of published cells that intersect each hex.

    Hexes with no intersecting cell are absent. There is no nearest-cell fill.
    """
    columns = ["h3_index", "rent_eur_m2", "flagged"]
    if cells is None or cells.empty or hexes.empty:
        return pd.DataFrame(columns=columns)
    left = cells[["rent", "flagged", "geometry"]].copy()
    if left.crs is None:
        left = left.set_crs(config.WGS84)
    right = hexes[["h3_index", "geometry"]].copy()
    if right.crs is None:
        right = right.set_crs(config.WGS84)
    joined = gpd.sjoin(left, right, how="inner", predicate="intersects")
    if joined.empty:
        return pd.DataFrame(columns=columns)
    grouped = joined.groupby("h3_index", sort=False).agg(
        rent_eur_m2=("rent", "mean"),
        flagged=("flagged", "max"),
    )
    return grouped.reset_index()


def hexes_within(hexes: gpd.GeoDataFrame, polygons: gpd.GeoDataFrame | None) -> pd.DataFrame:
    """Hexes whose centroid lies in a polygon.

    Centroids outside every polygon are absent. No nearest-polygon fallback.
    """
    if polygons is None or polygons.empty or hexes.empty:
        return pd.DataFrame(columns=["h3_index"])
    metric = hexes.to_crs("EPSG:3035")
    points = gpd.GeoDataFrame(
        {"h3_index": hexes["h3_index"].astype(str).to_numpy()},
        geometry=metric.geometry.centroid,
        crs="EPSG:3035",
    ).to_crs(hexes.crs or config.WGS84)
    areas = polygons if polygons.crs is not None else polygons.set_crs(points.crs)
    if areas.crs != points.crs:
        areas = areas.to_crs(points.crs)
    joined = gpd.sjoin(points, areas, how="inner", predicate="intersects")
    if joined.empty:
        return joined
    return joined[~joined["h3_index"].duplicated(keep="first")].copy()


def squares_from_centroids(x: np.ndarray, y: np.ndarray) -> gpd.GeoSeries:
    """100 m INSPIRE squares around EPSG:3035 centroids, returned in WGS84."""
    if len(x) == 0:
        return gpd.GeoSeries([], crs="EPSG:3035").to_crs(config.WGS84)
    boxes = [
        box(float(xi) - 50.0, float(yi) - 50.0, float(xi) + 50.0, float(yi) + 50.0)
        for xi, yi in zip(x, y, strict=True)
    ]
    return gpd.GeoSeries(boxes, crs="EPSG:3035").to_crs(config.WGS84)
