"""Open rent-data providers + shared helpers for the price factor.

The "price" comfort factor is resolved through a chain (see :mod:`pipeline.rents`):

  1. :func:`munich_districts` - real per-district Mietspiegel spatial join,
  2. :func:`berlin_wohnlagen` - Berlin Wohnlagen open WFS + class->euro anchor,
  3. :func:`boris_landvalue` - extensible BORIS land-value proxy (anchored),
  -> otherwise :mod:`pipeline.rents` falls back to the estimation model.

Every provider takes ``(ctx, avg)`` and returns a ``DataFrame[h3_index,
rent_eur_m2]`` aligned to the city grid, or ``None`` when the source is
unavailable/unreachable. All network access is wrapped so an offline run simply
falls through to the next tier (and ultimately to the estimate), keeping the
pipeline able to complete end-to-end without connectivity.
"""
from __future__ import annotations

import io
import re
from urllib.parse import urlencode

import geopandas as gpd
import numpy as np
import pandas as pd
import requests
from shapely.geometry import LineString, MultiLineString
from shapely.ops import linemerge, polygonize, unary_union

from . import config
from .city import CityContext, slugify
from .common import log, overpass_elements

STEP = "rent_sources"


# --- generic scaling / anchoring -------------------------------------------
def scale01(series: pd.Series, invert: bool = False, log_compress: bool = False) -> pd.Series:
    """Percentile-clipped min-max scale to 0..1 (matches normalize_export)."""
    x = series.astype(float).copy()
    if log_compress:
        x = np.log1p(x.clip(lower=0))
    lo = np.percentile(x, 5)
    hi = np.percentile(x, 95)
    if hi <= lo:
        return pd.Series(0.5, index=series.index)
    norm = ((x - lo) / (hi - lo)).clip(0, 1)
    if invert:
        norm = 1 - norm
    return norm


def anchor_to_average(values, avg: float) -> pd.Series:
    """Rescale a relative surface so its mean equals ``avg`` (ratios kept),
    then clip into the realistic euro band [avg*EDGE, avg*CENTER]."""
    v = pd.Series(values, dtype=float).reset_index(drop=True)
    mean = v.mean()
    if not np.isfinite(mean) or mean <= 0:
        return pd.Series(np.full(len(v), round(avg, 1)))
    scaled = v / mean * avg
    lo, hi = avg * config.RENT_EDGE_MULT, avg * config.RENT_CENTER_MULT
    return scaled.clip(lower=lo, upper=hi).round(1)


# --- grid helpers ----------------------------------------------------------
def _grid_points(ctx: CityContext) -> gpd.GeoDataFrame:
    grid = gpd.read_parquet(ctx.cache(config.GRID_FILE))[["h3_index", "lat", "lng"]]
    return gpd.GeoDataFrame(
        grid.reset_index(drop=True),
        geometry=gpd.points_from_xy(grid["lng"], grid["lat"]),
        crs=config.WGS84,
    )


def assign_from_polygons(ctx: CityContext, polys: gpd.GeoDataFrame, value_col: str) -> pd.DataFrame:
    """Join each hex centroid to the polygon it falls in (nearest as fallback)."""
    pts = _grid_points(ctx).to_crs(ctx.metric_crs)
    src = polys.to_crs(ctx.metric_crs)[[value_col, "geometry"]]

    joined = gpd.sjoin(pts, src, how="left", predicate="within")
    joined = joined[~joined.index.duplicated(keep="first")].reindex(pts.index)

    out = pts[["h3_index"]].copy()
    out[value_col] = joined[value_col].values

    missing = out[value_col].isna()
    if missing.any():
        nn = gpd.sjoin_nearest(pts.loc[missing.values], src, how="left")
        nn = nn[~nn.index.duplicated(keep="first")].reindex(pts.loc[missing.values].index)
        out.loc[missing.values, value_col] = nn[value_col].values
    return out[["h3_index", value_col]]


