"""Factor - daily-life walking accessibility (15-minute city).

Quality-over-quantity: each amenity uses walk-minute bands (5→100 … 20→0);
life groups take the best amenity score, then combine with fixed weights.
Parks are excluded (Green Index). City normalization applied in normalize_export.
"""
from __future__ import annotations

import itertools

import geopandas as gpd
import numpy as np
import pandas as pd

from . import config
from .city import CityContext, munich_context
from .common import (
    WALK_DETOUR,
    WALK_KMH,
    log,
    nearest_polygon_distance,
    walk_minutes_from_dist_m,
)
from .osm_data import load_daily_needs
from .score_scales import (
    daily_life_from_groups,
    daily_life_group_from_categories,
    daily_needs_distance_score,
    daily_needs_final,
    daily_needs_log_score,
    walk_minute_band_score,
    walk_minute_decay_score,
)

STEP = "factor_daily_needs"

CATEGORIES = config.DAILY_NEEDS_CATEGORIES
WEIGHTS = config.DAILY_NEEDS_WEIGHTS
CLUSTER_MAX_MIN = config.DAILY_NEEDS_CLUSTER_MAX_MIN
CLUSTER_SPAN_M = config.DAILY_NEEDS_CLUSTER_SPAN_M
LIFE_GROUPS = config.DAILY_LIFE_AMENITIES
GROUP_WEIGHTS = config.DAILY_LIFE_GROUP_WEIGHTS
CATEGORY_WEIGHTS = config.DAILY_LIFE_CATEGORY_WEIGHTS
DECAYS = config.WALK_DECAY_MINUTES
PLATEAU = config.WALK_DECAY_PLATEAU_MIN
USE_BAND = config.WALK_USE_BAND_SCORE
SECOND_BONUS = config.WALK_SECOND_AMENITY_BONUS
SECOND_MAX_MIN = config.WALK_SECOND_AMENITY_MAX_MIN


