"""Central configuration for the Living Score pipeline.

Global, city-independent tunables live here. Everything that varies per city
(centre, bounding box, boundary polygon, cache directory, output path) lives on
a ``CityContext`` (see :mod:`pipeline.city`) that is threaded through the steps.

Values can be overridden via environment variables where noted.
"""

from __future__ import annotations

import os
from pathlib import Path

from . import contract

# --- Paths -----------------------------------------------------------------
# Editable / in-tree: this file lives at microservices/data/pipeline/config.py.
# A wheel install lands in site-packages — then DATA_DIR / URBAN_ROOT must be set
# (Docker sets both).
_PIPELINE_DIR = Path(__file__).resolve().parent


def _service_dir() -> Path:
    parent = _PIPELINE_DIR.parent
    if (parent / "pyproject.toml").is_file() or (parent / "Dockerfile").is_file():
        return parent
    if os.environ.get("DATA_DIR"):
        return Path(os.environ["DATA_DIR"]).resolve().parent
    return parent


def _detect_root() -> Path:
    env = os.environ.get("URBAN_ROOT")
    if env:
        return Path(env)
    repo = _SERVICE_DIR.parent.parent
    if (repo / "frontend").is_dir() or (repo / "go.work").is_file():
        return repo
    return _SERVICE_DIR


_SERVICE_DIR = _service_dir()
ROOT = _detect_root()
DATA_DIR = Path(os.environ.get("DATA_DIR", _SERVICE_DIR / "data"))
FRONTEND_PUBLIC_DIR = Path(os.environ.get("FRONTEND_PUBLIC_DIR", ROOT / "frontend" / "public"))
CACHE_DIR = DATA_DIR / "cache"  # legacy single-city cache (kept for compat)
CITIES_DIR = DATA_DIR / "cities"  # per-city generated data root
DATA_DIR.mkdir(exist_ok=True)
CACHE_DIR.mkdir(exist_ok=True)
CITIES_DIR.mkdir(exist_ok=True)

# --- Grid ------------------------------------------------------------------
# H3 resolution. res 8 ~ 0.74 km2 / hex (~420 hexes over Munich) -> fast prototype.
# res 9 ~ 0.10 km2 / hex (~3000 hexes) -> release granularity.
H3_RES = int(os.environ.get("H3_RES", "9"))

# --- Geography -------------------------------------------------------------
# Default city (Munich) centre + bounding box, used to build the built-in
# Munich CityContext (the only city that ships with rent data).
# Marienplatz (city centre) -> destination for the transit factor.
MARIENPLATZ = (48.13741, 11.57549)  # (lat, lng)

# Polycentric scoring anchors per city slug. Primary anchor (index 0) sets
# ``center_min``; all anchors feed the polycentric ``s_center`` score.
CENTER_ANCHORS: dict[str, list[dict]] = {
    "muenchen": [
        {"id": "marienplatz", "label": "Marienplatz", "lat": 48.13741, "lng": 11.57549, "weight": 1.0},
        {"id": "hbf", "label": "Hauptbahnhof", "lat": 48.14023, "lng": 11.55838, "weight": 0.97},
        {"id": "ost", "label": "Ost", "lat": 48.12743, "lng": 11.60510, "weight": 0.94},
    ],
}

# Rough Munich bounding box used as a fallback when the admin boundary
# cannot be fetched. (south, west, north, east)
MUNICH_BBOX = (48.061, 11.360, 48.248, 11.723)

WGS84 = "EPSG:4326"
# Fallback metric CRS (UTM zone 32N / ETRS89) if a per-city UTM cannot be
# derived. Per-city metric CRS is computed from the city longitude in
# ``CityContext.metric_crs``.
METRIC_CRS = "EPSG:25832"

# --- Business factor -------------------------------------------------------
# Radius around a hex centroid within which businesses are counted (density).
BUSINESS_RADIUS_M = 450

# --- Centrality: data-driven centre detection ------------------------------
# The city centre is no longer a fixed point (Marienplatz) or the geometric
# boundary centroid; it is derived from where businesses + transport actually
# cluster. Larger cities are poly-centric, so we detect one MAIN centre and
# several SUB-centres.
#
# How much each layer contributes to the "centrality mass" surface.
CENTER_MASS_BUSINESS_W = 0.6
CENTER_MASS_TRANSPORT_W = 0.4
# Neighbourhood smoothing radius (in H3 k-rings) so a single dense hex does not
# win over a broad, genuine cluster.
CENTER_SMOOTH_KRING = 1
# A secondary centre must reach at least this fraction of the main centre mass.
CENTER_SECONDARY_MIN_FRAC = 0.45
# Minimum separation between two detected centres (m).
CENTER_MIN_SEPARATION_M = 1800
# Hard cap on the number of centres returned (1 main + up to N-1 sub-centres).
CENTER_MAX = 6