def assign_from_points(ctx: CityContext, pts_gdf: gpd.GeoDataFrame, value_col: str) -> pd.DataFrame:
    """Assign each hex centroid the value of its nearest source point."""
    hexes = _grid_points(ctx).to_crs(ctx.metric_crs)
    src = pts_gdf.to_crs(ctx.metric_crs)[[value_col, "geometry"]]
    nn = gpd.sjoin_nearest(hexes, src, how="left")
    nn = nn[~nn.index.duplicated(keep="first")].reindex(hexes.index)
    out = hexes[["h3_index"]].copy()
    out[value_col] = nn[value_col].values
    return out[["h3_index", value_col]]


# --- OSM admin polygons (Overpass) -----------------------------------------
def _relation_to_polygon(el: dict):
    """Reconstruct a (multi)polygon from an Overpass relation's outer ways."""
    lines: list[LineString] = []
    for m in el.get("members", []):
        if m.get("type") != "way" or m.get("role") not in ("outer", "", None):
            continue
        geom = m.get("geometry")
        if not geom:
            continue
        coords = [(p["lon"], p["lat"]) for p in geom if "lon" in p and "lat" in p]
        if len(coords) >= 2:
            lines.append(LineString(coords))
    if not lines:
        return None
    try:
        merged = linemerge(lines)
        if merged.geom_type == "LineString":
            merged = MultiLineString([merged])
        polys = list(polygonize(merged))
        if not polys:
            return None
        return unary_union(polys)
    except Exception:  # noqa: BLE001
        return None


def _fetch_admin_polygons(ctx: CityContext, admin_level: str) -> gpd.GeoDataFrame | None:
    query = f"""
    [out:json][timeout:120];
    rel["boundary"="administrative"]["admin_level"="{admin_level}"]({ctx.bbox_str});
    out geom;
    """
    try:
        els = overpass_elements(query, STEP)
    except Exception as exc:  # noqa: BLE001
        log(STEP, f"admin polygon fetch failed: {exc}")
        return None
    rows = []
    for el in els:
        if el.get("type") != "relation":
            continue
        name = (el.get("tags") or {}).get("name")
        geom = _relation_to_polygon(el)
        if name and geom is not None and not geom.is_empty:
            rows.append({"name": name, "geometry": geom})
    if not rows:
        return None
    return gpd.GeoDataFrame(rows, crs=config.WGS84)


# --- WFS ---------------------------------------------------------------------
# Presentation / cadastre layers to skip when auto-picking a data layer, and
# keywords that hint at the layer we actually want.
_WFS_SKIP_PREFIXES = ("adv:ap_", "adv:ax_", "ap_", "ax_")
_WFS_PREFER_KEYWORDS = ("brw", "boden", "richtwert", "wohnlage", "flaeche", "flache")


def _wfs_feature_types(base: str) -> list[str]:
    url = base + ("&" if "?" in base else "?") + "SERVICE=WFS&REQUEST=GetCapabilities"
    resp = requests.get(url, timeout=60, headers={"User-Agent": config.USER_AGENT})
    resp.raise_for_status()
    text = resp.text
    m = re.search(r"<(?:\w+:)?FeatureTypeList>(.*?)</(?:\w+:)?FeatureTypeList>", text, re.S)
    block = m.group(1) if m else text
    return re.findall(r"<(?:\w+:)?Name>([^<]+)</(?:\w+:)?Name>", block)


def _pick_typename(names: list[str]) -> str | None:
    if not names:
        return None
    usable = [n for n in names if n.strip().lower() not in ("", "none")
              and not any(n.strip().lower().startswith(p) for p in _WFS_SKIP_PREFIXES)]
    usable = usable or names
    for kw in _WFS_PREFER_KEYWORDS:
        for n in usable:
            if kw in n.lower():
                return n.strip()
    return usable[0].strip()


def _wfs_typename(base: str) -> str | None:
    return _pick_typename(_wfs_feature_types(base))


def _bbox_encodings(ctx: CityContext) -> list[str]:
    """Several BBOX encodings; servers disagree on axis order / CRS syntax."""
    s, w, n, e = ctx.bbox  # (south, west, north, east) = (miny, minx, maxy, maxx)
    return [
        f"{w},{s},{e},{n},EPSG:4326",                          # lng,lat (common)
        f"{s},{w},{n},{e},urn:ogc:def:crs:EPSG::4326",          # lat,lng (WFS 2.0 urn)
        f"{w},{s},{e},{n}",                                    # no CRS, lng,lat
    ]


