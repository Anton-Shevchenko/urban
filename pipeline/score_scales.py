"""Absolute 0–100 scoring scales for green and price (no city-relative percentiles)."""
from __future__ import annotations

import numpy as np
import pandas as pd


def _select(series: pd.Series, bounds: list[float], scores: list[float], default: float = 0.0) -> pd.Series:
    """Step function — used for green composites where averaging smooths the bins."""
    x = series.astype(float).fillna(np.inf)
    conds = [x <= b for b in bounds]
    return pd.Series(np.select(conds, scores, default=default), index=series.index).round(1)


def _interp(
    series: pd.Series,
    x_points: list[float],
    y_points: list[float],
    *,
    below: float | None = None,
    above: float | None = None,
) -> pd.Series:
    """Piecewise-linear score — continuous, no histogram holes."""
    x = series.astype(float).to_numpy()
    y_lo = y_points[0] if below is None else below
    y_hi = y_points[-1] if above is None else above
    scored = np.interp(np.where(np.isfinite(x), x, np.inf), x_points, y_points, left=y_lo, right=y_hi)
    return pd.Series(scored, index=series.index).round(1)


# ---- Green components -------------------------------------------------------

def green_park_distance_soft(dist_m: pd.Series) -> pd.Series:
    """Absolute walk distance to nearest accessible park (metres)."""
    return _select(dist_m, [50, 100, 200, 400, 700, 1000], [100, 95, 85, 70, 45, 20])


def green_park_distance_strict(dist_m: pd.Series) -> pd.Series:
    return _select(dist_m, [100, 300, 500, 800], [100, 75, 40, 15])


def green_share_500m_soft(share_pct: pd.Series) -> pd.Series:
    """Share of green area inside a 500 m buffer (%)."""
    return _select(share_pct, [5, 10, 20, 35, 50], [10, 35, 60, 85, 100])


def green_share_500m_strict(share_pct: pd.Series) -> pd.Series:
    return _select(share_pct, [5, 10, 20, 30], [0, 25, 55, 85], default=100.0)


def green_park_area_soft(area_ha: pd.Series) -> pd.Series:
    """Area of nearest accessible park (hectares). Larger parks stay at 100."""
    return _interp(area_ha, [0, 1, 3, 10, 25], [0, 15, 40, 70, 100], below=0, above=100)


def green_park_area_strict(area_ha: pd.Series) -> pd.Series:
    return _interp(area_ha, [0, 1, 3, 10, 25], [0, 0, 25, 60, 100], below=0, above=100)


def green_tree_canopy_soft(canopy_pct: pd.Series) -> pd.Series:
    return _select(canopy_pct, [5, 10, 20, 30], [20, 45, 70, 100])


def green_tree_canopy_strict(canopy_pct: pd.Series) -> pd.Series:
    return _select(canopy_pct, [5, 10, 20, 30], [0, 30, 65, 100])


def green_water_soft(dist_m: pd.Series) -> pd.Series:
    """Proximity to water (river/lake); bonus only, not a park substitute."""
    return _select(dist_m, [50, 150, 300, 500, 1000], [100, 80, 55, 30, 10])


def green_water_strict(dist_m: pd.Series) -> pd.Series:
    return _select(dist_m, [100, 300, 600], [100, 50, 15], default=0.0)


def green_composite_lenient(
    park_dist_m: pd.Series,
    share_500m_pct: pd.Series,
    tree_canopy_pct: pd.Series,
    water_dist_m: pd.Series,
    park_area_ha: pd.Series | None = None,
) -> pd.Series:
    """40% park dist + 30% green share + 20% canopy + 10% water."""
    park = green_park_distance_soft(park_dist_m)
    share = green_share_500m_soft(share_500m_pct)
    canopy = green_tree_canopy_soft(tree_canopy_pct)
    water = green_water_soft(water_dist_m)
    if park_area_ha is not None:
        # Blend park area into park-distance component (penalise tiny patches at dist≈0).
        area = green_park_area_soft(park_area_ha)
        park = (0.75 * park + 0.25 * area).round(1)
    return (0.40 * park + 0.30 * share + 0.20 * canopy + 0.10 * water).clip(0, 100).round(1)


