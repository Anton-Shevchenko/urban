"""Daily-needs walk times and in-hex amenity counts."""

from __future__ import annotations

import geopandas as gpd
from shapely.geometry import Point, Polygon

from pipeline.factors.daily_needs import _count_pois_in_hex


def test_count_pois_in_hex_counts_centroids_inside_each_cell():
    hexes = gpd.GeoDataFrame(
        {
            "h3_index": ["a", "b"],
            "geometry": [
                Polygon([(0, 0), (1, 0), (1, 1), (0, 1)]),
                Polygon([(2, 0), (3, 0), (3, 1), (2, 1)]),
            ],
        },
        crs="EPSG:4326",
    )
    pois = gpd.GeoDataFrame(
        {"geometry": [Point(0.5, 0.5), Point(0.6, 0.6), Point(2.5, 0.5)]},
        crs="EPSG:4326",
    )
    counts = _count_pois_in_hex(hexes, pois)
    assert list(counts) == [2, 1]


def test_count_pois_in_hex_empty_layer_is_zeros():
    hexes = gpd.GeoDataFrame(
        {
            "h3_index": ["a"],
            "geometry": [Polygon([(0, 0), (1, 0), (1, 1), (0, 1)])],
        },
        crs="EPSG:4326",
    )
    pois = gpd.GeoDataFrame({"geometry": []}, crs="EPSG:4326")
    assert list(_count_pois_in_hex(hexes, pois)) == [0]
