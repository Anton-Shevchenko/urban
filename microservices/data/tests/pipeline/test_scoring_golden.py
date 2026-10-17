"""Same hex inputs must produce the frozen pillar scores.

The frontend does not refit these curves. It reads the numbers this test locks.
"""

from __future__ import annotations

import json
from pathlib import Path

import pandas as pd

from pipeline import config
from pipeline.export.score_scales import (
    daily_life_from_groups,
    green_quality_score,
    living_score_composite,
    noise_quiet_score,
    rent_kalt_lenient,
)

FIXTURE = Path(__file__).resolve().parents[4] / "contracts" / "fixtures" / "scoring_golden.json"
GROUP_FIELDS = {
    "dl_food": "food",
    "dl_health": "health",
    "dl_education": "education",
    "dl_services": "services",
    "dl_restaurants_cafes": "restaurants_cafes",
    "dl_other": "other",
}


def _fixture() -> dict:
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


def _scored(fixture: dict) -> pd.DataFrame:
    raw = pd.DataFrame([hex_["raw"] for hex_ in fixture["hexes"]])
    groups = {name: raw[field] for field, name in GROUP_FIELDS.items()}
    daily = daily_life_from_groups(groups, config.DAILY_LIFE_GROUP_WEIGHTS)
    rent = rent_kalt_lenient(raw["rent_eur_m2"])
    quiet = noise_quiet_score(raw["noise_db"])
    green = green_quality_score(
        raw["green_share_inside_500m"],
        raw["nearest_park_dist_m"],
        raw["tree_canopy_pct"],
        raw["nearest_park_area_ha"],
        raw["dist_water_m"],
    )
    living = living_score_composite(
        {
            "daily_life": daily,
            "walk": raw["s_walk"],
            "green": green,
            "transit": raw["s_transit"],
            "quiet": quiet,
            "housing_affordability": rent,
        },
        config.LIVING_SCORE_WEIGHTS,
    )
    return pd.DataFrame(
        {
            "s_housing_affordability": rent,
            "s_quiet": quiet,
            "s_green": green,
            "s_daily_life": daily,
            "s_living": living,
        }
    )


def test_golden_hexes_match_pipeline_curves():
    fixture = _fixture()
    scored = _scored(fixture)
    for i, hex_ in enumerate(fixture["hexes"]):
        for key, expected in hex_["expected"].items():
            assert float(scored[key].iloc[i]) == expected, f"{hex_['id']} {key}"


def test_rent_at_8_and_12_eur_scores_100():
    fixture = _fixture()
    scored = _scored(fixture)
    by_id = {hex_["id"]: i for i, hex_ in enumerate(fixture["hexes"])}
    for hex_id in ("cheap", "twelve"):
        row = fixture["hexes"][by_id[hex_id]]
        assert row["raw"]["rent_eur_m2"] in (8, 12)
        assert float(scored["s_housing_affordability"].iloc[by_id[hex_id]]) == 100
