"""Custom destination travel-time matrix for client-side scoring."""

from __future__ import annotations

import hashlib
import json

import geopandas as gpd
import numpy as np
import pandas as pd

from pipeline import config
from pipeline.city import CityContext
from pipeline.common import WALK_DETOUR, WALK_KMH, log

STEP = "destinations"


def _heuristic_minutes_vec(
    lat: np.ndarray,
    lng: np.ndarray,
    dest_lat: float,
    dest_lng: float,
) -> np.ndarray:
    """Vectorized walk/transit blend minutes from hex centres to one destination."""
    lat1 = np.radians(lat.astype(float))
    lng1 = np.radians(lng.astype(float))
    lat2 = np.radians(dest_lat)
    lng2 = np.radians(dest_lng)
    dlat = lat2 - lat1
    dlng = lng2 - lng1
    a = np.sin(dlat / 2.0) ** 2 + np.cos(lat1) * np.cos(lat2) * np.sin(dlng / 2.0) ** 2
    dist_km = 2.0 * 6371000.0 * np.arcsin(np.sqrt(a)) / 1000.0
    walk_min = dist_km * 1000.0 * WALK_DETOUR / (WALK_KMH * 1000.0 / 60.0)
    transit_min = 5.0 + dist_km * 1.2 / 32.0 * 60.0 + 3.0
    return np.round(np.minimum(walk_min, transit_min), 1)


def matrix_cache_key(slug: str, destinations: list[dict]) -> str:
    payload = json.dumps(destinations, sort_keys=True)
    digest = hashlib.sha256(f"{slug}:{payload}".encode()).hexdigest()[:16]
    return digest


def compute_matrix(ctx: CityContext, destinations: list[dict]) -> pd.DataFrame:
    """Minutes from each hex to each destination (columns dest_0, dest_1, ...)."""
    grid = gpd.read_parquet(ctx.cache(config.GRID_FILE))
    out = grid[["h3_index", "lat", "lng"]].copy()
    lat = out["lat"].to_numpy()
    lng = out["lng"].to_numpy()
    for i, dest in enumerate(destinations[:3]):
        dlat, dlng = float(dest["lat"]), float(dest["lng"])
        out[f"dest_{i}_min"] = _heuristic_minutes_vec(lat, lng, dlat, dlng)
    return out


def load_or_compute(ctx: CityContext, destinations: list[dict]) -> pd.DataFrame:
    key = matrix_cache_key(ctx.slug, destinations)
    cache = ctx.cache(f"custom_dest_{key}.parquet")
    if cache.exists():
        log(STEP, f"cache hit {cache.name}")
        return pd.read_parquet(cache)
    df = compute_matrix(ctx, destinations)
    df.to_parquet(cache)
    log(STEP, f"saved matrix -> {cache}")
    return df