# --- Transport connectivity factor -----------------------------------------
# Connectivity of a hex to the transit network: a distance-decayed, importance-
# weighted sum over nearby stations (not travel time to a single point).
TRANSPORT_DECAY_M = 700  # gravity decay length for station accessibility
TRANSPORT_MAX_M = 2500  # stations beyond this do not contribute
# Relative importance by station class (rapid transit > tram).
TRANSPORT_CLASS_WEIGHT = {
    "subway": 1.0,  # U-Bahn
    "station": 1.0,  # S-Bahn / regional / main-line rail
    "light_rail": 0.9,
    "halt": 0.7,  # minor rail stop
    "tram": 0.6,  # tram / Stadtbahn stop
    "other": 0.5,
}

# --- Overpass --------------------------------------------------------------
# Rotated on failure; the public master server is often busy.
OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.osm.ch/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
]
OVERPASS_TIMEOUT = 90

# --- Nominatim (geocoding) -------------------------------------------------
NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
USER_AGENT = "wohnindex/1.0 (living-score pipeline)"

# --- OpenRouteService (transit / driving factor) ---------------------------
# Set ORS_API_KEY to use the real matrix API. Without it the transit step
# falls back to a haversine-based travel-time estimate so the pipeline still
# completes end-to-end offline.
ORS_API_KEY = os.environ.get("ORS_API_KEY", "").strip()
ORS_PROFILE = os.environ.get("ORS_PROFILE", "driving-car")
ORS_MATRIX_URL = "https://api.openrouteservice.org/v2/matrix/{profile}"

# --- Bavaria noise (Umgebungslaerm) ----------------------------------------
# Bavarian environment agency WFS. If unreachable, step 04 derives a noise
# proxy from proximity to major roads (a well-established acoustic proxy).
BAYERN_NOISE_WFS = os.environ.get(
    "BAYERN_NOISE_WFS",
    "https://www.lfu.bayern.de/gdi/wfs/laerm",
)

# --- Observed housing prices ------------------------------------------------
# Kaltmiete is the Zensus 2022 100 m net cold rent (or a cited publication),
# moved forward with the national Destatis Nettokaltmiete index. Asking rent
# and sale prices are separate nullable fields. Nothing is invented from
# infrastructure, land value, or a neighbour.
ZENSUS_RENT_ZIP_URL = (
    "https://www.destatis.de/static/DE/zensus/gitterdaten/Zensus2022_Durchschn_Nettokaltmiete.zip"
)
ZENSUS_RENT_CSV_NAME = "Zensus2022_Durchschn_Nettokaltmiete_100m-Gitter.csv"
DESTATIS_RENT_INDEX_URL = "https://www.destatis.de/DE/Themen/Wirtschaft/Konjunkturindikatoren/Basisdaten/vpi044a.html"
ZENSUS_RENT_YEAR = 2022
ZENSUS_RENT_MONTH = 5
GREIX_ASKING_XLSX_URL = (
    "https://www.kielinstitut.de/fileadmin/Dateiverwaltung/IfW_Unit/Macroeconomics/"
    "GREIX/Mietpreisindex/City_metrics_public.xlsx"
)
OBSERVED_PRICES_CSV = DATA_DIR / "observed_prices.csv"

# --- 15-Minute Living Score (objective-v2) ---------------------------------
# Absolute objective weights (no centrality). Frontend Personal Match may
# reweight separately; do not blend user prefs into s_living.
#
# Every constant below comes from contracts/scoring.json via pipeline.contract.
# Change the contract and run `python contracts/codegen.py`; editing the numbers
# here would silently desynchronise the pipeline from the frontend engine.
SCORE_METHOD_VERSION = contract.SCORE_METHOD_VERSION

LIVING_SCORE_WEIGHTS = contract.living_score_weights()

# Daily-life group weights (parks → Green Index, not here).
DAILY_LIFE_GROUP_WEIGHTS = contract.DAILY_LIFE_GROUP_WEIGHTS

# Within-group category weights (not max). Keys match DAILY_LIFE_AMENITIES.
DAILY_LIFE_CATEGORY_WEIGHTS = contract.DAILY_LIFE_CATEGORY_WEIGHTS

# Legacy Match groups (dormant — Match Score deferred).
MATCH_INFRASTRUCTURE_GROUP_WEIGHTS = {
    "food": 0.25,
    "health": 0.15,
    "education": 0.20,
    "services": 0.15,
    "lifestyle": 0.15,
    "shopping": 0.10,
}

