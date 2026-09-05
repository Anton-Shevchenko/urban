"""The pipeline must never disagree with contracts/*.json."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest

from pipeline import cache_status, config, contract
from pipeline.generated import contract as generated

REPO_ROOT = Path(__file__).resolve().parents[4]
CONTRACTS_DIR = REPO_ROOT / "contracts"


def test_config_weights_come_from_contract():
    for pillar, weight in generated.OBJECTIVE_WEIGHTS.items():
        assert config.LIVING_SCORE_WEIGHTS[pillar] == weight
    for alias, target in generated.OBJECTIVE_WEIGHT_ALIASES.items():
        assert config.LIVING_SCORE_WEIGHTS[alias] == generated.OBJECTIVE_WEIGHTS[target]
    for pillar, weight in generated.INFORMATIONAL_PILLARS.items():
        assert config.LIVING_SCORE_WEIGHTS[pillar] == weight


def test_objective_weights_sum_to_one():
    assert abs(sum(generated.OBJECTIVE_WEIGHTS.values()) - 1.0) < 1e-9


def test_daily_life_tables_agree_with_contract():
    # The pipeline writes dl_other where the contract calls the group "leisure".
    assert set(config.DAILY_LIFE_GROUP_WEIGHTS) == set(config.DAILY_LIFE_CATEGORY_WEIGHTS)
    assert abs(sum(config.DAILY_LIFE_GROUP_WEIGHTS.values()) - 1.0) < 1e-9
    for group, categories in config.DAILY_LIFE_CATEGORY_WEIGHTS.items():
        assert abs(sum(categories.values()) - 1.0) < 1e-9, group
    assert set(config.DAILY_LIFE_AMENITIES) == {
        amenity for categories in config.DAILY_LIFE_CATEGORY_WEIGHTS.values() for amenity in categories
    }
    assert "park" not in config.DAILY_LIFE_AMENITIES


def test_walk_bands_come_from_contract():
    from pipeline.export.score_scales import walk_minute_band_score

    for minutes, expected in generated.WALK_MINUTE_BANDS["default"]:
        assert float(walk_minute_band_score(float(minutes)).iloc[0]) == pytest.approx(expected)


def test_pipeline_version_tracks_schema():
    assert config.PIPELINE_SCHEMA_VERSION == generated.PIPELINE_VERSION
    assert config.SCORE_METHOD_VERSION == generated.SCORE_METHOD_VERSION


def test_consumer_properties_are_declared():
    declared = set(generated.DECLARED_HEX_PROPERTIES)
    for consumer, keys in generated.CONSUMER_HEX_PROPERTIES.items():
        missing = sorted(set(keys) - declared)
        assert not missing, f"{consumer} reads undeclared properties: {missing}"


def _valid_props() -> dict:
    return dict.fromkeys(generated.REQUIRED_HEX_PROPERTIES, 50.0) | {"h3": "891f1d4894bffff"}


def test_validator_accepts_a_complete_feature():
    assert contract.validate_feature_properties(_valid_props()) == []


def test_validator_reports_missing_required_property():
    props = _valid_props()
    del props["s_living"]
    errors = contract.validate_feature_properties(props)
    assert any("s_living" in e and "required" in e for e in errors)


def test_validator_reports_out_of_range_score():
    props = _valid_props() | {"s_living": 140.0}
    assert any("maximum" in e for e in contract.validate_feature_properties(props))


def test_validator_reports_wrong_type():
    props = _valid_props() | {"h3": 12}
    assert any("h3" in e for e in contract.validate_feature_properties(props))


def test_validator_reports_unknown_enum_value():
    props = _valid_props() | {"voi_class": "bargain"}
    assert any("voi_class" in e for e in contract.validate_feature_properties(props))


def test_pattern_properties_are_checked():
    props = _valid_props() | {"dl_food": "not a number"}
    assert any("dl_food" in e for e in contract.validate_feature_properties(props))


def test_cache_status_rejects_stale_pipeline_version():
    data = {
        "meta": {
            "has_rent": True,
            "rent_source": "mietspiegel",
            "city_type": "METROPOLIS",
            "pipeline_version": generated.PIPELINE_VERSION - 1,
        },
        "features": [{"properties": _valid_props()}],
    }
    assert "stale pipeline_version" in (cache_status._geojson_reason(data) or "")


def test_cache_status_rejects_stale_score_method():
    data = {
        "meta": {
            "has_rent": True,
            "rent_source": "mietspiegel",
            "city_type": "METROPOLIS",
            "pipeline_version": generated.PIPELINE_VERSION,
            "score_method_version": "objective-v1",
        },
        "features": [{"properties": _valid_props()}],
    }
    assert "stale score_method_version" in (cache_status._geojson_reason(data) or "")


def test_cache_status_rejects_non_living_score_product():
    data = _ready_city_payload({"dn_supermarket_min": 6.5, "s_daily_life": 72.0})
    data["meta"]["product"] = "price-map"
    reason = cache_status._geojson_reason(data)
    assert reason and "stale product" in reason
    assert "price-map" in reason


def _ready_city_payload(props: dict, n: int = 8) -> dict:
    served = {
        "rent_eur_m2": 18.0,
        "s_rent_relative_city": 50.0,
        "s_rent_absolute": 50.0,
        "data_quality": "high",
        "s_value_opportunity": 40.0,
        "voi_class": "normal",
        "voi_confidence": "high",
    }
    full = {**_valid_props(), **served, **props}
    return {
        "meta": {
            "has_rent": True,
            "rent_source": "mietspiegel",
            "city_type": "METROPOLIS",
            "pipeline_version": generated.PIPELINE_VERSION,
            "score_method_version": generated.SCORE_METHOD_VERSION,
        },
        "features": [{"properties": dict(full)} for _ in range(n)],
    }


def test_cache_status_rejects_daily_needs_sentinel():
    props = _valid_props() | {"dn_supermarket_min": 99.0, "s_daily_life": 0.0}
    reason = cache_status._geojson_reason(_ready_city_payload(props))
    assert reason and "99 sentinel" in reason


def test_cache_status_accepts_real_daily_needs_walk_times():
    props = _valid_props() | {"dn_supermarket_min": 6.5, "s_daily_life": 72.0}
    assert cache_status._geojson_reason(_ready_city_payload(props)) is None


def test_empty_daily_needs_osm_cache_is_detected(tmp_path):
    import pandas as pd

    pd.DataFrame({"category": pd.Series(dtype=str)}).to_parquet(
        tmp_path / config.OSM_DAILY_NEEDS_FILE,
    )
    assert cache_status._empty_daily_needs_cache(tmp_path) == (f"empty {config.OSM_DAILY_NEEDS_FILE} cache")


@pytest.mark.skipif(not CONTRACTS_DIR.is_dir(), reason="contracts/ not available")
def test_generated_python_matches_contract_sources():
    """Fails when someone edits pipeline/generated/contract.py by hand."""
    spec = importlib.util.spec_from_file_location("_codegen", CONTRACTS_DIR / "codegen.py")
    assert spec and spec.loader
    codegen = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(codegen)

    scoring = json.loads((CONTRACTS_DIR / "scoring.json").read_text(encoding="utf-8"))
    schema = json.loads((CONTRACTS_DIR / "hex-properties.schema.json").read_text(encoding="utf-8"))
    metrics = json.loads((CONTRACTS_DIR / "metrics.json").read_text(encoding="utf-8"))
    codegen.check_contract(scoring, schema, metrics)

    on_disk = (REPO_ROOT / "microservices" / "data" / "pipeline" / "generated" / "contract.py").read_text(
        encoding="utf-8"
    )
    assert on_disk == codegen.render_python(scoring, schema, metrics), (
        "pipeline/generated/contract.py is stale — run `python contracts/codegen.py`"
    )


def test_pipeline_registry_matches_run_steps():
    from pipeline import run

    assert [name for name, _ in run.STEPS] == [step["label"] for step in generated.PIPELINE_STEPS]
    assert run.WAVES == [list(wave) for wave in generated.PIPELINE_WAVES]
    assert cache_status._REQUIRED_CACHE == set(generated.REQUIRED_CACHE_FILES)
