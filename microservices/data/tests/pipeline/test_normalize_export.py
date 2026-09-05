"""Round-trip: factor caches -> normalize_export -> servable hexes.geojson."""

from __future__ import annotations

import json

import pytest

from pipeline import cache_status, contract
from pipeline.export import normalize_export
from pipeline.generated import contract as generated
from tests.fixtures import HEX_COUNT, build_fixture_city


@pytest.fixture(scope="module")
def exported(tmp_path_factory) -> dict:
    ctx = build_fixture_city(tmp_path_factory.mktemp("cities"))
    normalize_export.main(ctx)
    data = json.loads(ctx.out_geojson.read_text(encoding="utf-8"))
    return {"ctx": ctx, "data": data}


def test_export_writes_one_feature_per_hex(exported):
    data = exported["data"]
    assert data["type"] == "FeatureCollection"
    assert len(data["features"]) == HEX_COUNT
    assert data["meta"]["count"] == HEX_COUNT


def test_exported_features_satisfy_the_contract(exported):
    assert contract.validate_features(exported["data"]["features"]) == []


def test_export_meta_carries_current_versions(exported):
    meta = exported["data"]["meta"]
    assert meta["pipeline_version"] == generated.PIPELINE_VERSION
    assert meta["score_method_version"] == generated.SCORE_METHOD_VERSION
    assert meta["living_score_weights"] == generated.OBJECTIVE_WEIGHTS


def test_every_consumer_property_is_present(exported):
    props = exported["data"]["features"][0]["properties"]
    for consumer, keys in generated.CONSUMER_HEX_PROPERTIES.items():
        missing = [k for k in keys if k not in props]
        assert not missing, f"{consumer} reads properties the export omits: {missing}"


def test_scores_stay_in_range_and_vary(exported):
    living = [f["properties"]["s_living"] for f in exported["data"]["features"]]
    assert all(0 <= v <= 100 for v in living)
    # A gradient in every input must produce a gradient in the output; a flat
    # column here would mean the merge silently dropped the factor frames.
    assert max(living) - min(living) > 5


def test_round_trip_is_accepted_as_a_current_cache(exported):
    ok, reason = cache_status.is_cache_current(exported["ctx"].base_dir)
    assert ok, reason


def test_export_writes_parquet_and_stats_sidecars(exported):
    ctx = exported["ctx"]
    assert (ctx.base_dir / "hexes.parquet").is_file()
    stats = json.loads((ctx.base_dir / "city-stats.json").read_text(encoding="utf-8"))
    assert stats["count"] == HEX_COUNT
    assert stats["pipeline_version"] == generated.PIPELINE_VERSION
    assert "s_living" in stats


def test_export_is_reproducible(exported):
    ctx = exported["ctx"]
    first = ctx.out_geojson.read_text(encoding="utf-8")
    normalize_export.main(ctx)
    assert ctx.out_geojson.read_text(encoding="utf-8") == first
