"""Factor - access time to city centre anchors (minutes).

Polycentric cities use explicit anchors (München: Marienplatz, Hbf, Ost).
``center_min`` is travel time to the primary anchor; ``s_center`` scores the
best weighted pole via :func:`pipeline.score_scales.center_polycentric_score`.

If ORS_API_KEY is set, uses the OpenRouteService Matrix API. Otherwise a
keyless station-access model based on OSM rail/subway stations.
"""

from __future__ import annotations

import geopandas as gpd
import numpy as np
import pandas as pd

from pipeline import config
from pipeline.city import CityContext, munich_context
from pipeline.common import WALK_DETOUR, WALK_KMH, haversine_m, log
from pipeline.ingest.centers import main_center
from pipeline.ingest.osm_data import load_stations
from pipeline.providers import ROUTING

STEP = "factor_center"

RAIL_KMH = 32.0
RAIL_DETOUR = 1.2
WAIT_MIN = 5.0
EGRESS_MIN = 3.0
MAX_WALK_TO_STATION_M = 2500


def center_anchors(ctx: CityContext) -> list[dict]:
    """Activity-center anchors: detected density poles first, curated as boost.

    Rosenheim / mid-size cities use local Innenstadt/Bahnhof clusters — not
    München Marienplatz logic. Curated Munich anchors are merged as extras.
    """
    from pipeline.ingest.centers import load_centers

    anchors: list[dict] = []
    data = load_centers(ctx)
    detected = (data or {}).get("centers") or ctx.centers or []
    for i, c in enumerate(detected):
        anchors.append(
            {
                "id": "main" if i == 0 or c.get("primary") else f"sub_{i}",
                "label": "Activity centre" if i == 0 else f"Sub-centre {i}",
                "lat": float(c["lat"]),
                "lng": float(c["lng"]),
                "weight": 1.0 if i == 0 else float(c.get("strength", 0.9)),
            }
        )
        if i == 0:
            anchors[-1]["id"] = "main"

    curated = config.CENTER_ANCHORS.get(ctx.slug) or []
    seen = {(round(a["lat"], 4), round(a["lng"], 4)) for a in anchors}
    for a in curated:
        key = (round(a["lat"], 4), round(a["lng"], 4))
        if key in seen:
            continue
        anchors.append(
            {
                "id": a["id"],
                "label": a.get("label", a["id"]),
                "lat": a["lat"],
                "lng": a["lng"],
                "weight": float(a.get("weight", 0.95)),
            }
        )
        seen.add(key)

    if anchors:
        # Ensure primary is first.
        anchors.sort(key=lambda a: 0 if a["id"] == "main" else 1)
        return anchors

    lat, lng = main_center(ctx)
    return [{"id": "main", "label": "Centre", "lat": lat, "lng": lng, "weight": 1.0}]


def _centroids(ctx: CityContext) -> pd.DataFrame:
    grid = gpd.read_parquet(ctx.cache(config.GRID_FILE))
    return grid[["h3_index", "lat", "lng"]].copy()


def _plain_distance(df: pd.DataFrame, center: tuple[float, float]) -> pd.Series:
    c_lat, c_lng = center
    dist_km = df.apply(lambda r: haversine_m(r["lat"], r["lng"], c_lat, c_lng) / 1000.0, axis=1)
    return (8.0 + dist_km * 1.35 / 19.0 * 60.0).round(1)


