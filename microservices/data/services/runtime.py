"""Paths and city opening shared by the four map-view processes."""

from __future__ import annotations

import math
import os
from pathlib import Path

from pipeline import config
from pipeline.city import CityContext, resolve_city
from pipeline.grid_store import bind_grid, ensure_shared_grid, find_cached_city, load_record

NAMES = ("infrastructure", "cycleways", "walkability", "rents")


def service_root(name: str) -> Path:
    """Private cache for one view.

    ``SERVICE_DATA_ROOT`` is the whole data directory of a container that
    already runs as a single service. Locally every service shares ``DATA_DIR``
    and keeps its files under ``services/<name>``.
    """
    override = os.environ.get("SERVICE_DATA_ROOT", "").strip()
    if override:
        return Path(override)
    return config.DATA_DIR / "services" / name


def city_dir(name: str, slug: str) -> Path:
    return service_root(name) / slug


def json_number(value: object) -> float | None:
    try:
        number = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    if not math.isfinite(number):
        return None
    return number


def open_service_city(name: str, *, slug: str | None = None, query: str | None = None) -> CityContext:
    """Open a city for one service.

    A slug loads the shared grid record and never calls Nominatim. A query
    reuses that record when the city was opened before, and geocodes only
    when the shared grid does not exist yet.
    """
    if slug:
        ctx = load_record(slug, base_dir=city_dir(name, slug))
        if ctx is None:
            raise LookupError(f"unknown city '{slug}'")
        bind_grid(ctx)
        return ctx

    text = (query or "").strip()
    if not text:
        raise ValueError("empty city query")
    cached = find_cached_city(text)
    if cached is not None:
        cached.base_dir = city_dir(name, cached.slug)
        bind_grid(cached)
        return cached
    ctx = resolve_city(text)
    ensure_shared_grid(ctx)
    ctx.base_dir = city_dir(name, ctx.slug)
    bind_grid(ctx)
    return ctx
