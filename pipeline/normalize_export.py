"""Step final - merge factors, normalise to 0-100, export web GeoJSON."""
from __future__ import annotations

import json

import geopandas as gpd
import numpy as np
import pandas as pd

from . import config
from .centers import load_centers
from .city import CityContext, munich_context
from .common import log

from .metric_metadata import METRIC_META
from .city_context import ensure_city_context
from .score_scales import (
    center_anchor_strict,
    center_exponential_from_minutes,
    center_polycentric_exponential,
    centrality_index,
    city_normalize,
    density_sweet_spot_score,
    green_composite_strict,
    green_quality_score,
    housing_value_score,
    living_score_composite,
    noise_quiet_score,
    rent_kalt_lenient,
    rent_kalt_strict,
    rent_percentile_score,
    rent_value_score,
    rent_warm_lenient,
    rent_warm_strict,
    traffic_safety_score,
    traffic_safety_strict,
    _interp,
)
from .factor_center import center_anchors

STEP = "normalize"

P_LOW, P_HIGH = 5, 95
DEFAULT_RENT_AREA_M2 = 60
DEFAULT_NEBENKOSTEN_EUR_M2 = 4.0

METRIC_TYPES = {
    "living": "objective_positive",
    "daily_life": "objective_positive",
    "walk": "objective_positive",
    "walking_quality": "objective_positive",
    "transit": "objective_positive",
    "green": "objective_positive",
    "centrality": "objective_positive",
    "quiet": "objective_positive",
    "housing_value": "objective_positive",
    "urban_form": "objective_positive",
    "center": "objective_positive",
    "daily_needs": "objective_positive",
    "transit_service": "objective_positive",
    "noise": "objective_negative",
    "heat": "objective_negative",
    "traffic_safety": "objective_negative",
    "urban_activity": "preference",
    "density": "preference",
    "housing": "preference",
    "price": "objective_positive",
}


def _scale(series: pd.Series, invert: bool, log_compress: bool = False) -> pd.Series:
    x = series.astype(float).copy()
    if log_compress:
        x = np.log1p(x)
    lo = np.percentile(x, P_LOW)
    hi = np.percentile(x, P_HIGH)
    if hi <= lo:
        return pd.Series(50.0, index=series.index)
    norm = ((x - lo) / (hi - lo)).clip(0, 1)
    if invert:
        norm = 1 - norm
    return (norm * 100).round(1)


def _optional_parquet(ctx: CityContext, name: str) -> pd.DataFrame | None:
    path = ctx.cache(name)
    if path.exists():
        return pd.read_parquet(path)
    return None


def _rent_absolute_legacy(rent: pd.Series) -> pd.Series:
    """Deprecated city-relative-era scale; kept for comparison in exports."""
    r = rent.astype(float)
    score = np.select(
        [r <= 10, r <= 15, r <= 20, r <= 25],
        [100.0, 75.0, 50.0, 25.0],
        default=0.0,
    )
    mask = (r > 25) & (r < 30)
    score = np.where(mask, 25.0 * (30.0 - r) / 5.0, score)
    return pd.Series(score, index=r.index).round(1)


def _green_scores(df: pd.DataFrame) -> tuple[pd.Series, pd.Series]:
    park_dist = df.get("nearest_park_dist_m", df.get("green_dist_m", pd.Series(2000, index=df.index)))
    share = df.get("green_share_inside_500m", pd.Series(0, index=df.index))
    canopy = df.get("tree_canopy_pct", pd.Series(15, index=df.index))
    water = df.get("dist_water_m", pd.Series(2000, index=df.index))
    area_ha = df.get("nearest_park_area_ha")
    lenient = green_quality_score(share, park_dist, canopy, area_ha, water)
    strict = green_composite_strict(park_dist, share, canopy, water, area_ha)
    return lenient, strict