# Amenity → life group, derived from DAILY_LIFE_CATEGORY_WEIGHTS so a new
# category cannot be weighted without also being grouped.
# Parks are intentionally absent — Green Index owns them.
DAILY_LIFE_AMENITIES: dict[str, str] = contract.daily_life_amenity_groups()

# Legacy exponential walk-minute decay (kept for diagnostics / back-compat).
WALK_DECAY_MINUTES: dict[str, float] = {
    "supermarket": 7.0,
    "bakery": 4.5,
    "market": 5.5,
    "pharmacy": 6.0,
    "doctor": 7.5,
    "clinic": 8.0,
    "kita": 6.5,
    "school": 7.5,
    "post": 5.5,
    "bank": 5.5,
    "administration": 8.0,
    "park": 8.0,
    "playground": 5.0,
    "sports": 7.0,
    "restaurant": 4.0,
    "cafe": 4.0,
    "default": 6.0,
}
WALK_DECAY_PLATEAU_MIN = 2.0  # near-perfect within ~2 minutes
# Primary accessibility uses piecewise bands (see walk_minute_band_score).
WALK_USE_BAND_SCORE = True
WALK_SECOND_AMENITY_BONUS = 8.0  # soft bonus if 2+ amenities within 5 min
WALK_SECOND_AMENITY_MAX_MIN = 5.0

# Walking quality: network / safety / comfort / accessibility.
WALKING_QUALITY_WEIGHTS = {
    "network": 0.40,
    "safety": 0.30,
    "comfort": 0.20,
    "accessibility": 0.10,
}

# City-type walk weight overlays (renormalised at use time).
WALK_WEIGHTS_BY_CITY_TYPE: dict[str, dict[str, float]] = {
    "METROPOLIS": {
        "network": 0.45,
        "safety": 0.28,
        "comfort": 0.20,
        "accessibility": 0.07,
    },
    "LARGE_CITY": {
        "network": 0.42,
        "safety": 0.30,
        "comfort": 0.20,
        "accessibility": 0.08,
    },
    "MEDIUM_CITY": {
        "network": 0.32,
        "safety": 0.35,
        "comfort": 0.18,
        "accessibility": 0.15,
    },
    "SMALL_CITY": {
        "network": 0.28,
        "safety": 0.35,
        "comfort": 0.17,
        "accessibility": 0.20,
    },
}

# Urban form sub-weights (diagnostic only — not in Living Score).
URBAN_FORM_WEIGHTS = {
    "density": 0.35,
    "activity": 0.25,
    "mixed_use": 0.25,
    "green_balance": 0.15,
}

# City-normalization: type_curve shifts absolute raw before blend with rank.
# Higher ``strictness`` → same raw yields lower type_curve score (metros).
# ``rank_blend`` = weight on within-city percentile rank (rest on type_curve).
CITY_NORM_PARAMS: dict[str, dict[str, float]] = {
    "METROPOLIS": {"strictness": 1.15, "rank_blend": 0.55},
    "LARGE_CITY": {"strictness": 1.05, "rank_blend": 0.55},
    "MEDIUM_CITY": {"strictness": 0.90, "rank_blend": 0.50},
    "SMALL_CITY": {"strictness": 0.80, "rank_blend": 0.45},
}

# Centrality decay (km) by city type — smaller cities fall off faster.
CENTER_DECAY_KM_BY_CITY_TYPE: dict[str, float] = {
    "METROPOLIS": 7.2,
    "LARGE_CITY": 5.5,
    "MEDIUM_CITY": 3.5,
    "SMALL_CITY": 2.5,
}

# --- Default factor weights (legacy comfort / back-compat) -----------------
DEFAULT_WEIGHTS = {
    "daily_needs": 0.40,
    "transit_service": 0.20,
    "green": 0.0,
    "noise": 0.0,
    "traffic_safety": 0.0,
    "price": 0.0,
    "center": 0.0,
    "walking_quality": 0.25,
    "urban_form": 0.15,
    "business": 0.0,
    "transport": 0.0,
}

# Exponential centrality: score = 100 * exp(-distance_km / decay).
# Best-fit to anchors ~1 km→90, ~5 km→50, ~15 km→10 (single decay ≈ 7.2).
CENTER_DECAY_KM = 7.2
# Approximate path-km from ORS/fallback travel minutes (Munich-calibrated).
CENTER_KM_PER_MIN = 0.35

