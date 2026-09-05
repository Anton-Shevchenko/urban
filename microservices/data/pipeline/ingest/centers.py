"""Step - detect the city centre(s) from business + transport density.

The legacy pipeline treated "the centre" as a single fixed point (Marienplatz
for Munich) or the geometric centroid of the admin boundary. Neither reflects
reality: the centre is where businesses and transport actually cluster, and
larger cities are poly-centric.

This step builds a "centrality mass" surface over the H3 grid from the broad
business layer and the (importance-weighted) transit stations, smooths it over
neighbouring hexes, then:

  * picks the global peak as the MAIN centre (``ctx.center`` is updated to it),
  * greedily adds well-separated, sufficiently strong peaks as SUB-centres.

The result is cached to ``centers.json`` and consumed by ``factor_center`` (the
"proximity to the main centre" factor) and by ``rents`` (the monocentric rent
gradient). It is also exported into the map meta so the frontend can mark the
main centre and highlight the secondary clusters in other districts.
"""

from __future__ import annotations

import json
from collections import defaultdict

import geopandas as gpd
import h3

from pipeline import config
from pipeline.city import CityContext, munich_context
from pipeline.common import haversine_m, log
from pipeline.ingest.osm_data import load_business, load_stations

STEP = "centers"


def _mass_by_hex(grid: gpd.GeoDataFrame, ctx: CityContext) -> dict[str, float]:
    """Smoothed centrality mass (0..1) per grid hex."""
    res = config.H3_RES
    grid_cells = set(grid["h3_index"])

    biz = load_business(ctx)
    sta = load_stations(ctx)

    biz_raw: dict[str, float] = defaultdict(float)
    for geom in biz.geometry:
        if geom is None or geom.is_empty:
            continue
        cell = h3.latlng_to_cell(geom.y, geom.x, res)
        biz_raw[cell] += 1.0

    sta_raw: dict[str, float] = defaultdict(float)
    if len(sta):
        weights = sta["weight"] if "weight" in sta.columns else [1.0] * len(sta)
        for geom, w in zip(sta.geometry, weights, strict=True):
            if geom is None or geom.is_empty:
                continue
            cell = h3.latlng_to_cell(geom.y, geom.x, res)
            sta_raw[cell] += float(w)

    # Smooth each layer over the k-ring neighbourhood so a lone dense hex does
    # not beat a broad, genuine cluster.
    k = config.CENTER_SMOOTH_KRING
    biz_sm: dict[str, float] = {}
    sta_sm: dict[str, float] = {}
    for cell in grid_cells:
        disk = h3.grid_disk(cell, k)
        biz_sm[cell] = sum(biz_raw.get(nb, 0.0) for nb in disk)
        sta_sm[cell] = sum(sta_raw.get(nb, 0.0) for nb in disk)

    biz_max = max(biz_sm.values(), default=0.0)
    sta_max = max(sta_sm.values(), default=0.0)
    wb, wt = config.CENTER_MASS_BUSINESS_W, config.CENTER_MASS_TRANSPORT_W

    mass: dict[str, float] = {}
    for cell in grid_cells:
        b = biz_sm[cell] / biz_max if biz_max else 0.0
        s = sta_sm[cell] / sta_max if sta_max else 0.0
        mass[cell] = wb * b + wt * s
    return mass


def compute(ctx: CityContext) -> dict:
    grid = gpd.read_parquet(ctx.cache(config.GRID_FILE))[["h3_index", "lat", "lng"]]
    latlng = {r.h3_index: (r.lat, r.lng) for r in grid.itertuples()}

    mass = _mass_by_hex(grid, ctx)
    ranked = sorted(mass.items(), key=lambda kv: kv[1], reverse=True)

    # No signal at all (tiny place, no OSM data) -> keep the geometric centre.
    if not ranked or ranked[0][1] <= 0.0:
        c_lat, c_lng = ctx.center
        result = {
            "main": [c_lat, c_lng],
            "centers": [{"lat": c_lat, "lng": c_lng, "strength": 1.0, "primary": True}],
            "source": "geometric",
        }
        _save(ctx, result)
        log(STEP, "no business/transport signal; keeping geometric centre")
        return result

    main_cell, main_mass = ranked[0]
    selected: list[tuple[str, float]] = [(main_cell, main_mass)]

    for cell, m in ranked[1:]:
        if len(selected) >= config.CENTER_MAX:
            break
        if m < config.CENTER_SECONDARY_MIN_FRAC * main_mass:
            break
        lat, lng = latlng[cell]
        far_enough = all(
            haversine_m(lat, lng, *latlng[s]) >= config.CENTER_MIN_SEPARATION_M for s, _ in selected
        )
        if far_enough:
            selected.append((cell, m))

    centers = []
    for i, (cell, m) in enumerate(selected):
        lat, lng = latlng[cell]
        centers.append(
            {
                "lat": round(lat, 6),
                "lng": round(lng, 6),
                "strength": round(m / main_mass, 3),
                "primary": i == 0,
            }
        )

    main_lat, main_lng = latlng[main_cell]
    result = {"main": [main_lat, main_lng], "centers": centers, "source": "density"}
    _save(ctx, result)
    # Re-anchor the context on the real (data-driven) centre for the rest of
    # the run: the centre factor, the rent gradient and the map all use it.
    ctx.center = (main_lat, main_lng)
    ctx.centers = centers
    log(
        STEP,
        f"detected {len(centers)} centre(s); main at ({main_lat:.4f}, {main_lng:.4f}), "
        f"{len(centers) - 1} sub-centre(s)",
    )
    return result


def _save(ctx: CityContext, result: dict) -> None:
    path = ctx.cache(config.CENTERS_FILE)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(result, fh)


def load_centers(ctx: CityContext) -> dict | None:
    path = ctx.cache(config.CENTERS_FILE)
    if not path.exists():
        return None
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def main_center(ctx: CityContext) -> tuple[float, float]:
    """The main (data-driven) centre, falling back to the context centre."""
    data = load_centers(ctx)
    if data and data.get("main"):
        lat, lng = data["main"]
        return (lat, lng)
    return ctx.center


def main(ctx: CityContext | None = None) -> None:
    ctx = ctx or munich_context()
    compute(ctx)


if __name__ == "__main__":
    main()