def _attach_match_attributes(df: pd.DataFrame) -> None:
    """Export stable 7D Match Score attribute vector (aliases of core s_*)."""
    if "s_match_infrastructure" not in df.columns:
        if "s_daily_life" in df.columns:
            df["s_match_infrastructure"] = df["s_daily_life"]
        else:
            df["s_match_infrastructure"] = 50.0
    df["s_match_centrality"] = df["s_center"] if "s_center" in df.columns else 50.0
    df["s_match_walk"] = df["s_walking_quality"] if "s_walking_quality" in df.columns else 50.0
    df["s_match_green"] = df["s_green"] if "s_green" in df.columns else 50.0
    df["s_match_transit"] = df["s_transit"] if "s_transit" in df.columns else 50.0
    df["s_match_quiet"] = df["s_noise"] if "s_noise" in df.columns else 50.0
    if "s_rent_relative_city" in df.columns:
        df["s_match_price"] = df["s_rent_relative_city"]
    else:
        df["s_match_price"] = 50.0
    for col in (
        "s_match_centrality",
        "s_match_infrastructure",
        "s_match_walk",
        "s_match_green",
        "s_match_transit",
        "s_match_quiet",
        "s_match_price",
    ):
        df[col] = df[col].astype(float).clip(0, 100).round(1)


def _derive_walking_quality(df: pd.DataFrame) -> pd.Series:
    """Fallback walking quality from traffic safety + green + quiet."""
    safety = df["s_traffic_safety"] if "s_traffic_safety" in df.columns else pd.Series(55.0, index=df.index)
    green = df["s_green"] if "s_green" in df.columns else pd.Series(50.0, index=df.index)
    quiet = df["s_noise"] if "s_noise" in df.columns else pd.Series(50.0, index=df.index)
    return (0.45 * safety.astype(float) + 0.30 * green.astype(float) + 0.25 * quiet.astype(float)).clip(0, 100).round(1)


def _derive_urban_form(df: pd.DataFrame) -> pd.Series:
    """Fallback urban form from density + activity + green."""
    if "population_density" in df.columns:
        dens = density_sweet_spot_score(df["population_density"].fillna(2000))
    elif "s_density" in df.columns:
        dens = df["s_density"].astype(float)
    else:
        dens = pd.Series(55.0, index=df.index)
    if "urban_activity" in df.columns:
        act = _interp(
            np.log1p(df["urban_activity"].astype(float).fillna(20)),
            [0, 1.5, 3.0, 4.5, 6.0, 7.5],
            [10, 35, 55, 75, 90, 100],
            below=5,
            above=100,
        )
    elif "s_urban_activity" in df.columns:
        act = df["s_urban_activity"].astype(float)
    else:
        act = pd.Series(50.0, index=df.index)
    green = df["s_green"] if "s_green" in df.columns else pd.Series(50.0, index=df.index)
    return (0.45 * dens + 0.35 * act + 0.20 * green.astype(float)).clip(0, 100).round(1)


def _weighted_comfort(df: gpd.GeoDataFrame) -> pd.Series:
    """Primary comfort = 15-Minute Living Score when pillars exist."""
    if "s_living" in df.columns:
        return df["s_living"].astype(float).round(1)
    w = config.DEFAULT_WEIGHTS
    parts: list[pd.Series] = []
    weights: list[float] = []
    mapping = {
        "daily_needs": "s_daily_needs",
        "transit_service": "s_transit_service",
        "walking_quality": "s_walking_quality",
        "urban_form": "s_urban_form",
        "green": "s_green",
        "noise": "s_noise",
        "traffic_safety": "s_traffic_safety",
        "price": "s_rent_relative_city",
        "center": "s_center",
    }
    for key, col in mapping.items():
        weight = w.get(key, 0)
        if weight <= 0 or col not in df.columns:
            continue
        parts.append(df[col].astype(float).fillna(50) * weight)
        weights.append(weight)
    if not parts:
        return pd.Series(50.0, index=df.index)
    total_w = sum(weights)
    return (sum(parts) / total_w).round(1)


