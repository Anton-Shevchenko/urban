"""Factor - pedestrian/cyclist traffic safety proxy.

Road risk and accident density normalised by road length (and population
when available) so dense centres are not automatically penalised.
"""

from __future__ import annotations

import geopandas as gpd
import pandas as pd

from pipeline import config
from pipeline.city import CityContext, munich_context
from pipeline.common import log
from pipeline.ingest.osm_data import load_roads

STEP = "factor_traffic_safety"

SPEED_RISK = {30: 0.2, 50: 0.5, 70: 0.8, 100: 1.0}
HIGHWAY_RISK = {
    "motorway": 1.0,
    "trunk": 0.9,
    "primary": 0.7,
    "secondary": 0.5,
    "tertiary": 0.35,
    "residential": 0.15,
    "living_street": 0.05,
}


def _speed_risk(row) -> float:
    try:
        spd = int(float(row.get("maxspeed", 50)))
    except (TypeError, ValueError):
        spd = 50
    for limit, risk in sorted(SPEED_RISK.items()):
        if spd <= limit:
            return risk
    return 1.0


def _ped_infra_bonus(row) -> float:
    cycle_bonus = 0.15 if row.get("cycleway") or row.get("bicycle") == "yes" else 0.0
    crossing_bonus = 0.10 if row.get("crossing") else 0.0
    return cycle_bonus + crossing_bonus


def _road_risk(row) -> float:
    hw = str(row.get("highway", "residential"))
    base = HIGHWAY_RISK.get(hw, 0.4)
    spd_r = _speed_risk(row)
    return max(0.05, base * 0.6 + spd_r * 0.4 - _ped_infra_bonus(row))


def compute(ctx: CityContext) -> gpd.GeoDataFrame:
    grid = gpd.read_parquet(ctx.cache(config.GRID_FILE)).to_crs(ctx.metric_crs)
    out = grid[["h3_index"]].copy()

    try:
        roads = load_roads(ctx).to_crs(ctx.metric_crs)
    except Exception:  # noqa: BLE001
        out["traffic_safety_score"] = 50.0
        out["road_risk_index"] = 0.5
        out["accident_density"] = 0.0
        out["safety_source"] = "osm_roads"
        out["safety_confidence"] = 0.3
        log(STEP, "no roads; default safety=50")
        return out

    roads["risk"] = roads.apply(_road_risk, axis=1)
    roads["speed_risk"] = roads.apply(_speed_risk, axis=1)
    roads["ped_infra"] = roads.apply(_ped_infra_bonus, axis=1)
    roads["length_m"] = roads.geometry.length

    inter = gpd.overlay(
        grid[["h3_index", "geometry"]],
        roads[["geometry", "risk", "speed_risk", "ped_infra"]],
        how="intersection",
        keep_geom_type=False,
    )
    if len(inter) == 0:
        out["traffic_safety_score"] = 50.0
        out["road_risk_index"] = 0.5
        out["accident_density"] = 0.0
        out["safety_source"] = "osm_roads"
        out["safety_confidence"] = 0.3
        return out

    inter["seg_len"] = inter.geometry.length
    inter["weighted"] = inter["risk"] * inter["seg_len"]
    inter["weighted_speed"] = inter["speed_risk"] * inter["seg_len"]
    inter["weighted_ped"] = inter["ped_infra"] * inter["seg_len"]
    agg = inter.groupby("h3_index").agg(
        road_risk_index=("weighted", "sum"),
        speed_risk_index=("weighted_speed", "sum"),
        ped_infra_index=("weighted_ped", "sum"),
        road_length_m=("seg_len", "sum"),
    )
    for col in ("road_risk_index", "speed_risk_index", "ped_infra_index"):
        agg[col] = (agg[col] / agg["road_length_m"].clip(lower=1)).round(3)

    accident_weight = pd.Series(0.0, index=agg.index)
    acc_path = ctx.cache("osm_accidents.parquet")
    has_accidents = False
    if acc_path.exists():
        try:
            acc = gpd.read_parquet(acc_path).to_crs(ctx.metric_crs)
            acc_join = gpd.sjoin(acc, grid[["h3_index", "geometry"]], predicate="within", how="inner")
            if "severity_weight" in acc_join.columns:
                accident_weight = acc_join.groupby("h3_index")["severity_weight"].sum()
            else:
                accident_weight = acc_join.groupby("h3_index").size()
            has_accidents = len(accident_weight) > 0
        except Exception:  # noqa: BLE001
            pass

    out = out.merge(agg, on="h3_index", how="left")
    out["road_risk_index"] = out["road_risk_index"].fillna(0.3)
    out["road_length_m"] = out["road_length_m"].fillna(1.0)
    out["accident_weight"] = out["h3_index"].map(accident_weight).fillna(0.0)
    out["accident_density"] = (out["accident_weight"] / (out["road_length_m"] / 1000 + 0.01)).round(3)

    pop_path = ctx.cache(config.HOUSING_FILE)
    pop_norm = pd.Series(1.0, index=out.index)
    if pop_path.exists():
        try:
            housing = pd.read_parquet(pop_path)
            if "population" in housing.columns:
                pop = housing.set_index("h3_index")["population"].fillna(0)
                mapped = out["h3_index"].map(pop).fillna(0)
                pop_norm = (mapped / mapped.median().clip(lower=1)).clip(lower=0.1, upper=10)
                out["accident_density"] = (out["accident_density"] / pop_norm).round(3)
        except Exception:  # noqa: BLE001
            pass

    raw_risk = out["road_risk_index"] * 0.6 + (out["accident_density"] / 10).clip(0, 1) * 0.4
    out["traffic_safety_score"] = ((1 - raw_risk) * 100).clip(0, 100).round(1)
    out["safety_source"] = "osm_roads+accidents" if has_accidents else "osm_roads"
    out["safety_confidence"] = 0.55 if has_accidents else 0.4

    log(STEP, f"traffic safety mean={out['traffic_safety_score'].mean():.1f}")
    return out


def main(ctx: CityContext | None = None) -> None:
    ctx = ctx or munich_context()
    out = compute(ctx)
    dest = ctx.cache(config.TRAFFIC_SAFETY_FILE)
    out.to_parquet(dest)
    log(STEP, f"saved -> {dest}")


if __name__ == "__main__":
    main()
