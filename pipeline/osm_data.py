"""Step 2 - download raw OSM layers for the city via the Overpass API.

Produces cached GeoParquet files (in the city cache dir) used by the factor
steps and by the data-driven centre detection:
  * business - points (shops, offices, food, banks, ...)  -> factor_business + centres
  * green    - park / water / forest polygons             -> factor_green
  * water    - rivers (waterway=river) lines              -> factor_green
  * stations - rail/subway/tram stops (classed + weighted)-> factor_transport + centres

Roads (for the noise factor) are still fetched lazily by ``factor_noise``.
"""
from __future__ import annotations

import geopandas as gpd
from shapely.geometry import LineString, Point, Polygon

from . import config
from .city import CityContext, munich_context
from .common import empty_gdf, log, overpass_elements

STEP = "osm"


def _geom_from_way(el: dict):
    """Build a shapely geometry from an Overpass 'out geom' way."""
    coords = [(nd["lon"], nd["lat"]) for nd in el.get("geometry", [])]
    if len(coords) < 2:
        return None
    if coords[0] == coords[-1] and len(coords) >= 4:
        return Polygon(coords)
    return LineString(coords)


def _point_lonlat(el: dict) -> tuple[float, float] | None:
    if el.get("type") == "node":
        return el.get("lon"), el.get("lat")
    c = el.get("center") or {}
    return c.get("lon"), c.get("lat")


def fetch_business(bbox_str: str) -> gpd.GeoDataFrame:
    """A broad "business" layer: shops, offices, food, banks, services, ...

    This is intentionally wider than the old cafe/restaurant/supermarket POI
    set so that "where the businesses are" reflects the real economic fabric
    of the city (and drives centre detection).
    """
    query = f"""
    [out:json][timeout:180];
    (
      nwr["shop"]({bbox_str});
      nwr["office"]({bbox_str});
      nwr["amenity"~"^(cafe|restaurant|bar|pub|fast_food|food_court|bank|pharmacy|marketplace|cinema|theatre|nightclub|clinic|doctors|dentist|post_office|fuel|car_rental)$"]({bbox_str});
      nwr["tourism"~"^(hotel|hostel|guest_house|museum|gallery|attraction)$"]({bbox_str});
      nwr["healthcare"]({bbox_str});
      nwr["craft"]({bbox_str});
    );
    out center tags;
    """
    els = overpass_elements(query, STEP)
    rows = []
    for el in els:
        lon, lat = _point_lonlat(el)
        if lon is None or lat is None:
            continue
        tags = el.get("tags", {})
        kind = (
            tags.get("shop")
            or tags.get("office")
            or tags.get("amenity")
            or tags.get("tourism")
            or tags.get("healthcare")
            or tags.get("craft")
            or "other"
        )
        rows.append({"kind": kind, "geometry": Point(lon, lat)})
    gdf = empty_gdf(["kind"]) if not rows else gpd.GeoDataFrame(rows, crs=config.WGS84)
    log(STEP, f"business POIs fetched: {len(gdf)}")
    return gdf


def _classify_station(tags: dict) -> str:
    if tags.get("station") == "subway":
        return "subway"
    railway = tags.get("railway")
    if railway == "tram_stop":
        return "tram"
    if tags.get("station") == "light_rail" or railway == "light_rail":
        return "light_rail"
    if railway == "halt":
        return "halt"
    if railway == "station":
        return "station"
    return "other"


def fetch_stations(bbox_str: str) -> gpd.GeoDataFrame:
    """Rail/subway/tram stops, tagged with an importance class + weight."""
    query = f"""
    [out:json][timeout:120];
    (
      node["railway"~"^(station|halt|tram_stop)$"]({bbox_str});
      node["station"~"^(subway|light_rail)$"]({bbox_str});
    );
    out center tags;
    """
    els = overpass_elements(query, STEP)
    rows = []
    for el in els:
        lon, lat = el.get("lon"), el.get("lat")
        if lon is None or lat is None:
            continue
        cls = _classify_station(el.get("tags", {}))
        rows.append(
            {
                "geometry": Point(lon, lat),
                "lat": lat,
                "lng": lon,
                "cls": cls,
                "weight": config.TRANSPORT_CLASS_WEIGHT.get(cls, 0.5),
            }
        )
    if not rows:
        gdf = empty_gdf(["lat", "lng", "cls", "weight"])
    else:
        gdf = gpd.GeoDataFrame(rows, crs=config.WGS84).drop_duplicates(subset=["lat", "lng"])
    log(STEP, f"stations fetched: {len(gdf)} ({gdf['cls'].value_counts().to_dict() if len(gdf) else {}})")
    return gdf