def _hex_data_quality(row: pd.Series) -> str:
    confs: list[float] = []
    for col in ("noise_confidence", "heat_confidence", "safety_confidence"):
        v = row.get(col)
        if v is not None and pd.notna(v):
            confs.append(float(v))
    rent_conf = row.get("rent_confidence")
    if rent_conf is not None and pd.notna(rent_conf):
        confs.append(0.35 if str(rent_conf) == "low" else 0.65)
    if not confs:
        return "estimated"
    avg = sum(confs) / len(confs)
    if avg >= 0.6:
        return "high"
    if avg >= 0.45:
        return "mixed"
    return "estimated"


def build(ctx: CityContext) -> gpd.GeoDataFrame:
    grid = gpd.read_parquet(ctx.cache(config.GRID_FILE))
    business = pd.read_parquet(ctx.cache(config.BUSINESS_FILE))
    green = pd.read_parquet(ctx.cache(config.GREEN_FILE))
    noise = pd.read_parquet(ctx.cache(config.NOISE_FILE))
    center = pd.read_parquet(ctx.cache(config.CENTER_FILE))
    transport = pd.read_parquet(ctx.cache(config.TRANSPORT_FILE))

    df = (
        grid.merge(business, on="h3_index")
        .merge(green, on="h3_index")
        .merge(noise, on="h3_index")
        .merge(center, on="h3_index")
        .merge(transport, on="h3_index")
    )

    for name, file_key in [
        ("daily_needs", config.DAILY_NEEDS_FILE),
        ("transit_service", config.TRANSIT_SERVICE_FILE),
        ("heat", config.HEAT_FILE),
        ("traffic_safety", config.TRAFFIC_SAFETY_FILE),
        ("housing", config.HOUSING_FILE),
        ("walking_quality", config.WALKING_QUALITY_FILE),
        ("urban_form", config.URBAN_FORM_FILE),
    ]:
        extra = _optional_parquet(ctx, file_key)
        if extra is not None:
            # Avoid duplicate s_* columns when factor already exports them.
            overlap = [c for c in extra.columns if c in df.columns and c != "h3_index"]
            if overlap:
                extra = extra.drop(columns=overlap)
            df = df.merge(extra, on="h3_index", how="left")

    rents_path = ctx.cache(config.RENTS_FILE)
    if rents_path.exists():
        rents = pd.read_parquet(rents_path)
        df = df.merge(rents, on="h3_index")

    ensure_city_context(ctx)
    city_type = ctx.city_type or "LARGE_CITY"

    if "urban_activity" not in df.columns:
        df["urban_activity"] = df.get("business_count", 0)
    if "green_access" not in df.columns:
        df["green_access"] = _scale(df["green_dist_m"], invert=True)

    # --- Raw metric scores -------------------------------------------------
    s_green_raw, s_green_strict = _green_scores(df)
    df["green_raw"] = s_green_raw
    df["s_green_strict"] = s_green_strict

    anchors = center_anchors(ctx)
    mins_by_id = {
        a["id"]: df[f"center_min_{a['id']}"]
        for a in anchors
        if f"center_min_{a['id']}" in df.columns
    }
    decay_km = float(
        config.CENTER_DECAY_KM_BY_CITY_TYPE.get(city_type, config.CENTER_DECAY_KM)
    )
    km_per_min = float(config.CENTER_KM_PER_MIN)
    if mins_by_id:
        center_prox = center_polycentric_exponential(
            mins_by_id, anchors, km_per_min=km_per_min, decay_km=decay_km,
        )
        df["s_center_strict"] = center_anchor_strict(df["center_min"])
    else:
        center_prox = center_exponential_from_minutes(
            df["center_min"], km_per_min=km_per_min, decay_km=decay_km,
        )
        df["s_center_strict"] = center_anchor_strict(df["center_min"])
    df["s_urban_activity"] = _scale(df["urban_activity"], invert=False, log_compress=True)
    df["s_business"] = df["s_urban_activity"]
    df["s_transport"] = _scale(df["transport_score"], invert=False, log_compress=True)
    # Centrality: 80% activity-center proximity + 20% destination/transit access.
    dest_access = df["s_transport"]
    if "transit_service_raw" in df.columns:
        dest_access = (
            0.5 * df["s_transport"].astype(float)
            + 0.5 * df["transit_service_raw"].astype(float)
        ).clip(0, 100)
    df["centrality_raw"] = centrality_index(center_prox, dest_access)

    df["quiet_raw"] = noise_quiet_score(df["noise_db"])

    if "daily_life_raw" in df.columns:
        daily_raw = df["daily_life_raw"].astype(float).clip(0, 100)
    elif "s_daily_life" in df.columns:
        daily_raw = df["s_daily_life"].astype(float).clip(0, 100)
    elif "daily_needs_score" in df.columns:
        daily_raw = df["daily_needs_score"].astype(float).clip(0, 100)
    else:
        daily_raw = pd.Series(50.0, index=df.index)
    df["daily_life_raw"] = daily_raw

    if "transit_service_raw" in df.columns:
        transit_raw = df["transit_service_raw"].astype(float).clip(0, 100)
    elif "transit_service_score" in df.columns:
        transit_raw = df["transit_service_score"].astype(float).clip(0, 100)
    else:
        transit_raw = pd.Series(50.0, index=df.index)
    df["transit_raw"] = transit_raw

    if "walking_quality_raw" in df.columns:
        walk_raw = df["walking_quality_raw"].astype(float).clip(0, 100)
    elif "s_walking_quality" in df.columns:
        walk_raw = df["s_walking_quality"].astype(float).clip(0, 100)
    elif "walking_quality_score" in df.columns:
        walk_raw = df["walking_quality_score"].astype(float).clip(0, 100)
    else:
        walk_raw = _derive_walking_quality(df)
    df["walk_raw"] = walk_raw

    # --- City normalization → final living metrics -------------------------
    df["s_daily_life"] = city_normalize(daily_raw, city_type, "daily_life")
    df["s_daily_needs"] = df["s_daily_life"]
    df["s_walk"] = city_normalize(walk_raw, city_type, "walk")
    df["s_walking_quality"] = df["s_walk"]
    df["s_transit"] = city_normalize(transit_raw, city_type, "transit")
    df["s_transit_service"] = df["s_transit"]
    df["s_green"] = city_normalize(df["green_raw"], city_type, "green")
    df["s_center"] = city_normalize(df["centrality_raw"], city_type, "centrality")
    df["s_quiet"] = city_normalize(df["quiet_raw"], city_type, "quiet")
    df["s_noise"] = df["s_quiet"]  # quiet = high

    if "heat_resilience_score" in df.columns:
        heat_spread = df["heat_resilience_score"].max() - df["heat_resilience_score"].min()
        if heat_spread >= 1.0:
            df["s_heat"] = df["heat_resilience_score"].clip(0, 100).round(1)
    if "traffic_safety_score" in df.columns:
        if "road_risk_index" in df.columns:
            acc = df["accident_density"] if "accident_density" in df.columns else None
            length = df["road_length_m"] if "road_length_m" in df.columns else None
            spd = df["speed_risk_index"] if "speed_risk_index" in df.columns else None
            ped = df["ped_infra_index"] if "ped_infra_index" in df.columns else None
            df["s_traffic_safety"] = traffic_safety_score(
                df["road_risk_index"], acc, length, spd, ped,
            )
            df["s_traffic_safety_strict"] = traffic_safety_strict(df["road_risk_index"])
        else:
            df["s_traffic_safety"] = df["traffic_safety_score"].clip(0, 100).round(1)
            df["s_traffic_safety_strict"] = df["traffic_safety_score"].clip(0, 100).round(1)
    if "housing_quality_score" in df.columns:
        df["s_housing"] = df["housing_quality_score"].clip(0, 100).round(1)
    if "population_density" in df.columns:
        df["s_density"] = _scale(df["population_density"], invert=False, log_compress=True)

    if "s_urban_form" not in df.columns and "urban_form_score" in df.columns:
        df["s_urban_form"] = df["urban_form_score"].clip(0, 100).round(1)
    if "s_urban_form" not in df.columns:
        df["s_urban_form"] = _derive_urban_form(df)

    if "rent_eur_m2" in df.columns:
        df["s_rent_relative_city"] = rent_percentile_score(df["rent_eur_m2"])
        df["s_rent_kalt_benchmark"] = rent_kalt_lenient(df["rent_eur_m2"])
        df["s_rent_absolute"] = df["s_rent_relative_city"]
        df["s_rent_strict"] = rent_kalt_strict(df["rent_eur_m2"])
        df["s_rent_absolute_legacy"] = _rent_absolute_legacy(df["rent_eur_m2"])
        df["rent_monthly_est"] = ((df["rent_eur_m2"] + DEFAULT_NEBENKOSTEN_EUR_M2) * DEFAULT_RENT_AREA_M2).round(0)
        df["s_rent_warm"] = rent_warm_lenient(df["rent_monthly_est"])
        df["s_rent_warm_strict"] = rent_warm_strict(df["rent_monthly_est"])
        df["s_rent_value"] = rent_value_score(
            df["s_rent_relative_city"], df["s_transit"], df["s_daily_life"],
        )
        hv_raw = housing_value_score(
            df["s_rent_relative_city"], df["s_daily_life"], df["s_transit"], df["s_walk"],
        )
        df["s_housing_value"] = city_normalize(hv_raw, city_type, "housing_value")
    else:
        df["s_housing_value"] = city_normalize(
            (0.5 * df["s_daily_life"] + 0.5 * df["s_transit"]).clip(0, 100),
            city_type,
            "housing_value",
        )

    df["s_living"] = living_score_composite(
        {
            "daily_life": df["s_daily_life"],
            "walk": df["s_walk"],
            "green": df["s_green"],
            "transit": df["s_transit"],
            "centrality": df["s_center"],
            "quiet": df["s_quiet"],
            "housing_value": df["s_housing_value"],
        },
        config.LIVING_SCORE_WEIGHTS,
    )

    # Value Opportunity Index (Hidden Gems) — analytical overlay, not Living Score.
    from .value_opportunity import compute_value_opportunity

    df = compute_value_opportunity(
        df,
        city_type=city_type,
        neighbor_k=getattr(config, "VOI_NEIGHBOR_K", 4),
    )

    # Match aliases (dormant product — keep for future wiring).
    df["s_match_centrality"] = df["s_center"]
    df["s_match_infrastructure"] = df["s_daily_life"]
    df["s_match_walk"] = df["s_walk"]
    df["s_match_green"] = df["s_green"]
    df["s_match_transit"] = df["s_transit"]
    df["s_match_quiet"] = df["s_quiet"]
    df["s_match_price"] = df["s_housing_value"]

    df["data_quality"] = df.apply(_hex_data_quality, axis=1)

    df["comfort"] = _weighted_comfort(df)

    log(
        STEP,
        f"merged {len(df)} hexes; living {df['s_living'].min():.0f}-{df['s_living'].max():.0f} "
        f"(mean={df['s_living'].mean():.0f})",
    )
    return df


