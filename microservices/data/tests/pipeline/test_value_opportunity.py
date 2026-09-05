"""Unit tests for Value Opportunity Index v1.2."""

from __future__ import annotations

import numpy as np
import pandas as pd

from pipeline.export.value_opportunity import (
    compute_value_opportunity,
    fair_rent_range,
    fair_rent_score,
    location_premium_score,
    residential_quality_score,
)


def _fake_city(n: int = 80) -> pd.DataFrame:
    rng = np.random.default_rng(42)
    living = np.linspace(20, 90, n)
    # Market rent loosely tracks living but with bargains at the top.
    rent = 12 + living * 0.18 + rng.normal(0, 1.2, n)
    rent[n - 5 : n] -= 6
    rent[:10] -= 4
    res = np.where(living >= 50, 0.55, 0.02)
    res[n - 5 : n] = 0.75
    return pd.DataFrame(
        {
            "h3_index": [f"cell{i}" for i in range(n)],
            "s_living": living,
            "s_center": living * 0.9,
            "s_center_strict": living * 0.85,
            "s_transit": living * 0.85,
            "s_daily_life": living * 0.95,
            "s_green": 50 + rng.normal(0, 10, n),
            "s_walk": living * 0.8,
            "s_business": living * 0.7,
            "dl_education": living * 0.6,
            "dl_restaurants_cafes": living * 0.5,
            "dn_school_avail": np.where(res >= 0.3, 90, 10),
            "dn_supermarket_avail": np.where(res >= 0.3, 90, 10),
            "dn_pharmacy_avail": np.where(res >= 0.3, 85, 5),
            "dn_restaurant_avail": np.where(living > 70, 80, 20),
            "rent_eur_m2": rent.clip(8, 40),
            "rent_confidence": "medium",
            "landuse_residential_share": res,
            "landuse_commercial_share": np.where(res < 0.1, 0.5, 0.05),
            "urban_activity": np.where(res < 0.1, 200, 40),
            "building_count": np.where(res >= 0.3, 80, 5),
            "population_density": np.where(res >= 0.3, 4000, 200),
            "housing_quality_score": np.where(res >= 0.3, 70, 30),
        }
    )


def test_cheap_poor_not_highlighted():
    df = compute_value_opportunity(_fake_city(), city_type="METROPOLIS", neighbor_k=1)
    poor = df[df["s_living"] < 45]
    assert (~poor["voi_class"].isin(["hidden_gem", "good_value"])).all()


def test_high_quality_bargain_can_be_gem():
    df = compute_value_opportunity(_fake_city(), city_type="METROPOLIS", neighbor_k=1)
    gems = df[df["voi_class"] == "hidden_gem"]
    assert len(gems) >= 1
    assert gems["s_living"].min() >= 60
    assert gems["s_residential_quality"].min() >= 50
    assert gems["voi_adjusted_price_gap"].min() >= 0.05
    assert (gems["voi_confidence"] != "low").all()


def test_industrial_fails_residential_gate():
    df = _fake_city()
    i = len(df) - 1
    df.loc[i, "s_living"] = 85
    df.loc[i, "rent_eur_m2"] = 14
    df.loc[i, "landuse_residential_share"] = 0.0
    df.loc[i, "landuse_commercial_share"] = 0.6
    df.loc[i, "urban_activity"] = 400
    df.loc[i, "building_count"] = 2
    df.loc[i, "population_density"] = 50
    out = compute_value_opportunity(df, city_type="METROPOLIS", neighbor_k=1)
    assert out.loc[i, "s_residential_quality"] < 50
    assert out.loc[i, "voi_class"] not in {"hidden_gem", "good_value"}


def test_fair_rent_not_market_clone():
    base = _fake_city()
    score = fair_rent_score(base, city_type="METROPOLIS")
    lo, med, hi = fair_rent_range(score, base["rent_eur_m2"], city_type="METROPOLIS")
    actual = base["rent_eur_m2"].astype(float)
    # Means may differ — fair model must not perfectly track market.
    corr = float(np.corrcoef(med.to_numpy(), actual.to_numpy())[0, 1])
    assert corr < 0.98
    assert (hi >= med).all()
    assert (med >= lo).all()


def test_location_premium_shields_central_core():
    base = _fake_city()
    # Extreme rent on highest-centrality cell with strong premium drivers.
    i = int(base["s_center"].idxmax())
    base.loc[i, "rent_eur_m2"] = float(base["rent_eur_m2"].max()) + 20
    base.loc[i, "s_living"] = 85
    base.loc[i, "s_center"] = 95
    base.loc[i, "s_center_strict"] = 95
    base.loc[i, "s_business"] = 90
    base.loc[i, "dl_education"] = 90
    base.loc[i, "dl_restaurants_cafes"] = 90
    out = compute_value_opportunity(base, city_type="METROPOLIS", neighbor_k=1)
    assert out.loc[i, "voi_location_premium"] >= 70
    # High premium should prevent overpriced classification.
    assert out.loc[i, "voi_class"] != "overpriced"


def test_exports_v12_fields():
    df = compute_value_opportunity(_fake_city(), city_type="LARGE_CITY", neighbor_k=1)
    for col in (
        "s_value_opportunity",
        "voi_class",
        "voi_confidence",
        "voi_fair_rent_min",
        "voi_fair_rent_max",
        "voi_fair_rent_median",
        "voi_adjusted_price_gap",
        "voi_location_premium",
        "voi_local_value_advantage",
        "voi_gem_strength",
        "voi_explain",
        "s_residential_quality",
    ):
        assert col in df.columns


def test_adaptive_hidden_gem_threshold_small_city():
    metro = compute_value_opportunity(_fake_city(), city_type="METROPOLIS", neighbor_k=1)
    small = compute_value_opportunity(_fake_city(), city_type="SMALL_CITY", neighbor_k=1)
    # Same synthetic city → SMALL_CITY allows a wider top slice.
    assert (small["voi_class"] == "hidden_gem").sum() >= (metro["voi_class"] == "hidden_gem").sum()


def test_residential_quality_rewards_housing_fabric():
    df = _fake_city()
    rq = residential_quality_score(df)
    assert (
        rq[df["landuse_residential_share"] >= 0.5].mean() > rq[df["landuse_residential_share"] < 0.05].mean()
    )


def test_living_score_unchanged():
    base = _fake_city()
    before = base["s_living"].copy()
    out = compute_value_opportunity(base, city_type="LARGE_CITY", neighbor_k=1)
    assert np.allclose(out["s_living"], before)


def test_location_premium_score_range():
    prem = location_premium_score(_fake_city())
    assert prem.min() >= 0
    assert prem.max() <= 100
