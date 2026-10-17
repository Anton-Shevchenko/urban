"""FastAPI backend: on-demand, cached, multi-city Living Score generation.

Endpoints
---------
GET  /api/cities            -> list already-generated (cached) cities
POST /api/generate {q}      -> geocode + (re)use cache or start a background job
GET  /api/status/{slug}     -> job/cache status for polling
GET  /api/city/{slug}.geojson -> the generated hex GeoJSON
GET  /api/city/{slug}/cycleways.geojson -> dedicated cycleway line overlay
GET  /api/city/{slug}/stats   -> compact city-stats.json sidecar
GET  /api/city/{slug}/hexes.parquet -> property table without geometry
POST /api/destinations/matrix -> per-hex travel minutes to custom destinations

Generation is expensive (Overpass-bound, minutes) so it runs on a bounded
worker pool. The city product is the files under data/cities/<slug>/
(hexes.geojson, meta.json, sidecars). SQLite (data/wohnindex.db) stores only
the metadata index and job status. Frontend is served separately (React + nginx).
"""

from __future__ import annotations

import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from pipeline import config
from pipeline.cache_status import has_factor_cache, is_cache_current
from pipeline.city import CityContext, load_meta, resolve_city
from pipeline.common import log
from pipeline.export import normalize_export
from pipeline.run import STEPS, generate_city
from server import db, jobs
from server.destinations import load_or_compute

TOTAL_STEPS = len(STEPS)


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    db.init_db()
    jobs.init()
    yield


app = FastAPI(title="Living Score API", lifespan=lifespan)


def _cors_origins() -> list[str]:
    raw = os.environ.get("CORS_ORIGINS", "*").strip()
    if raw == "*":
        return ["*"]
    return [o.strip() for o in raw.split(",") if o.strip()]


app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins(),
    allow_methods=["*"],
    allow_headers=["*"],
)


class GenerateRequest(BaseModel):
    q: str


class DestinationPoint(BaseModel):
    lat: float
    lng: float
    weight: int = Field(default=2, ge=0, le=4)
    label: str = ""


class DestinationsMatrixRequest(BaseModel):
    slug: str
    destinations: list[DestinationPoint] = Field(default_factory=list, max_length=3)


def _city_dir(slug: str):
    return config.CITIES_DIR / slug


def _persist_city(slug: str) -> dict | None:
    """Index meta.json for a finished city; the GeoJSON stays on disk."""
    return db.upsert_city_from_dir(_city_dir(slug))


def _cached_meta(slug: str) -> dict | None:
    meta = db.get_city_meta(slug)
    if meta is not None and db.is_db_city_current(slug):
        return meta
    geojson = _city_dir(slug) / "hexes.geojson"
    if not geojson.exists():
        return meta  # may be stale DB entry
    disk_meta = load_meta(_city_dir(slug))
    if disk_meta is not None:
        ok, _ = is_cache_current(_city_dir(slug))
        if ok:
            db.upsert_city_from_dir(_city_dir(slug))
            return disk_meta
    return disk_meta or meta


def _submit_normalize(ctx: CityContext) -> None:
    """Re-export GeoJSON from existing factor parquets (fast path)."""
    slug = ctx.slug
    jobs.mark_queued(slug, TOTAL_STEPS, message="normalize + export", step=TOTAL_STEPS - 1)

    def work() -> dict | None:
        normalize_export.main(ctx)
        return _persist_city(slug) or _cached_meta(slug) or {**ctx.to_meta()}

    jobs.submit(slug, work, TOTAL_STEPS)


def _submit_generate(ctx: CityContext) -> None:
    slug = ctx.slug
    jobs.mark_queued(slug, TOTAL_STEPS)

    def work() -> dict | None:
        def on_step(i: int, total: int, name: str) -> None:
            jobs.mark_progress(slug, i, total, name)

        generate_city(ctx, on_step=on_step)
        return _persist_city(slug) or {**ctx.to_meta()}

    jobs.submit(slug, work, TOTAL_STEPS)


# --- API -------------------------------------------------------------------
@app.get("/api/cities")
def list_cities() -> dict:
    return {"cities": db.list_cities()}


@app.post("/api/generate")
def generate(req: GenerateRequest) -> dict:
    try:
        ctx = resolve_city(req.q)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"geocoding failed: {exc}") from exc

    slug = ctx.slug

    # Metadata index is enough when the on-disk file hex-svc reads is in place.
    if db.is_db_city_current(slug):
        meta = db.get_city_meta(slug)
        if meta is not None:
            return {"status": "ready", "slug": slug, "meta": meta}

    meta = _cached_meta(slug)
    if meta is not None:
        ok, reason = is_cache_current(_city_dir(slug))
        if ok:
            db.upsert_city_from_dir(_city_dir(slug))
            return {"status": "ready", "slug": slug, "meta": meta}
        if has_factor_cache(_city_dir(slug)):
            log("api", f"quick refresh for {slug}: {reason}")
            if not jobs.is_running(slug):
                _submit_normalize(ctx)
            return {"status": "pending", "slug": slug, "name": ctx.name}
        log("api", f"stale cache for {slug}: {reason}; regenerating")

    if not jobs.is_running(slug):
        _submit_generate(ctx)
    return {"status": "pending", "slug": slug, "name": ctx.name}


