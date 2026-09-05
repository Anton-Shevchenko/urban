"""Factor - walking quality (pleasantness of pedestrian environment).

Combines street-network connectivity, pedestrian infrastructure, traffic
calmness, and green/quiet environment. Distinct from Daily Life access:
a short walk along a hostile arterial scores poorly here.
"""

from __future__ import annotations

import geopandas as gpd
import numpy as np
import pandas as pd
from shapely.geometry import LineString, Point

from pipeline import config
from pipeline.city import CityContext, munich_context
from pipeline.common import empty_gdf, log, overpass_elements
from pipeline.export.score_scales import _interp
from pipeline.ingest.osm_data import load_roads

STEP = "factor_walking_quality"
WQ_WEIGHTS = config.WALKING_QUALITY_WEIGHTS
PED_CACHE = "osm_pedestrian_ways.parquet"

HIGHWAY_HOSTILITY = {
    "motorway": 1.0,
    "trunk": 0.95,
    "primary": 0.80,
    "secondary": 0.55,
    "tertiary": 0.35,
    "unclassified": 0.30,
    "residential": 0.12,
    "living_street": 0.05,
    "service": 0.15,
}


def _geom_from_way(el: dict):
    coords = [(nd["lon"], nd["lat"]) for nd in el.get("geometry", [])]
    if len(coords) < 2:
        return None
    return LineString(coords)


def _load_pedestrian_ways(ctx: CityContext) -> gpd.GeoDataFrame:
    cache = ctx.cache(PED_CACHE)
    if cache.exists():
        cached = gpd.read_parquet(cache)
        if len(cached) > 0:
            return cached
        cache.unlink(missing_ok=True)

    bbox_str = ctx.bbox_str
    query = f"""
    [out:json][timeout:180];
    (
      way["highway"~"^(footway|pedestrian|path|steps|living_street)$"]({bbox_str});
      way["highway"]["sidewalk"~"^(both|left|right|yes)$"]({bbox_str});
      way["highway"="crossing"]({bbox_str});
      node["highway"="crossing"]({bbox_str});
    );
    out geom;
    """
    els = overpass_elements(query, STEP)
    rows = []
    for el in els:
        tags = el.get("tags", {})
        if el.get("type") == "node":
            lon, lat = el.get("lon"), el.get("lat")
            if lon is None or lat is None:
                continue
            rows.append(
                {
                    "geometry": Point(lon, lat),
                    "highway": tags.get("highway", "crossing"),
                    "sidewalk": tags.get("sidewalk", ""),
                    "kind": "crossing_node",
                }
            )
            continue
        geom = _geom_from_way(el)
        if geom is None:
            continue
        hw = tags.get("highway", "")
        kind = (
            "footway"
            if hw in ("footway", "path", "steps")
            else (
                "pedestrian" if hw == "pedestrian" else ("crossing" if hw == "crossing" else "sidewalk_road")
            )
        )
        rows.append(
            {
                "geometry": geom,
                "highway": hw,
                "sidewalk": tags.get("sidewalk", ""),
                "kind": kind,
            }
        )
    cols = ["highway", "sidewalk", "kind"]
    gdf = empty_gdf(cols) if not rows else gpd.GeoDataFrame(rows, crs=config.WGS84)
    if len(gdf):
        gdf.to_parquet(cache)
    log(STEP, f"pedestrian ways fetched: {len(gdf)}")
    return gdf


def _intersection_density(roads: gpd.GeoDataFrame, hexes: gpd.GeoDataFrame) -> pd.Series:
    """Nodes where ≥3 road segments meet, per km² of hex."""
    if roads is None or len(roads) == 0:
        return pd.Series(0.0, index=hexes.index)

    # Sample endpoints + mid vertices as candidate nodes (rounded to ~2 m).
    coords = []
    for geom in roads.geometry:
        if geom is None or geom.is_empty:
            continue
        if geom.geom_type == "LineString":
            pts = list(geom.coords)
        elif geom.geom_type == "MultiLineString":
            pts = [c for line in geom.geoms for c in line.coords]
        else:
            continue
        for x, y in pts:
            coords.append((round(x / 2) * 2, round(y / 2) * 2))

    if not coords:
        return pd.Series(0.0, index=hexes.index)

    node_df = pd.DataFrame(coords, columns=["x", "y"])
    degree = node_df.groupby(["x", "y"]).size().reset_index(name="deg")
    junctions = degree[degree["deg"] >= 3]
    if len(junctions) == 0:
        return pd.Series(0.0, index=hexes.index)

    pts = gpd.GeoDataFrame(
        junctions,
        geometry=gpd.points_from_xy(junctions["x"], junctions["y"]),
        crs=hexes.crs,
    )
    joined = gpd.sjoin(pts, hexes[["h3_index", "geometry"]], predicate="within", how="inner")
    counts = joined.groupby("h3_index").size()
    area_km2 = hexes.set_index("h3_index").geometry.area / 1_000_000
    dens = hexes["h3_index"].map(counts).fillna(0) / hexes["h3_index"].map(area_km2).clip(lower=1e-6)
    return dens.reset_index(drop=True)