def fetch_daily_needs(bbox_str: str) -> gpd.GeoDataFrame:
    """Everyday POIs for 15-minute daily-life accessibility."""
    query = f"""
    [out:json][timeout:180];
    (
      nwr["shop"~"^(supermarket|convenience|bakery)$"]({bbox_str});
      nwr["amenity"~"^(pharmacy|doctors|clinic|hospital|kindergarten|school|post_office|post_box|restaurant|cafe|bank|atm|marketplace|townhall|community_centre|social_facility)$"]({bbox_str});
      nwr["shop"~"^(copyshop|kiosk)$"]({bbox_str});
      nwr["amenity"="marketplace"]({bbox_str});
      nwr["leisure"~"^(sports_centre|pitch|swimming_pool|park|playground)$"]({bbox_str});
      nwr["office"="government"]({bbox_str});
    );
    out center tags;
    """
    els = overpass_elements(query, STEP)
    rows = []
    for el in els:
        lon, lat = _point_lonlat(el)
        if lon is None or lat is None:
            continue
        tags = el.get("tags", {})
        cat = _classify_daily_need(tags)
        if cat:
            name = (tags.get("name") or tags.get("brand") or "").strip()
            brand = 1 if _is_supermarket_brand(name) else 0
            rows.append({
                "category": cat,
                "name": name,
                "brand": brand,
                "geometry": Point(lon, lat),
            })
    cols = ["category", "name", "brand"]
    gdf = empty_gdf(cols) if not rows else gpd.GeoDataFrame(rows, crs=config.WGS84)
    log(STEP, f"daily-needs POIs fetched: {len(gdf)}")
    return gdf


def _is_supermarket_brand(name: str) -> bool:
    low = (name or "").lower()
    return any(b in low for b in config.SUPERMARKET_BRANDS)


def _classify_daily_need(tags: dict) -> str | None:
    shop = tags.get("shop", "")
    amenity = tags.get("amenity", "")
    leisure = tags.get("leisure", "")
    office = tags.get("office", "")
    if shop in ("supermarket", "convenience"):
        return "supermarket"
    if shop == "bakery":
        return "bakery"
    if amenity == "marketplace" or shop == "farm":
        return "market"
    if shop in ("copyshop", "kiosk") or amenity in ("post_office", "post_box"):
        return "post"
    if amenity in ("bank", "atm"):
        return "bank"
    if amenity in ("restaurant", "cafe"):
        return amenity
    if leisure == "park":
        return "park"
    if leisure == "playground":
        return "playground"
    if amenity == "pharmacy":
        return "pharmacy"
    if amenity == "clinic":
        return "clinic"
    if amenity in ("doctors", "hospital"):
        return "doctor"
    if amenity == "kindergarten":
        return "kita"
    if amenity == "school":
        return "school"
    if leisure in ("sports_centre", "pitch", "swimming_pool"):
        return "sports"
    if amenity in ("townhall", "community_centre", "social_facility") or office == "government":
        return "administration"
    return None


def fetch_buildings(bbox_str: str) -> gpd.GeoDataFrame:
    query = f"""
    [out:json][timeout:180];
    (
      way["building"]({bbox_str});
      relation["building"]({bbox_str});
    );
    out center tags;
    """
    els = overpass_elements(query, STEP)
    rows = []
    for el in els:
        lon, lat = _point_lonlat(el)
        if lon is None or lat is None:
            continue
        tags = el.get("tags", {})
        rows.append({
            "geometry": Point(lon, lat),
            "start_date": tags.get("start_date") or tags.get("building:year") or "",
            "building:levels": tags.get("building:levels", ""),
        })
    gdf = empty_gdf(["start_date", "building:levels"]) if not rows else gpd.GeoDataFrame(rows, crs=config.WGS84)
    log(STEP, f"buildings fetched: {len(gdf)}")
    return gdf


def fetch_landuse(bbox_str: str) -> gpd.GeoDataFrame:
    query = f"""
    [out:json][timeout:120];
    (
      way["landuse"]({bbox_str});
      relation["landuse"]({bbox_str});
    );
    out geom;
    """
    els = overpass_elements(query, STEP)
    rows = []
    for el in els:
        geom = _geom_from_way(el)
        if geom is None:
            continue
        rows.append({"landuse": el.get("tags", {}).get("landuse", "other"), "geometry": geom})
    gdf = empty_gdf(["landuse"]) if not rows else gpd.GeoDataFrame(rows, crs=config.WGS84)
    log(STEP, f"landuse polygons fetched: {len(gdf)}")
    return gdf