@app.get("/api/status/{slug}")
def status(slug: str) -> dict:
    job = jobs.snapshot(slug)
    if job is not None and job.get("status") == "pending":
        return {"slug": slug, **job}

    if db.is_db_city_current(slug):
        meta = db.get_city_meta(slug)
        if meta is not None:
            return {"status": "ready", "slug": slug, "meta": meta}
    city_dir = _city_dir(slug)
    meta = _cached_meta(slug)
    if meta is not None:
        ok, _ = is_cache_current(city_dir)
        if ok:
            return {"status": "ready", "slug": slug, "meta": meta}
    if job is not None and job.get("status") != "ready":
        # Error / interrupted: surface it. A stale "ready" job must not
        # hide a city that failed the living-score current check (e.g. a
        # leftover price-map export).
        return {"slug": slug, **job}
    raise HTTPException(status_code=404, detail="unknown city")


@app.get("/api/city/{slug}.geojson")
def city_geojson(slug: str):
    path = _city_dir(slug) / "hexes.geojson"
    if path.is_file():
        return FileResponse(path, media_type="application/geo+json")
    raise HTTPException(status_code=404, detail="not generated")


@app.get("/api/city/{slug}/cycleways.geojson")
def city_cycleways(slug: str):
    path = _city_dir(slug) / config.CYCLEWAYS_GEOJSON_FILE
    if path.exists():
        return FileResponse(path, media_type="application/geo+json")
    raise HTTPException(status_code=404, detail="not generated")


@app.get("/api/city/{slug}/stats")
def city_stats(slug: str):
    path = _city_dir(slug) / "city-stats.json"
    if path.exists():
        return FileResponse(path, media_type="application/json")
    raise HTTPException(status_code=404, detail="not generated")


@app.get("/api/city/{slug}/hexes.parquet")
def city_parquet(slug: str):
    path = _city_dir(slug) / "hexes.parquet"
    if path.exists():
        return FileResponse(path, media_type="application/vnd.apache.parquet")
    raise HTTPException(status_code=404, detail="not generated")


@app.post("/api/destinations/matrix")
def destinations_matrix(req: DestinationsMatrixRequest) -> dict:
    city_dir = _city_dir(req.slug)
    meta = db.get_city_meta(req.slug) or load_meta(city_dir) or {}
    if not city_dir.exists() and not meta:
        raise HTTPException(status_code=404, detail="city not found")
    if city_dir.exists():
        ok, reason = is_cache_current(city_dir)
        if not ok and not db.is_db_city_current(req.slug):
            raise HTTPException(status_code=409, detail=f"stale cache: {reason}")

    center = meta.get("center", [48.0, 11.0])
    if isinstance(center, list) and len(center) >= 2:
        center_tuple = (float(center[0]), float(center[1]))
    else:
        center_tuple = (48.0, 11.0)
    bbox_raw = meta.get("bbox", [47.5, 11.0, 48.5, 12.0])
    ctx = CityContext(
        slug=req.slug,
        name=meta.get("name", req.slug),
        center=center_tuple,
        bbox=tuple(float(x) for x in bbox_raw[:4]),
        base_dir=city_dir if city_dir.exists() else config.CITIES_DIR / req.slug,
    )
    dests = [d.model_dump() for d in req.destinations[:3]]
    if not dests:
        return {"destinations": [], "matrix": {}}

    if not city_dir.exists() or not (city_dir / "cache" / config.GRID_FILE).exists():
        raise HTTPException(
            status_code=409,
            detail="destination matrix needs on-disk grid cache; regenerate city",
        )

    df = load_or_compute(ctx, dests)
    matrix = {}
    for _, row in df.iterrows():
        h3 = row["h3_index"]
        entry = {}
        for i in range(len(dests)):
            col = f"dest_{i}_min"
            if col in row:
                entry[col] = float(row[col])
        matrix[h3] = entry

    return {"destinations": dests, "matrix": matrix}


@app.get("/api/health")
def health() -> dict:
    return {
        "ok": True,
        "db": str(db._DB_PATH),
        "pipeline_version": int(config.PIPELINE_SCHEMA_VERSION),
        "jobs_running": jobs.queue_depth(),
    }
