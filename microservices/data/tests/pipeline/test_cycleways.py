"""Dedicated cycleways: tagging filter + per-hex overlay score."""

from __future__ import annotations

import json
from pathlib import Path

import geopandas as gpd
import pandas as pd
from shapely.geometry import LineString, Polygon

from pipeline.city import CityContext
from pipeline.export.score_scales import cycleway_density_score, cycleway_distance_score, cycleway_score
from pipeline.factors import cycleways as cycleways_factor
from pipeline.ingest.osm_data import is_dedicated_cycleway


def test_is_dedicated_cycleway_keeps_separated_ways():
    assert is_dedicated_cycleway({"highway": "cycleway"})
    assert is_dedicated_cycleway({"highway": "cycleway", "foot": "no"})
    assert is_dedicated_cycleway({"highway": "cycleway", "foot": "yes", "segregated": "yes"})
    assert is_dedicated_cycleway({"highway": "path", "bicycle": "designated", "segregated": "yes"})
    assert is_dedicated_cycleway({"highway": "residential", "cycleway": "track"})
    assert is_dedicated_cycleway({"highway": "tertiary", "cycleway:left": "track"})


def test_is_dedicated_cycleway_drops_lanes_and_shared_paths():
    assert not is_dedicated_cycleway({"highway": "residential", "cycleway": "lane"})
    assert not is_dedicated_cycleway({"highway": "residential", "cycleway": "shared_lane"})
    assert not is_dedicated_cycleway({"highway": "residential", "bicycle": "yes"})
    assert not is_dedicated_cycleway(
        {"highway": "cycleway", "foot": "designated", "segregated": "no"}
    )
    assert not is_dedicated_cycleway({"highway": "cycleway", "foot": "designated"})
    assert not is_dedicated_cycleway({"highway": "path", "bicycle": "designated"})
    assert not is_dedicated_cycleway({})


def test_cycleway_score_lights_up_hexes_with_paths():
    dense = cycleway_score(pd.Series([4.0]), pd.Series([0.0]))
    empty_far = cycleway_score(pd.Series([0.0]), pd.Series([1500.0]))
    nearby = cycleway_score(pd.Series([0.0]), pd.Series([80.0]))
    assert float(dense.iloc[0]) >= 80
    assert float(empty_far.iloc[0]) == 0
    assert 15 <= float(nearby.iloc[0]) <= 30
    assert float(cycleway_density_score(pd.Series([0.0])).iloc[0]) == 0
    assert float(cycleway_distance_score(pd.Series([0.0])).iloc[0]) == 100


def test_compute_scores_hex_that_contains_a_cycleway(tmp_path: Path):
    ctx = CityContext(
        slug="radtest",
        name="Radtest",
        center=(48.14, 11.57),
        bbox=(48.13, 11.56, 48.15, 11.58),
        base_dir=tmp_path / "radtest",
    )
    lat, lng = 48.14, 11.57
    size = 0.002
    cells = [
        {
            "h3_index": "hex_with",
            "geometry": Polygon(
                [
                    (lng - size, lat - size),
                    (lng + size, lat - size),
                    (lng + size, lat + size),
                    (lng - size, lat + size),
                ]
            ),
        },
        {
            "h3_index": "hex_far",
            "geometry": Polygon(
                [
                    (lng + 0.04 - size, lat + 0.04 - size),
                    (lng + 0.04 + size, lat + 0.04 - size),
                    (lng + 0.04 + size, lat + 0.04 + size),
                    (lng + 0.04 - size, lat + 0.04 + size),
                ]
            ),
        },
    ]
    gpd.GeoDataFrame(cells, crs="EPSG:4326").to_parquet(ctx.cache("grid.parquet"))
    ways = gpd.GeoDataFrame(
        [
            {
                "geometry": LineString([(lng - 0.001, lat), (lng + 0.001, lat)]),
                "highway": "cycleway",
                "kind": "cycleway",
                "foot": "",
                "segregated": "",
                "cycleway": "",
            }
        ],
        crs="EPSG:4326",
    )
    ways.to_parquet(ctx.cache("osm_cycleways.parquet"))

    out = cycleways_factor.compute(ctx).set_index("h3_index")
    assert float(out.loc["hex_with", "cycleway_length_m"]) > 0
    assert float(out.loc["hex_with", "s_cycleways"]) > float(out.loc["hex_far", "s_cycleways"])
    assert float(out.loc["hex_far", "cycleway_length_m"]) == 0
    assert float(out.loc["hex_with", "nearest_cycleway_m"]) < float(out.loc["hex_far", "nearest_cycleway_m"])


def test_write_overlay_geojson_emits_lines(tmp_path: Path):
    ctx = CityContext(
        slug="lines",
        name="Lines",
        center=(48.1, 11.5),
        bbox=(48.0, 11.4, 48.2, 11.6),
        base_dir=tmp_path / "lines",
    )
    ctx.cache_dir.mkdir(parents=True, exist_ok=True)
    gpd.GeoDataFrame(
        {
            "geometry": [LineString([(11.5, 48.1), (11.51, 48.11)])],
            "kind": ["cycleway"],
        },
        crs="EPSG:4326",
    ).to_parquet(ctx.cache("osm_cycleways.parquet"))

    cycleways_factor.write_overlay_geojson(ctx)
    overlay = json.loads((ctx.base_dir / "cycleways.geojson").read_text(encoding="utf-8"))
    assert overlay["features"][0]["geometry"]["type"] == "LineString"
    assert overlay["features"][0]["properties"]["kind"] == "cycleway"
