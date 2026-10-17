"""EPA-shaped walkability from columns the pipeline already has."""

from __future__ import annotations

import pandas as pd

from pipeline.export.score_scales import WALKABILITY_WEIGHTS, walkability_index


def _grid() -> pd.DataFrame:
    """A short-block mixed hex next to a long-block residential hex with no transit."""
    return pd.DataFrame(
        {
            "intersection_density": [180.0, 8.0],
            "mean_block_length_m": [40.0, 280.0],
            "transit_distance_score": [95.0, 0.0],
            "landuse_residential_share": [0.34, 0.85],
            "landuse_commercial_share": [0.33, 0.0],
            "population_density": [14000.0, 500.0],
        }
    )


def test_walkability_weights_sum_to_one():
    assert abs(sum(WALKABILITY_WEIGHTS.values()) - 1.0) < 1e-9


def test_walkable_grid_beats_sparse_residential():
    out = walkability_index(_grid())
    assert float(out["s_walkability"].iloc[0]) > float(out["s_walkability"].iloc[1]) + 25
    assert float(out["wb_connectivity"].iloc[0]) > float(out["wb_connectivity"].iloc[1])
    assert float(out["wb_transit"].iloc[1]) == 0.0
    assert all(0 <= float(v) <= 100 for v in out["s_walkability"])


def test_even_three_way_landuse_scores_full_diversity():
    out = walkability_index(
        pd.DataFrame(
            {
                "landuse_residential_share": [1 / 3],
                "landuse_commercial_share": [1 / 3],
            }
        )
    )
    assert float(out["wb_diversity"].iloc[0]) == 100.0


def test_sparse_landuse_falls_back_to_daily_life_groups():
    shared = {
        "intersection_density": [80.0, 80.0],
        "mean_block_length_m": [90.0, 90.0],
        "transit_distance_score": [50.0, 50.0],
        "landuse_residential_share": [0.6, 0.6],
        "landuse_commercial_share": [0.0, 0.0],
        "population_density": [4000.0, 4000.0],
    }
    groups = ("dl_food", "dl_health", "dl_education", "dl_services", "dl_restaurants_cafes", "dl_other")
    covered = {name: [80.0, 10.0] for name in groups}
    out = walkability_index(pd.DataFrame({**shared, **covered}))
    assert float(out["wb_diversity"].iloc[0]) == 100.0
    assert float(out["wb_diversity"].iloc[1]) == 0.0
    assert float(out["s_walkability"].iloc[0]) > float(out["s_walkability"].iloc[1])


def test_missing_component_is_dropped_instead_of_scored_as_zero():
    full = _grid().iloc[[0]].reset_index(drop=True)
    full["transit_distance_score"] = 0.0
    dropped = full.drop(columns=["transit_distance_score"])
    with_zero = walkability_index(full)
    without = walkability_index(dropped)
    assert float(with_zero["wb_transit"].iloc[0]) == 0.0
    assert pd.isna(without["wb_transit"].iloc[0])
    assert float(without["s_walkability"].iloc[0]) > float(with_zero["s_walkability"].iloc[0])


def test_no_inputs_leaves_the_score_empty():
    out = walkability_index(pd.DataFrame({"h3_index": ["a", "b"]}))
    assert out["s_walkability"].isna().all()
    assert out["wb_connectivity"].isna().all()


def test_park_hex_is_not_painted_poor():
    """Parks lack intersections/mix, but they are still places people walk."""
    park = pd.DataFrame(
        {
            "intersection_density": [5.0],
            "mean_block_length_m": [200.0],
            "transit_distance_score": [20.0],
            "landuse_residential_share": [0.05],
            "landuse_commercial_share": [0.0],
            "population_density": [200.0],
            "green_share_inside_500m": [65.0],
            "nearest_park_dist_m": [40.0],
            "nearest_park_area_ha": [25.0],
        }
    )
    out = walkability_index(park)
    assert float(out["wb_green"].iloc[0]) >= 70
    assert float(out["s_walkability"].iloc[0]) >= 70


def test_green_floor_does_not_lower_a_dense_street_grid():
    dense = _grid().iloc[[0]].reset_index(drop=True)
    dense["green_share_inside_500m"] = 8.0
    without = walkability_index(dense.drop(columns=["green_share_inside_500m"]))
    with_green = walkability_index(dense)
    assert float(with_green["s_walkability"].iloc[0]) >= float(without["s_walkability"].iloc[0]) - 0.1
