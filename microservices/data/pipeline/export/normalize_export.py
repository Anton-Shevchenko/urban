"""Step final - merge factors, normalise to 0-100, export web GeoJSON."""

from __future__ import annotations

import json

import geopandas as gpd
import numpy as np
import pandas as pd

from pipeline import config, contract
from pipeline.city import CityContext, munich_context
from pipeline.city_context import ensure_city_context
from pipeline.common import log
from pipeline.export.metric_metadata import METRIC_META, METRIC_TYPES
from pipeline.export.score_scales import (
    _interp,
    center_anchor_strict,
    center_exponential_from_minutes,
    center_polycentric_exponential,
    centrality_index,
    city_normalize,
    cycleway_score,
    density_sweet_spot_score,
    green_composite_strict,
    green_quality_score,
    living_score_composite,
    noise_quiet_score,
    rent_kalt_lenient,
    rent_kalt_strict,
    rent_percentile_score,
    rent_value_score,
    traffic_safety_score,
    traffic_safety_strict,
    walkability_index,
)
from pipeline.factors.center import center_anchors
from pipeline.generated import contract as generated
from pipeline.ingest.centers import load_centers

STEP = "normalize"

P_LOW, P_HIGH = 5, 95


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
    out = pd.Series(score, index=r.index).round(1)
    return out.where(np.isfinite(r))


def _green_scores(df: pd.DataFrame) -> tuple[pd.Series, pd.Series]:
    park_dist = df.get("nearest_park_dist_m", df.get("green_dist_m", pd.Series(2000, index=df.index)))
    share = df.get("green_share_inside_500m", pd.Series(0, index=df.index))
    canopy = df.get("tree_canopy_pct", pd.Series(15, index=df.index))
    water = df.get("dist_water_m", pd.Series(2000, index=df.index))
    area_ha = df.get("nearest_park_area_ha")
    lenient = green_quality_score(share, park_dist, canopy, area_ha, water)
    strict = green_composite_strict(park_dist, share, canopy, water, area_ha)
    return lenient, strict


def _derive_walking_quality(df: pd.DataFrame) -> pd.Series:
    """Fallback walking quality from traffic safety + green + quiet."""
    safety = df["s_traffic_safety"] if "s_traffic_safety" in df.columns else pd.Series(55.0, index=df.index)
    green = df["s_green"] if "s_green" in df.columns else pd.Series(50.0, index=df.index)
    quiet = df["s_noise"] if "s_noise" in df.columns else pd.Series(50.0, index=df.index)
    return (
        (0.45 * safety.astype(float) + 0.30 * green.astype(float) + 0.25 * quiet.astype(float))
        .clip(0, 100)
        .round(1)
    )


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


