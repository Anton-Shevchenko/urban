"""Factor — dedicated / physically separated cycleways (map overlay).

Not part of Living Score. Hex scores stay in the export; the map overlay
draws the OSM line geometries (``highway=cycleway``, segregated paths,
``cycleway=track``). Painted on-street lanes are ignored.
"""

from __future__ import annotations

import json

import geopandas as gpd
import pandas as pd

from pipeline import config
from pipeline.city import CityContext, munich_context
from pipeline.common import empty_gdf, log, nearest_polygon_distance
from pipeline.export.score_scales import cycleway_score
from pipeline.ingest.osm_data import load_cycleways

STEP = "factor_cycleways"
# ~4–5 m in WGS84 — enough to drop Overpass vertices the map will never show.
_SIMPLIFY_DEG = 0.00004
_EMPTY_FC = {"type": "FeatureCollection", "features": []}


def compute(ctx: CityContext) -> gpd.GeoDataFrame:
    grid = gpd.read_parquet(ctx.cache(config.GRID_FILE)).to_crs(ctx.metric_crs)
    out = grid[["h3_index"]].copy()
    area_km2 = (grid.geometry.area / 1_000_000.0).clip(lower=1e-6)

    try:
        ways = load_cycleways(ctx)
    except Exception:  # noqa: BLE001
        ways = empty_gdf(["highway", "kind", "foot", "segregated", "cycleway"])
        log(STEP, "cycleway fetch failed; scoring 0")

    if ways is None or len(ways) == 0:
        out["cycleway_length_m"] = 0.0
        out["cycleway_km_per_km2"] = 0.0
        out["nearest_cycleway_m"] = 1500.0
        out["s_cycleways"] = cycleway_score(out["cycleway_km_per_km2"], out["nearest_cycleway_m"])
        log(STEP, "no dedicated cycleways; score=0")
        return out

    ways = ways.to_crs(ctx.metric_crs)
    dist = nearest_polygon_distance(grid, ways, "nearest_cycleway_m")
    out["nearest_cycleway_m"] = dist.reindex(grid.index).fillna(1500.0).round(0)

    inter = gpd.overlay(
        grid[["h3_index", "geometry"]],
        ways[["geometry"]],
        how="intersection",
        keep_geom_type=False,
    )
    if len(inter) == 0:
        length = pd.Series(dtype=float)
    else:
        inter["seg_len"] = inter.geometry.length
        length = inter.groupby("h3_index")["seg_len"].sum()

    out["cycleway_length_m"] = out["h3_index"].map(length).fillna(0.0).round(1)
    out["cycleway_km_per_km2"] = (out["cycleway_length_m"] / 1000.0 / area_km2).round(3)
    out["s_cycleways"] = cycleway_score(out["cycleway_km_per_km2"], out["nearest_cycleway_m"])

    log(
        STEP,
        f"cycleways mean={out['s_cycleways'].mean():.1f} "
        f"hexes_with_path={int((out['cycleway_length_m'] > 0).sum())}/{len(out)}",
    )
    return out


def write_overlay_geojson(ctx: CityContext) -> None:
    """Sidecar LineString layer for the Radwege map view (not hex fill).

    Schema 2 infrastructure (``osm_cycle_infra.parquet``) wins. A current schema
    2 file is left in place so a Wohnindex export cannot replace it with the
    dedicated-only score cache. Without either, the legacy dedicated lines are
    written and are not marked schema 2.
    """
    from pipeline.ingest.cycle_infra import cycleways_cache_ready, write_cycle_infra_geojson

    infra = ctx.cache(config.OSM_CYCLE_INFRA_FILE)
    if infra.exists():
        write_cycle_infra_geojson(ctx, gpd.read_parquet(infra))
        return
    if cycleways_cache_ready(ctx.base_dir):
        log(STEP, "schema 2 cycleways kept; osm_cycleways.parquet stays the score cache")
        return

    dest = ctx.base_dir / config.CYCLEWAYS_GEOJSON_FILE
    dest.parent.mkdir(parents=True, exist_ok=True)
    cache = ctx.cache(config.OSM_CYCLEWAYS_FILE)
    if not cache.exists():
        dest.write_text(json.dumps(_EMPTY_FC), encoding="utf-8")
        log(STEP, f"no {config.OSM_CYCLEWAYS_FILE}; empty overlay -> {dest}")
        return
    gdf = gpd.read_parquet(cache)
    if gdf.crs is not None:
        gdf = gdf.to_crs(config.WGS84)
    if gdf.empty or "geometry" not in gdf.columns:
        dest.write_text(json.dumps(_EMPTY_FC), encoding="utf-8")
        log(STEP, f"empty cycleway overlay -> {dest}")
        return
    gdf = gdf[gdf.geometry.notna() & ~gdf.geometry.is_empty].copy()
    gdf = gdf[gdf.geometry.geom_type.isin(["LineString", "MultiLineString"])]
    if gdf.empty:
        dest.write_text(json.dumps(_EMPTY_FC), encoding="utf-8")
        return
    gdf["geometry"] = gdf.geometry.simplify(_SIMPLIFY_DEG, preserve_topology=False)
    features = []
    for _, row in gdf.iterrows():
        geom = row.geometry
        if geom is None or geom.is_empty:
            continue
        kind = ""
        if "kind" in gdf.columns and row["kind"] is not None:
            kind = str(row["kind"])
        side = ""
        if "side" in gdf.columns and row["side"] is not None:
            side = str(row["side"])
        features.append(
            {
                "type": "Feature",
                "geometry": geom.__geo_interface__,
                "properties": {"kind": kind, "side": side},
            }
        )
    dest.write_text(
        json.dumps({"type": "FeatureCollection", "features": features}, separators=(",", ":")),
        encoding="utf-8",
    )
    log(STEP, f"cycleway overlay {len(features)} ways -> {dest}")


def main(ctx: CityContext | None = None) -> None:
    ctx = ctx or munich_context()
    out = compute(ctx)
    dest = ctx.cache(config.CYCLEWAYS_FILE)
    out.to_parquet(dest)
    log(STEP, f"saved -> {dest}")


if __name__ == "__main__":
    main()
