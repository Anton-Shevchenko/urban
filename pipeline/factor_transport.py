"""Factor - transport connectivity.

Unlike the centre factor (travel time to *one* point), this measures how well a
hex is plugged into the transit network as a whole: a distance-decayed,
importance-weighted sum over nearby stations.

    connectivity(hex) = sum_s  weight(s) * exp(-dist(hex, s) / decay)

Rapid transit (U-/S-Bahn) counts more than trams; both proximity to important
stations and the sheer density of stations raise the score. Stations farther
than ``TRANSPORT_MAX_M`` do not contribute.
"""
from __future__ import annotations

import geopandas as gpd
import numpy as np
import pandas as pd

from . import config
from .city import CityContext, munich_context
from .common import log
from .osm_data import load_stations

STEP = "factor_transport"


def compute(ctx: CityContext) -> gpd.GeoDataFrame:
    grid = gpd.read_parquet(ctx.cache(config.GRID_FILE))
    out = grid[["h3_index"]].copy()

    stations = load_stations(ctx)
    if len(stations) == 0:
        out["transport_score"] = 0.0
        log(STEP, "no stations found; transport_score = 0")
        return out

    grid_m = gpd.GeoDataFrame(
        grid[["h3_index"]].copy(),
        geometry=gpd.points_from_xy(grid["lng"], grid["lat"]),
        crs=config.WGS84,
    ).to_crs(ctx.metric_crs)
    st_m = stations.to_crs(ctx.metric_crs)

    hx = np.c_[grid_m.geometry.x.values, grid_m.geometry.y.values]     # (H,2)
    sx = np.c_[st_m.geometry.x.values, st_m.geometry.y.values]         # (S,2)
    weights = (
        st_m["weight"].to_numpy(dtype=float)
        if "weight" in st_m.columns
        else np.ones(len(st_m))
    )                                                                  # (S,)

    dist = np.sqrt(((hx[:, None, :] - sx[None, :, :]) ** 2).sum(axis=2))  # (H,S)
    decay = np.exp(-dist / config.TRANSPORT_DECAY_M)
    decay[dist > config.TRANSPORT_MAX_M] = 0.0
    score = (decay * weights[None, :]).sum(axis=1)                     # (H,)

    out["transport_score"] = np.round(score, 4)
    log(
        STEP,
        f"transport connectivity computed (max={out['transport_score'].max():.2f}, "
        f"mean={out['transport_score'].mean():.2f})",
    )
    return out


def main(ctx: CityContext | None = None) -> None:
    ctx = ctx or munich_context()
    out = compute(ctx)
    dest = ctx.cache(config.TRANSPORT_FILE)
    out.to_parquet(dest)
    log(STEP, f"saved -> {dest}")


if __name__ == "__main__":
    main()
