"""City context + geocoding.

A ``CityContext`` bundles everything the pipeline needs to know about the city
it is currently building: display name, url-safe slug, centre, bounding box,
admin boundary polygon, the per-city cache/output directory, and whether rent
data is available.

``resolve_city`` turns a free-text query (e.g. "Hamburg") into a fully
populated context via the Nominatim geocoder, deriving the bounding box and
centre from the returned admin boundary polygon.
"""

from __future__ import annotations

import json
import re
import shutil
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path

from shapely.geometry import shape

from . import config
from .common import log
from .providers import NOMINATIM

STEP = "city"

_UMLAUTS = {"ä": "ae", "ö": "oe", "ü": "ue", "ß": "ss"}


def slugify(name: str) -> str:
    """Return a url-safe, ascii slug for a (possibly umlauted) city name."""
    s = name.lower().strip()
    for a, b in _UMLAUTS.items():
        s = s.replace(a, b)
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode("ascii")
    s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")
    return s or "city"


def _utm_epsg(lat: float, lng: float) -> str:
    """WGS84 UTM CRS for a lat/lng, used for metric distance/area math."""
    zone = int((lng + 180) / 6) + 1
    base = 32600 if lat >= 0 else 32700
    return f"EPSG:{base + zone}"


@dataclass
class CityContext:
    slug: str
    name: str
    center: tuple[float, float]  # (lat, lng)
    bbox: tuple[float, float, float, float]  # (south, west, north, east)
    boundary_geojson: dict | None = None
    has_rent: bool = False  # true only after an observed Kaltmiete is attached
    rent_estimated: bool = False  # prices are never modelled
    rent_source: str = ""  # provenance label, set by pipeline.rents
    centers: list = field(default_factory=list)  # detected centres (main + sub)
    population: int = 0
    city_type: str = ""  # METROPOLIS | LARGE_CITY | MEDIUM_CITY | SMALL_CITY
    city_context: dict = field(default_factory=dict)
    base_dir: Path = field(default=None)  # type: ignore[assignment]

    def __post_init__(self) -> None:
        if self.base_dir is None:
            self.base_dir = config.CITIES_DIR / self.slug

    # --- derived paths -----------------------------------------------------
    @property
    def cache_dir(self) -> Path:
        d = self.base_dir / "cache"
        d.mkdir(parents=True, exist_ok=True)
        return d

    @property
    def out_geojson(self) -> Path:
        self.base_dir.mkdir(parents=True, exist_ok=True)
        return self.base_dir / "hexes.geojson"

    @property
    def meta_json(self) -> Path:
        self.base_dir.mkdir(parents=True, exist_ok=True)
        return self.base_dir / "meta.json"

    def cache(self, name: str) -> Path:
        return self.cache_dir / name

    # --- derived geometry --------------------------------------------------
    @property
    def bbox_str(self) -> str:
        """Overpass bbox string: south,west,north,east."""
        s, w, n, e = self.bbox
        return f"{s},{w},{n},{e}"

    @property
    def metric_crs(self) -> str:
        return _utm_epsg(self.center[0], self.center[1])

    def to_meta(self) -> dict:
        return {
            "slug": self.slug,
            "name": self.name,
            "center": [self.center[0], self.center[1]],
            "bbox": list(self.bbox),
            "has_rent": self.has_rent,
            "rent_estimated": self.rent_estimated,
            "rent_source": self.rent_source,
            "centers": self.centers,
            "population": self.population,
            "city_type": self.city_type,
            "normalization": (self.city_context or {}).get("normalization", "city_context_v1"),
            "city_context": self.city_context
            or {
                "population": self.population,
                "city_type": self.city_type,
                "normalization": "city_context_v1",
            },
        }


def munich_context() -> CityContext:
    """The built-in Munich context (the one city that ships with rent data)."""
    from .city_context import attach_city_context

    ctx = CityContext(
        slug="muenchen",
        name="München",
        center=config.MARIENPLATZ,
        bbox=config.MUNICH_BBOX,
        has_rent=False,
        rent_estimated=False,
    )
    return attach_city_context(ctx)


def _short_name(result: dict, query: str) -> str:
    nd = result.get("namedetails") or {}
    if nd.get("name"):
        return nd["name"]
    disp = result.get("display_name")
    if disp:
        return disp.split(",")[0].strip()
    return query.strip()