def _mean_block_length(roads: gpd.GeoDataFrame, hexes: gpd.GeoDataFrame) -> pd.Series:
    """Mean segment length in hex — shorter blocks → more walkable."""
    if roads is None or len(roads) == 0:
        return pd.Series(120.0, index=hexes.index)
    work = roads.copy()
    work["seg_len"] = work.geometry.length
    inter = gpd.overlay(
        hexes[["h3_index", "geometry"]],
        work[["geometry", "seg_len"]],
        how="intersection",
        keep_geom_type=False,
    )
    if len(inter) == 0:
        return pd.Series(120.0, index=hexes.index)
    inter["len"] = inter.geometry.length
    agg = inter.groupby("h3_index")["len"].mean()
    return hexes["h3_index"].map(agg).fillna(120.0).reset_index(drop=True)


def compute(ctx: CityContext) -> gpd.GeoDataFrame:
    grid = gpd.read_parquet(ctx.cache(config.GRID_FILE)).to_crs(ctx.metric_crs)
    hexes = grid[["h3_index", "geometry"]].copy().reset_index(drop=True)
    out = hexes[["h3_index"]].copy()

    try:
        roads = load_roads(ctx).to_crs(ctx.metric_crs)
    except Exception:  # noqa: BLE001
        roads = gpd.GeoDataFrame(columns=["geometry", "highway", "maxspeed"], crs=ctx.metric_crs)

    ped = _load_pedestrian_ways(ctx).to_crs(ctx.metric_crs)

    # --- Network connectivity ---
    ix_dens = _intersection_density(roads, hexes)
    block_len = _mean_block_length(roads, hexes)
    link_len = pd.Series(0.0, index=hexes.index)
    if len(roads):
        inter = gpd.overlay(
            hexes[["h3_index", "geometry"]],
            roads[["geometry"]].assign(_w=1),
            how="intersection",
            keep_geom_type=False,
        )
        if len(inter):
            inter["seg_len"] = inter.geometry.length
            link_len = hexes["h3_index"].map(inter.groupby("h3_index")["seg_len"].sum()).fillna(0)
    area_ha = hexes.geometry.area / 10_000
    link_density = (link_len / area_ha.clip(lower=0.01)).reset_index(drop=True)

    # Wider bands → more dispersion (poor 20–40, mid 50–70, good 80–100).
    network_ix = _interp(ix_dens, [5, 20, 45, 80, 140, 200], [10, 30, 55, 75, 92, 100], below=5, above=100)
    network_block = _interp(
        block_len, [35, 60, 90, 130, 200, 320], [100, 88, 70, 45, 22, 8], below=100, above=5
    )
    network_link = _interp(
        link_density, [30, 100, 220, 400, 650, 1000], [8, 25, 50, 72, 90, 100], below=5, above=100
    )
    network = (0.45 * network_ix + 0.30 * network_block + 0.25 * network_link).clip(0, 100)

    # --- Pedestrian infrastructure ---
    ped_score = pd.Series(35.0, index=hexes.index)
    if len(ped):
        lines = ped[ped.geom_type.isin(["LineString", "MultiLineString"])]
        nodes = ped[ped.geom_type == "Point"]
        ped_len = pd.Series(0.0, index=hexes.index)
        if len(lines):
            inter = gpd.overlay(
                hexes[["h3_index", "geometry"]],
                lines[["geometry"]],
                how="intersection",
                keep_geom_type=False,
            )
            if len(inter):
                inter["seg_len"] = inter.geometry.length
                ped_len = hexes["h3_index"].map(inter.groupby("h3_index")["seg_len"].sum()).fillna(0)
        crossing_n = pd.Series(0.0, index=hexes.index)
        if len(nodes):
            joined = gpd.sjoin(nodes, hexes[["h3_index", "geometry"]], predicate="within", how="inner")
            crossing_n = hexes["h3_index"].map(joined.groupby("h3_index").size()).fillna(0)
        ped_share = (ped_len / link_len.clip(lower=1)).clip(0, 2)
        ped_infra_raw = _interp(
            ped_share, [0, 0.03, 0.10, 0.25, 0.50, 0.90], [15, 35, 55, 75, 90, 100], below=10, above=100
        )
        crossing_bonus = _interp(crossing_n, [0, 1, 2, 5, 10, 18], [0, 8, 15, 25, 35, 40], below=0, above=40)
        ped_score = (0.75 * ped_infra_raw + 0.25 * (crossing_bonus / 40 * 100)).clip(0, 100)

    # Also fold in road-tag ped infra from safety roads.
    if len(roads) and "cycleway" in roads.columns:
        roads = roads.copy()
        roads["ped_tag"] = (
            roads["cycleway"].fillna("").ne("").astype(float) * 0.15
            + roads.get("crossing", pd.Series("", index=roads.index)).fillna("").ne("").astype(float) * 0.10
        )
        roads["length_m"] = roads.geometry.length
        inter = gpd.overlay(
            hexes[["h3_index", "geometry"]],
            roads[["geometry", "ped_tag", "length_m"]],
            how="intersection",
            keep_geom_type=False,
        )
        if len(inter):
            inter["seg_len"] = inter.geometry.length
            inter["w"] = inter["ped_tag"] * inter["seg_len"]
            agg = inter.groupby("h3_index").agg(w=("w", "sum"), L=("seg_len", "sum"))
            tag_idx = (agg["w"] / agg["L"].clip(lower=1)).clip(0, 0.4)
            tag_score = _interp(
                hexes["h3_index"].map(tag_idx).fillna(0),
                [0, 0.05, 0.10, 0.20, 0.30],
                [40, 55, 70, 85, 100],
                below=40,
                above=100,
            )
            ped_score = (0.7 * ped_score + 0.3 * tag_score).clip(0, 100)

    # --- Traffic calm (invert hostility) ---
    traffic_calm = pd.Series(55.0, index=hexes.index)
    if len(roads):
        roads = roads.copy()
        roads["hostility"] = roads["highway"].map(HIGHWAY_HOSTILITY).fillna(0.4)

        def _spd(v) -> float:
            """Parse OSM maxspeed; empty / non-numeric tags → residential default."""
            if v is None or (isinstance(v, float) and np.isnan(v)):
                return 50.0
            s = str(v).strip().lower()
            if not s or s in {"none", "signals", "variable", "walk", "nan"}:
                return 50.0
            # Common German / OSM textual limits
            if s in {"de:walk", "walk"}:
                return 5.0
            if "zone:30" in s or s in {"de:zone30", "30"}:
                return 30.0
            if s in {"de:urban", "urban"}:
                return 50.0
            if s in {"de:rural", "rural"}:
                return 100.0
            if s in {"de:motorway", "motorway"}:
                return 130.0
            token = s.replace("km/h", "").replace("kmh", "").strip().split()[0] if s.split() else ""
            if not token:
                return 50.0
            # Ranges like "30;50" or "80|100" → take first number
            for sep in (";", "|", ","):
                if sep in token:
                    token = token.split(sep)[0]
            try:
                return float(token)
            except ValueError:
                digits = "".join(ch for ch in token if ch.isdigit() or ch == ".")
                try:
                    return float(digits) if digits else 50.0
                except ValueError:
                    return 50.0

        maxspeed = roads["maxspeed"] if "maxspeed" in roads.columns else pd.Series("", index=roads.index)
        roads["spd"] = maxspeed.map(_spd)
        roads["spd_risk"] = (roads["spd"] / 100.0).clip(0.1, 1.0)
        roads["risk"] = roads["hostility"] * 0.65 + roads["spd_risk"] * 0.35
        roads["length_m"] = roads.geometry.length
        inter = gpd.overlay(
            hexes[["h3_index", "geometry"]],
            roads[["geometry", "risk"]],
            how="intersection",
            keep_geom_type=False,
        )
        if len(inter):
            inter["seg_len"] = inter.geometry.length
            inter["w"] = inter["risk"] * inter["seg_len"]
            agg = inter.groupby("h3_index").agg(w=("w", "sum"), L=("seg_len", "sum"))
            risk = hexes["h3_index"].map(agg["w"] / agg["L"].clip(lower=1)).fillna(0.35)
            traffic_calm = _interp(
                risk,
                [0.08, 0.15, 0.28, 0.42, 0.60, 0.80, 0.95],
                [100, 88, 70, 48, 28, 12, 3],
                below=100,
                above=0,
            )

    # --- Comfort: trees + quiet + traffic ---
    green_path = ctx.cache(config.GREEN_FILE)
    noise_path = ctx.cache(config.NOISE_FILE)
    green_share = pd.Series(5.0, index=hexes.index)
    canopy = pd.Series(15.0, index=hexes.index)
    noise_db = pd.Series(60.0, index=hexes.index)
    if green_path.exists():
        green = pd.read_parquet(green_path)
        if "green_share_inside_500m" in green.columns:
            green_share = (
                hexes["h3_index"].map(green.set_index("h3_index")["green_share_inside_500m"]).fillna(5.0)
            )
        if "tree_canopy_pct" in green.columns:
            canopy = hexes["h3_index"].map(green.set_index("h3_index")["tree_canopy_pct"]).fillna(15.0)
    if noise_path.exists():
        noise = pd.read_parquet(noise_path)
        if "noise_db" in noise.columns:
            noise_db = hexes["h3_index"].map(noise.set_index("h3_index")["noise_db"]).fillna(60.0)

    green_s = _interp(green_share, [0, 3, 8, 18, 30, 50], [8, 25, 45, 70, 88, 100], below=5, above=100)
    tree_s = _interp(canopy, [0, 3, 10, 20, 30, 45], [10, 28, 50, 72, 90, 100], below=8, above=100)
    quiet_s = _interp(noise_db, [45, 52, 58, 65, 72, 80], [100, 82, 60, 35, 15, 3], below=100, above=0)
    comfort = (0.35 * green_s + 0.35 * tree_s + 0.30 * quiet_s).clip(0, 100)
    # Safety = pedestrian infra + traffic calmness.
    safety = (0.55 * ped_score + 0.45 * traffic_calm).clip(0, 100)

    # Accessibility: daily destinations (+ center compact access for small cities).
    accessibility = pd.Series(50.0, index=hexes.index)
    dn_path = ctx.cache(config.DAILY_NEEDS_FILE)
    if dn_path.exists():
        dn = pd.read_parquet(dn_path)
        col = "daily_life_raw" if "daily_life_raw" in dn.columns else "s_daily_life"
        if col in dn.columns:
            accessibility = hexes["h3_index"].map(dn.set_index("h3_index")[col]).fillna(50.0)
    center_path = ctx.cache(config.CENTER_FILE)
    if center_path.exists() and ctx.city_type in ("MEDIUM_CITY", "SMALL_CITY"):
        center_df = pd.read_parquet(center_path)
        if "center_min" in center_df.columns:
            cmin = hexes["h3_index"].map(center_df.set_index("h3_index")["center_min"]).fillna(30)
            center_access = _interp(cmin, [3, 8, 15, 25, 40], [100, 80, 55, 30, 10], below=100, above=5)
            accessibility = (0.65 * accessibility + 0.35 * center_access).clip(0, 100)

    from pipeline.city_context import ensure_city_context

    ensure_city_context(ctx)
    w = dict(config.WALK_WEIGHTS_BY_CITY_TYPE.get(ctx.city_type) or WQ_WEIGHTS)
    tw = sum(w.values()) or 1.0
    w = {k: v / tw for k, v in w.items()}

    walking_raw = (
        (
            w.get("network", 0.40) * network
            + w.get("safety", 0.30) * safety
            + w.get("comfort", 0.20) * comfort
            + w.get("accessibility", 0.10) * accessibility
        )
        .clip(0, 100)
        .round(1)
    )

    out["wq_network"] = network.round(1).values
    out["wq_ped_infra"] = ped_score.round(1).values
    out["wq_traffic_calm"] = traffic_calm.round(1).values
    out["wq_environment"] = comfort.round(1).values
    out["wq_safety"] = safety.round(1).values
    out["wq_comfort"] = comfort.round(1).values
    out["wq_accessibility"] = accessibility.round(1).values
    out["intersection_density"] = ix_dens.round(1).values
    out["mean_block_length_m"] = block_len.round(0).values
    out["walking_quality_raw"] = walking_raw.values
    out["walking_quality_score"] = walking_raw.values
    out["s_walking_quality"] = walking_raw.values

    log(STEP, f"walking quality raw mean={out['walking_quality_raw'].mean():.1f} ({ctx.city_type})")
    return out


def main(ctx: CityContext | None = None) -> None:
    ctx = ctx or munich_context()
    out = compute(ctx)
    dest = ctx.cache(config.WALKING_QUALITY_FILE)
    out.to_parquet(dest)
    log(STEP, f"saved -> {dest}")


if __name__ == "__main__":
    main()