def green_composite_strict(
    park_dist_m: pd.Series,
    share_500m_pct: pd.Series,
    tree_canopy_pct: pd.Series,
    water_dist_m: pd.Series,
    park_area_ha: pd.Series | None = None,
) -> pd.Series:
    park = green_park_distance_strict(park_dist_m)
    share = green_share_500m_strict(share_500m_pct)
    canopy = green_tree_canopy_strict(tree_canopy_pct)
    water = green_water_strict(water_dist_m)
    if park_area_ha is not None:
        area = green_park_area_strict(park_area_ha)
        park = (0.65 * park + 0.35 * area).round(1)
    return (0.40 * park + 0.30 * share + 0.20 * canopy + 0.10 * water).clip(0, 100).round(1)


def green_cooling_proxy(
    tree_canopy_pct: pd.Series,
    water_dist_m: pd.Series | None = None,
) -> pd.Series:
    """Cooling effect proxy: canopy + nearby water."""
    tree = _interp(tree_canopy_pct, [0, 5, 15, 25, 40], [0, 30, 60, 85, 100], below=0, above=100)
    if water_dist_m is None:
        return tree
    water = _interp(water_dist_m, [50, 150, 300, 600, 1200], [100, 80, 55, 25, 5], below=100, above=0)
    return (0.70 * tree + 0.30 * water).clip(0, 100).round(1)


def _canopy_citywide_missing(tree_canopy_pct: pd.Series) -> bool:
    """True when canopy looks unavailable for the whole city (median≈0, p90≈0)."""
    x = tree_canopy_pct.astype(float)
    if len(x) == 0:
        return True
    return float(x.median()) <= 0.5 and float(x.quantile(0.9)) <= 0.5


def green_quality_score(
    share_500m_pct: pd.Series,
    park_dist_m: pd.Series,
    tree_canopy_pct: pd.Series,
    park_area_ha: pd.Series | None = None,
    water_dist_m: pd.Series | None = None,
) -> pd.Series:
    """Match/Living green: 40% reachable + 30% trees + 20% park quality + 10% cooling.

    When tree canopy is missing city-wide, redistribute tree+cooling mass onto
    reachable + park quality so park proximity still paints green.
    """
    reachable = _interp(park_dist_m, [50, 200, 500, 1000, 2000], [100, 85, 60, 35, 10], below=100, above=5)
    # Blend local green share into reachable green.
    share = _interp(share_500m_pct, [0, 5, 15, 30, 50], [0, 25, 50, 75, 100], below=0, above=100)
    reachable = (0.65 * reachable + 0.35 * share).clip(0, 100)
    tree = _interp(tree_canopy_pct, [0, 5, 15, 25, 40], [0, 30, 60, 85, 100], below=0, above=100)
    if park_area_ha is not None:
        park_q = green_park_area_soft(park_area_ha)
    else:
        park_q = share
    cooling = green_cooling_proxy(tree_canopy_pct, water_dist_m)
    if _canopy_citywide_missing(tree_canopy_pct):
        # No usable canopy: reachable 55% + park quality 35% + water cooling 10%.
        if water_dist_m is not None:
            water_only = _interp(
                water_dist_m, [50, 150, 300, 600, 1200], [100, 80, 55, 25, 5], below=100, above=0,
            )
        else:
            water_only = pd.Series(0.0, index=reachable.index)
        return (0.55 * reachable + 0.35 * park_q + 0.10 * water_only).clip(0, 100).round(1)
    return (
        0.40 * reachable + 0.30 * tree + 0.20 * park_q + 0.10 * cooling
    ).clip(0, 100).round(1)


# ---- Price ------------------------------------------------------------------

def rent_percentile_score(rent_eur_m2: pd.Series) -> pd.Series:
    """City-relative affordability — smooth rank: cheap hexes → 100."""
    x = rent_eur_m2.astype(float)
    n = len(x)
    if n <= 1:
        return pd.Series(50.0, index=x.index)
    # Break ties within identical €/m² using stable sort order for continuous ranks.
    order = np.argsort(x.to_numpy(), kind="mergesort")
    ranks = np.empty(n, dtype=float)
    ranks[order] = np.arange(n, dtype=float)
    pct = ranks / (n - 1)
    return pd.Series(100.0 * (1.0 - pct), index=x.index).round(2)


