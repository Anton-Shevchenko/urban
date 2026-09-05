"""Green ingest + factor: empty OSM parks must not freeze a city at 3.6."""

from __future__ import annotations

from pathlib import Path

import geopandas as gpd
import pandas as pd
from shapely.geometry import Polygon

from pipeline import config
from pipeline.city import CityContext
from pipeline.common import empty_gdf
from pipeline.export.score_scales import green_quality_score
from pipeline.factors import green as green_factor
from pipeline.ingest import osm_data


def _square_way(coords: list[tuple[float, float]]) -> dict:
    return {"type": "way", "geometry": [{"lon": x, "lat": y} for x, y in coords]}


def test_overpass_way_and_relation_become_polygons():
    closed = [(12.0, 47.8), (12.01, 47.8), (12.01, 47.81), (12.0, 47.81), (12.0, 47.8)]
    way = osm_data._geom_from_element(_square_way(closed))
    assert way is not None and way.geom_type == "Polygon"
    assert way.area > 0

    relation = {
        "type": "relation",
        "members": [
            {
                "type": "way",
                "role": "outer",
                "geometry": [
                    {"lon": 12.0, "lat": 47.8},
                    {"lon": 12.02, "lat": 47.8},
                    {"lon": 12.02, "lat": 47.82},
                ],
            },
            {
                "type": "way",
                "role": "outer",
                "geometry": [
                    {"lon": 12.02, "lat": 47.82},
                    {"lon": 12.0, "lat": 47.82},
                    {"lon": 12.0, "lat": 47.8},
                ],
            },
        ],
    }
    poly = osm_data._geom_from_element(relation)
    assert poly is not None and not poly.is_empty
    assert poly.geom_type in ("Polygon", "MultiPolygon")
    assert poly.area > 0


def test_missing_green_inputs_score_the_rosenheim_constant():
    """2000 m fill-in + 0 share + 0 canopy is 3.6 after green_quality_score."""
    n = 4
    score = green_quality_score(
        pd.Series([0.0] * n),
        pd.Series([2000.0] * n),
        pd.Series([0.0] * n),
        pd.Series([0.0] * n),
        pd.Series([2000.0] * n),
    )
    assert all(float(v) == 3.6 for v in score)


def test_factor_green_uses_landuse_when_osm_parks_are_empty(tmp_path: Path):
    ctx = CityContext(
        slug="greenstadt",
        name="Greenstadt",
        center=(47.85, 12.12),
        bbox=(47.84, 12.11, 47.86, 12.13),
        base_dir=tmp_path / "greenstadt",
    )
    lat, lng = 47.85, 12.12
    size = 0.002
    hex_poly = Polygon(
        [
            (lng - size, lat - size),
            (lng + size, lat - size),
            (lng + size, lat + size),
            (lng - size, lat + size),
        ]
    )
    far_poly = Polygon(
        [
            (lng + 0.04, lat + 0.04),
            (lng + 0.042, lat + 0.04),
            (lng + 0.042, lat + 0.042),
            (lng + 0.04, lat + 0.042),
        ]
    )
    gpd.GeoDataFrame(
        [
            {"h3_index": "near", "geometry": hex_poly},
            {"h3_index": "far", "geometry": far_poly},
        ],
        crs=config.WGS84,
    ).to_parquet(ctx.cache(config.GRID_FILE))

    empty_gdf().to_parquet(ctx.cache(config.OSM_GREEN_FILE))
    empty_gdf().to_parquet(ctx.cache(config.OSM_WATER_FILE))
    empty_gdf().to_parquet(ctx.cache("osm_trees.parquet"))

    forest = Polygon(
        [
            (lng - 0.0004, lat - 0.0004),
            (lng + 0.0004, lat - 0.0004),
            (lng + 0.0004, lat + 0.0004),
            (lng - 0.0004, lat + 0.0004),
        ]
    )
    gpd.GeoDataFrame(
        [{"landuse": "forest", "geometry": forest}, {"landuse": "industrial", "geometry": far_poly}],
        crs=config.WGS84,
    ).to_parquet(ctx.cache(config.OSM_LANDUSE_FILE))

    out = green_factor.compute(ctx)
    by_h3 = out.set_index("h3_index")
    assert float(by_h3.loc["near", "nearest_park_dist_m"]) < 200
    assert float(by_h3.loc["far", "nearest_park_dist_m"]) > 500
    assert float(by_h3.loc["near", "green_share_inside_500m"]) > 0
