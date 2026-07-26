"""Approximate rent (EUR/m2) per hex - produced for EVERY city.

Rent feeds the "price" comfort factor on the map (expensive hexes lose comfort
when the price slider is turned up). It is resolved through a chain, best data
first (see :mod:`pipeline.rent_sources`):

  1. Real open per-area rent geodata where it exists:
       * Munich - per-district Mietspiegel joined to the actual Stadtbezirk
         polygons (``data/mietspiegel_districts.csv`` + OSM admin_level=9),
       * Berlin - open Wohnlagen WFS (einfach/mittel/gut) mapped to euro.
  2. An extensible BORIS land-value proxy (open Bodenrichtwerte zones),
     anchored to the city-average rent level.
  3. Otherwise, an ESTIMATION MODEL: the curated city average is redistributed
     across the city by the already-computed transport connectivity, business
     density and centre-access factors - so price tracks real infrastructure
     and accessibility rather than a plain distance-from-centre gradient.

Every tier degrades gracefully (network sources return ``None`` when
unreachable), so the pipeline always completes - offline runs land on the
estimate. The chosen tier is recorded on ``ctx.rent_source`` /
``ctx.rent_estimated`` and exported into the map meta for attribution.
"""
from __future__ import annotations

import geopandas as gpd
import numpy as np
import pandas as pd

from . import config, rent_sources
from .centers import load_centers
from .city import CityContext, munich_context
from .common import haversine_m, log

STEP = "rents"


def _load_city_averages() -> dict[str, float]:
    """slug -> average EUR/m2 from the curated table (empty if missing)."""
    if not config.CITY_RENTS_FILE.exists():
        return {}
    table = pd.read_csv(config.CITY_RENTS_FILE)
    return {
        str(row["slug"]).strip(): float(row["avg_eur_m2"])
        for _, row in table.iterrows()
    }


def _fallback_average(ctx: CityContext) -> float:
    """National default average nudged by local business density.

    Denser cities tend to be pricier, so we scale the base average by the mean
    business count per hex relative to a typical reference, clamped to a sane
    band. This only sets the overall level; the estimate provides the intra-city
    variation.
    """
    base = config.RENT_BASE_DEFAULT
    try:
        biz = pd.read_parquet(ctx.cache(config.BUSINESS_FILE))
        mean_biz = float(biz["business_count"].mean())
    except Exception:  # noqa: BLE001 - any missing/empty factor -> no nudge
        return base

    ref_biz = 15.0  # typical mean business_count for a mid-size city hex
    if mean_biz <= 0:
        return base
    scale = (mean_biz / ref_biz) ** 0.25
    scale = max(0.75, min(1.5, scale))
    return base * scale


def _city_average(ctx: CityContext) -> float:
    """Resolve the overall city rent level (EUR/m2) used to anchor estimates."""
    avg = _load_city_averages().get(ctx.slug)
    if avg is None:
        avg = _fallback_average(ctx)
        log(STEP, f"{ctx.name}: no table entry, estimated avg {avg:.1f} EUR/m2")
    else:
        log(STEP, f"{ctx.name}: curated avg {avg:.1f} EUR/m2")
    return avg


def _polycentric_access_min(ctx: CityContext, df: pd.DataFrame) -> pd.Series:
    """Best access-time proxy (minutes) to any detected centre (main + sub).

    ``factor_center`` only measures travel to the MAIN centre, which recreates
    a monocentric rent ring. For the estimate we use the minimum over all
    detected centres so secondary clusters (e.g. Rosenheim west) lift local
    rent instead of everything decaying from one point.
    """
    data = load_centers(ctx)
    centers: list[tuple[float, float]] = []
    if data and data.get("centers"):
        for c in data["centers"]:
            centers.append((c["lat"], c["lng"]))
    elif data and data.get("main"):
        lat, lng = data["main"]
        centers = [(lat, lng)]
    else:
        centers = [ctx.center]

    def best_minutes(row: pd.Series) -> float:
        best = float("inf")
        for c_lat, c_lng in centers:
            dist_km = haversine_m(row["lat"], row["lng"], c_lat, c_lng) / 1000.0
            best = min(best, 8.0 + dist_km * 1.35 / 19.0 * 60.0)
        return best

    return df.apply(best_minutes, axis=1)