def rent_value_score(
    affordability: pd.Series,
    transit_score: pd.Series,
    daily_needs_score: pd.Series,
) -> pd.Series:
    """Value for money — cheap alone is not enough without access."""
    return (
        0.50 * affordability.astype(float)
        + 0.25 * transit_score.astype(float)
        + 0.25 * daily_needs_score.astype(float)
    ).clip(0, 100).round(1)


def rent_kalt_lenient(rent_eur_m2: pd.Series) -> pd.Series:
    """Absolute cold-rent €/m² — steeper Munich curve (16→80, not flat 60–70 band)."""
    return _interp(rent_eur_m2, [16, 18, 20, 22, 24, 26], [80, 65, 50, 35, 20, 10], below=100, above=0)


def rent_kalt_strict(rent_eur_m2: pd.Series) -> pd.Series:
    return _interp(rent_eur_m2, [16, 18, 20, 22, 24, 26], [80, 60, 40, 22, 8, 0], below=100, above=0)


def rent_warm_lenient(warm_monthly: pd.Series) -> pd.Series:
    """Absolute warm monthly rent (€) at user/default area."""
    return _interp(warm_monthly, [900, 1100, 1300, 1500, 1700, 2000], [100, 80, 60, 40, 20, 5], below=100, above=0)


def rent_warm_strict(warm_monthly: pd.Series) -> pd.Series:
    return _interp(warm_monthly, [900, 1100, 1300, 1500, 1700, 2000], [100, 65, 35, 15, 5, 0], below=100, above=0)


# ---- Daily needs / walk-time decay ------------------------------------------

def walk_minute_band_score(minutes: pd.Series | np.ndarray | float) -> pd.Series:
    """Piecewise walk-minute accessibility.

    Knots: 5 min → 100, 10 → 70, 15 → 30, ≥20 → 0 (linear between).
    """
    knots_x = [0.0, 5.0, 10.0, 15.0, 20.0]
    knots_y = [100.0, 100.0, 70.0, 30.0, 0.0]
    if np.isscalar(minutes):
        m = float(minutes)
        if not np.isfinite(m):
            return pd.Series([0.0])
        return pd.Series([float(np.interp(m, knots_x, knots_y))])
    s = pd.Series(minutes).astype(float)
    scored = np.interp(np.where(np.isfinite(s), s, 99.0), knots_x, knots_y)
    return pd.Series(scored, index=s.index).clip(0, 100).round(1)


def walk_minute_decay_score(
    minutes: pd.Series | np.ndarray | float,
    decay: float = 6.0,
    plateau: float = 2.0,
) -> pd.Series:
    """Exponential walk-minute accessibility: 100 * exp(-max(0, m - plateau) / decay).

    Prefer :func:`walk_minute_band_score` for Match/Living accessibility.
    """
    if np.isscalar(minutes):
        m = float(minutes)
        if not np.isfinite(m):
            return pd.Series([0.0])
        effective = max(0.0, m - plateau)
        return pd.Series([float(np.clip(100.0 * np.exp(-effective / max(decay, 0.1)), 0, 100))])
    s = pd.Series(minutes).astype(float)
    effective = (s.clip(lower=0) - plateau).clip(lower=0)
    return (100.0 * np.exp(-effective / max(decay, 0.1))).clip(0, 100).round(1)


def daily_needs_availability(minutes: pd.Series, decay: float = 6.0) -> pd.Series:
    """Walk-minute accessibility via piecewise bands (Match Score curves)."""
    del decay  # unused — bands replace per-amenity exponential decay
    return walk_minute_band_score(minutes)


def daily_needs_log_score(raw: pd.Series, ref: float = 320.0) -> pd.Series:
    """Log-compress weighted coverage — diminishing returns at top."""
    x = raw.astype(float).clip(lower=0)
    log_s = 100 * np.log1p(x) / np.log1p(ref)
    return _interp(log_s, [0, 35, 50, 62, 72, 82, 92], [0, 18, 35, 48, 58, 65, 70], below=0, above=70)