def _nearest_poi_per_hex(
    hexes: gpd.GeoDataFrame,
    pois: gpd.GeoDataFrame,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    n = len(hexes)
    walk = np.full(n, np.inf)
    poi_x = np.full(n, np.nan)
    poi_y = np.full(n, np.nan)
    brand = np.zeros(n)
    if pois is None or len(pois) == 0:
        return walk, poi_x, poi_y, brand

    dist_m = nearest_polygon_distance(hexes, pois, "dist_m")
    walk = dist_m.map(walk_minutes_from_dist_m).to_numpy().copy()

    work = hexes.copy()
    work["_hid"] = np.arange(n)
    pois_pts = pois.copy()
    pois_pts["geometry"] = pois_pts.geometry.centroid
    joined = gpd.sjoin_nearest(work, pois_pts, how="left", distance_col="dist_m")
    best = joined.sort_values("dist_m").groupby("_hid", as_index=False).first()
    for _, row in best.iterrows():
        hid = int(row["_hid"])
        if not np.isfinite(row["dist_m"]):
            continue
        walk[hid] = walk_minutes_from_dist_m(row["dist_m"])
        if "index_right" in row.index and pd.notna(row.get("index_right")):
            geom = pois_pts.loc[int(row["index_right"])].geometry
            poi_x[hid] = geom.x
            poi_y[hid] = geom.y
            if "brand" in pois_pts.columns:
                brand[hid] = float(pois_pts.loc[int(row["index_right"])].get("brand", 0) or 0)
    return walk, poi_x, poi_y, brand


def _count_within_minutes(
    hexes: gpd.GeoDataFrame,
    pois: gpd.GeoDataFrame,
    max_min: float,
) -> np.ndarray:
    n = len(hexes)
    counts = np.zeros(n)
    if pois is None or len(pois) == 0:
        return counts
    radius_m = max_min * (WALK_KMH * 1000.0 / 60.0) / WALK_DETOUR
    hex_buf = hexes.copy()
    hex_buf["geometry"] = hex_buf.geometry.centroid.buffer(radius_m)
    pois_pts = pois.copy()
    pois_pts["geometry"] = pois_pts.geometry.centroid
    joined = gpd.sjoin(pois_pts, hex_buf[["h3_index", "geometry"]], predicate="within", how="inner")
    if len(joined) == 0:
        return counts
    vc = joined.groupby("h3_index").size()
    mapped = hexes["h3_index"].map(vc).fillna(0).to_numpy()
    return mapped.astype(float)


def _cluster_penalty_and_span(
    walk_mins: np.ndarray,
    poi_x: np.ndarray,
    poi_y: np.ndarray,
    categories: tuple[str, ...],
) -> tuple[np.ndarray, np.ndarray]:
    n = len(walk_mins)
    penalties = np.zeros(n)
    spans = np.zeros(n)
    sup_j = categories.index("supermarket") if "supermarket" in categories else 0

    for i in range(n):
        mask = np.isfinite(walk_mins[i]) & (walk_mins[i] <= CLUSTER_MAX_MIN)
        mask &= np.isfinite(poi_x[i]) & np.isfinite(poi_y[i])
        idxs = np.where(mask)[0]
        if len(idxs) < 2:
            continue
        pts = list(zip(poi_x[i, idxs], poi_y[i, idxs]))
        span = max(
            np.hypot(a[0] - b[0], a[1] - b[1])
            for a, b in itertools.combinations(pts, 2)
        )
        spans[i] = span
        if len(idxs) >= 4 and span < CLUSTER_SPAN_M:
            penalties[i] = max(penalties[i], 25.0 * (1.0 - span / CLUSTER_SPAN_M))
        elif len(idxs) >= 3 and span < CLUSTER_SPAN_M * 0.75:
            penalties[i] = max(penalties[i], 15.0 * (1.0 - span / (CLUSTER_SPAN_M * 0.75)))

        if (
            np.isfinite(walk_mins[i, sup_j])
            and walk_mins[i, sup_j] <= CLUSTER_MAX_MIN
            and np.isfinite(poi_x[i, sup_j])
        ):
            sx, sy = poi_x[i, sup_j], poi_y[i, sup_j]
            bundled = 0
            for j in idxs:
                if np.hypot(poi_x[i, j] - sx, poi_y[i, j] - sy) <= 150:
                    bundled += 1
            if bundled >= 6:
                penalties[i] = max(penalties[i], 18.0)
            elif bundled >= 5:
                penalties[i] = max(penalties[i], 12.0)

    return penalties, spans


def compute(ctx: CityContext) -> gpd.GeoDataFrame:
    grid = gpd.read_parquet(ctx.cache(config.GRID_FILE)).to_crs(ctx.metric_crs)
    hexes = grid[["h3_index", "geometry"]].copy().reset_index(drop=True)
    needs = load_daily_needs(ctx).to_crs(ctx.metric_crs)
    out = hexes[["h3_index"]].copy()

    n_hex = len(hexes)
    n_cat = len(CATEGORIES)
    walk_arr = np.full((n_hex, n_cat), np.inf)
    avail_arr = np.zeros((n_hex, n_cat))
    brand_arr = np.zeros((n_hex, n_cat))
    count_arr = np.zeros((n_hex, n_cat))
    weight_arr = np.array([WEIGHTS.get(c, 1.0) for c in CATEGORIES])

    poi_x = np.full((n_hex, n_cat), np.nan)
    poi_y = np.full((n_hex, n_cat), np.nan)

    for j, cat in enumerate(CATEGORIES):
        col_min = f"dn_{cat}_min"
        col_avail = f"dn_{cat}_avail"
        subset = needs[needs["category"] == cat] if len(needs) else needs
        walk, px, py, br = _nearest_poi_per_hex(hexes, subset)
        walk_arr[:, j] = walk
        poi_x[:, j] = px
        poi_y[:, j] = py
        brand_arr[:, j] = br
        count_arr[:, j] = _count_within_minutes(hexes, subset, SECOND_MAX_MIN)
        decay = DECAYS.get(cat, DECAYS["default"])
        mins = np.where(np.isfinite(walk), walk, 99.0)
        if USE_BAND:
            avail = walk_minute_band_score(pd.Series(mins))
        else:
            avail = walk_minute_decay_score(pd.Series(mins), decay=decay, plateau=PLATEAU)
        if cat == "supermarket":
            avail = (avail + brand_arr[:, j] * 4.0).clip(0, 100)
        bonus = np.where(count_arr[:, j] >= 2, SECOND_BONUS * 0.5, 0.0)
        avail = (avail + bonus).clip(0, 100)
        avail_arr[:, j] = avail.values
        out[col_min] = np.where(np.isfinite(walk), walk, 99.0).round(1)
        out[col_avail] = avail.round(1).values

    # Weighted category aggregation inside each group (not max).
    # categoryScore ≈ 0.75×nearestAvail + 0.25×choice when count≥2 bonus already in avail.
    group_scores: dict[str, pd.Series] = {}
    cat_series = {
        cat: pd.Series(avail_arr[:, j], index=out.index)
        for j, cat in enumerate(CATEGORIES)
    }
    for group in GROUP_WEIGHTS:
        cat_w = CATEGORY_WEIGHTS.get(group) or {
            c: 1.0 for c in CATEGORIES if LIFE_GROUPS.get(c) == group
        }
        if not cat_w:
            group_scores[group] = pd.Series(np.nan, index=out.index)
            out[f"dl_{group}"] = np.nan
            continue
        # Blend nearest accessibility with choice (count bonus already applied).
        blended: dict[str, pd.Series] = {}
        for cat in cat_w:
            if cat not in cat_series:
                continue
            nearest = cat_series[cat]
            # Without a separate choice field, use avail as nearest; coverage reduced in frontend.
            blended[cat] = nearest
        scored = daily_life_group_from_categories(blended, cat_w)
        group_scores[group] = scored
        out[f"dl_{group}"] = scored.values

    # Absolute daily life raw (objective-v2 — not city-rank).
    daily_raw = daily_life_from_groups(group_scores, GROUP_WEIGHTS)
    out["daily_life_raw"] = daily_raw.values
    out["s_daily_life"] = daily_raw.values
    out["daily_life_score"] = daily_raw.values

    wsum = weight_arr.sum()
    coverage = (avail_arr * weight_arr).sum(axis=1) / wsum
    penalties, spans = _cluster_penalty_and_span(walk_arr, poi_x, poi_y, CATEGORIES)
    dispersion_bonus = np.clip(spans / 50.0, 0, 15)
    raw = np.clip(coverage - penalties + dispersion_bonus * 0.5, 0, 100)
    out["dn_coverage"] = np.round(coverage, 1)
    out["dn_cluster_span_m"] = np.round(spans, 0)
    out["dn_cluster_penalty"] = np.round(penalties, 1)
    out["dn_dispersion_bonus"] = np.round(dispersion_bonus, 1)
    out["daily_needs_raw"] = np.round(raw, 1)
    coverage_score = daily_needs_log_score(pd.Series(raw, index=out.index))

    sup_j = CATEGORIES.index("supermarket") if "supermarket" in CATEGORIES else 0
    nearest_min = walk_arr[:, sup_j]
    nearest_m = np.where(np.isfinite(nearest_min), nearest_min * 61.5, 2500.0)
    distance_score = daily_needs_distance_score(pd.Series(nearest_m, index=out.index))
    out["dn_nearest_key_m"] = np.round(nearest_m, 0)
    out["dn_distance_score"] = distance_score.values
    out["daily_needs_score"] = daily_raw.values
    out["daily_needs_score_legacy"] = daily_needs_final(coverage_score, distance_score).values

    log(
        STEP,
        f"daily life foundation (raw mean={out['daily_life_raw'].mean():.1f}, "
        f"food={out.get('dl_food', pd.Series([0])).mean():.1f}, "
        f"health={out.get('dl_health', pd.Series([0])).mean():.1f})",
    )
    return out


def main(ctx: CityContext | None = None) -> None:
    ctx = ctx or munich_context()
    out = compute(ctx)
    dest = ctx.cache(config.DAILY_NEEDS_FILE)
    out.to_parquet(dest)
    log(STEP, f"saved -> {dest}")


if __name__ == "__main__":
    main()