def _estimate_fallback(
    ctx: CityContext,
    df: pd.DataFrame,
    center: tuple[float, float],
) -> pd.Series:
    try:
        stations = load_stations(ctx)
    except Exception as exc:  # noqa: BLE001
        log(STEP, f"station load failed ({exc}); plain distance estimate")
        return _plain_distance(df, center)
    if len(stations) == 0:
        return _plain_distance(df, center)

    c_lat, c_lng = center
    hexes = gpd.GeoDataFrame(
        df.copy(),
        geometry=gpd.points_from_xy(df["lng"], df["lat"]),
        crs=config.WGS84,
    ).to_crs(ctx.metric_crs)
    st_m = stations.to_crs(ctx.metric_crs)

    hx = np.c_[hexes.geometry.x.values, hexes.geometry.y.values]
    sx = np.c_[st_m.geometry.x.values, st_m.geometry.y.values]

    ride_min = np.array(
        [
            haversine_m(r.lat, r.lng, c_lat, c_lng) / 1000.0 * RAIL_DETOUR / RAIL_KMH * 60.0
            for r in stations.itertuples()
        ]
    )

    dwalk = np.sqrt(((hx[:, None, :] - sx[None, :, :]) ** 2).sum(axis=2))
    walk_min = dwalk / 1000.0 * WALK_DETOUR / WALK_KMH * 60.0

    total = walk_min + WAIT_MIN + ride_min[None, :] + EGRESS_MIN
    total[dwalk > MAX_WALK_TO_STATION_M] = np.inf
    via_rail = total.min(axis=1)

    direct_walk = (
        df.apply(lambda r: haversine_m(r["lat"], r["lng"], c_lat, c_lng), axis=1).values
        / 1000.0
        * WALK_DETOUR
        / WALK_KMH
        * 60.0
    )

    minutes = np.minimum(via_rail, direct_walk)
    minutes = np.where(np.isfinite(minutes), minutes, direct_walk)
    return pd.Series(np.round(minutes, 1), index=df.index)


def _ors_matrix(ctx: CityContext, df: pd.DataFrame, center: tuple[float, float]) -> pd.Series:
    c_lat, c_lng = center
    url = config.ORS_MATRIX_URL.format(profile=config.ORS_PROFILE)
    headers = {
        "Authorization": config.ORS_API_KEY,
        "Content-Type": "application/json",
    }
    all_minutes: list[float] = []
    chunk = 1000
    coords = df[["lng", "lat"]].values.tolist()

    for start in range(0, len(coords), chunk):
        batch = coords[start : start + chunk]
        locations = [[c_lng, c_lat]] + batch
        payload = {
            "locations": locations,
            "sources": list(range(1, len(locations))),
            "destinations": [0],
            "metrics": ["duration"],
        }
        log(STEP, f"ORS matrix batch {start}-{start + len(batch)}")
        resp = ROUTING.post(url, json_body=payload, headers=headers)
        resp.raise_for_status()
        durations = resp.json()["durations"]
        all_minutes.extend(round(d[0] / 60.0, 1) if d and d[0] is not None else None for d in durations)

    return pd.Series(all_minutes, index=df.index)


def _travel_minutes(
    ctx: CityContext,
    df: pd.DataFrame,
    center: tuple[float, float],
) -> pd.Series:
    if config.ORS_API_KEY:
        try:
            minutes = _ors_matrix(ctx, df, center)
            fallback = _estimate_fallback(ctx, df, center)
            return minutes.fillna(fallback)
        except Exception as exc:  # noqa: BLE001
            log(STEP, f"ORS failed ({exc}); using distance-based estimate")
    return _estimate_fallback(ctx, df, center)


def compute(ctx: CityContext) -> pd.DataFrame:
    df = _centroids(ctx)
    anchors = center_anchors(ctx)
    out = df[["h3_index"]].copy()
    min_cols: list[str] = []

    for a in anchors:
        center = (a["lat"], a["lng"])
        col = f"center_min_{a['id']}"
        out[col] = _travel_minutes(ctx, df, center).values
        min_cols.append(col)

    primary = anchors[0]["id"]
    out["center_min"] = out[f"center_min_{primary}"]
    out["center_min_best"] = out[min_cols].min(axis=1).round(1)

    log(
        STEP,
        f"anchor access ({len(anchors)} poles, primary={primary}): "
        f"min={out['center_min'].min():.1f}, max={out['center_min'].max():.1f}, "
        f"mean={out['center_min'].mean():.1f} min",
    )
    return out


def main(ctx: CityContext | None = None) -> None:
    ctx = ctx or munich_context()
    out = compute(ctx)
    dest = ctx.cache(config.CENTER_FILE)
    out.to_parquet(dest)
    log(STEP, f"saved -> {dest}")


if __name__ == "__main__":
    main()
