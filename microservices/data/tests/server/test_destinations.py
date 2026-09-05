"""Custom destination matrix uses the shared pedestrian model."""

from __future__ import annotations

import numpy as np

from server.destinations import _heuristic_minutes_vec, matrix_cache_key


def test_cache_key_is_stable_for_the_same_destinations():
    dests = [{"lat": 48.1, "lng": 11.5, "weight": 2}]
    assert matrix_cache_key("muenchen", dests) == matrix_cache_key("muenchen", dests)
    assert matrix_cache_key("muenchen", dests) != matrix_cache_key("hamburg", dests)


def test_heuristic_minutes_are_zero_at_the_destination():
    minutes = _heuristic_minutes_vec(np.array([48.1]), np.array([11.5]), 48.1, 11.5)
    assert minutes[0] == 0.0


def test_heuristic_minutes_use_walk_for_short_hops():
    # ~111 m north: walk is a couple of minutes, transit blend has a 5 min floor.
    minutes = _heuristic_minutes_vec(np.array([48.1]), np.array([11.5]), 48.1 + 0.001, 11.5)
    assert 1.0 < float(minutes[0]) < 5.0