def export(ctx: CityContext, df: gpd.GeoDataFrame) -> None:
    out_path = ctx.out_geojson
    out_path.parent.mkdir(parents=True, exist_ok=True)

    if not ctx.rent_source and "rent_source" in df.columns:
        ctx.rent_source = str(df["rent_source"].dropna().iloc[0]) if df["rent_source"].notna().any() else ctx.rent_source
    if "rent_confidence" in df.columns:
        conf = df["rent_confidence"].dropna()
        if len(conf) and conf.iloc[0] == "low":
            ctx.rent_estimated = True

    dn_cols = [c for c in df.columns if c.startswith("dn_")]
    dl_cols = [c for c in df.columns if c.startswith("dl_")]

    features = []
    for _, r in df.iterrows():
        props = {
            "h3": r["h3_index"],
            "s_living": round(float(r["s_living"]), 1) if pd.notna(r.get("s_living")) else None,
            "s_daily_life": round(float(r["s_daily_life"]), 1) if pd.notna(r.get("s_daily_life")) else None,
            "s_walk": round(float(r["s_walk"]), 1) if pd.notna(r.get("s_walk")) else None,
            "s_walking_quality": round(float(r["s_walking_quality"]), 1) if pd.notna(r.get("s_walking_quality")) else None,
            "s_transit": round(float(r["s_transit"]), 1) if pd.notna(r.get("s_transit")) else None,
            "s_green": round(float(r["s_green"]), 1) if pd.notna(r.get("s_green")) else None,
            "s_quiet": round(float(r["s_quiet"]), 1) if pd.notna(r.get("s_quiet")) else None,
            "s_housing_value": round(float(r["s_housing_value"]), 1) if pd.notna(r.get("s_housing_value")) else None,
            "s_urban_form": round(float(r["s_urban_form"]), 1) if pd.notna(r.get("s_urban_form")) else None,
            "s_center": r["s_center"],
            "s_urban_activity": r["s_urban_activity"],
            "s_business": r["s_business"],
            "s_transport": r["s_transport"],
            "s_noise": r["s_noise"],
            "s_match_centrality": round(float(r["s_match_centrality"]), 1) if pd.notna(r.get("s_match_centrality")) else None,
            "s_match_infrastructure": round(float(r["s_match_infrastructure"]), 1) if pd.notna(r.get("s_match_infrastructure")) else None,
            "s_match_walk": round(float(r["s_match_walk"]), 1) if pd.notna(r.get("s_match_walk")) else None,
            "s_match_green": round(float(r["s_match_green"]), 1) if pd.notna(r.get("s_match_green")) else None,
            "s_match_transit": round(float(r["s_match_transit"]), 1) if pd.notna(r.get("s_match_transit")) else None,
            "s_match_quiet": round(float(r["s_match_quiet"]), 1) if pd.notna(r.get("s_match_quiet")) else None,
            "s_match_price": round(float(r["s_match_price"]), 1) if pd.notna(r.get("s_match_price")) else None,
            "center_min": round(float(r["center_min"]), 1),
            "center_min_best": round(float(r["center_min_best"]), 1) if pd.notna(r.get("center_min_best")) else None,
            "urban_activity": int(r["urban_activity"]),
            "business_count": int(r.get("business_count", r["urban_activity"])),
            "transport_score": round(float(r["transport_score"]), 3),
            "green_dist_m": round(float(r["green_dist_m"])),
            "green_access": round(float(r.get("green_access", 0)), 1),
            "noise_db": round(float(r["noise_db"]), 1),
        }
        for optional in (
            "s_center_strict",
            "center_min_marienplatz", "center_min_hbf", "center_min_ost", "center_min_main",
            "s_green_strict",
            "nearest_park_dist_m", "dist_water_m", "nearest_park_area_ha", "tree_canopy_pct",
            "s_daily_needs", "daily_needs_score", "daily_life_score", "dn_coverage", "dn_cluster_span_m",
            "dn_cluster_penalty", "dn_dispersion_bonus", "daily_needs_raw",
            "dn_nearest_key_m", "dn_distance_score",
            "s_transit_service", "transit_service_score", "station_proximity_score",
            "walking_quality_score", "wq_network", "wq_ped_infra", "wq_traffic_calm", "wq_environment",
            "intersection_density", "mean_block_length_m",
            "urban_form_score", "uf_density", "uf_activity", "uf_mixed_use", "uf_green_balance",
            "landuse_residential_share", "landuse_commercial_share",
            "s_heat", "heat_resilience_score", "heat_source", "heat_confidence",
            "s_traffic_safety", "s_traffic_safety_strict", "traffic_safety_score", "road_risk_index",
            "speed_risk_index", "ped_infra_index", "road_length_m", "accident_density",
            "safety_source", "safety_confidence",
            "s_housing", "housing_quality_score", "building_age_median",
            "share_pre_1949", "share_1950_1979", "share_1980_1999", "share_2000_plus",
            "s_density", "population_density",
            "green_area_m2", "green_quality", "green_share_inside_500m",
            "noise_source", "noise_confidence",
            "s_rent_relative_city", "s_rent_absolute", "s_rent_strict", "s_rent_kalt_benchmark", "s_rent_value",
            "s_rent_warm", "s_rent_warm_strict", "rent_monthly_est",
            "data_quality",
        ):
            if optional in df.columns and pd.notna(r.get(optional)):
                val = r[optional]
                props[optional] = round(float(val), 1) if isinstance(val, (float, np.floating)) else val
        for col in dn_cols + dl_cols:
            if pd.notna(r.get(col)):
                props[col] = round(float(r[col]), 1)
        # Value Opportunity Index (separate analytical layer)
        if "s_value_opportunity" in df.columns and pd.notna(r.get("s_value_opportunity")):
            props["s_value_opportunity"] = round(float(r["s_value_opportunity"]), 1)
        if "s_value_opportunity_raw" in df.columns and pd.notna(r.get("s_value_opportunity_raw")):
            props["s_value_opportunity_raw"] = round(float(r["s_value_opportunity_raw"]), 1)
        if "s_residential_quality" in df.columns and pd.notna(r.get("s_residential_quality")):
            props["s_residential_quality"] = round(float(r["s_residential_quality"]), 1)
        if "voi_fair_rent_min" in df.columns and pd.notna(r.get("voi_fair_rent_min")):
            props["voi_fair_rent_min"] = round(float(r["voi_fair_rent_min"]), 2)
        if "voi_fair_rent_max" in df.columns and pd.notna(r.get("voi_fair_rent_max")):
            props["voi_fair_rent_max"] = round(float(r["voi_fair_rent_max"]), 2)
        if "voi_fair_rent_median" in df.columns and pd.notna(r.get("voi_fair_rent_median")):
            props["voi_fair_rent_median"] = round(float(r["voi_fair_rent_median"]), 2)
        if "voi_expected_rent_eur_m2" in df.columns and pd.notna(r.get("voi_expected_rent_eur_m2")):
            props["voi_expected_rent_eur_m2"] = round(float(r["voi_expected_rent_eur_m2"]), 2)
        if "voi_adjusted_price_gap" in df.columns and pd.notna(r.get("voi_adjusted_price_gap")):
            props["voi_adjusted_price_gap"] = round(float(r["voi_adjusted_price_gap"]), 4)
        if "voi_price_gap" in df.columns and pd.notna(r.get("voi_price_gap")):
            props["voi_price_gap"] = round(float(r["voi_price_gap"]), 4)
        if "voi_location_premium" in df.columns and pd.notna(r.get("voi_location_premium")):
            props["voi_location_premium"] = round(float(r["voi_location_premium"]), 1)
        if "voi_local_advantage" in df.columns and pd.notna(r.get("voi_local_advantage")):
            props["voi_local_advantage"] = round(float(r["voi_local_advantage"]), 3)
        if "voi_local_value_advantage" in df.columns and pd.notna(r.get("voi_local_value_advantage")):
            props["voi_local_value_advantage"] = round(float(r["voi_local_value_advantage"]), 3)
        if "voi_local_delta" in df.columns and pd.notna(r.get("voi_local_delta")):
            props["voi_local_delta"] = round(float(r["voi_local_delta"]), 3)
        if "voi_gem_strength" in df.columns and pd.notna(r.get("voi_gem_strength")):
            props["voi_gem_strength"] = round(float(r["voi_gem_strength"]), 1)
        if "voi_highlight" in df.columns and pd.notna(r.get("voi_highlight")):
            props["voi_highlight"] = int(r["voi_highlight"])
        if "voi_class" in df.columns and pd.notna(r.get("voi_class")):
            props["voi_class"] = str(r["voi_class"])
        if "voi_confidence" in df.columns and pd.notna(r.get("voi_confidence")):
            props["voi_confidence"] = str(r["voi_confidence"])
        if "voi_explain" in df.columns and pd.notna(r.get("voi_explain")):
            props["voi_explain"] = str(r["voi_explain"])
        if "rent_eur_m2" in df.columns:
            props["rent_eur_m2"] = round(float(r["rent_eur_m2"]), 1)
            for meta_col in ("rent_source", "rent_confidence", "rent_year"):
                if meta_col in df.columns and pd.notna(r.get(meta_col)):
                    props[meta_col] = r[meta_col]
        features.append({
            "type": "Feature",
            "geometry": r["geometry"].__geo_interface__,
            "properties": props,
        })

    centers_data = load_centers(ctx)
    centers = centers_data.get("centers", []) if centers_data else ctx.centers
    center = centers_data["main"] if centers_data and centers_data.get("main") else [ctx.center[0], ctx.center[1]]
    anchor_meta = [
        {"id": a["id"], "label": a["label"], "lat": a["lat"], "lng": a["lng"], "weight": a.get("weight", 1.0)}
        for a in center_anchors(ctx)
    ]

    fc = {
        "type": "FeatureCollection",
        "meta": {
            "slug": ctx.slug,
            "name": ctx.name,
            "center": center,
            "bbox": list(ctx.bbox),
            "has_rent": ctx.has_rent,
            "rent_estimated": ctx.rent_estimated,
            "rent_source": ctx.rent_source,
            "centers": centers,
            "center_anchors": anchor_meta,
            "h3_res": config.H3_RES,
            "count": len(features),
            "default_weights": config.DEFAULT_WEIGHTS,
            "living_score_weights": {
                k: v for k, v in config.LIVING_SCORE_WEIGHTS.items()
                if k in ("daily_life", "walk", "green", "transit", "centrality", "quiet", "housing_value")
            },
            "daily_life_group_weights": config.DAILY_LIFE_GROUP_WEIGHTS,
            "metric_types": METRIC_TYPES,
            "metric_quality": METRIC_META,
            "pipeline_version": config.PIPELINE_SCHEMA_VERSION,
            "product": "15-minute-living-score",
            "population": ctx.population,
            "city_type": ctx.city_type,
            "normalization": "city_context_v1",
            "city_context": ctx.city_context or {
                "population": ctx.population,
                "city_type": ctx.city_type,
                "normalization": "city_context_v1",
            },
            "heat_enabled": bool(
                "s_heat" in df.columns and (df["s_heat"].max() - df["s_heat"].min()) >= 1.0
            ),
            "noise_db_spread": round(float(df["noise_db"].max() - df["noise_db"].min()), 2),
            "has_value_opportunity": bool(
                "voi_highlight" in df.columns and int((df["voi_highlight"] > 0).sum()) > 0
            ),
            "value_opportunity": {
                "version": "voi_v1.2",
                "residential_quality_min": 50,
                "hidden_gems": int((df["voi_class"] == "hidden_gem").sum())
                if "voi_class" in df.columns else 0,
                "good_value": int((df["voi_class"] == "good_value").sum())
                if "voi_class" in df.columns else 0,
                "overpriced": int((df["voi_class"] == "overpriced").sum())
                if "voi_class" in df.columns else 0,
                "confidence_high": int((df["voi_confidence"] == "high").sum())
                if "voi_confidence" in df.columns else 0,
            },
        },
        "features": features,
    }
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(fc, fh)
    meta = {
        **ctx.to_meta(),
        "center": center,
        "centers": centers,
        "center_anchors": anchor_meta,
        "count": len(features),
        "metric_types": METRIC_TYPES,
        "metric_quality": METRIC_META,
        "pipeline_version": config.PIPELINE_SCHEMA_VERSION,
        "noise_db_spread": round(float(df["noise_db"].max() - df["noise_db"].min()), 2),
    }
    with open(ctx.meta_json, "w", encoding="utf-8") as fh:
        json.dump(meta, fh)
    size_kb = out_path.stat().st_size / 1024
    log(STEP, f"exported {len(features)} features -> {out_path} ({size_kb:.0f} KB)")


def main(ctx: CityContext | None = None) -> None:
    ctx = ctx or munich_context()
    ensure_city_context(ctx)
    df = build(ctx)
    df.drop(columns="geometry").to_parquet(ctx.cache(config.MERGED_FILE))
    export(ctx, df)


if __name__ == "__main__":
    main()
