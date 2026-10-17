"""Six-class cycle infrastructure: classification, GeoJSON kind/side, schema 2."""

from __future__ import annotations

import json
from pathlib import Path

import geopandas as gpd
import pytest
from shapely.geometry import LineString

from pipeline.city import CityContext
from pipeline.factors import cycleways as cycleways_factor
from pipeline.ingest.cycle_infra import (
    KIND_ADVISORY,
    KIND_EIGEN,
    KIND_LANE,
    KIND_MIXED,
    KIND_SHARED,
    KIND_TRACK,
    classify_cycle_infra,
    cycleways_cache_ready,
    fetch_and_store_cycle_infra,
    write_cycle_infra_geojson,
)


def _ctx(tmp_path: Path, slug: str = "radinfra") -> CityContext:
    return CityContext(
        slug=slug,
        name="Radinfra",
        center=(48.14, 11.57),
        bbox=(48.1, 11.5, 48.2, 11.6),
        base_dir=tmp_path / slug,
    )


@pytest.mark.parametrize(
    ("tags", "expected"),
    [
        ({"highway": "cycleway"}, [(KIND_EIGEN, "")]),
        ({"highway": "cycleway", "foot": "no"}, [(KIND_EIGEN, "")]),
        (
            {"highway": "cycleway", "foot": "designated", "segregated": "yes"},
            [(KIND_EIGEN, "")],
        ),
        (
            {"highway": "path", "bicycle": "designated", "segregated": "yes"},
            [(KIND_EIGEN, "")],
        ),
        (
            {"highway": "residential", "cycleway": "track"},
            [(KIND_TRACK, "left"), (KIND_TRACK, "right")],
        ),
        ({"highway": "tertiary", "cycleway:left": "track"}, [(KIND_TRACK, "left")]),
        (
            {"highway": "secondary", "cycleway:both": "track"},
            [(KIND_TRACK, "left"), (KIND_TRACK, "right")],
        ),
        (
            {"highway": "residential", "cycleway": "lane", "cycleway:lane": "exclusive"},
            [(KIND_LANE, "left"), (KIND_LANE, "right")],
        ),
        (
            {
                "highway": "residential",
                "cycleway:right": "lane",
                "cycleway:right:lane": "exclusive",
            },
            [(KIND_LANE, "right")],
        ),
        (
            {"highway": "residential", "cycleway": "lane", "cycleway:lane": "advisory"},
            [(KIND_ADVISORY, "left"), (KIND_ADVISORY, "right")],
        ),
        ({"highway": "cycleway", "foot": "designated"}, [(KIND_SHARED, "")]),
        (
            {"highway": "cycleway", "foot": "designated", "segregated": "no"},
            [(KIND_SHARED, "")],
        ),
        (
            {
                "highway": "path",
                "bicycle": "designated",
                "foot": "designated",
                "segregated": "no",
            },
            [(KIND_SHARED, "")],
        ),
        (
            {"highway": "footway", "bicycle": "designated"},
            [(KIND_SHARED, "")],
        ),
        (
            {"highway": "residential", "cycleway": "shared_lane"},
            [(KIND_MIXED, "left"), (KIND_MIXED, "right")],
        ),
        (
            {"highway": "primary", "cycleway:left": "share_busway"},
            [(KIND_MIXED, "left")],
        ),
        (
            {
                "highway": "primary",
                "cycleway:left": "track",
                "cycleway:right": "lane",
                "cycleway:right:lane": "advisory",
            },
            [(KIND_TRACK, "left"), (KIND_ADVISORY, "right")],
        ),
        ({"highway": "residential", "bicycle": "yes"}, []),
        ({"highway": "residential", "cycleway": "lane"}, [(KIND_LANE, "left"), (KIND_LANE, "right")]),
        (
            {"highway": "cycleway", "cycleway": "lane", "cycleway:lane": "exclusive"},
            [(KIND_EIGEN, "")],
        ),
    ],
)
def test_classify_cycle_infra(tags, expected):
    assert classify_cycle_infra(tags) == expected


def test_write_cycle_infra_geojson_emits_kind_and_side(tmp_path: Path):
    ctx = _ctx(tmp_path)
    gpd.GeoDataFrame(
        {
            "geometry": [
                LineString([(11.50, 48.14), (11.52, 48.14)]),
                LineString([(11.50, 48.15), (11.52, 48.15)]),
                LineString([(11.50, 48.15), (11.52, 48.15)]),
            ],
            "kind": [KIND_EIGEN, KIND_LANE, KIND_ADVISORY],
            "side": ["", "left", "right"],
            "label": ["Eigenständiger Radweg", "Radfahrstreifen", "Schutzstreifen"],
        },
        crs="EPSG:4326",
    ).pipe(lambda frame: write_cycle_infra_geojson(ctx, frame))

    overlay = json.loads((ctx.base_dir / "cycleways.geojson").read_text(encoding="utf-8"))
    props = [feature["properties"] for feature in overlay["features"]]
    assert props[0]["kind"] == KIND_EIGEN
    assert props[0]["side"] == ""
    assert props[1] == {"kind": KIND_LANE, "side": "left", "label": "Radfahrstreifen"}
    assert props[2]["kind"] == KIND_ADVISORY
    assert props[2]["side"] == "right"
    assert all(feature["geometry"]["type"] == "LineString" for feature in overlay["features"])

    meta = json.loads((ctx.base_dir / "cycleways.meta.json").read_text(encoding="utf-8"))
    assert meta["schema"] == 2
    assert meta["counts"][KIND_EIGEN] == 1
    assert meta["counts"][KIND_LANE] == 1
    assert meta["counts"][KIND_ADVISORY] == 1
    assert cycleways_cache_ready(ctx.base_dir)


