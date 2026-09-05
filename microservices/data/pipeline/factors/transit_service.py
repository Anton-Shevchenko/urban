"""Factor - transit service (distance / frequency / connectivity).

Discriminates U/S-Bahn vs tram vs infrequent bus. City normalization applied
in normalize_export.
"""

from __future__ import annotations

import geopandas as gpd
import numpy as np
import pandas as pd

from pipeline import config
from pipeline.city import CityContext, munich_context
from pipeline.common import log
from pipeline.ingest.gtfs_registry import OSM_CLASS_DEPARTURES, load_city_departures
from pipeline.ingest.osm_data import load_stations

STEP = "factor_transit_service"

DECAY_M = 500.0
MAX_M = 2000.0

# Class quality anchors (frequency proxy when GTFS missing).
CLASS_FREQ_SCORE = {
    "subway": 95.0,  # U-Bahn ~every 5 min
    "station": 90.0,  # S-Bahn / main rail
    "light_rail": 78.0,
    "tram": 70.0,
    "halt": 45.0,
    "bus": 40.0,  # ~every 30 min
    "other": 35.0,
}

NIGHT_CLASS_WEIGHT = {
    "subway": 1.0,
    "station": 1.0,
    "light_rail": 0.85,
    "halt": 0.55,
    "tram": 0.75,
    "bus": 0.35,
    "other": 0.4,
}


def _dist_score(dist_m: float) -> float:
    """Walking distance to nearest station — steep falloff."""
    if dist_m > MAX_M:
        return 0.0
    # 100m→100, 300→85, 600→60, 1000→35, 1500→15, 2000→0
    if dist_m <= 100:
        return 100.0
    if dist_m <= 300:
        return 100.0 - (dist_m - 100) / 200 * 15
    if dist_m <= 600:
        return 85.0 - (dist_m - 300) / 300 * 25
    if dist_m <= 1000:
        return 60.0 - (dist_m - 600) / 400 * 25
    if dist_m <= 1500:
        return 35.0 - (dist_m - 1000) / 500 * 20
    return max(0.0, 15.0 - (dist_m - 1500) / 500 * 15)


def _freq_score_from_departures(dep_h: float, cls: str) -> float:
    """Map departures/hour to 0–100 with class floor/ceiling."""
    # 12+/h ≈ U-Bahn every 5 min → 95–100; 2/h ≈ bus every 30 min → ~40
    if dep_h >= 12:
        base = 98.0
    elif dep_h >= 8:
        base = 90.0
    elif dep_h >= 6:
        base = 80.0
    elif dep_h >= 4:
        base = 65.0
    elif dep_h >= 2:
        base = 45.0
    elif dep_h >= 1:
        base = 30.0
    else:
        base = 15.0
    class_anchor = CLASS_FREQ_SCORE.get(str(cls), 40.0)
    return float(np.clip(0.55 * base + 0.45 * class_anchor, 0, 100))


def _station_departures(ctx: CityContext, stations: gpd.GeoDataFrame) -> pd.Series:
    dep = load_city_departures(ctx)
    if len(dep) and "stop_id" in dep.columns:
        max_dep = float(dep["departures_h"].max()) if len(dep) else 0.0
        if max_dep > 0:
            return stations["cls"].map(OSM_CLASS_DEPARTURES).fillna(2.0) * (max_dep / 8.0)
    # Class-based estimate — do NOT flatten all classes to similar values.
    return stations["cls"].map(OSM_CLASS_DEPARTURES).fillna(2.0)


def compute(ctx: CityContext) -> gpd.GeoDataFrame:
    grid = gpd.read_parquet(ctx.cache(config.GRID_FILE))
    stations = load_stations(ctx)
    out = grid[["h3_index"]].copy()

    if len(stations) == 0:
        out["transit_service_score"] = 0.0
        out["transit_service_raw"] = 0.0
        out["station_proximity_score"] = 0.0
        log(STEP, "no stations; transit_service_score = 0")
        return out

    transport = pd.read_parquet(ctx.cache(config.TRANSPORT_FILE))
    out = out.merge(transport[["h3_index", "transport_score"]], on="h3_index", how="left")
    out.rename(columns={"transport_score": "station_proximity_score"}, inplace=True)

    hexes = gpd.GeoDataFrame(
        grid[["h3_index", "lat", "lng"]].copy(),
        geometry=gpd.points_from_xy(grid["lng"], grid["lat"]),
        crs=config.WGS84,
    ).to_crs(ctx.metric_crs)
    st_m = stations.to_crs(ctx.metric_crs)
    st_m["departures_h"] = _station_departures(ctx, stations).values

    hx = np.c_[hexes.geometry.x.values, hexes.geometry.y.values]
    sx = np.c_[st_m.geometry.x.values, st_m.geometry.y.values]
    dep = st_m["departures_h"].values
    weights = st_m["weight"].values if "weight" in st_m.columns else np.ones(len(st_m))
    classes = st_m["cls"].astype(str).values if "cls" in st_m.columns else np.array(["other"] * len(st_m))

    nearest_dist = np.full(len(hexes), MAX_M)
    nearest_dep = np.zeros(len(hexes))
    nearest_cls = np.array(["other"] * len(hexes), dtype=object)
    coverage = np.zeros(len(hexes))

    for i in range(len(hexes)):
        d = np.sqrt(((sx - hx[i]) ** 2).sum(axis=1))
        mask = d <= MAX_M
        if not mask.any():
            continue
        d_m = d[mask]
        j = int(np.argmin(d_m))
        nearest_dist[i] = d_m[j]
        nearest_dep[i] = dep[mask][j]
        nearest_cls[i] = classes[mask][j]
        coverage[i] = (dep[mask] * weights[mask] * np.exp(-d_m / DECAY_M)).sum()

    dist_s = np.array([_dist_score(d) for d in nearest_dist])
    freq_s = np.array(
        [_freq_score_from_departures(nearest_dep[i], nearest_cls[i]) for i in range(len(hexes))]
    )
    cov_cap = max(float(coverage.max()), 0.001)
    cov_norm = np.clip(coverage / cov_cap, 0, 1) * 100
    night = np.array([NIGHT_CLASS_WEIGHT.get(str(c), 0.4) * 100 for c in nearest_cls])
    connectivity = (0.75 * cov_norm + 0.25 * night).clip(0, 100)

    composite = 0.40 * dist_s + 0.30 * freq_s + 0.30 * connectivity
    out["transit_distance_score"] = np.round(dist_s, 1)
    out["transit_frequency_score"] = np.round(freq_s, 1)
    out["transit_connectivity_score"] = np.round(connectivity, 1)
    out["transit_service_raw"] = np.round(composite, 1)
    out["transit_service_score"] = np.round(composite, 3)
    log(
        STEP,
        f"transit raw mean={out['transit_service_raw'].mean():.1f} "
        f"(dist={dist_s.mean():.0f} freq={freq_s.mean():.0f} conn={connectivity.mean():.0f})",
    )
    return out


def main(ctx: CityContext | None = None) -> None:
    ctx = ctx or munich_context()
    out = compute(ctx)
    dest = ctx.cache(config.TRANSIT_SERVICE_FILE)
    out.to_parquet(dest)
    log(STEP, f"saved -> {dest}")


if __name__ == "__main__":
    main()