def daily_needs_distance_score(dist_m: pd.Series) -> pd.Series:
    """Walk distance to nearest essential POI — steep: 300 m ≠ 800 m."""
    return _interp(dist_m, [0, 200, 400, 600, 1000, 2000], [100, 88, 68, 45, 20, 5], below=100, above=0)


def daily_needs_final(coverage_score: pd.Series, distance_score: pd.Series) -> pd.Series:
    """Legacy blend — prefer :func:`daily_life_from_groups`."""
    return (0.40 * coverage_score.astype(float) + 0.60 * distance_score.astype(float)).clip(0, 100).round(1)


def daily_life_from_groups(group_scores: dict[str, pd.Series], weights: dict[str, float]) -> pd.Series:
    """Weighted daily-life from amenity groups (max amenity score per group)."""
    total_w = sum(weights.values()) or 1.0
    acc = None
    for key, w in weights.items():
        part = group_scores.get(key)
        if part is None:
            continue
        term = part.astype(float).fillna(0) * (w / total_w)
        acc = term if acc is None else acc + term
    if acc is None:
        return pd.Series(dtype=float)
    return acc.clip(0, 100).round(1)


def city_normalize(
    raw: pd.Series,
    city_type: str = "LARGE_CITY",
    metric: str = "generic",
    *,
    rank_blend: float | None = None,
    strictness: float | None = None,
) -> pd.Series:
    """Raw → city-context score: blend within-city rank with type-shifted absolute.

    METROPOLIS is stricter (same raw → lower type curve); SMALL_CITY more generous.
    """
    from . import config

    params = config.CITY_NORM_PARAMS.get(city_type) or config.CITY_NORM_PARAMS["LARGE_CITY"]
    rb = float(rank_blend if rank_blend is not None else params["rank_blend"])
    strict = float(strictness if strictness is not None else params["strictness"])

    x = raw.astype(float)
    n = len(x)
    if n == 0:
        return x
    if n == 1:
        return x.clip(0, 100).round(1)

    # Within-city percentile rank → 0–100.
    order = np.argsort(x.to_numpy(), kind="mergesort")
    ranks = np.empty(n, dtype=float)
    ranks[order] = np.arange(n, dtype=float)
    rank100 = pd.Series(100.0 * ranks / (n - 1), index=x.index)

    # Type curve: power transform of absolute score (strictness > 1 compresses highs).
    abs_clipped = x.clip(0, 100) / 100.0
    type_curve = (np.power(abs_clipped.clip(lower=0), strict) * 100.0)

    # Metric-specific mild tweaks.
    if metric in ("daily_life", "walk", "transit") and city_type == "METROPOLIS":
        type_curve = type_curve * 0.95
    if metric in ("daily_life", "walk") and city_type in ("MEDIUM_CITY", "SMALL_CITY"):
        type_curve = (type_curve * 1.08).clip(0, 100)

    out = (rb * rank100 + (1.0 - rb) * type_curve).clip(0, 100)
    return out.round(1)