# --- Per-city cache file names ---------------------------------------------
# Combined with ``CityContext.cache_dir`` to form the actual paths.
BOUNDARY_FILE = "boundary.geojson"
GRID_FILE = "grid.parquet"
OSM_BUSINESS_FILE = "osm_business.parquet"
OSM_GREEN_FILE = "osm_green.parquet"
OSM_WATER_FILE = "osm_water.parquet"
OSM_ROADS_FILE = "osm_roads.parquet"
OSM_STATIONS_FILE = "osm_stations.parquet"
CENTERS_FILE = "centers.json"
BUSINESS_FILE = "factor_business.parquet"
GREEN_FILE = "factor_green.parquet"
NOISE_FILE = "factor_noise.parquet"
CENTER_FILE = "factor_center.parquet"
TRANSPORT_FILE = "factor_transport.parquet"
RENTS_FILE = "rents.parquet"
MERGED_FILE = "merged.parquet"

# Bump when exported GeoJSON schema / required cache files change (see
# pipeline.cache_status).
# --- Daily needs -----------------------------------------------------------
# Amenity types fetched from OSM and scored for daily-life accessibility.
DAILY_NEEDS_CATEGORIES = (
    "supermarket",
    "bakery",
    "market",
    "pharmacy",
    "doctor",
    "clinic",
    "kita",
    "school",
    "restaurant",
    "cafe",
    "bank",
    "sports",
    "post",
    "park",
    "playground",
    "administration",
)
# Legacy per-amenity weights (used for optional coverage diagnostics).
DAILY_NEEDS_WEIGHTS: dict[str, float] = {
    "supermarket": 1.2,
    "bakery": 0.6,
    "market": 0.8,
    "pharmacy": 1.0,
    "doctor": 1.0,
    "clinic": 0.9,
    "kita": 0.8,
    "school": 0.8,
    "restaurant": 0.5,
    "cafe": 0.4,
    "bank": 0.5,
    "sports": 0.6,
    "post": 0.4,
    "park": 0.7,
    "playground": 0.6,
    "administration": 0.5,
}
# Max walk minutes for a category to count toward cluster-dispersion check.
DAILY_NEEDS_CLUSTER_MAX_MIN = 12.0
# If nearest POIs for >=3 categories lie within this span (m), apply cluster penalty.
DAILY_NEEDS_CLUSTER_SPAN_M = 200.0
# German supermarket brand name fragments (OSM name/brand soft boost).
SUPERMARKET_BRANDS = (
    "rewe",
    "aldi",
    "lidl",
    "edeka",
    "penny",
    "netto",
    "kaufland",
    "norma",
)

# --- Green access quality weights ------------------------------------------
GREEN_QUALITY_WEIGHTS = {
    "large_park": 1.0,  # park/forest > 5 ha
    "medium_park": 0.7,  # 1-5 ha
    "small_green": 0.4,  # garden / small park
    "water_inaccessible": 0.2,
    "riverbank": 0.8,
}

# --- GTFS (Germany-wide registry) ------------------------------------------
GTFS_CACHE_DIR = DATA_DIR / "gtfs"
GTFS_CACHE_DIR.mkdir(exist_ok=True)

# --- Zensus ----------------------------------------------------------------
ZENSUS_CACHE_DIR = DATA_DIR / "zensus"
ZENSUS_CACHE_DIR.mkdir(exist_ok=True)
MARKET_CACHE_DIR = DATA_DIR / "market"
MARKET_CACHE_DIR.mkdir(exist_ok=True)

# --- New factor cache files ------------------------------------------------
DAILY_NEEDS_FILE = "factor_daily_needs.parquet"
TRANSIT_SERVICE_FILE = "factor_transit_service.parquet"
HEAT_FILE = "factor_heat.parquet"
TRAFFIC_SAFETY_FILE = "factor_traffic_safety.parquet"
HOUSING_FILE = "factor_housing.parquet"
WALKING_QUALITY_FILE = "factor_walking_quality.parquet"
URBAN_FORM_FILE = "factor_urban_form.parquet"
CYCLEWAYS_FILE = "factor_cycleways.parquet"
OSM_CYCLEWAYS_FILE = "osm_cycleways.parquet"
CYCLEWAYS_GEOJSON_FILE = "cycleways.geojson"
OSM_DAILY_NEEDS_FILE = "osm_daily_needs.parquet"
OSM_BUILDINGS_FILE = "osm_buildings.parquet"
OSM_LANDUSE_FILE = "osm_landuse.parquet"

# Bumped in contracts/hex-properties.schema.json (x-pipeline-version) whenever
# the exported property set changes, so stale caches are detected.
PIPELINE_SCHEMA_VERSION = contract.PIPELINE_VERSION
# Served city product. Anything else (price-map, AVM-only, …) is stale.
LIVING_SCORE_PRODUCT = "15-minute-living-score"

# Value Opportunity Index (Hidden Gems) — H3 neighbour ring (~1 km at res 9).
VOI_NEIGHBOR_K = 4