def resolve_city(query: str) -> CityContext:
    """Geocode a free-text place name into a fully populated CityContext.

    Uses Nominatim to fetch the admin boundary polygon, then derives the
    bounding box and centre from it. Restricts results to Germany.
    """
    query = query.strip()
    if not query:
        raise ValueError("empty city query")

    log(STEP, f"geocoding '{query}' via Nominatim")
    resp = NOMINATIM.get(
        config.NOMINATIM_URL,
        params={
            "q": query,
            "format": "json",
            "polygon_geojson": 1,
            "namedetails": 1,
            "extratags": 1,
            "limit": 1,
            "countrycodes": "de",
            "featureType": "city",
        },
    )
    resp.raise_for_status()
    results = resp.json()
    if not results:
        raise LookupError(f"no result for '{query}'")

    r = results[0]
    geom = r.get("geojson")
    if not geom:
        raise LookupError(f"no boundary polygon for '{query}'")

    shp = shape(geom)
    minx, miny, maxx, maxy = shp.bounds  # (lng, lat) order
    bbox = (miny, minx, maxy, maxx)  # (south, west, north, east)
    centroid = shp.centroid
    center = (centroid.y, centroid.x)  # (lat, lng)

    name = _short_name(r, query)
    slug = slugify(name)

    nom_pop = None
    extratags = r.get("extratags") or {}
    for key in ("population", "population:date"):
        raw = extratags.get("population") if key == "population" else None
        if raw:
            try:
                nom_pop = int(str(raw).replace(".", "").replace(",", "").split()[0])
            except ValueError:
                nom_pop = None
            break

    ctx = CityContext(
        slug=slug,
        name=name,
        center=center,
        bbox=bbox,
        boundary_geojson=geom,
        has_rent=False,
        rent_estimated=False,
    )
    # Persist the boundary so grid.py can reuse it without re-geocoding.
    with open(ctx.cache(config.BOUNDARY_FILE), "w", encoding="utf-8") as fh:
        json.dump(geom, fh)

    from .city_context import attach_city_context

    attach_city_context(ctx, nominatim_population=nom_pop)
    log(STEP, f"resolved '{query}' -> {name} (slug={slug})")
    return ctx


def load_meta(base_dir: Path) -> dict | None:
    meta = base_dir / "meta.json"
    if not meta.exists():
        return None
    with open(meta, encoding="utf-8") as fh:
        return json.load(fh)


def ctx_from_cache(slug: str) -> CityContext | None:
    """Rebuild a CityContext from an already-generated city directory."""
    from .city_context import attach_city_context

    base = config.CITIES_DIR / slug
    meta = load_meta(base)
    if not meta:
        log(STEP, f"skip {slug}: no meta.json")
        return None
    if not (base / "cache" / config.GRID_FILE).exists():
        log(STEP, f"skip {slug}: no cached grid (needs full regeneration)")
        return None
    ctx = CityContext(
        slug=meta["slug"],
        name=meta.get("name", slug),
        center=tuple(meta.get("center", (0.0, 0.0))),
        bbox=tuple(meta.get("bbox", (0.0, 0.0, 0.0, 0.0))),
        has_rent=bool(meta.get("has_rent", False)),
        rent_estimated=bool(meta.get("rent_estimated", False)),
        rent_source=meta.get("rent_source") or "",
        centers=meta.get("centers", []),
        population=int(meta.get("population") or 0),
        city_type=meta.get("city_type") or "",
        city_context=meta.get("city_context") or {},
        base_dir=base,
    )
    return attach_city_context(ctx)


def sync_munich_bundle(ctx: CityContext) -> None:
    """Copy München's export into frontend/public so the bundled map stays current."""
    if ctx.slug not in {"muenchen", "munich"}:
        return
    dst_dir = config.FRONTEND_PUBLIC_DIR / "data"
    dst = dst_dir / "hexes.geojson"
    if ctx.out_geojson.exists() and dst_dir.exists():
        shutil.copyfile(ctx.out_geojson, dst)
        log(STEP, f"synced bundled map -> {dst}")
    overlay = ctx.base_dir / config.CYCLEWAYS_GEOJSON_FILE
    overlay_dst = dst_dir / config.CYCLEWAYS_GEOJSON_FILE
    if overlay.exists() and dst_dir.exists():
        shutil.copyfile(overlay, overlay_dst)
        log(STEP, f"synced cycleway overlay -> {overlay_dst}")