def _wfs_getfeature(base: str, tn: str, bbox: str, as_json: bool) -> gpd.GeoDataFrame | None:
    params = {
        "SERVICE": "WFS",
        "REQUEST": "GetFeature",
        "VERSION": "2.0.0",
        "TYPENAMES": tn,
        "BBOX": bbox,
        "COUNT": "100000",
    }
    if as_json:
        params["OUTPUTFORMAT"] = "application/json"
    url = base + ("&" if "?" in base else "?") + urlencode(params)
    resp = requests.get(url, timeout=120, headers={"User-Agent": config.USER_AGENT})
    resp.raise_for_status()
    gdf = gpd.read_file(io.BytesIO(resp.content))  # GDAL sniffs GeoJSON or GML
    if len(gdf) == 0 or gdf.geometry.isna().all():
        return None
    gdf = gdf.set_crs(config.WGS84) if gdf.crs is None else gdf.to_crs(config.WGS84)
    return gdf


def _fetch_wfs(base: str, ctx: CityContext, typename: str | None = None) -> gpd.GeoDataFrame | None:
    try:
        tn = typename or _wfs_typename(base)
    except Exception as exc:  # noqa: BLE001
        log(STEP, f"WFS capabilities failed ({base}): {exc}")
        return None
    if not tn:
        log(STEP, f"WFS: no typename discoverable at {base}")
        return None
    # Prefer GeoJSON; many German WFS are GML-only. Also try a few BBOX
    # encodings because servers disagree on axis order / CRS syntax.
    for as_json in (True, False):
        for bbox in _bbox_encodings(ctx):
            try:
                gdf = _wfs_getfeature(base, tn, bbox, as_json)
                if gdf is not None and len(gdf):
                    return gdf
            except Exception:  # noqa: BLE001 - try the next encoding
                continue
    log(STEP, f"WFS GetFeature returned no usable data for {tn} at {base}")
    return None


# --- provider 1: Munich district Mietspiegel --------------------------------
def munich_districts(ctx: CityContext, avg: float) -> pd.DataFrame | None:
    if ctx.slug not in config.MUNICH_SLUGS or not config.MIETSPIEGEL_CSV.exists():
        return None
    try:
        table = pd.read_csv(config.MIETSPIEGEL_CSV)
    except Exception as exc:  # noqa: BLE001
        log(STEP, f"munich: cannot read Mietspiegel csv: {exc}")
        return None
    lut = {slugify(str(r["bezirk"])): float(r["eur_per_m2"]) for _, r in table.iterrows()}

    polys = _fetch_admin_polygons(ctx, config.MUNICH_DISTRICT_ADMIN_LEVEL)
    if polys is None or polys.empty:
        return None
    polys = polys.copy()
    polys["rent_eur_m2"] = polys["name"].map(lambda n: lut.get(slugify(str(n))))
    polys = polys.dropna(subset=["rent_eur_m2"])
    if polys.empty:
        log(STEP, "munich: no district name matched the Mietspiegel table")
        return None

    out = assign_from_polygons(ctx, polys, "rent_eur_m2")
    out["rent_eur_m2"] = out["rent_eur_m2"].round(1)
    log(STEP, f"munich: matched {polys['name'].nunique()} districts to Mietspiegel")
    return out


# --- provider 2: Berlin Wohnlagen -------------------------------------------
def _norm_wohnlage(s) -> str:
    s = str(s).strip().lower()
    if "einfach" in s:
        return "einfach"
    if "mittel" in s:
        return "mittel"
    if "gut" in s:
        return "gut"
    return s


def _detect_class_column(gdf: gpd.GeoDataFrame, classes: set[str]) -> pd.Series | None:
    for col in gdf.columns:
        if col == "geometry":
            continue
        try:
            vals = gdf[col].astype(str).map(_norm_wohnlage)
        except Exception:  # noqa: BLE001
            continue
        if vals.isin(classes).mean() > 0.5:
            return vals
    return None