def living_score_composite(
    metrics: dict[str, pd.Series] | None = None,
    weights: dict[str, float] | None = None,
    *,
    daily_life: pd.Series | None = None,
    walking_quality: pd.Series | None = None,
    transit: pd.Series | None = None,
    urban_form: pd.Series | None = None,
) -> pd.Series:
    """7-metric Living Score (foundation rewrite).

    Legacy kwargs (daily_life/walking/transit/urban_form) still accepted for
    older callers — mapped into the new weight set when ``metrics`` is omitted.
    """
    from . import config

    w = dict(weights or config.LIVING_SCORE_WEIGHTS)
    if metrics is None:
        metrics = {}
        if daily_life is not None:
            metrics["daily_life"] = daily_life
        if walking_quality is not None:
            metrics["walk"] = walking_quality
            metrics["walking_quality"] = walking_quality
        if transit is not None:
            metrics["transit"] = transit
        if urban_form is not None:
            # Legacy: fold urban_form into centrality proxy weight if needed.
            metrics["centrality"] = urban_form

    keys = ["daily_life", "walk", "green", "transit", "centrality", "quiet", "housing_value"]
    # Alias resolution
    alias = {
        "walk": ("walk", "walking_quality"),
        "centrality": ("centrality", "center", "s_center"),
        "quiet": ("quiet", "noise"),
        "housing_value": ("housing_value", "price"),
    }
    total_w = 0.0
    acc = None
    index = None
    for key in keys:
        series = metrics.get(key)
        if series is None:
            for alt in alias.get(key, ()):
                if alt in metrics:
                    series = metrics[alt]
                    break
        if series is None:
            continue
        ww = float(w.get(key, 0) or w.get("walking_quality" if key == "walk" else key, 0) or 0)
        if ww <= 0:
            continue
        total_w += ww
        term = series.astype(float).fillna(50) * ww
        acc = term if acc is None else acc + term
        index = series.index
    if acc is None or total_w <= 0:
        return pd.Series(50.0, index=index if index is not None else None)
    raw = (acc / total_w).astype(float)
    # Mild contrast expand so composites keep map discrimination after averaging
    # correlated pillars (target München p90−p10 ≥ 40, mean in mid-50s band).
    mu = float(raw.mean()) if len(raw) else 50.0
    stretched = (mu + (raw - mu) * 1.22 + 1.0).clip(0, 100)
    return stretched.round(1)


def housing_value_score(
    affordability: pd.Series,
    daily_life: pd.Series,
    transit: pd.Series,
    walk: pd.Series,
) -> pd.Series:
    """Quality of life per euro — cheap alone is not enough."""
    access = 0.5 * transit.astype(float) + 0.5 * walk.astype(float)
    return (
        0.50 * affordability.astype(float)
        + 0.25 * daily_life.astype(float)
        + 0.25 * access
    ).clip(0, 100).round(1)


def centrality_index(
    center_distance_score: pd.Series,
    destination_access_score: pd.Series,
) -> pd.Series:
    """80% activity-center proximity + 20% important destinations."""
    return (
        0.80 * center_distance_score.astype(float)
        + 0.20 * destination_access_score.astype(float)
    ).clip(0, 100).round(1)


def density_sweet_spot_score(density_per_km2: pd.Series) -> pd.Series:
    """European urban density sweet-spot — mid-high best; extremes capped."""
    return _interp(
        density_per_km2,
        [500, 1500, 3000, 6000, 10000, 15000, 25000],
        [15, 45, 75, 95, 88, 72, 55],
        below=5,
        above=45,
    )


def mixed_use_balance_score(residential_share: pd.Series, commercial_share: pd.Series) -> pd.Series:
    """Reward balanced residential/commercial mix; penalise mono-use."""
    res = residential_share.astype(float).clip(0, 1)
    com = commercial_share.astype(float).clip(0, 1)
    # Ideal: both present; geometric mean of presence, plus mild balance bonus.
    presence = np.sqrt((res * 2).clip(0, 1) * (com * 4).clip(0, 1))
    balance = 1.0 - (res - com).abs()
    raw = 100 * (0.65 * presence + 0.35 * balance * presence)
    return pd.Series(raw, index=res.index).clip(0, 100).round(1)


def urban_form_green_balance(
    density_score: pd.Series,
    green_share_pct: pd.Series,
) -> pd.Series:
    """High density without green should not reach the top of the scale."""
    dens = density_score.astype(float)
    green = green_share_pct.astype(float).fillna(0)
    green_ok = _interp(green, [0, 3, 8, 15, 25], [0.55, 0.70, 0.85, 0.95, 1.0], below=0.5, above=1.0)
    # Cap very dense+green-poor hexes below ~88.
    capped = dens * green_ok
    return capped.clip(0, 100).round(1)


# ---- Center (exponential decay) ---------------------------------------------

def center_distance_km(minutes: pd.Series, km_per_min: float = 0.38) -> pd.Series:
    """Approximate path distance from travel-time minutes."""
    return minutes.astype(float).clip(lower=0) * km_per_min


def center_distance_score(distance_km: pd.Series) -> pd.Series:
    """Piecewise km falloff: 0–2 km ≈ 100, 2–5 → 70–90, 5–10 → 30–70, 10+ → 0–30."""
    return _interp(
        distance_km,
        [0, 2, 3.5, 5, 7.5, 10, 15, 20],
        [100, 100, 90, 80, 60, 45, 25, 10],
        below=100,
        above=5,
    )