def test_stale_schema_is_not_ready(tmp_path: Path):
    city = tmp_path / "alt"
    city.mkdir()
    (city / "cycleways.geojson").write_text(
        json.dumps({"type": "FeatureCollection", "features": []}),
        encoding="utf-8",
    )
    (city / "cycleways.meta.json").write_text(
        json.dumps({"schema": 1, "fetched_at": "2020-01-01T00:00:00+00:00", "counts": {}}),
        encoding="utf-8",
    )
    assert cycleways_cache_ready(city) is False


def test_missing_meta_is_not_ready(tmp_path: Path):
    city = tmp_path / "nometa"
    city.mkdir()
    (city / "cycleways.geojson").write_text(
        json.dumps(
            {
                "type": "FeatureCollection",
                "features": [
                    {
                        "type": "Feature",
                        "geometry": {"type": "LineString", "coordinates": [[11.5, 48.1], [11.51, 48.11]]},
                        "properties": {"kind": "cycleway"},
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    assert cycleways_cache_ready(city) is False


def test_schema_2_without_geojson_is_not_ready(tmp_path: Path):
    city = tmp_path / "nogeo"
    city.mkdir()
    (city / "cycleways.meta.json").write_text(json.dumps({"schema": 2}), encoding="utf-8")
    assert cycleways_cache_ready(city) is False


def test_fetch_and_store_writes_kind_side_and_leaves_score_cache(tmp_path: Path, monkeypatch):
    elements = [
        {
            "type": "way",
            "tags": {"highway": "cycleway"},
            "geometry": [{"lon": 11.50, "lat": 48.14}, {"lon": 11.52, "lat": 48.14}],
        },
        {
            "type": "way",
            "tags": {
                "highway": "residential",
                "cycleway:left": "lane",
                "cycleway:left:lane": "exclusive",
                "cycleway:right": "lane",
                "cycleway:right:lane": "advisory",
            },
            "geometry": [{"lon": 11.50, "lat": 48.15}, {"lon": 11.53, "lat": 48.15}],
        },
        {
            "type": "way",
            "tags": {"highway": "residential", "cycleway": "shared_lane"},
            "geometry": [{"lon": 11.50, "lat": 48.16}, {"lon": 11.51, "lat": 48.16}],
        },
    ]
    monkeypatch.setattr("pipeline.ingest.cycle_infra._overpass_elements", lambda _query: elements)
    ctx = _ctx(tmp_path, "stored")
    score = ctx.cache("osm_cycleways.parquet")
    score.write_bytes(b"original-score-cache")

    meta = fetch_and_store_cycle_infra(ctx)

    assert score.read_bytes() == b"original-score-cache"
    assert (ctx.cache_dir / "osm_cycle_infra.parquet").is_file()
    assert meta["schema"] == 2
    overlay = json.loads((ctx.base_dir / "cycleways.geojson").read_text(encoding="utf-8"))
    pairs = {(feature["properties"]["kind"], feature["properties"]["side"]) for feature in overlay["features"]}
    assert (KIND_EIGEN, "") in pairs
    assert (KIND_LANE, "left") in pairs
    assert (KIND_ADVISORY, "right") in pairs
    assert (KIND_MIXED, "left") in pairs
    assert (KIND_MIXED, "right") in pairs
    assert cycleways_cache_ready(ctx.base_dir)
    assert "overpass fetch cycle infra" not in score.read_text(encoding="utf-8", errors="ignore")


def test_score_export_does_not_downgrade_schema_2(tmp_path: Path):
    ctx = _ctx(tmp_path, "keep")
    gpd.GeoDataFrame(
        {
            "geometry": [LineString([(11.50, 48.14), (11.52, 48.14)])],
            "kind": [KIND_LANE],
            "side": ["left"],
        },
        crs="EPSG:4326",
    ).pipe(lambda frame: write_cycle_infra_geojson(ctx, frame))
    original = (ctx.base_dir / "cycleways.geojson").read_text(encoding="utf-8")
    gpd.GeoDataFrame(
        {
            "geometry": [LineString([(11.40, 48.10), (11.41, 48.11)])],
            "kind": ["cycleway"],
        },
        crs="EPSG:4326",
    ).to_parquet(ctx.cache("osm_cycleways.parquet"))

    cycleways_factor.write_overlay_geojson(ctx)

    assert (ctx.base_dir / "cycleways.geojson").read_text(encoding="utf-8") == original
    assert cycleways_cache_ready(ctx.base_dir)


def test_score_export_writes_schema_2_from_infra_cache(tmp_path: Path):
    ctx = _ctx(tmp_path, "frominfra")
    gpd.GeoDataFrame(
        {
            "geometry": [LineString([(11.50, 48.14), (11.52, 48.14)])],
            "kind": [KIND_TRACK],
            "side": ["right"],
        },
        crs="EPSG:4326",
    ).to_parquet(ctx.cache("osm_cycle_infra.parquet"))

    cycleways_factor.write_overlay_geojson(ctx)

    overlay = json.loads((ctx.base_dir / "cycleways.geojson").read_text(encoding="utf-8"))
    assert overlay["features"][0]["properties"]["kind"] == KIND_TRACK
    assert overlay["features"][0]["properties"]["side"] == "right"
    assert cycleways_cache_ready(ctx.base_dir)
