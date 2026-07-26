"""Factor - European urban form (density, mixed-use, green balance).

Higher density is not always better: very dense areas without green are capped.
"""
from __future__ import annotations

import geopandas as gpd
import numpy as np
import pandas as pd

from . import config
from .city import CityContext, munich_context
from .common import log
from .osm_data import load_landuse
from .score_scales import (
    density_sweet_spot_score,
    mixed_use_balance_score,
    urban_form_green_balance,
    _interp,
)

STEP = "factor_urban_form"
UF_WEIGHTS = config.URBAN_FORM_WEIGHTS

RESIDENTIAL = {"residential", "apartments"}
COMMERCIAL = {"commercial", "retail", "mixed"}
OTHER_ACTIVE = {"industrial", "warehouse", "railway"}


def _landuse_shares(hexes: gpd.GeoDataFrame, landuse: gpd.GeoDataFrame) -> tuple[pd.Series, pd.Series]:
    """Residential / commercial land-use share of hex area."""
    n = len(hexes)
    res = pd.Series(0.0, index=hexes.index)
    com = pd.Series(0.0, index=hexes.index)
    if landuse is None or len(landuse) == 0:
        return res, com

    lu = landuse.copy()
    lu["lu"] = lu.get("landuse", pd.Series("other", index=lu.index)).fillna("other")
    inter = gpd.overlay(
        hexes[["h3_index", "geometry"]],
        lu[["geometry", "lu"]],
        how="intersection",
        keep_geom_type=False,
    )
    if len(inter) == 0:
        return res, com
    inter["area"] = inter.geometry.area
    hex_area = hexes.set_index("h3_index").geometry.area
    for kind, bucket in (("res", RESIDENTIAL), ("com", COMMERCIAL)):
        sub = inter[inter["lu"].isin(bucket)]
        if len(sub) == 0:
            continue
        areas = sub.groupby("h3_index")["area"].sum()
        share = hexes["h3_index"].map(areas).fillna(0) / hexes["h3_index"].map(hex_area).clip(lower=1)
        if kind == "res":
            res = share.reset_index(drop=True)
        else:
            com = share.reset_index(drop=True)
    return res.clip(0, 1), com.clip(0, 1)


def compute(ctx: CityContext) -> gpd.GeoDataFrame:
    grid = gpd.read_parquet(ctx.cache(config.GRID_FILE)).to_crs(ctx.metric_crs)
    hexes = grid[["h3_index", "geometry"]].copy().reset_index(drop=True)
    out = hexes[["h3_index"]].copy()

    # Population density
    density = pd.Series(2000.0, index=hexes.index)
    housing_path = ctx.cache(config.HOUSING_FILE)
    if housing_path.exists():
        housing = pd.read_parquet(housing_path)
        if "population_density" in housing.columns:
            density = hexes["h3_index"].map(
                housing.set_index("h3_index")["population_density"]
            ).fillna(density)

    dens_score = density_sweet_spot_score(density)

    # Activity / building intensity
    activity = pd.Series(20.0, index=hexes.index)
    biz_path = ctx.cache(config.BUSINESS_FILE)
    if biz_path.exists():
        biz = pd.read_parquet(biz_path)
        col = "urban_activity" if "urban_activity" in biz.columns else "business_count"
        if col in biz.columns:
            activity = hexes["h3_index"].map(biz.set_index("h3_index")[col]).fillna(20.0)
    activity_score = _interp(
        np.log1p(activity.astype(float)),
        [0, 1.5, 3.0, 4.5, 6.0, 7.5],
        [10, 35, 55, 75, 90, 100],
        below=5,
        above=100,
    )

    # Mixed use from landuse
    try:
        landuse = load_landuse(ctx).to_crs(ctx.metric_crs)
    except Exception:  # noqa: BLE001
        landuse = gpd.GeoDataFrame(columns=["geometry", "landuse"], crs=ctx.metric_crs)
    res_share, com_share = _landuse_shares(hexes, landuse)

    # If landuse is sparse, fall back to activity as commercial proxy.
    if float(com_share.max()) < 0.02 and float(activity.max()) > 0:
        q90 = max(float(activity.quantile(0.9)), 1.0)
        com_proxy = (activity / q90).clip(0, 1) * 0.35
        res_proxy = (1.0 - com_proxy * 0.5).clip(0.2, 0.9)
        mixed = mixed_use_balance_score(res_proxy, com_proxy)
    else:
        mixed = mixed_use_balance_score(res_share, com_share)

    # Green balance vs density
    green_share = pd.Series(8.0, index=hexes.index)
    green_path = ctx.cache(config.GREEN_FILE)
    if green_path.exists():
        green = pd.read_parquet(green_path)
        if "green_share_inside_500m" in green.columns:
            green_share = hexes["h3_index"].map(
                green.set_index("h3_index")["green_share_inside_500m"]
            ).fillna(8.0)

    green_bal = urban_form_green_balance(dens_score, green_share)
    # Replace raw density component with green-balanced density for the composite.
    dens_for_form = green_bal

    w = UF_WEIGHTS
    form = (
        w["density"] * dens_for_form
        + w["activity"] * activity_score
        + w["mixed_use"] * mixed
        + w["green_balance"] * _interp(green_share, [0, 5, 12, 25, 40], [30, 50, 70, 90, 100], below=25, above=100)
    ).clip(0, 100).round(1)

    # Hard cap: extreme density + almost no green → max 88
    extreme = (density > 12000) & (green_share < 5)
    form = pd.Series(np.where(extreme, np.minimum(form, 88.0), form), index=out.index).round(1)

    out["uf_density"] = dens_for_form.round(1).values
    out["uf_activity"] = activity_score.round(1).values
    out["uf_mixed_use"] = mixed.round(1).values
    out["uf_green_balance"] = _interp(
        green_share, [0, 5, 12, 25, 40], [30, 50, 70, 90, 100], below=25, above=100
    ).round(1).values
    out["landuse_residential_share"] = res_share.round(3).values
    out["landuse_commercial_share"] = com_share.round(3).values
    out["urban_form_score"] = form.values
    out["s_urban_form"] = form.values

    log(STEP, f"urban form mean={out['s_urban_form'].mean():.1f}")
    return out


def main(ctx: CityContext | None = None) -> None:
    ctx = ctx or munich_context()
    out = compute(ctx)
    dest = ctx.cache(config.URBAN_FORM_FILE)
    out.to_parquet(dest)
    log(STEP, f"saved -> {dest}")


if __name__ == "__main__":
    main()