def fetch_trees(bbox_str: str) -> gpd.GeoDataFrame:
    query = f"""
    [out:json][timeout:90];
    (
      node["natural"="tree"]({bbox_str});
      way["natural"="tree_row"]({bbox_str});
    );
    out center geom;
    """
    els = overpass_elements(query, STEP)
    rows = []
    for el in els:
        if el.get("type") == "node":
            rows.append({"geometry": Point(el["lon"], el["lat"])})
        else:
            geom = _geom_from_way(el)
            if geom is not None:
                rows.append({"geometry": geom})
    gdf = empty_gdf() if not rows else gpd.GeoDataFrame(rows, crs=config.WGS84)
    log(STEP, f"trees fetched: {len(gdf)}")
    return gdf


def fetch_green(bbox_str: str) -> gpd.GeoDataFrame:
    query = f"""
    [out:json][timeout:180];
    (
      way["leisure"="park"]({bbox_str});
      relation["leisure"="park"]({bbox_str});
      way["landuse"="forest"]({bbox_str});
    );
    out geom;
    """
    els = overpass_elements(query, STEP)
    rows = []
    for el in els:
        geom = _geom_from_way(el)
        if geom is None:
            continue
        rows.append({"geometry": geom})
    gdf = empty_gdf() if not rows else gpd.GeoDataFrame(rows, crs=config.WGS84)
    log(STEP, f"green polygons fetched: {len(gdf)}")
    return gdf


def fetch_water(bbox_str: str) -> gpd.GeoDataFrame:
    query = f"""
    [out:json][timeout:120];
    (
      way["waterway"="river"]({bbox_str});
    );
    out geom;
    """
    els = overpass_elements(query, STEP)
    rows = []
    for el in els:
        geom = _geom_from_way(el)
        if geom is None:
            continue
        rows.append({"geometry": geom})
    gdf = empty_gdf() if not rows else gpd.GeoDataFrame(rows, crs=config.WGS84)
    log(STEP, f"river lines fetched: {len(gdf)}")
    return gdf


# --- cached loaders (used by centre detection + factor steps) --------------
def load_business(ctx: CityContext) -> gpd.GeoDataFrame:
    cache = ctx.cache(config.OSM_BUSINESS_FILE)
    if not cache.exists():
        fetch_business(ctx.bbox_str).to_parquet(cache)
    return gpd.read_parquet(cache)


def load_daily_needs(ctx: CityContext) -> gpd.GeoDataFrame:
    cache = ctx.cache(config.OSM_DAILY_NEEDS_FILE)
    if cache.exists():
        gdf = gpd.read_parquet(cache)
        # Schema v11 adds brand + newer amenity categories.
        if "brand" in gdf.columns:
            return gdf
        log(STEP, "refetch daily_needs (missing brand column for schema v11)")
        cache.unlink(missing_ok=True)
    fetch_daily_needs(ctx.bbox_str).to_parquet(cache)
    return gpd.read_parquet(cache)


def load_buildings(ctx: CityContext) -> gpd.GeoDataFrame:
    cache = ctx.cache(config.OSM_BUILDINGS_FILE)
    if not cache.exists():
        fetch_buildings(ctx.bbox_str).to_parquet(cache)
    return gpd.read_parquet(cache)


def load_landuse(ctx: CityContext) -> gpd.GeoDataFrame:
    cache = ctx.cache(config.OSM_LANDUSE_FILE)
    if not cache.exists():
        fetch_landuse(ctx.bbox_str).to_parquet(cache)
    return gpd.read_parquet(cache)


def load_green(ctx: CityContext) -> gpd.GeoDataFrame:
    cache = ctx.cache(config.OSM_GREEN_FILE)
    if not cache.exists():
        fetch_green(ctx.bbox_str).to_parquet(cache)
    return gpd.read_parquet(cache)


