"""Zensus 2022 grid loader (Germany-wide, bbox-scoped).

Downloads or loads cached 100 m population / housing grids from Destatis
open data when available. Falls back to OSM building proxies when the
national grid file is not present locally.
"""
from __future__ import annotations

import json
from pathlib import Path

import geopandas as gpd
import numpy as np
import pandas as pd
import requests

from . import config
from .city import CityContext
from .common import log
from .osm_data import load_buildings

STEP = "zensus"

# Open Zensus 2022 grid URLs (INSPIRE 100 m). Extend as Destatis publishes.
ZENSUS_GRID_URLS = {
    "population": "https://www.zensus2022.de/static/zensus/data/csv/100m-grid/population.csv",
    "housing": "https://www.zensus2022.de/static/zensus/data/csv/100m-grid/living-space.csv",
}


def _load_cached_grid(name: str) -> pd.DataFrame | None:
    path = config.ZENSUS_CACHE_DIR / f"{name}.parquet"
    if path.exists():
        return pd.read_parquet(path)
    return None


def _fetch_grid_csv(url: str) -> pd.DataFrame | None:
    try:
        resp = requests.get(url, timeout=60, headers={"User-Agent": config.USER_AGENT})
        if resp.status_code != 200:
            return None
        from io import StringIO
        return pd.read_csv(StringIO(resp.text), sep=";")
    except (requests.RequestException, pd.errors.ParserError) as exc:
        log(STEP, f"Zensus fetch failed {url}: {exc}")
        return None


def population_for_bbox(ctx: CityContext) -> gpd.GeoDataFrame | None:
    """Return population grid cells intersecting the city bbox."""
    cached = _load_cached_grid("population")
    if cached is None:
        raw = _fetch_grid_csv(ZENSUS_GRID_URLS["population"])
        if raw is None:
            return None
        cached = raw
        cached.to_parquet(config.ZENSUS_CACHE_DIR / "population.parquet")

    # Expected columns: grid_id, x, y, population (varies by release).
    if "population" not in cached.columns and "einwohner" in cached.columns:
        cached = cached.rename(columns={"einwohner": "population"})
    if "population" not in cached.columns:
        return None

    # Filter by rough bbox if lat/lon columns exist.
    south, west, north, east = ctx.bbox
    if "lat" in cached.columns and "lon" in cached.columns:
        sub = cached[
            (cached["lat"] >= south) & (cached["lat"] <= north)
            & (cached["lon"] >= west) & (cached["lon"] <= east)
        ].copy()
        if len(sub):
            return gpd.GeoDataFrame(
                sub,
                geometry=gpd.points_from_xy(sub["lon"], sub["lat"]),
                crs=config.WGS84,
            )
    return None


def osm_housing_proxy(ctx: CityContext) -> pd.DataFrame:
    """Fallback housing metrics from OSM buildings when Zensus is unavailable."""
    grid = gpd.read_parquet(ctx.cache(config.GRID_FILE))
    try:
        bld = load_buildings(ctx).to_crs(ctx.metric_crs)
        grid_m = gpd.read_parquet(ctx.cache(config.GRID_FILE)).to_crs(ctx.metric_crs)
    except Exception:  # noqa: BLE001
        out = grid[["h3_index"]].copy()
        out["population_density"] = 0.0
        out["housing_space_m2_per_capita"] = 30.0
        out["building_age_median"] = 1970.0
        out["vacancy_rate"] = 0.05
        return out

    bld["year"] = pd.to_numeric(bld.get("start_date", pd.Series()), errors="coerce")
    bld["levels"] = pd.to_numeric(bld.get("building:levels", pd.Series()), errors="coerce").fillna(3)

    joined = gpd.sjoin(bld, grid_m[["h3_index", "geometry"]], predicate="within", how="inner")
    joined = joined[joined["year"].notna()].copy()

    def _bucket(year: float) -> str:
        if year < 1949:
            return "pre_1949"
        if year < 1980:
            return "1950_1979"
        if year < 2000:
            return "1980_1999"
        return "2000_plus"

    if len(joined):
        joined["age_bucket"] = joined["year"].map(_bucket)
        counts = joined.groupby(["h3_index", "age_bucket"]).size().unstack(fill_value=0)
        for col in ("pre_1949", "1950_1979", "1980_1999", "2000_plus"):
            if col not in counts.columns:
                counts[col] = 0
        totals = counts.sum(axis=1).clip(lower=1)
        shares = counts.div(totals, axis=0)
        share_cols = {
            "share_pre_1949": shares["pre_1949"],
            "share_1950_1979": shares["1950_1979"],
            "share_1980_1999": shares["1980_1999"],
            "share_2000_plus": shares["2000_plus"],
        }
    else:
        share_cols = {}

    agg = joined.groupby("h3_index").agg(
        building_age_median=("year", "median"),
        units_per_building=("levels", "mean"),
        building_count=("year", "count"),
    )
    out = grid[["h3_index"]].merge(agg, on="h3_index", how="left")
    for col, series in share_cols.items():
        out[col] = out["h3_index"].map(series).fillna(0.25)
    if not share_cols:
        out["share_pre_1949"] = 0.25
        out["share_1950_1979"] = 0.25
        out["share_1980_1999"] = 0.25
        out["share_2000_plus"] = 0.25
    out["building_age_median"] = out["building_age_median"].fillna(1970)
    out["units_per_building"] = out["units_per_building"].fillna(3)
    out["housing_space_m2_per_capita"] = 35.0
    out["vacancy_rate"] = 0.04
    out["population_density"] = out["building_count"].fillna(0) * 50
    return out


def housing_metrics(ctx: CityContext) -> pd.DataFrame:
    """Resolve per-hex housing / population metrics."""
    zensus = population_for_bbox(ctx)
    if zensus is not None and len(zensus):
        grid = gpd.read_parquet(ctx.cache(config.GRID_FILE))
        joined = gpd.sjoin(zensus, grid[["h3_index", "geometry"]], predicate="within", how="inner")
        pop = joined.groupby("h3_index")["population"].sum().reset_index()
        pop["population_density"] = pop["population"] / 0.1  # per km2 approx for res-9 hex
        out = grid[["h3_index"]].merge(pop, on="h3_index", how="left")
        out["population"] = out["population"].fillna(0)
        out["population_density"] = out["population_density"].fillna(0)
        out["housing_space_m2_per_capita"] = 38.0
        out["building_age_median"] = 1965.0
        out["vacancy_rate"] = 0.03
        out["units_per_building"] = 4.0
        out["share_pre_1949"] = 0.25
        out["share_1950_1979"] = 0.25
        out["share_1980_1999"] = 0.25
        out["share_2000_plus"] = 0.25
        log(STEP, f"Zensus population joined for {len(pop)} hexes")
        return out

    log(STEP, "Zensus unavailable; using OSM building proxy")
    return osm_housing_proxy(ctx)