def center_exponential_score(
    distance_km: pd.Series,
    decay_km: float = 7.2,
) -> pd.Series:
    """Centrality: 100 * exp(-km / decay). Decay ≈7.2 fits 1→90, 5→50, 15→10."""
    d = distance_km.astype(float).clip(lower=0)
    return (100 * np.exp(-d / max(decay_km, 0.1))).clip(0, 100).round(1)


def center_exponential_from_minutes(
    minutes: pd.Series,
    km_per_min: float = 0.35,
    decay_km: float = 7.2,
) -> pd.Series:
    return center_exponential_score(center_distance_km(minutes, km_per_min), decay_km=decay_km)


def center_polycentric_exponential(
    minutes_by_id: dict[str, pd.Series],
    anchors: list[dict],
    km_per_min: float = 0.35,
    decay_km: float = 7.2,
) -> pd.Series:
    """Best pole by exponential decay — polycentric without step artefacts."""
    if not minutes_by_id or not anchors:
        return pd.Series(50.0)
    parts: list[pd.Series] = []
    for a in anchors:
        col = minutes_by_id.get(a["id"])
        if col is None:
            continue
        base = center_exponential_from_minutes(col, km_per_min, decay_km=decay_km)
        if a["id"] != anchors[0]["id"]:
            w = float(a.get("weight", 1.0))
            base = (base * w).clip(0, 100).round(1)
        parts.append(base)
    if not parts:
        return pd.Series(50.0)
    out = parts[0]
    for s in parts[1:]:
        out = pd.Series(np.maximum(out.values, s.values), index=out.index)
    return out.round(1)


# ---- Center (anchor-based, legacy piecewise) --------------------------------

def center_anchor_score(minutes: pd.Series) -> pd.Series:
    """Anchored centrality — steep falloff (Altstadt≈100, Feldmoching≈18)."""
    return _interp(minutes, [6, 12, 16, 20, 28, 32, 40, 48], [100, 92, 86, 72, 58, 46, 33, 18], below=100, above=0)


def center_anchor_strict(minutes: pd.Series) -> pd.Series:
    """Harsh curve for Kritisch / diagnose strict view."""
    return _interp(minutes, [5, 8, 12, 16, 22, 30, 40], [100, 70, 45, 25, 10, 3, 0], below=100, above=0)


def center_polycentric_score(
    minutes_by_id: dict[str, pd.Series],
    anchors: list[dict],
) -> pd.Series:
    """Best weighted anchor score — Marienplatz/Hbf/Ost poles for Munich."""
    if not minutes_by_id or not anchors:
        return pd.Series(50.0)
    primary_id = anchors[0]["id"]
    parts: list[pd.Series] = []
    for a in anchors:
        col = minutes_by_id.get(a["id"])
        if col is None:
            continue
        base = center_anchor_score(col)
        w = float(a.get("weight", 1.0))
        if a["id"] == primary_id:
            parts.append(base)
        else:
            parts.append((base * w).clip(0, 100).round(1))
    if not parts:
        return pd.Series(50.0)
    out = parts[0]
    for s in parts[1:]:
        out = pd.Series(np.maximum(out.values, s.values), index=out.index)
    return out.round(1)


def daily_needs_city_relative(raw: pd.Series) -> pd.Series:
    """Stretch raw composite to city p10–p90 — TOP districts → 100, weak → ~0."""
    x = raw.astype(float)
    lo = float(np.percentile(x, 10))
    hi = float(np.percentile(x, 90))
    if hi <= lo + 1:
        return pd.Series(50.0, index=x.index)
    norm = ((x - lo) / (hi - lo)).clip(0, 1)
    return (norm * 100).round(1)


# ---- Noise (quiet = high score) ---------------------------------------------

