"""Unit checks for Match Score base scales."""

from __future__ import annotations

import pandas as pd

from pipeline import config
from pipeline.export.score_scales import (
    center_exponential_score,
    centrality_index,
    green_park_area_soft,
    green_quality_score,
    walk_minute_band_score,
)


def test_walk_minute_bands():
    s = walk_minute_band_score(pd.Series([5, 10, 15, 20, 25]))
    assert float(s.iloc[0]) == 100
    assert float(s.iloc[1]) == 70
    assert float(s.iloc[2]) == 30
    assert float(s.iloc[3]) == 0
    assert float(s.iloc[4]) == 0


def test_center_decay_anchors():
    # Best-fit decay ~7.2: 1→~87, 5→~50, 15→~12
    s = center_exponential_score(pd.Series([1.0, 5.0, 15.0]), decay_km=config.CENTER_DECAY_KM)
    assert 80 <= float(s.iloc[0]) <= 95
    assert 45 <= float(s.iloc[1]) <= 55
    assert 5 <= float(s.iloc[2]) <= 20


def test_match_infra_weights_sum():
    assert abs(sum(config.MATCH_INFRASTRUCTURE_GROUP_WEIGHTS.values()) - 1.0) < 1e-9


def test_wq_weights_sum():
    assert abs(sum(config.WALKING_QUALITY_WEIGHTS.values()) - 1.0) < 1e-9


def test_green_quality_weights():
    n = 3
    score = green_quality_score(
        pd.Series([20.0] * n),
        pd.Series([200.0] * n),
        pd.Series([15.0] * n),
        pd.Series([3.0] * n),
        pd.Series([400.0] * n),
    )
    assert all(0 <= v <= 100 for v in score)


def test_large_parks_score_full_park_quality():
    s = green_park_area_soft(pd.Series([0.5, 25.0, 100.0, 393.0]))
    assert float(s.iloc[0]) < 15
    assert float(s.iloc[1]) == 100
    assert float(s.iloc[2]) == 100
    assert float(s.iloc[3]) == 100


def test_green_quality_without_canopy_near_large_park():
    """City-wide zero canopy must not keep park-adjacent hexes in the yellow band."""
    n = 5
    score = green_quality_score(
        pd.Series([12.0] * n),
        pd.Series([40.0] * n),
        pd.Series([0.0] * n),
        pd.Series([50.0] * n),
        pd.Series([800.0] * n),
    )
    assert all(float(v) >= 70 for v in score)


def test_green_quality_empty_city_is_the_3_6_floor():
    score = green_quality_score(
        pd.Series([0.0]),
        pd.Series([2000.0]),
        pd.Series([0.0]),
        pd.Series([0.0]),
        pd.Series([2000.0]),
    )
    assert float(score.iloc[0]) == 3.6


def test_centrality_weights_proximity():
    s = centrality_index(pd.Series([100.0, 50.0]), pd.Series([0.0, 100.0]))
    assert float(s.iloc[0]) == 80.0
    assert float(s.iloc[1]) == 60.0
