"""Value Opportunity Index v1.2 — independent analytical layer.

Classes: hidden_gem | good_value | overpriced | normal

Does NOT modify Living Score or Match Score.

Fair-rent model estimates what an area *should* cost given quality of life
(not a least-squares fit of observed market rents).

Score =
  40% adjusted price advantage
+ 25% local neighborhood advantage
+ 20% Living Score quality
+ 10% market confidence
+  5% residential quality
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from pipeline import config

try:
    import h3
except ImportError:  # pragma: no cover
    h3 = None  # type: ignore

# H3 res 9: k=4 ≈ 1.0–1.2 km (within 500–1500 m).
DEFAULT_NEIGHBOR_K = config.VOI_NEIGHBOR_K

RESIDENTIAL_QUALITY_MIN = 50.0
HIDDEN_GEM_MIN_GAP = 0.05  # must be ≥5% cheaper than fair rent
OVERPRICED_MAX_GAP = -0.15  # ≤ −15% after premium adjustment
OVERPRICED_MIN_LIVING = 70.0
OVERPRICED_MAX_PREMIUM = 70.0

# Adaptive Hidden Gem cutoffs (percentile of VOI score).
HIDDEN_GEM_PCTL_BY_CITY = {
    "METROPOLIS": 95.0,  # top 5%
    "LARGE_CITY": 94.0,  # top 6%
    "MEDIUM_CITY": 93.0,  # top 7%
    "SMALL_CITY": 90.0,  # top 10%
}
GOOD_VALUE_PCTL = 80.0  # top 20%

# Comparable-neighbour windows
LIVING_SIM_DELTA = 12.0
CENTER_SIM_DELTA = 20.0
RQ_SIM_DELTA = 20.0

# City-size rent-curve elasticity (how strongly fair score moves rent).
_CITY_RENT_ELASTICITY = {
    "METROPOLIS": 1.15,
    "LARGE_CITY": 1.05,
    "MEDIUM_CITY": 0.95,
    "SMALL_CITY": 0.85,
}

_CITY_SIZE_SCORE = {
    "METROPOLIS": 85.0,
    "LARGE_CITY": 70.0,
    "MEDIUM_CITY": 50.0,
    "SMALL_CITY": 30.0,
}

_RESIDENTIAL_SERVICE_COLS = (
    "dn_supermarket_avail",
    "dn_bakery_avail",
    "dn_pharmacy_avail",
    "dn_doctor_avail",
    "dn_kita_avail",
    "dn_school_avail",
)


def _rank100(series: pd.Series) -> pd.Series:
    x = series.astype(float)
    n = len(x)
    if n <= 1:
        return pd.Series(50.0, index=x.index)
    order = np.argsort(x.to_numpy(), kind="mergesort")
    ranks = np.empty(n, dtype=float)
    ranks[order] = np.arange(n, dtype=float)
    return pd.Series(100.0 * ranks / (n - 1), index=x.index)


def _col(df: pd.DataFrame, name: str, default: float = 0.0) -> pd.Series:
    if name in df.columns:
        return df[name].astype(float)
    return pd.Series(default, index=df.index, dtype=float)


def _interp_score(x: pd.Series, xs: list[float], ys: list[float]) -> pd.Series:
    return pd.Series(
        np.interp(x.astype(float).fillna(0).to_numpy(), xs, ys),
        index=x.index,
    )


def residential_quality_score(df: pd.DataFrame) -> pd.Series:
    """Residential Quality v2 — continuous fabric score (industrial / empty → low)."""
    res = _col(df, "landuse_residential_share").clip(0, 1)
    com = _col(df, "landuse_commercial_share").clip(0, 1)
    daily = _col(df, "s_daily_life", 50.0).clip(0, 100)
    landuse_ok = bool((res > 0.05).mean() >= 0.08 or float(res.mean()) >= 0.04)

    svc_parts = [_col(df, c).clip(0, 100) for c in _RESIDENTIAL_SERVICE_COLS if c in df.columns]
    services = (sum(svc_parts) / len(svc_parts)) if svc_parts else daily

    # 30% housing density
    building = _col(df, "building_count")
    if landuse_ok and building.notna().any() and float(building.fillna(0).max()) > 0:
        housing_density = 0.55 * _rank100(building.fillna(0)) + 0.45 * _interp_score(
            res,
            [0, 0.05, 0.15, 0.35, 0.7, 1.0],
            [0, 15, 40, 70, 90, 100],
        )
    else:
        housing_density = (0.55 * daily + 0.45 * services).clip(0, 100)

    # 25% population density
    pop = _col(df, "population_density")
    if float(pop.max() - pop.min()) >= 50:
        pop_density = _interp_score(
            pop.fillna(0),
            [0, 500, 1500, 4000, 8000, 15000],
            [0, 20, 45, 70, 90, 100],
        )
    else:
        activity = _col(df, "urban_activity")
        if float(activity.max()) <= 0 and "business_count" in df.columns:
            activity = _col(df, "business_count")
        act_term = (np.log1p(activity.clip(lower=0)) * 6.0).clip(upper=25.0)
        pop_density = (res * 70.0 + act_term).where(res >= 0.05, res * 40.0).clip(0, 100)
        if not landuse_ok:
            pop_density = _rank100(daily)

    # 20% residential building share
    res_share = _interp_score(res, [0, 0.05, 0.15, 0.35, 0.7, 1.0], [0, 12, 40, 70, 90, 100])
    if not landuse_ok:
        res_share = (0.6 * daily + 0.4 * services).clip(0, 100)

    # 15% daily services
    daily_services = (0.6 * services + 0.4 * daily).clip(0, 100)

    # 10% housing market activity (rent presence + housing quality / listings proxy)
    housing = _col(df, "s_housing") if "s_housing" in df.columns else _col(df, "housing_quality_score")
    has_rent = (
        df["rent_eur_m2"].notna() & (df["rent_eur_m2"].astype(float) > 0)
        if "rent_eur_m2" in df.columns
        else pd.Series(False, index=df.index)
    )
    if float(housing.max() - housing.min()) >= 5:
        market = (0.7 * housing.clip(0, 100) + 0.3 * has_rent.astype(float) * 100.0).clip(0, 100)
    else:
        market = (res_share * 0.7 + has_rent.astype(float) * 30.0).clip(0, 100)

    score = (
        0.30 * housing_density + 0.25 * pop_density + 0.20 * res_share + 0.15 * daily_services + 0.10 * market
    )
    if landuse_ok:
        # Hard filters only when landuse coverage is trustworthy.
        score = score.where(~((com >= 0.30) & (res < 0.12)), score * 0.35)
        score = score.where(~(res < 0.03), np.minimum(score, 28.0))
        score = score.where(res >= 0.08, np.minimum(score, 45.0))
    else:
        # Fallback cities (sparse OSM landuse): gate on services, not empty shares.
        score = score.where(~((daily < 45) & (services < 40)), np.minimum(score, 40.0))

    return score.clip(0, 100).round(1)


def location_premium_score(df: pd.DataFrame) -> pd.Series:
    """Legitimate price-premium drivers (0–100). High → expensive can still be fair."""
    central = _col(df, "s_center", 50.0).clip(0, 100)

    # Employment proximity — business / urban activity
    if "s_business" in df.columns:
        employ = _col(df, "s_business", 50.0).clip(0, 100)
    elif "s_urban_activity" in df.columns:
        employ = _col(df, "s_urban_activity", 50.0).clip(0, 100)
    else:
        activity = _col(df, "urban_activity")
        if float(activity.max()) > 0:
            employ = _rank100(activity.fillna(0))
        else:
            employ = central * 0.8

    # University / education
    edu_parts = []
    if "dl_education" in df.columns:
        edu_parts.append(_col(df, "dl_education").clip(0, 100))
    if "dn_school_avail" in df.columns:
        edu_parts.append(_col(df, "dn_school_avail").clip(0, 100))
    if "dn_kita_avail" in df.columns:
        edu_parts.append(_col(df, "dn_kita_avail").clip(0, 100) * 0.7)
    education = (sum(edu_parts) / len(edu_parts)) if edu_parts else (_col(df, "s_daily_life", 50.0) * 0.6)

    # Historical / civic core — strict centrality + primary-centre travel time
    if "s_center_strict" in df.columns:
        historic = _col(df, "s_center_strict", 50.0).clip(0, 100)
    elif "center_min" in df.columns:
        historic = _interp_score(
            _col(df, "center_min", 30.0),
            [0, 5, 10, 20, 35, 60],
            [100, 90, 70, 45, 20, 5],
        )
    else:
        historic = central

    # Tourism / landmark influence — F&B + commercial activity near centre
    tour_parts = []
    if "dl_restaurants_cafes" in df.columns:
        tour_parts.append(_col(df, "dl_restaurants_cafes").clip(0, 100))
    if "dn_restaurant_avail" in df.columns:
        tour_parts.append(_col(df, "dn_restaurant_avail").clip(0, 100))
    if "dn_cafe_avail" in df.columns:
        tour_parts.append(_col(df, "dn_cafe_avail").clip(0, 100))
    if tour_parts:
        tourism = 0.7 * (sum(tour_parts) / len(tour_parts)) + 0.3 * central
    else:
        tourism = 0.5 * employ + 0.5 * central

    return (
        (0.30 * central + 0.20 * employ + 0.20 * education + 0.15 * historic + 0.15 * tourism)
        .clip(0, 100)
        .round(1)
    )


def fair_rent_score(df: pd.DataFrame, *, city_type: str) -> pd.Series:
    """0–100 'what should this cost given quality' — not a market fit."""
    living = _col(df, "s_living", 50.0).clip(0, 100)
    center = _col(df, "s_center", 50.0).clip(0, 100)
    walk = _col(df, "s_walk", 50.0).clip(0, 100)
    if float(walk.max() - walk.min()) < 1 and "s_walking_quality" in df.columns:
        walk = _col(df, "s_walking_quality", 50.0).clip(0, 100)
    transit = _col(df, "s_transit", 50.0).clip(0, 100)
    daily = _col(df, "s_daily_life", 50.0).clip(0, 100)
    green = _col(df, "s_green", 50.0).clip(0, 100)
    city_adj = float(_CITY_SIZE_SCORE.get(city_type, 50.0))

    return (
        0.30 * living
        + 0.20 * center
        + 0.15 * walk
        + 0.10 * transit
        + 0.10 * daily
        + 0.10 * green
        + 0.05 * city_adj
    ).clip(0, 100)


def fair_rent_range(
    fair_score: pd.Series,
    rent: pd.Series,
    *,
    city_type: str,
) -> tuple[pd.Series, pd.Series, pd.Series]:
    """Map fair-score → (min, median, max) €/m² using city rent anchors.

    Intentionally *not* OLS against actual rent (that reproduces the market).
    Uses city distribution anchors + quality elasticity so undervalued /
    overpriced residuals remain informative.
    """
    r = rent.astype(float)
    mask = r.notna() & (r > 0)
    if int(mask.sum()) < 8:
        med = float(r[mask].median()) if mask.any() else 15.0
        s = pd.Series(med, index=fair_score.index)
        return s * 0.92, s, s * 1.08

    y = r[mask].to_numpy()
    # Anchors: low / mid / high fair quality → rent levels
    # Mid sits below city median so typical areas aren't "fair = market".
    p15 = float(np.percentile(y, 15))
    p40 = float(np.percentile(y, 40))
    p75 = float(np.percentile(y, 75))
    p90 = float(np.percentile(y, 90))

    elasticity = float(_CITY_RENT_ELASTICITY.get(city_type, 1.0))
    # Score 0→p15, 50→blend(p40,p75), 100→p90 * elasticity stretch
    score = fair_score.astype(float).clip(0, 100).to_numpy()
    t = score / 100.0
    # Ease-in curve so mid-high quality doesn't jump to top market rents
    t_adj = np.power(t, 0.85 + 0.1 * (elasticity - 1.0))
    low_anchor = p15
    mid_anchor = 0.65 * p40 + 0.35 * float(np.percentile(y, 50))
    high_anchor = p75 + (p90 - p75) * min(elasticity, 1.25)

    median = np.where(
        t_adj <= 0.5,
        low_anchor + (mid_anchor - low_anchor) * (t_adj / 0.5),
        mid_anchor + (high_anchor - mid_anchor) * ((t_adj - 0.5) / 0.5),
    )
    # Uncertainty band widens for mid scores / sparse cities
    band = 0.06 + 0.04 * (1.0 - np.abs(t_adj - 0.5) * 2.0)
    lo = np.clip(median * (1.0 - band), max(p15 * 0.75, 4.0), None)
    hi = median * (1.0 + band)

    idx = fair_score.index
    return (
        pd.Series(lo, index=idx).round(2),
        pd.Series(median, index=idx).round(2),
        pd.Series(hi, index=idx).round(2),
    )


def _neighbor_stats(
    df: pd.DataFrame,
    *,
    k: int,
    residential: pd.Series,
) -> tuple[pd.Series, pd.Series, pd.Series, pd.Series]:
    """Return local_value_advantage (€/m²), comparable count, cheaper-alt flag, uniqueness."""
    living = df["s_living"].astype(float)
    center = _col(df, "s_center", 50.0)
    rent = df["rent_eur_m2"].astype(float)
    n = len(df)
    local_adv = np.zeros(n)
    counts = np.zeros(n)
    cheaper_alts = np.zeros(n, dtype=bool)
    uniqueness = np.full(n, 50.0)

    if h3 is None or "h3_index" not in df.columns:
        return (
            pd.Series(local_adv, index=df.index),
            pd.Series(counts, index=df.index),
            pd.Series(cheaper_alts, index=df.index),
            pd.Series(uniqueness, index=df.index),
        )

    cells = df["h3_index"].astype(str).to_numpy()
    by_h3 = {
        c: (
            float(living.iloc[i]),
            float(center.iloc[i]),
            float(rent.iloc[i]),
            float(residential.iloc[i]) if pd.notna(residential.iloc[i]) else 50.0,
            i,
        )
        for i, c in enumerate(cells)
        if np.isfinite(living.iloc[i]) and np.isfinite(rent.iloc[i]) and rent.iloc[i] > 0
    }

    for i, cell in enumerate(cells):
        own_liv = float(living.iloc[i])
        own_ctr = float(center.iloc[i])
        own_rent = float(rent.iloc[i])
        own_rq = float(residential.iloc[i]) if pd.notna(residential.iloc[i]) else 50.0
        if not np.isfinite(own_liv) or not np.isfinite(own_rent) or own_rent <= 0:
            continue
        try:
            disk = h3.grid_disk(cell, k)
        except Exception:  # noqa: BLE001
            continue
        comp_rents = []
        for nb in disk:
            if nb == cell or nb not in by_h3:
                continue
            nliv, nctr, nrent, nrq, _ = by_h3[nb]
            if (
                abs(nliv - own_liv) <= LIVING_SIM_DELTA
                and abs(nctr - own_ctr) <= CENTER_SIM_DELTA
                and abs(nrq - own_rq) <= RQ_SIM_DELTA
            ):
                comp_rents.append(nrent)
        if not comp_rents:
            continue
        med = float(np.median(comp_rents))
        local_adv[i] = med - own_rent  # + = cheaper than similar neighbours
        counts[i] = len(comp_rents)
        cheaper_alts[i] = any(cr < own_rent * 0.92 for cr in comp_rents)
        # Uniqueness: how much cheaper vs similar peers (for gem strength)
        if med > 0:
            uniqueness[i] = float(np.clip(50.0 + 50.0 * ((med - own_rent) / med), 0, 100))

    return (
        pd.Series(local_adv, index=df.index),
        pd.Series(counts, index=df.index),
        pd.Series(cheaper_alts, index=df.index),
        pd.Series(uniqueness, index=df.index),
    )


def _confidence_labels(
    df: pd.DataFrame,
    *,
    comparable_count: pd.Series,
    residential: pd.Series,
) -> tuple[pd.Series, pd.Series]:
    """HIGH / MEDIUM / LOW with numeric score for VOI blend."""
    labels: list[str] = []
    scores: list[float] = []
    rent_conf = df["rent_confidence"] if "rent_confidence" in df.columns else None
    has_rent = (
        df["rent_eur_m2"].notna() & (df["rent_eur_m2"].astype(float) > 0)
        if "rent_eur_m2" in df.columns
        else pd.Series(False, index=df.index)
    )

    for i in df.index:
        rq = float(residential.loc[i]) if pd.notna(residential.loc[i]) else 0.0
        n_comp = float(comparable_count.loc[i]) if pd.notna(comparable_count.loc[i]) else 0.0
        rc = str(rent_conf.loc[i]).lower() if rent_conf is not None else ""
        market_ok = bool(has_rent.loc[i]) and rc not in {"missing", "none"}

        if rq > 70 and market_ok and n_comp > 10:
            labels.append("high")
            scores.append(90.0)
        elif rq > 50 and market_ok:
            labels.append("medium")
            scores.append(60.0)
        else:
            labels.append("low")
            scores.append(30.0)

    return pd.Series(labels, index=df.index), pd.Series(scores, index=df.index)


def _gem_strength(
    *,
    adjusted_gap: pd.Series,
    living: pd.Series,
    uniqueness: pd.Series,
    cls: pd.Series,
) -> pd.Series:
    """0–100 strength for border thickness (gems/good value)."""
    gap_term = (adjusted_gap.clip(0, 0.35) / 0.35 * 100.0).fillna(0)
    living_term = living.clip(0, 100)
    uniq_term = uniqueness.clip(0, 100)
    raw = 0.50 * gap_term + 0.30 * living_term + 0.20 * uniq_term
    # Scale into visualization bands; non-gems get 0
    strength = raw.clip(0, 100)
    strength = strength.where(cls.isin(["hidden_gem", "good_value"]), 0.0)
    # Boost hidden gems into 70–100 band for map borders
    strength = strength.where(
        cls != "hidden_gem",
        (70.0 + 0.30 * strength).clip(70, 100),
    )
    strength = strength.where(
        cls != "good_value",
        (55.0 + 0.25 * strength).clip(50, 85),
    )
    return strength.round(1)


def _explain_row(
    *,
    cls: str,
    living: float,
    adjusted_gap: float,
    local_adv: float,
    center: float,
    walk: float,
    green: float,
    transit: float,
    daily: float,
    location_premium: float,
    confidence: str,
) -> str:
    if cls in {"normal", "none", ""}:
        return ""

    if cls == "overpriced":
        lines = [
            "High-quality but expensive compared with similar locations.",
            "Reasons:",
        ]
        if location_premium >= 60 or center >= 70:
            lines.append("+ Excellent location")
        if living >= 70:
            lines.append("+ High living quality")
        lines.append("Negative:")
        if adjusted_gap < 0:
            lines.append(f"- {abs(adjusted_gap) * 100:.0f}% price premium vs fair rent")
        if local_adv < 0:
            lines.append("- Similar quality available cheaper nearby")
        if len(lines) <= 3:
            lines.append("- Price premium exceeds location value")
        return "\n".join(lines)

    if cls == "hidden_gem":
        lines = ["High quality neighborhood below expected price.", "Reasons:"]
    else:
        lines = ["Good value relative to quality and nearby prices.", "Reasons:"]

    if adjusted_gap >= 0.05:
        lines.append(f"+ {adjusted_gap * 100:.0f}% cheaper than fair rent")
    if local_adv >= 1.0:
        lines.append(f"+ {local_adv:.0f} €/m² cheaper than comparable areas")
    if walk >= 70:
        lines.append("+ High walking quality")
    if daily >= 70:
        lines.append("+ Strong daily infrastructure")
    if green >= 70:
        lines.append("+ Green areas nearby")
    if transit >= 70:
        lines.append("+ Strong transit access")
    if living >= 60:
        lines.append(f"+ Living Score {living:.0f}")

    trade: list[str] = []
    if center < 35:
        trade.append("- Further from city center")
    if transit < 45:
        trade.append("- Lower transit access")
    if confidence == "low":
        trade.append("- Lower data confidence")
    if trade:
        lines.append("Trade-offs:")
        lines.extend(trade[:2])
    return "\n".join(lines)


def compute_value_opportunity(
    df: pd.DataFrame,
    *,
    city_type: str = "LARGE_CITY",
    neighbor_k: int = DEFAULT_NEIGHBOR_K,
) -> pd.DataFrame:
    """Attach VOI v1.2 columns. Living Score columns are never modified."""
    ct = (city_type or "LARGE_CITY").upper()
    if ct not in HIDDEN_GEM_PCTL_BY_CITY:
        ct = "LARGE_CITY"

    out = df
    n = len(out)
    empty_cols = {
        "s_value_opportunity": np.nan,
        "s_value_opportunity_raw": np.nan,
        "voi_class": "normal",
        "voi_confidence": "low",
        "voi_fair_rent_min": np.nan,
        "voi_fair_rent_max": np.nan,
        "voi_fair_rent_median": np.nan,
        "voi_expected_rent_eur_m2": np.nan,  # back-compat = fair median
        "voi_price_gap": np.nan,  # back-compat = adjusted gap
        "voi_adjusted_price_gap": np.nan,
        "voi_location_premium": np.nan,
        "voi_local_advantage": np.nan,
        "voi_local_delta": np.nan,
        "voi_local_value_advantage": np.nan,
        "voi_gem_strength": np.nan,
        "voi_explain": "",
        "s_residential_quality": np.nan,
        "voi_highlight": 0,
    }
    if n == 0 or "rent_eur_m2" not in out.columns or "s_living" not in out.columns:
        for col, val in empty_cols.items():
            out[col] = val
        return out

    rent = out["rent_eur_m2"].astype(float)
    living = out["s_living"].astype(float)
    valid = rent.notna() & (rent > 0) & living.notna()

    residential = residential_quality_score(out)
    out["s_residential_quality"] = residential
    premium = location_premium_score(out)

    if int(valid.sum()) < 8:
        for col, val in empty_cols.items():
            if col == "s_residential_quality":
                continue
            out[col] = val
        out["voi_location_premium"] = premium
        return out

    local_adv, comp_count, cheaper_alts, uniqueness = _neighbor_stats(
        out,
        k=neighbor_k,
        residential=residential,
    )

    f_score = fair_rent_score(out, city_type=ct)
    fair_min, fair_med, fair_max = fair_rent_range(f_score, rent, city_type=ct)

    # Fair price gap vs quality-based fair rent (+ = cheaper than fair).
    adjusted_gap = (fair_med - rent) / fair_med.replace(0, np.nan)
    # Location premium dampens only the *score contribution* of overpricing,
    # so legitimate premium neighbourhoods don't tank VOI. Classification uses
    # the raw fair gap plus an explicit premium < 70 gate (see below).
    premium01 = (premium / 100.0).clip(0, 1)
    gap_for_score = adjusted_gap.where(
        adjusted_gap >= 0,
        adjusted_gap * (1.0 - premium01),
    )

    conf_label, conf_score = _confidence_labels(
        out,
        comparable_count=comp_count,
        residential=residential,
    )

    gap_score = _rank100(gap_for_score.where(valid, np.nan)).fillna(50)
    local_score = _rank100(local_adv.where(valid, np.nan)).fillna(50)
    living_score = living.clip(0, 100)
    rq_score = residential.clip(0, 100)

    opp = (
        0.40 * gap_score + 0.25 * local_score + 0.20 * living_score + 0.10 * conf_score + 0.05 * rq_score
    ).clip(0, 100)

    opp_valid = opp.where(valid)
    p_hidden = float(
        np.nanpercentile(
            opp_valid.dropna(),
            HIDDEN_GEM_PCTL_BY_CITY[ct],
        )
    )
    p_good = float(np.nanpercentile(opp_valid.dropna(), GOOD_VALUE_PCTL))

    residential_ok = residential >= RESIDENTIAL_QUALITY_MIN
    conf_ok_gem = conf_label != "low"

    cls = pd.Series("normal", index=out.index)

    # Overpriced: expensive vs fair value, without legitimate location premium
    overpriced = (
        valid
        & (living >= OVERPRICED_MIN_LIVING)
        & (adjusted_gap <= OVERPRICED_MAX_GAP)
        & (premium < OVERPRICED_MAX_PREMIUM)
        & cheaper_alts
        & (conf_label != "low")
    )

    good = valid & residential_ok & (living >= 55) & (opp >= p_good) & (conf_label != "low")
    hidden = (
        valid
        & (living >= 60)
        & residential_ok
        & conf_ok_gem
        & (opp >= p_hidden)
        & (adjusted_gap >= HIDDEN_GEM_MIN_GAP)
    )

    cls = cls.mask(overpriced, "overpriced")
    cls = cls.mask(good, "good_value")
    cls = cls.mask(hidden, "hidden_gem")
    # Low confidence: no strong highlights
    cls = cls.mask((cls.isin(["hidden_gem", "good_value", "overpriced"])) & (conf_label == "low"), "normal")

    gem_strength = _gem_strength(
        adjusted_gap=adjusted_gap,
        living=living,
        uniqueness=uniqueness,
        cls=cls,
    )

    center = _col(out, "s_center", 50.0)
    walk = _col(out, "s_walk", 50.0)
    green = _col(out, "s_green", 50.0)
    transit = _col(out, "s_transit", 50.0)
    daily = _col(out, "s_daily_life", 50.0)

    explains = [
        _explain_row(
            cls=str(cls.loc[i]),
            living=float(living.loc[i]) if pd.notna(living.loc[i]) else 0.0,
            adjusted_gap=float(adjusted_gap.loc[i]) if pd.notna(adjusted_gap.loc[i]) else 0.0,
            local_adv=float(local_adv.loc[i]) if pd.notna(local_adv.loc[i]) else 0.0,
            center=float(center.loc[i]) if pd.notna(center.loc[i]) else 50.0,
            walk=float(walk.loc[i]) if pd.notna(walk.loc[i]) else 50.0,
            green=float(green.loc[i]) if pd.notna(green.loc[i]) else 50.0,
            transit=float(transit.loc[i]) if pd.notna(transit.loc[i]) else 50.0,
            daily=float(daily.loc[i]) if pd.notna(daily.loc[i]) else 50.0,
            location_premium=float(premium.loc[i]) if pd.notna(premium.loc[i]) else 0.0,
            confidence=str(conf_label.loc[i]),
        )
        for i in out.index
    ]

    highlight = (
        cls.map(
            {
                "hidden_gem": 2,
                "good_value": 1,
                "overpriced": 3,
                "normal": 0,
                "none": 0,
            }
        )
        .fillna(0)
        .astype(int)
    )

    out["voi_fair_rent_min"] = fair_min
    out["voi_fair_rent_max"] = fair_max
    out["voi_fair_rent_median"] = fair_med
    out["voi_expected_rent_eur_m2"] = fair_med  # back-compat
    out["voi_adjusted_price_gap"] = adjusted_gap.round(4)
    out["voi_price_gap"] = adjusted_gap.round(4)  # back-compat
    out["voi_location_premium"] = premium
    out["voi_local_advantage"] = local_adv.round(3)
    out["voi_local_value_advantage"] = local_adv.round(3)
    out["voi_local_delta"] = local_adv.round(3)
    out["voi_gem_strength"] = gem_strength
    out["s_value_opportunity"] = opp.round(1)
    out["s_value_opportunity_raw"] = opp.round(1)
    out["voi_class"] = cls
    out["voi_confidence"] = conf_label
    out["voi_explain"] = pd.Series(explains, index=out.index)
    out["voi_highlight"] = highlight
    return out
