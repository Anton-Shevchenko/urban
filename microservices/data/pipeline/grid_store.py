"""Shared H3 grid for the map-view services.

The first caller to open a city writes ``<shared>/cities/<slug>/grid/``
(boundary, grid parquet, city record). Later services read that directory
and do not geocode the city again, so every view paints the same hex ids.
"""

from __future__ import annotations

import fcntl
import json
import os
from pathlib import Path

from pipeline import config
from pipeline.city import CityContext
from pipeline.common import log
from pipeline.ingest.grid import build_grid

STEP = "grid_store"


def shared_root() -> Path:
    return config.SHARED_DIR


def grid_dir(slug: str) -> Path:
    return shared_root() / "cities" / slug / "grid"


def city_record_path(slug: str) -> Path:
    return grid_dir(slug) / "city.json"


def grid_parquet_path(slug: str) -> Path:
    return grid_dir(slug) / config.GRID_FILE


def _record_from_ctx(ctx: CityContext) -> dict:
    return {
        "slug": ctx.slug,
        "name": ctx.name,
        "center": [ctx.center[0], ctx.center[1]],
        "bbox": list(ctx.bbox),
        "boundary": ctx.boundary_geojson,
        "population": ctx.population,
        "city_type": ctx.city_type,
    }


def write_record(ctx: CityContext) -> None:
    dest = grid_dir(ctx.slug)
    dest.mkdir(parents=True, exist_ok=True)
    if ctx.boundary_geojson is not None:
        (dest / config.BOUNDARY_FILE).write_text(
            json.dumps(ctx.boundary_geojson),
            encoding="utf-8",
        )
    city_record_path(ctx.slug).write_text(
        json.dumps(_record_from_ctx(ctx)),
        encoding="utf-8",
    )


def context_from_record(data: dict, *, base_dir: Path | None = None) -> CityContext:
    center = data.get("center") or [0.0, 0.0]
    bbox = data.get("bbox") or [0.0, 0.0, 0.0, 0.0]
    return CityContext(
        slug=str(data["slug"]),
        name=str(data.get("name") or data["slug"]),
        center=(float(center[0]), float(center[1])),
        bbox=(float(bbox[0]), float(bbox[1]), float(bbox[2]), float(bbox[3])),
        boundary_geojson=data.get("boundary"),
        population=int(data.get("population") or 0),
        city_type=str(data.get("city_type") or ""),
        base_dir=base_dir,
    )


def load_record(slug: str, *, base_dir: Path | None = None) -> CityContext | None:
    path = city_record_path(slug)
    if not path.is_file():
        return None
    data = json.loads(path.read_text(encoding="utf-8"))
    ctx = context_from_record(data, base_dir=base_dir)
    boundary = grid_dir(slug) / config.BOUNDARY_FILE
    if ctx.boundary_geojson is None and boundary.is_file():
        ctx.boundary_geojson = json.loads(boundary.read_text(encoding="utf-8"))
    return ctx


def find_cached_city(query: str) -> CityContext | None:
    """Match a previous geocode by slug or display name. No Nominatim call."""
    root = shared_root() / "cities"
    if not root.is_dir():
        return None
    needle = query.strip().lower()
    if not needle:
        return None
    for child in sorted(root.iterdir()):
        if not child.is_dir():
            continue
        ctx = load_record(child.name)
        if ctx is None:
            continue
        if ctx.slug == needle or ctx.name.strip().lower() == needle:
            return ctx
    return None


def ensure_shared_grid(ctx: CityContext) -> Path:
    """Write the shared grid once. Concurrent callers block on a file lock."""
    dest = grid_dir(ctx.slug)
    dest.mkdir(parents=True, exist_ok=True)
    lock_path = dest / ".lock"
    with open(lock_path, "a+") as fh:
        fcntl.flock(fh, fcntl.LOCK_EX)
        try:
            parquet = grid_parquet_path(ctx.slug)
            if parquet.is_file() and city_record_path(ctx.slug).is_file():
                log(STEP, f"{ctx.slug} grid already shared")
                return parquet
            if ctx.boundary_geojson is None:
                boundary = dest / config.BOUNDARY_FILE
                if boundary.is_file():
                    ctx.boundary_geojson = json.loads(boundary.read_text(encoding="utf-8"))
            log(STEP, f"writing shared grid for {ctx.slug}")
            gdf = build_grid(ctx)
            gdf.to_parquet(parquet)
            write_record(ctx)
            return parquet
        finally:
            fcntl.flock(fh, fcntl.LOCK_UN)


def bind_grid(ctx: CityContext) -> Path:
    """Make the shared grid visible at ``ctx.cache(GRID_FILE)`` via a hard link."""
    src = grid_parquet_path(ctx.slug)
    if not src.is_file():
        src = ensure_shared_grid(ctx)
    dest = ctx.cache(config.GRID_FILE)
    if dest.exists() or dest.is_symlink():
        return dest
    boundary_src = grid_dir(ctx.slug) / config.BOUNDARY_FILE
    boundary_dest = ctx.cache(config.BOUNDARY_FILE)
    if boundary_src.is_file() and not boundary_dest.exists():
        _link_or_copy(boundary_src, boundary_dest)
    _link_or_copy(src, dest)
    return dest


def _link_or_copy(src: Path, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    try:
        os.link(src, dest)
    except OSError:
        dest.write_bytes(src.read_bytes())