def _clip_grid_to_admin_boundary(ctx: CityContext, grid: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    """Drop hexes whose centre sits outside the cached admin polygon.

    Older cities were sometimes filled from the Nominatim bounding box, which
    paints neighbouring Gemeinden. Clipping here keeps a quick re-export honest
    even before the grid parquet is rebuilt.
    """
    boundary_path = ctx.cache(config.BOUNDARY_FILE)
    if not boundary_path.exists() or len(grid) == 0:
        return grid
    if "lat" not in grid.columns or "lng" not in grid.columns:
        return grid
    try:
        from shapely import points
        from shapely.geometry import shape
        from shapely.predicates import covers

        boundary = shape(json.loads(boundary_path.read_text(encoding="utf-8")))
        pts = points(grid["lng"].to_numpy(dtype=float), grid["lat"].to_numpy(dtype=float))
        mask = covers(boundary, pts)
    except Exception as exc:  # noqa: BLE001
        log(STEP, f"admin-boundary clip skipped: {exc}")
        return grid
    kept = int(mask.sum())
    if kept == len(grid):
        return grid
    log(STEP, f"clipped grid to admin boundary: {len(grid)} → {kept}")
    return grid.loc[mask].reset_index(drop=True)


def build(ctx: CityContext) -> gpd.GeoDataFrame:
    grid = _clip_grid_to_admin_boundary(ctx, gpd.read_parquet(ctx.cache(config.GRID_FILE)))
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

    for file_key in (
        config.DAILY_NEEDS_FILE,
        config.TRANSIT_SERVICE_FILE,
        config.HEAT_FILE,
        config.TRAFFIC_SAFETY_FILE,
        config.HOUSING_FILE,
        config.WALKING_QUALITY_FILE,
        config.URBAN_FORM_FILE,
        config.CYCLEWAYS_FILE,
    ):
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
        df = df.merge(rents, on="h3_index", how="left")

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
        a["id"]: df[f"center_min_{a['id']}"] for a in anchors if f"center_min_{a['id']}" in df.columns
    }
    decay_km = float(config.CENTER_DECAY_KM_BY_CITY_TYPE.get(city_type, config.CENTER_DECAY_KM))
    km_per_min = float(config.CENTER_KM_PER_MIN)
    if mins_by_id:
        center_prox = center_polycentric_exponential(
            mins_by_id,
            anchors,
            km_per_min=km_per_min,
            decay_km=decay_km,
        )
        df["s_center_strict"] = center_anchor_strict(df["center_min"])
    else:
        center_prox = center_exponential_from_minutes(
            df["center_min"],
            km_per_min=km_per_min,
            decay_km=decay_km,
        )
        df["s_center_strict"] = center_anchor_strict(df["center_min"])
    df["s_urban_activity"] = _scale(df["urban_activity"], invert=False, log_compress=True)
    df["s_business"] = df["s_urban_activity"]
    df["s_transport"] = _scale(df["transport_score"], invert=False, log_compress=True)
    # Centrality: 80% activity-center proximity + 20% destination/transit access.
    dest_access = df["s_transport"]
    if "transit_service_raw" in df.columns:
        dest_access = (
            0.5 * df["s_transport"].astype(float) + 0.5 * df["transit_service_raw"].astype(float)
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

    # --- Objective pillars (absolute) + city-context legacy columns --------
    # objective-v2: s_* pillars used for Living Score are absolute / raw.
    # City-normalized copies kept as s_*_city for diagnostics / percentile.
    df["s_daily_life"] = daily_raw.clip(0, 100).round(1)
    df["s_daily_life_city"] = city_normalize(daily_raw, city_type, "daily_life")
    df["s_daily_needs"] = df["s_daily_life"]
    df["s_walk"] = walk_raw.clip(0, 100).round(1)
    df["s_walk_city"] = city_normalize(walk_raw, city_type, "walk")
    df["s_walking_quality"] = df["s_walk"]
    df["s_transit"] = transit_raw.clip(0, 100).round(1)
    df["s_transit_city"] = city_normalize(transit_raw, city_type, "transit")
    df["s_transit_service"] = df["s_transit"]
    df["s_green"] = df["green_raw"].clip(0, 100).round(1)
    df["s_green_city"] = city_normalize(df["green_raw"], city_type, "green")
    df["s_center"] = city_normalize(df["centrality_raw"], city_type, "centrality")
    df["s_quiet"] = df["quiet_raw"].clip(0, 100).round(1)
    df["s_quiet_city"] = city_normalize(df["quiet_raw"], city_type, "quiet")
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
                df["road_risk_index"],
                acc,
                length,
                spd,
                ped,
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

    if "s_cycleways" not in df.columns and "cycleway_km_per_km2" in df.columns:
        dist = df["nearest_cycleway_m"] if "nearest_cycleway_m" in df.columns else pd.Series(1500.0, index=df.index)
        df["s_cycleways"] = cycleway_score(df["cycleway_km_per_km2"].fillna(0), dist.fillna(1500.0))
    if "s_cycleways" in df.columns:
        df["s_cycleways"] = df["s_cycleways"].clip(0, 100).round(1)

    wb = walkability_index(df)
    df[wb.columns] = wb

    if "rent_eur_m2" in df.columns:
        df["s_rent_relative_city"] = rent_percentile_score(df["rent_eur_m2"])
        df["s_rent_kalt_benchmark"] = rent_kalt_lenient(df["rent_eur_m2"])
        # Absolute affordability for Objective Score (not city-relative).
        df["s_housing_affordability"] = df["s_rent_kalt_benchmark"]
        df["s_rent_absolute"] = df["s_rent_kalt_benchmark"]
        df["s_rent_strict"] = rent_kalt_strict(df["rent_eur_m2"])
        df["s_rent_absolute_legacy"] = _rent_absolute_legacy(df["rent_eur_m2"])
        df["s_rent_value"] = rent_value_score(
            df["s_rent_relative_city"],
            df["s_transit"],
            df["s_daily_life"],
        )
        # Legacy alias — affordability only (no daily_life/walk/transit double-count).
        df["s_housing_value"] = df["s_housing_affordability"]
    else:
        df["s_housing_affordability"] = pd.Series(np.nan, index=df.index)
        df["s_housing_value"] = df["s_housing_affordability"]

    df["s_living"] = living_score_composite(
        {
            "daily_life": df["s_daily_life"],
            "walk": df["s_walk"],
            "green": df["s_green"],
            "transit": df["s_transit"],
            "quiet": df["s_quiet"],
            "housing_affordability": df["s_housing_affordability"],
        },
        config.LIVING_SCORE_WEIGHTS,
    )
    df["s_objective"] = df["s_living"]

    # Value Opportunity Index (Hidden Gems) — analytical overlay, not Living Score.
    from pipeline.export.value_opportunity import compute_value_opportunity

    df = compute_value_opportunity(
        df,
        city_type=city_type,
        neighbor_k=getattr(config, "VOI_NEIGHBOR_K", 4),
    )

    df["data_quality"] = df.apply(_hex_data_quality, axis=1)

    df["comfort"] = _weighted_comfort(df)

    log(
        STEP,
        f"merged {len(df)} hexes; living {df['s_living'].min():.0f}-{df['s_living'].max():.0f} "
        f"(mean={df['s_living'].mean():.0f})",
    )
    return df


_SKIP_EXPORT = frozenset({"geometry", "h3_index", "comfort"})
_CONSUMED = frozenset(key for keys in generated.CONSUMER_HEX_PROPERTIES.values() for key in keys)
_PATTERN_PREFIXES = ("dn_", "dl_", "center_min_", "wq_", "uf_", "wb_")
_ROUND = {
    "transport_score": 3,
    "green_dist_m": 0,
    "cycleway_length_m": 1,
    "nearest_cycleway_m": 0,
    "cycleway_km_per_km2": 3,
    "voi_adjusted_price_gap": 4,
    "voi_price_gap": 4,
    "voi_local_advantage": 3,
    "voi_local_value_advantage": 3,
    "voi_local_delta": 3,
    "voi_fair_rent_min": 2,
    "voi_fair_rent_max": 2,
    "voi_fair_rent_median": 2,
    "voi_expected_rent_eur_m2": 2,
    "asking_rent_eur_m2": 2,
    "sale_eur_m2": 0,
}
_INT_KEYS = frozenset({"urban_activity", "business_count", "voi_highlight", "rent_year"})
_STRING_KEYS = frozenset(
    {
        "h3",
        "rent_source",
        "rent_confidence",
        "rent_as_of",
        "rent_resolution",
        "asking_rent_source",
        "asking_rent_as_of",
        "sale_source",
        "sale_as_of",
        "data_quality",
        "voi_class",
        "voi_confidence",
        "voi_explain",
        "noise_source",
        "heat_source",
        "safety_source",
    }
)


def _jsonify(key: str, val: object) -> object:
    if key in _STRING_KEYS or isinstance(val, str):
        return str(val)
    if key in _INT_KEYS or (key.startswith("dn_") and key.endswith("_n")):
        return int(val)
    number = float(val)
    digits = _ROUND.get(key, 1)
    if digits == 0:
        return int(round(number))
    return round(number, digits)


def _cell(row: pd.Series, key: str) -> object:
    if key == "h3":
        return row["h3_index"]
    if key == "business_count":
        if "business_count" in row.index and pd.notna(row["business_count"]):
            return row["business_count"]
        return row.get("urban_activity")
    if key not in row.index:
        return None
    val = row[key]
    if val is None or (not isinstance(val, str) and pd.isna(val)):
        return None
    return val


def _feature_properties(row: pd.Series) -> dict:
    """Copy declared + pattern properties; skip dormant s_match_* aliases."""
    required = set(generated.REQUIRED_HEX_PROPERTIES)
    declared = set(generated.DECLARED_HEX_PROPERTIES)
    props: dict[str, object] = {}
    for key in generated.DECLARED_HEX_PROPERTIES:
        if key.startswith("s_match_"):
            continue
        raw = _cell(row, key)
        if raw is None:
            if key in required:
                if key not in row.index:
                    raise contract.ContractError(f"required property {key} missing on hex {row.get('h3_index')}")
                props[key] = None
            elif key in _CONSUMED:
                # A stale cache can lack a column; consumers need an explicit null, not an absent key.
                props[key] = None
            continue
        props[key] = _jsonify(key, raw)
    for key, raw in row.items():
        if key in declared or key in _SKIP_EXPORT or str(key).startswith("s_match_"):
            continue
        if not str(key).startswith(_PATTERN_PREFIXES):
            continue
        if raw is None or (not isinstance(raw, str) and pd.isna(raw)):
            continue
        props[str(key)] = _jsonify(str(key), raw)
    return props


def _write_sidecars(ctx: CityContext, df: gpd.GeoDataFrame, count: int) -> None:
    """Compact property table + city stats for hex-svc / future vector tiles."""
    parquet_path = ctx.base_dir / "hexes.parquet"
    df.drop(columns="geometry", errors="ignore").to_parquet(parquet_path)
    living = df["s_living"].astype(float)
    stats = {
        "slug": ctx.slug,
        "name": ctx.name,
        "count": count,
        "bbox": list(ctx.bbox),
        "pipeline_version": config.PIPELINE_SCHEMA_VERSION,
        "score_method_version": getattr(config, "SCORE_METHOD_VERSION", "objective-v2"),
        "s_living": {
            "min": round(float(living.min()), 1),
            "max": round(float(living.max()), 1),
            "mean": round(float(living.mean()), 1),
        },
    }
    (ctx.base_dir / "city-stats.json").write_text(json.dumps(stats), encoding="utf-8")


def export(ctx: CityContext, df: gpd.GeoDataFrame) -> None:
    out_path = ctx.out_geojson
    out_path.parent.mkdir(parents=True, exist_ok=True)

    observed = (
        pd.to_numeric(df["rent_eur_m2"], errors="coerce") if "rent_eur_m2" in df.columns else pd.Series(dtype=float)
    )
    ctx.has_rent = bool(observed.notna().any())
    ctx.rent_estimated = False
    if "rent_source" in df.columns and df["rent_source"].notna().any():
        sources = [str(value) for value in df["rent_source"].dropna().unique()]
        ctx.rent_source = sources[0] if len(sources) == 1 else "beobachtete Kaltmiete"
    elif not ctx.rent_source:
        ctx.rent_source = "keine Beobachtung"

    features = [
        {
            "type": "Feature",
            "geometry": r["geometry"].__geo_interface__,
            "properties": _feature_properties(r),
        }
        for _, r in df.iterrows()
    ]

    # Fail here rather than in hex-svc or the browser: a missing or malformed
    # property is a producer bug, and every consumer reads this contract.
    contract.assert_features_valid(features, context=f"{ctx.slug} export")

    centers_data = load_centers(ctx)
    centers = centers_data.get("centers", []) if centers_data else ctx.centers
    center = (
        centers_data["main"] if centers_data and centers_data.get("main") else [ctx.center[0], ctx.center[1]]
    )
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
                k: v
                for k, v in config.LIVING_SCORE_WEIGHTS.items()
                if k
                in (
                    "daily_life",
                    "walk",
                    "green",
                    "transit",
                    "quiet",
                    "housing_affordability",
                )
            },
            "daily_life_group_weights": config.DAILY_LIFE_GROUP_WEIGHTS,
            "metric_types": METRIC_TYPES,
            "metric_quality": METRIC_META,
            "pipeline_version": config.PIPELINE_SCHEMA_VERSION,
            "score_method_version": getattr(config, "SCORE_METHOD_VERSION", "objective-v2"),
            "product": config.LIVING_SCORE_PRODUCT,
            "population": ctx.population,
            "city_type": ctx.city_type,
            "normalization": "absolute_objective_v2",
            "city_context": ctx.city_context
            or {
                "population": ctx.population,
                "city_type": ctx.city_type,
                "normalization": "absolute_objective_v2",
            },
            "heat_enabled": bool("s_heat" in df.columns and (df["s_heat"].max() - df["s_heat"].min()) >= 1.0),
            "noise_db_spread": round(float(df["noise_db"].max() - df["noise_db"].min()), 2),
            "has_value_opportunity": bool(
                "voi_highlight" in df.columns and int((df["voi_highlight"] > 0).sum()) > 0
            ),
            "value_opportunity": {
                "version": "voi_v1.2",
                "residential_quality_min": 50,
                "hidden_gems": int((df["voi_class"] == "hidden_gem").sum())
                if "voi_class" in df.columns
                else 0,
                "good_value": int((df["voi_class"] == "good_value").sum())
                if "voi_class" in df.columns
                else 0,
                "overpriced": int((df["voi_class"] == "overpriced").sum())
                if "voi_class" in df.columns
                else 0,
                "confidence_high": int((df["voi_confidence"] == "high").sum())
                if "voi_confidence" in df.columns
                else 0,
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
    _write_sidecars(ctx, df, len(features))
    from pipeline.factors import cycleways as cycleways_overlay

    cycleways_overlay.write_overlay_geojson(ctx)
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
