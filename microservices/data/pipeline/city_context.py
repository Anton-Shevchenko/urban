"""City Context Layer — population, city_type, and meta for normalization.

Classification:

  METROPOLIS   >500k
  LARGE_CITY   100k–500k
  MEDIUM_CITY  20k–100k
  SMALL_CITY   <20k
"""

from __future__ import annotations

import math

import pandas as pd

from . import config
from .city import CityContext
from .common import log

STEP = "city_context"

CITY_TYPES = ("METROPOLIS", "LARGE_CITY", "MEDIUM_CITY", "SMALL_CITY")

# Manual fallbacks when Zensus / Nominatim population is unavailable.
KNOWN_POPULATION: dict[str, int] = {
    "muenchen": 1_510_000,
    "munich": 1_510_000,
    "berlin": 3_700_000,
    "hamburg": 1_900_000,
    "koeln": 1_100_000,
    "frankfurt-am-main": 770_000,
    "stuttgart": 630_000,
    "duesseldorf": 630_000,
    "leipzig": 620_000,
    "dortmund": 595_000,
    "essen": 580_000,
    "bremen": 570_000,
    "dresden": 560_000,
    "hannover": 540_000,
    "nuernberg": 520_000,
    "rosenheim": 65_000,
    "potsdam": 185_000,
}


def classify_city_type(population: int | float | None) -> str:
    pop = float(population or 0)
    if pop > 500_000:
        return "METROPOLIS"
    if pop >= 100_000:
        return "LARGE_CITY"
    if pop >= 20_000:
        return "MEDIUM_CITY"
    return "SMALL_CITY"


def _population_from_housing(ctx: CityContext) -> int | None:
    path = ctx.cache(config.HOUSING_FILE)
    if not path.exists():
        return None
    try:
        df = pd.read_parquet(path)
    except Exception:  # noqa: BLE001
        return None
    if "population" not in df.columns:
        return None
    total = float(df["population"].fillna(0).sum())
    return int(round(total)) if total > 1000 else None


def _population_from_area(ctx: CityContext) -> int:
    """Rough fallback: bbox area × city-type-ish density."""
    s, w, n, e = ctx.bbox
    # degrees → rough km²
    lat_km = (n - s) * 111.0
    lng_km = (e - w) * 111.0 * max(0.3, abs(math.cos(math.radians((n + s) / 2))))
    area_km2 = max(1.0, lat_km * lng_km)
    # Assume mid-density German city fabric.
    return int(round(area_km2 * 2500))


def resolve_population(ctx: CityContext, nominatim_population: int | None = None) -> int:
    """Best-effort city population for classification."""
    if ctx.slug in KNOWN_POPULATION:
        return KNOWN_POPULATION[ctx.slug]
    if nominatim_population and nominatim_population > 1000:
        return int(nominatim_population)
    zensus = _population_from_housing(ctx)
    if zensus:
        return zensus
    return _population_from_area(ctx)


def attach_city_context(
    ctx: CityContext,
    *,
    nominatim_population: int | None = None,
    force: bool = False,
) -> CityContext:
    """Populate ``population`` / ``city_type`` on the context."""
    if not force and ctx.city_type and ctx.population:
        return ctx
    pop = resolve_population(ctx, nominatim_population=nominatim_population)
    # Prefer Zensus sum when housing already ran and known lookup is absent.
    zensus = _population_from_housing(ctx)
    if zensus and ctx.slug not in KNOWN_POPULATION:
        pop = zensus
    ctx.population = int(pop)
    ctx.city_type = classify_city_type(ctx.population)
    ctx.city_context = {
        "population": ctx.population,
        "city_type": ctx.city_type,
        "normalization": "city_context_v1",
    }
    log(STEP, f"{ctx.name}: population≈{ctx.population:,} → {ctx.city_type}")
    return ctx


def ensure_city_context(ctx: CityContext) -> CityContext:
    """Idempotent attach — call before normalize / scoring."""
    return attach_city_context(ctx)
