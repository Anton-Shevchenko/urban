"""Cycle infrastructure for the map layer.

This is separate from the Wohnindex score. ``osm_cycleways.parquet`` and
``s_cycleways`` stay on the dedicated-cycleway filter. The map reads
``osm_cycle_infra.parquet``, ``cycleways.geojson`` and ``cycleways.meta.json``
(schema 2) and draws six OSM classes, with left/right copies of centreline tags.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path

import geopandas as gpd
from shapely.geometry import LineString

from pipeline import config
from pipeline.city import CityContext
from pipeline.common import empty_gdf, log

STEP = "cycle_infra"
_SIMPLIFY_DEG = 0.00004

KIND_EIGEN = "eigenstaendig"
KIND_TRACK = "track"
KIND_LANE = "lane"
KIND_ADVISORY = "advisory"
KIND_SHARED = "shared_path"
KIND_MIXED = "mixed"

KIND_LABELS: dict[str, str] = {
    KIND_EIGEN: "Eigenständiger Radweg",
    KIND_TRACK: "Baulich getrennter Radweg",
    KIND_LANE: "Radfahrstreifen",
    KIND_ADVISORY: "Schutzstreifen",
    KIND_SHARED: "Gemeinsamer Geh- und Radweg",
    KIND_MIXED: "Mischverkehr",
}

KIND_ORDER: tuple[str, ...] = (
    KIND_EIGEN,
    KIND_TRACK,
    KIND_LANE,
    KIND_ADVISORY,
    KIND_SHARED,
    KIND_MIXED,
)

_INFRA_COLUMNS = [
    "highway",
    "kind",
    "side",
    "foot",
    "segregated",
    "cycleway",
    "cycleway_lane",
    "label",
]

_TRACK_VALUES = frozenset({"track"})
_LANE_VALUES = frozenset({"lane"})
_MIXED_VALUES = frozenset({"shared_lane", "share_busway"})
_SIDES = ("left", "right")


def _raw(tags: dict, key: str) -> str:
    value = tags.get(key)
    if value is None:
        return ""
    return str(value).strip().lower()


def _kind_from_cycleway_value(value: str, lane: str) -> str | None:
    """Map one ``cycleway*`` value to a legend class.

    ``cycleway=lane`` without ``cycleway:lane`` is a Radfahrstreifen: in OSM
    ``exclusive`` is the default and ``advisory`` is the Schutzstreifen.
    """
    if value in _TRACK_VALUES:
        return KIND_TRACK
    if value in _LANE_VALUES:
        if lane == "advisory":
            return KIND_ADVISORY
        if lane in {"", "exclusive"}:
            return KIND_LANE
        return None
    if value in _MIXED_VALUES:
        return KIND_MIXED
    return None


def _value_for_side(tags: dict, side: str) -> tuple[str, str]:
    """OSM: ``cycleway:left/right`` overrides ``cycleway:both`` and ``cycleway``."""
    specific = _raw(tags, f"cycleway:{side}")
    if specific:
        lane = (
            _raw(tags, f"cycleway:{side}:lane")
            or _raw(tags, "cycleway:both:lane")
            or _raw(tags, "cycleway:lane")
        )
        return specific, lane
    both = _raw(tags, "cycleway:both")
    if both:
        lane = _raw(tags, "cycleway:both:lane") or _raw(tags, "cycleway:lane")
        return both, lane
    general = _raw(tags, "cycleway")
    if general:
        return general, _raw(tags, "cycleway:lane")
    return "", ""


def _own_geometry_kind(tags: dict) -> str | None:
    """Ways that already have their own alignment, not a road centreline.

    Eigenständiger Radweg is ``highway=cycleway`` that is not a shared
    Geh- und Radweg. A shared path is ``foot=designated`` (or a footway with
    ``bicycle=designated``) without ``segregated=yes``.
    """
    hw = _raw(tags, "highway")
    foot = _raw(tags, "foot")
    bicycle = _raw(tags, "bicycle")
    segregated = _raw(tags, "segregated")

    if hw == "cycleway":
        if foot == "designated" and segregated != "yes":
            return KIND_SHARED
        return KIND_EIGEN
    if hw == "path" and bicycle == "designated":
        if foot == "designated" and segregated != "yes":
            return KIND_SHARED
        return KIND_EIGEN
    if hw == "footway" and bicycle == "designated" and segregated != "yes":
        return KIND_SHARED
    return None


def classify_cycle_infra(tags: dict | None) -> list[tuple[str, str]]:
    """Return ``(kind, side)`` pairs for one OSM way.

    ``side`` is ``""`` for a way drawn on its real geometry. Centreline tags
    (track, lane, advisory, mixed) become one feature per side so the map can
    ``line-offset`` them off the road axis.
    """
    tags = tags or {}
    own = _own_geometry_kind(tags)
    if own:
        return [(own, "")]
    found: list[tuple[str, str]] = []
    for side in _SIDES:
        value, lane = _value_for_side(tags, side)
        kind = _kind_from_cycleway_value(value, lane)
        if kind:
            found.append((kind, side))
    return found


def _way_coords(element: dict) -> list[tuple[float, float]]:
    coords: list[tuple[float, float]] = []
    for node in element.get("geometry") or []:
        lon = node.get("lon")
        lat = node.get("lat")
        if lon is None or lat is None:
            continue
        coords.append((float(lon), float(lat)))
    return coords


def rows_from_element(element: dict) -> list[dict]:
    tags = element.get("tags") or {}
    pairs = classify_cycle_infra(tags)
    if not pairs:
        return []
    coords = _way_coords(element)
    if len(coords) < 2:
        return []
    geom = LineString(coords)
    highway = _raw(tags, "highway")
    foot = _raw(tags, "foot")
    segregated = _raw(tags, "segregated")
    cycleway = _raw(tags, "cycleway")
    cycleway_lane = _raw(tags, "cycleway:lane")
    rows = []
    for kind, side in pairs:
        rows.append(
            {
                "geometry": geom,
                "highway": highway,
                "kind": kind,
                "side": side,
                "foot": foot,
                "segregated": segregated,
                "cycleway": cycleway,
                "cycleway_lane": cycleway_lane,
                "label": KIND_LABELS[kind],
            }
        )
    return rows


def _overpass_query(bbox_str: str) -> str:
    selectors = [
        'way["highway"="cycleway"]',
        'way["highway"="path"]["bicycle"="designated"]',
        'way["highway"="footway"]["bicycle"="designated"]',
        'way["cycleway"="track"]',
        'way["cycleway:both"="track"]',
        'way["cycleway:left"="track"]',
        'way["cycleway:right"="track"]',
        'way["cycleway"="lane"]',
        'way["cycleway:both"="lane"]',
        'way["cycleway:left"="lane"]',
        'way["cycleway:right"="lane"]',
        'way["cycleway"="shared_lane"]',
        'way["cycleway:both"="shared_lane"]',
        'way["cycleway:left"="shared_lane"]',
        'way["cycleway:right"="shared_lane"]',
        'way["cycleway"="share_busway"]',
        'way["cycleway:both"="share_busway"]',
        'way["cycleway:left"="share_busway"]',
        'way["cycleway:right"="share_busway"]',
    ]
    body = "\n".join(f"      {item}({bbox_str});" for item in selectors)
    return f"""
    [out:json][timeout:90];
    (
{body}
    );
    out geom;
    """


def _overpass_elements(query: str) -> list[dict]:
    from pipeline.providers import OVERPASS

    log(STEP, "overpass fetch cycle infra")
    data = OVERPASS.post_json_rotating(
        config.OVERPASS_ENDPOINTS,
        data={"data": query},
        timeout_s=120,
    )
    return data.get("elements", [])


def fetch_cycle_infra(bbox_str: str) -> gpd.GeoDataFrame:
    """All six cycle classes inside ``bbox_str`` (south,west,north,east)."""
    elements = _overpass_elements(_overpass_query(bbox_str))
    rows: list[dict] = []
    for element in elements:
        rows.extend(rows_from_element(element))
    if not rows:
        gdf = empty_gdf(_INFRA_COLUMNS)
    else:
        gdf = gpd.GeoDataFrame(rows, geometry="geometry", crs=config.WGS84)
    log(STEP, f"cycle infra fetched: {len(gdf)}")
    return gdf


def cycleways_cache_ready(city_dir: Path) -> bool:
    """True only when schema 2 meta and the GeoJSON are both on disk.

    A previous overlay (no meta, or schema 1) is not ready and must not be served.
    """
    meta_path = city_dir / config.CYCLEWAYS_META_FILE
    geo_path = city_dir / config.CYCLEWAYS_GEOJSON_FILE
    if not meta_path.is_file() or not geo_path.is_file():
        return False
    try:
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        schema = int(meta.get("schema"))
    except (OSError, json.JSONDecodeError, TypeError, ValueError, UnicodeError):
        return False
    return schema == int(config.CYCLEWAYS_SCHEMA_VERSION)


def write_cycle_infra_geojson(ctx: CityContext, gdf: gpd.GeoDataFrame) -> dict:
    """Write schema 2 GeoJSON plus ``cycleways.meta.json`` from infra rows."""
    dest = ctx.base_dir / config.CYCLEWAYS_GEOJSON_FILE
    meta_path = ctx.base_dir / config.CYCLEWAYS_META_FILE
    dest.parent.mkdir(parents=True, exist_ok=True)

    counts = dict.fromkeys(KIND_ORDER, 0)
    features: list[dict] = []
    if gdf is not None and len(gdf) and "geometry" in gdf.columns:
        frame = gdf
        if frame.crs is not None:
            frame = frame.to_crs(config.WGS84)
        frame = frame[frame.geometry.notna() & ~frame.geometry.is_empty].copy()
        frame = frame[frame.geometry.geom_type.isin(["LineString", "MultiLineString"])]
        if len(frame):
            frame["geometry"] = frame.geometry.simplify(_SIMPLIFY_DEG, preserve_topology=False)
        for _, row in frame.iterrows():
            geom = row.geometry
            if geom is None or geom.is_empty:
                continue
            kind = str(row["kind"]) if "kind" in frame.columns and row["kind"] is not None else ""
            if kind not in KIND_LABELS:
                continue
            side = ""
            if "side" in frame.columns and row["side"] is not None:
                side = str(row["side"])
            if side not in {"", "left", "right"}:
                side = ""
            counts[kind] += 1
            features.append(
                {
                    "type": "Feature",
                    "geometry": geom.__geo_interface__,
                    "properties": {
                        "kind": kind,
                        "side": side,
                        "label": KIND_LABELS[kind],
                    },
                }
            )

    dest.write_text(
        json.dumps({"type": "FeatureCollection", "features": features}, separators=(",", ":")),
        encoding="utf-8",
    )
    meta = {
        "schema": int(config.CYCLEWAYS_SCHEMA_VERSION),
        "fetched_at": datetime.now(UTC).isoformat(),
        "counts": counts,
        "slug": ctx.slug,
        "name": ctx.name,
        "bbox": [ctx.bbox[0], ctx.bbox[1], ctx.bbox[2], ctx.bbox[3]],
        "center": [ctx.center[0], ctx.center[1]],
    }
    meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    log(STEP, f"cycle infra geojson {len(features)} features -> {dest}")
    return meta


def fetch_and_store_cycle_infra(ctx: CityContext) -> dict:
    """Overpass → ``osm_cycle_infra.parquet`` + schema 2 GeoJSON.

    Does not read or write ``osm_cycleways.parquet``.
    """
    log(STEP, f"cycle infra build {ctx.slug}")
    gdf = fetch_cycle_infra(ctx.bbox_str)
    gdf.to_parquet(ctx.cache(config.OSM_CYCLE_INFRA_FILE))
    return write_cycle_infra_geojson(ctx, gdf)