def _estimate(ctx: CityContext, avg: float) -> gpd.GeoDataFrame:
    """Multi-factor rent estimate anchored to the city average.

    Builds a 0..1 "premium" surface from transport connectivity, business
    density and poly-centric centre access, then maps it onto the euro band
    [avg*EDGE, avg*CENTER].
    """
    grid = gpd.read_parquet(ctx.cache(config.GRID_FILE))[["h3_index", "lat", "lng"]]
    transport = pd.read_parquet(ctx.cache(config.TRANSPORT_FILE))
    business = pd.read_parquet(ctx.cache(config.BUSINESS_FILE))

    df = (
        grid.merge(transport, on="h3_index")
        .merge(business, on="h3_index")
    )

    t = rent_sources.scale01(df["transport_score"], log_compress=True)
    b = rent_sources.scale01(df["business_count"], log_compress=True)
    c = rent_sources.scale01(_polycentric_access_min(ctx, df), invert=True)

    w = config.RENT_ESTIMATE_WEIGHTS
    total = w["transport"] + w["business"] + w["center"]
    premium = (w["transport"] * t + w["business"] * b + w["center"] * c) / total

    lo, hi = avg * config.RENT_EDGE_MULT, avg * config.RENT_CENTER_MULT
    rent = lo + (hi - lo) * premium

    out = df[["h3_index"]].copy()
    out["rent_eur_m2"] = rent.round(1).values
    return out


def _attach_rent_meta(out: pd.DataFrame, ctx: CityContext) -> pd.DataFrame:
    """Per-hex rent attribution fields for map trust badges."""
    if ctx.rent_estimated:
        out["rent_confidence"] = "low"
        out["rent_year"] = 2024
    elif "Mietspiegel" in (ctx.rent_source or "") or "Wohnlagen" in (ctx.rent_source or ""):
        out["rent_confidence"] = "high"
        out["rent_year"] = 2024
    elif "Zensus" in (ctx.rent_source or ""):
        out["rent_confidence"] = "medium"
        out["rent_year"] = 2022
    else:
        out["rent_confidence"] = "medium"
        out["rent_year"] = 2024
    out["rent_source"] = ctx.rent_source or "Schätzung"
    return out


def compute(ctx: CityContext) -> gpd.GeoDataFrame:
    """Resolve rent per hex through the provider chain, then the estimate."""
    avg = _city_average(ctx)

    for label, estimated, provider in rent_sources.PROVIDERS:
        try:
            out = provider(ctx, avg)
        except Exception as exc:  # noqa: BLE001 - any provider failure -> next tier
            log(STEP, f"provider '{label}' failed ({type(exc).__name__}: {exc})")
            out = None
        if out is not None and len(out):
            ctx.rent_source = label
            ctx.rent_estimated = estimated
            log(
                STEP,
                f"rent from '{label}' ({out['rent_eur_m2'].min():.1f}-"
                f"{out['rent_eur_m2'].max():.1f} EUR/m2)",
            )
            return _attach_rent_meta(out, ctx)

    out = _estimate(ctx, avg)
    ctx.rent_source = "Schätzung (Infrastruktur-Modell)"
    ctx.rent_estimated = True
    log(
        STEP,
        f"rent estimated from factors ({out['rent_eur_m2'].min():.1f}-"
        f"{out['rent_eur_m2'].max():.1f} EUR/m2)",
    )
    return _attach_rent_meta(out, ctx)


def main(ctx: CityContext | None = None) -> None:
    ctx = ctx or munich_context()
    out = compute(ctx)
    dest = ctx.cache(config.RENTS_FILE)
    out.to_parquet(dest)
    log(STEP, f"saved -> rents.parquet (source: {ctx.rent_source})")


if __name__ == "__main__":
    main()