def load_roads(ctx: CityContext) -> gpd.GeoDataFrame:
    """Roads with safety attributes (broader than noise-only major roads)."""
    cache = ctx.cache("osm_roads_safety.parquet")
    if cache.exists():
        cached = gpd.read_parquet(cache)
        if len(cached) > 0:
            return cached
        log(STEP, f"discarding empty safety roads cache {cache.name}")
        cache.unlink(missing_ok=True)
    bbox_str = ctx.bbox_str
    query = f"""
    [out:json][timeout:180];
    (
      way["highway"~"^(motorway|trunk|primary|secondary|tertiary|residential|living_street|unclassified)$"]({bbox_str});
    );
    out geom;
    """
    els = overpass_elements(query, STEP)
    rows = []
    for el in els:
        geom = _geom_from_way(el)
        if geom is None or geom.geom_type != "LineString":
            if geom is not None and hasattr(geom, "geoms"):
                from shapely.ops import linemerge
                geom = linemerge(geom)
            if geom is None or geom.geom_type != "LineString":
                coords = [(nd["lon"], nd["lat"]) for nd in el.get("geometry", [])]
                if len(coords) >= 2:
                    from shapely.geometry import LineString
                    geom = LineString(coords)
                else:
                    continue
        tags = el.get("tags", {})
        rows.append({
            "geometry": geom,
            "highway": tags.get("highway", "residential"),
            "maxspeed": tags.get("maxspeed", ""),
            "cycleway": tags.get("cycleway", ""),
            "bicycle": tags.get("bicycle", ""),
            "crossing": tags.get("crossing", ""),
            "lanes": tags.get("lanes", ""),
        })
    gdf = empty_gdf(["highway", "maxspeed", "cycleway", "bicycle", "crossing", "lanes"]) if not rows else gpd.GeoDataFrame(rows, crs=config.WGS84)
    if len(gdf) > 0:
        gdf.to_parquet(cache)
    else:
        log(STEP, "skipping empty safety roads cache write (will retry next run)")
    log(STEP, f"safety roads fetched: {len(gdf)}")
    return gdf


def load_stations(ctx: CityContext) -> gpd.GeoDataFrame:
    cache = ctx.cache(config.OSM_STATIONS_FILE)
    if not cache.exists():
        fetch_stations(ctx.bbox_str).to_parquet(cache)
    gdf = gpd.read_parquet(cache)
    # Backfill weight for caches produced before stations carried a class.
    if len(gdf) and "weight" not in gdf.columns:
        gdf["cls"] = gdf.get("cls", "other")
        gdf["weight"] = gdf["cls"].map(config.TRANSPORT_CLASS_WEIGHT).fillna(0.5)
    return gdf


def _fetch_to_cache(
    cache,
    fetch_fn,
    bbox_str: str,
    label: str,
    *,
    min_rows: int = 0,
) -> None:
    if cache.exists():
        if min_rows > 0:
            try:
                gdf = gpd.read_parquet(cache)
                if len(gdf) >= min_rows:
                    log(STEP, f"skip {label} (cached {cache.name})")
                    return
                log(STEP, f"refetch {label} (cached {cache.name} is empty)")
            except Exception:  # noqa: BLE001
                log(STEP, f"refetch {label} (unreadable cache {cache.name})")
        else:
            log(STEP, f"skip {label} (cached {cache.name})")
            return
    fetch_fn(bbox_str).to_parquet(cache)
    log(STEP, f"saved -> {cache}")


def main(ctx: CityContext | None = None) -> None:
    ctx = ctx or munich_context()
    bbox_str = ctx.bbox_str

    _fetch_to_cache(ctx.cache(config.OSM_BUSINESS_FILE), fetch_business, bbox_str, "business", min_rows=1)
    _fetch_to_cache(ctx.cache(config.OSM_DAILY_NEEDS_FILE), fetch_daily_needs, bbox_str, "daily_needs", min_rows=0)
    _fetch_to_cache(ctx.cache(config.OSM_STATIONS_FILE), fetch_stations, bbox_str, "stations", min_rows=1)
    _fetch_to_cache(ctx.cache(config.OSM_GREEN_FILE), fetch_green, bbox_str, "green")
    _fetch_to_cache(ctx.cache(config.OSM_WATER_FILE), fetch_water, bbox_str, "water")
    _fetch_to_cache(ctx.cache(config.OSM_BUILDINGS_FILE), fetch_buildings, bbox_str, "buildings", min_rows=0)
    _fetch_to_cache(ctx.cache(config.OSM_LANDUSE_FILE), fetch_landuse, bbox_str, "landuse", min_rows=0)
    _fetch_to_cache(ctx.cache("osm_trees.parquet"), fetch_trees, bbox_str, "trees", min_rows=0)


if __name__ == "__main__":
    main()