def berlin_wohnlagen(ctx: CityContext, avg: float) -> pd.DataFrame | None:
    if ctx.slug not in config.BERLIN_SLUGS or not config.BERLIN_WOHNLAGEN_CSV.exists():
        return None
    try:
        table = pd.read_csv(config.BERLIN_WOHNLAGEN_CSV)
        lut = {_norm_wohnlage(r["class"]): float(r["eur_per_m2"]) for _, r in table.iterrows()}
    except Exception as exc:  # noqa: BLE001
        log(STEP, f"berlin: cannot read Wohnlagen csv: {exc}")
        return None

    gdf = _fetch_wfs(config.BERLIN_WOHNLAGEN_WFS, ctx)
    if gdf is None or gdf.empty:
        return None
    cls = _detect_class_column(gdf, set(lut.keys()))
    if cls is None:
        log(STEP, "berlin: no Wohnlage class column found in WFS response")
        return None

    gdf = gdf.copy()
    gdf["rent_eur_m2"] = cls.map(lambda c: lut.get(_norm_wohnlage(c)))
    gdf = gdf.dropna(subset=["rent_eur_m2"])
    if gdf.empty:
        return None

    geom_types = set(gdf.geom_type.dropna().unique())
    if geom_types & {"Polygon", "MultiPolygon"}:
        out = assign_from_polygons(ctx, gdf, "rent_eur_m2")
    else:
        out = assign_from_points(ctx, gdf, "rent_eur_m2")
    out["rent_eur_m2"] = anchor_to_average(out["rent_eur_m2"], avg).values
    log(STEP, f"berlin: assigned Wohnlagen from {len(gdf)} features")
    return out


# --- provider 3: BORIS land value (proxy, extensible) -----------------------
def _detect_numeric_field(gdf: gpd.GeoDataFrame, preferred: str | None) -> str | None:
    keywords = ("brw", "richtwert", "boden", "wert")
    ordered: list[tuple[int, str]] = []
    for c in gdf.columns:
        if c == "geometry":
            continue
        name = c.lower()
        score = 0
        if preferred and name == preferred.lower():
            score = 3
        elif any(k in name for k in keywords):
            score = 2
        ordered.append((score, c))
    ordered.sort(key=lambda t: t[0], reverse=True)
    for _, c in ordered:
        s = pd.to_numeric(gdf[c], errors="coerce")
        if s.notna().mean() > 0.5 and bool(s.dropna().gt(0).any()):
            gdf[c] = s
            return c
    return None


def boris_landvalue(ctx: CityContext, avg: float) -> pd.DataFrame | None:
    code = config.CITY_BUNDESLAND.get(ctx.slug)
    if not code:
        return None
    src = config.BORIS_SOURCES.get(code)
    if not src:
        return None

    gdf = _fetch_wfs(src["wfs"], ctx, typename=src.get("typename"))
    if gdf is None or gdf.empty:
        return None
    field = _detect_numeric_field(gdf, src.get("value_field"))
    if field is None:
        log(STEP, f"boris: no numeric land-value field found for {code}")
        return None
    gdf = gdf.dropna(subset=[field])
    gdf = gdf[gdf[field] > 0]
    if gdf.empty:
        return None

    geom_types = set(gdf.geom_type.dropna().unique())
    if geom_types & {"Polygon", "MultiPolygon"}:
        raw = assign_from_polygons(ctx, gdf, field)
    else:
        raw = assign_from_points(ctx, gdf, field)

    out = raw[["h3_index"]].copy()
    out["rent_eur_m2"] = anchor_to_average(raw[field], avg).values
    log(STEP, f"boris: anchored land-value surface for {code} ({len(gdf)} zones)")
    return out


# --- provider registry ------------------------------------------------------
# (source_label, rent_estimated, provider_fn). Order = resolution priority.
PROVIDERS = [
    ("Mietspiegel München (Bezirke)", False, munich_districts),
    ("Berliner Mietspiegel (Wohnlagen)", True, berlin_wohnlagen),
    ("Bodenrichtwerte (BORIS)", True, boris_landvalue),
]