def noise_quiet_score(db: pd.Series) -> pd.Series:
    """Quiet = high. Harsh absolute + city-calibrated log mapping.

    Road / rail / airport exposure should materially change Living Score.
    """
    x = db.astype(float)
    # Absolute harsh curve first (typical urban dB proxy bands).
    absolute = _interp(
        x,
        [45, 52, 58, 62, 68, 75, 85],
        [100, 85, 65, 45, 25, 10, 0],
        below=100,
        above=0,
    )
    lo = float(np.percentile(x, 5))
    hi = float(np.percentile(x, 95))
    if hi <= lo + 1:
        return absolute.round(1)
    log_lo = float(np.log1p(max(lo, 0.0)))
    log_hi = float(np.log1p(max(hi, 0.0)))
    if log_hi <= log_lo + 1e-6:
        return absolute.round(1)
    log_x = np.log1p(x.clip(lower=0))
    relative = ((log_hi - log_x) / (log_hi - log_lo)).clip(0, 1) * 100
    # Emphasise absolute harshness so loud corridors stay low.
    quiet = 0.55 * absolute + 0.45 * relative
    return pd.Series(quiet, index=x.index).clip(0, 100).round(1)


# ---- Straßenrisiko (traffic safety proxy) -----------------------------------

def traffic_safety_lenient(raw_score: pd.Series) -> pd.Series:
    """Deprecated city-relative stretch — inflates 80–90 cluster to 90–100 band."""
    x = raw_score.astype(float)
    lo = float(np.percentile(x, 10))
    hi = float(np.percentile(x, 90))
    if hi <= lo + 0.5:
        return pd.Series(50.0, index=x.index)
    return (((x - lo) / (hi - lo)).clip(0, 1) * 100).round(1)


def traffic_safety_score(
    road_risk: pd.Series,
    accident_density: pd.Series | None = None,
    road_length_m: pd.Series | None = None,
    speed_risk: pd.Series | None = None,
    ped_infra: pd.Series | None = None,
) -> pd.Series:
    """50% accidents + 25% traffic volume + 15% speed + 10% pedestrian infra."""
    road_score = _interp(
        road_risk,
        [0.10, 0.16, 0.22, 0.30, 0.38, 0.48, 0.58],
        [100, 78, 58, 42, 28, 14, 0],
        below=100,
        above=0,
    )
    if accident_density is None and road_length_m is None:
        return road_score

    acc = accident_density.astype(float).fillna(0) if accident_density is not None else pd.Series(0, index=road_risk.index)
    has_accidents = float(acc.max()) > 0.05
    if has_accidents:
        acc_score = _interp(acc, [0, 0.5, 1.5, 3.0, 6.0, 12.0], [100, 82, 62, 40, 18, 0], below=100, above=0)
    else:
        acc_score = road_score

    if road_length_m is not None:
        vol = road_length_m.astype(float).fillna(0)
        # High road length alone ≠ busy traffic; use length as mild congestion proxy only.
        lo = float(np.percentile(vol, 25))
        hi = float(np.percentile(vol, 75))
        vol_risk = ((vol - lo) / max(hi - lo, 1)).clip(0, 1) * 0.5
        vol_score = (100 * (1 - vol_risk)).round(1)
    else:
        vol_score = road_score

    if speed_risk is not None:
        spd = speed_risk.astype(float).fillna(0.5)
        spd_score = _interp(spd, [0.15, 0.25, 0.35, 0.45, 0.55, 0.70], [100, 75, 55, 35, 18, 0], below=100, above=0)
    else:
        spd_score = road_score

    if ped_infra is not None:
        ped = ped_infra.astype(float).fillna(0)
        ped_score = _interp(ped, [0, 0.05, 0.10, 0.15, 0.25], [40, 55, 70, 85, 100], below=40, above=100)
    else:
        ped_score = pd.Series(55.0, index=road_risk.index)

    return (
        0.50 * acc_score
        + 0.20 * vol_score
        + 0.20 * spd_score
        + 0.10 * ped_score
    ).clip(0, 100).round(1)


def traffic_safety_strict(road_risk: pd.Series) -> pd.Series:
    """Absolute road-risk thresholds (low risk → high score)."""
    return _interp(road_risk, [0.17, 0.22, 0.30, 0.38, 0.48, 0.58], [100, 68, 42, 22, 8, 0], below=100, above=0)
