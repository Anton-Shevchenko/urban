"""Shared helpers: logging, Overpass fetching, geometry utilities."""
from __future__ import annotations

import json
import math
import time
from typing import Iterable

import requests

from . import config


def log(step: str, msg: str) -> None:
    print(f"[{step}] {msg}", flush=True)


# --- Overpass --------------------------------------------------------------
def overpass_query(query: str, step: str = "overpass") -> dict:
    """Run an Overpass QL query, rotating through mirrors on failure."""
    last_err: Exception | None = None
    for endpoint in config.OVERPASS_ENDPOINTS:
        for attempt in range(2):
            try:
                log(step, f"POST {endpoint} (attempt {attempt + 1})")
                resp = requests.post(
                    endpoint,
                    data={"data": query},
                    timeout=config.OVERPASS_TIMEOUT,
                    headers={"User-Agent": "munich-value-index/1.0 (MVP pipeline)"},
                )
                if resp.status_code == 200 and resp.text.lstrip().startswith("{"):
                    return resp.json()
                log(step, f"  bad response {resp.status_code}; server busy, rotating")
            except requests.RequestException as exc:  # noqa: PERF203
                last_err = exc
                log(step, f"  error: {exc}")
            time.sleep(3)
    raise RuntimeError(f"All Overpass endpoints failed: {last_err}")


def overpass_elements(query: str, step: str = "overpass") -> list[dict]:
    return overpass_query(query, step).get("elements", [])


# --- Geometry --------------------------------------------------------------
def haversine_m(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Great-circle distance in metres."""
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlmb = math.radians(lng2 - lng1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlmb / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def element_lonlat(el: dict) -> tuple[float, float] | None:
    """Return (lon, lat) for an Overpass node/way/relation element."""
    if el.get("type") == "node":
        return (el["lon"], el["lat"])
    center = el.get("center")
    if center:
        return (center["lon"], center["lat"])
    return None


def save_geojson(path, features: Iterable[dict]) -> None:
    fc = {"type": "FeatureCollection", "features": list(features)}
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(fc, fh)


# Pedestrian model (matches factor_center / factor_daily_needs).
WALK_KMH = 4.8
WALK_DETOUR = 1.3


def walk_minutes_from_dist_m(dist_m: float) -> float:
    """Estimate walking time from straight-line distance (minutes)."""
    if not math.isfinite(dist_m) or dist_m < 0:
        return float("inf")
    return dist_m * WALK_DETOUR / (WALK_KMH * 1000.0 / 60.0)


def threshold_score_minutes(minutes: float) -> float:
    """Absolute daily-needs style score from walk minutes."""
    if not math.isfinite(minutes):
        return 0.0
    if minutes <= 5:
        return 100.0
    if minutes <= 10:
        return 75.0
    if minutes <= 15:
        return 40.0
    if minutes <= 20:
        return 10.0
    return 0.0


def nearest_polygon_distance(
    hexes: "gpd.GeoDataFrame",
    features: "gpd.GeoDataFrame",
    col: str = "dist_m",
) -> "pd.Series":
    """Min distance from each hex polygon boundary to target geometries."""
    import geopandas as gpd  # noqa: PLC0415
    import pandas as pd  # noqa: PLC0415

    if features is None or len(features) == 0:
        return pd.Series(float("nan"), index=hexes.index, name=col)
    joined = gpd.sjoin_nearest(hexes, features, how="left", distance_col=col)
    return joined.groupby(joined.index)[col].min()


def green_share_within_buffer(
    hexes: "gpd.GeoDataFrame",
    green: "gpd.GeoDataFrame",
    buffer_m: float = 500.0,
) -> "pd.Series":
    """Share of green area inside a buffer around each hex (0..100)."""
    import geopandas as gpd  # noqa: PLC0415
    import pandas as pd  # noqa: PLC0415

    if green is None or len(green) == 0:
        return pd.Series(0.0, index=hexes.index)
    buffered = hexes[["h3_index", "geometry"]].copy()
    buffered["geometry"] = buffered.geometry.buffer(buffer_m)
    inter = gpd.overlay(
        buffered,
        green[["geometry"]],
        how="intersection",
        keep_geom_type=False,
    )
    if len(inter) == 0:
        return pd.Series(0.0, index=hexes.index)
    green_area = inter.groupby("h3_index").apply(
        lambda g: g.geometry.area.sum(), include_groups=False,
    )
    buf_area = buffered.set_index("h3_index").geometry.area
    share = (green_area / buf_area.clip(lower=1) * 100).clip(0, 100)
    return hexes["h3_index"].map(share).fillna(0.0)


def empty_gdf(extra_cols: Iterable[str] | None = None):
    """An empty GeoDataFrame with a 'geometry' column + CRS.

    Building ``gpd.GeoDataFrame([], crs=...)`` raises because there is no
    geometry column to attach the CRS to. Some Overpass queries legitimately
    return zero elements for smaller cities, so the fetch helpers use this to
    degrade gracefully (empty layer) instead of crashing the whole run.
    """
    import geopandas as gpd  # local import keeps this module light

    data = {c: [] for c in (extra_cols or [])}
    data["geometry"] = []
    return gpd.GeoDataFrame(data, geometry="geometry", crs=config.WGS84)
