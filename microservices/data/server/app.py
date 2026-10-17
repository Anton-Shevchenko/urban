"""FastAPI backend: on-demand, cached, multi-city Living Score generation.

Endpoints
---------
GET  /api/cities            -> list already-generated (cached) cities
POST /api/generate {q}      -> geocode + (re)use cache or start a background job
GET  /api/status/{slug}     -> job/cache status for polling
GET  /api/suggest?q=        -> Photon suggestions, Germany only
POST /api/cycleways {q}     -> Nominatim boundary + schema-2 cycle infra only
GET  /api/cycleways/status/{slug} -> cycle-infra job status
GET  /api/city/{slug}.geojson -> the generated hex GeoJSON
GET  /api/city/{slug}/cycleways.geojson -> schema-2 cycle infrastructure
GET  /api/city/{slug}/stats   -> compact city-stats.json sidecar
GET  /api/city/{slug}/hexes.parquet -> property table without geometry
POST /api/destinations/matrix -> per-hex travel minutes to custom destinations

Generation is expensive (Overpass-bound, minutes) so it runs on a bounded
worker pool; results are written to data/cities/<slug>/ and persisted in SQLite
(data/wohnindex.db), as is job status. Frontend is served separately
(React + nginx).
"""

from __future__ import annotations

import json
import os
import threading
import traceback
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel, Field

from pipeline import config
from pipeline.cache_status import has_factor_cache, is_cache_current
from pipeline.city import CityContext, load_meta, resolve_city
from pipeline.common import log
from pipeline.export import normalize_export
from pipeline.ingest.cycle_infra import cycleways_cache_ready
from pipeline.run import STEPS, generate_city
from server import db, jobs
from server.destinations import load_or_compute
from server.suggest import photon_suggestions

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


class CyclewaysRequest(BaseModel):
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
    """Write finished city product into SQLite; return meta."""
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


def _cycle_job_id(slug: str) -> str:
    """Job key separate from Wohnindex generation for the same city."""
    return f"cycleways:{slug}"


_cycle_guard = threading.Lock()


def _cycleways_context(slug: str) -> CityContext | None:
    """Bbox for a refresh: schema meta, Wohnindex meta.json, or the DB row."""
    city_dir = _city_dir(slug)
    metas: list[dict] = []
    for path in (city_dir / config.CYCLEWAYS_META_FILE, city_dir / "meta.json"):
        if not path.is_file():
            continue
        try:
            metas.append(json.loads(path.read_text(encoding="utf-8")))
        except (OSError, json.JSONDecodeError):
            continue
    db_meta = db.get_city_meta(slug)
    if db_meta:
        metas.append(db_meta)
    for meta in metas:
        bbox = meta.get("bbox")
        if not isinstance(bbox, (list, tuple)) or len(bbox) < 4:
            continue
        center = meta.get("center")
        if not isinstance(center, (list, tuple)) or len(center) < 2:
            center = ((float(bbox[0]) + float(bbox[2])) / 2, (float(bbox[1]) + float(bbox[3])) / 2)
        return CityContext(
            slug=slug,
            name=str(meta.get("name") or slug),
            center=(float(center[0]), float(center[1])),
            bbox=(float(bbox[0]), float(bbox[1]), float(bbox[2]), float(bbox[3])),
            base_dir=city_dir,
        )
    return None


def _submit_cycleways(ctx: CityContext) -> None:
    """Queue one Overpass fetch for cycle infrastructure. Never ``generate_city``."""
    job_id = _cycle_job_id(ctx.slug)
    with _cycle_guard:
        if jobs.is_running(job_id):
            return
        snap = jobs.snapshot(job_id)
        if snap and snap.get("status") == "pending":
            return
        jobs.mark_queued(job_id, 1, message="Radwege werden geladen …")

        def work() -> dict:
            from pipeline.ingest.cycle_infra import fetch_and_store_cycle_infra

            jobs.mark_progress(job_id, 0, 1, "Radwege werden geladen …")
            return fetch_and_store_cycle_infra(ctx)

        jobs.submit(job_id, work, 1)


def _cycleways_payload(ctx: CityContext, *, status: str, cached: bool, message: str, job: dict | None = None) -> dict:
    body = {
        "status": status,
        "cached": cached,
        "slug": ctx.slug,
        "name": ctx.name,
        "bbox": [ctx.bbox[0], ctx.bbox[1], ctx.bbox[2], ctx.bbox[3]],
        "center": [ctx.center[0], ctx.center[1]],
        "message": message,
    }
    if job:
        body["step"] = job.get("step", 0)
        body["total"] = job.get("total", 1)
    return body


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
    cities = db.list_cities()
    # Also surface filesystem-only cities (e.g. mid-migration).
    seen = {c.get("slug") for c in cities}
    if config.CITIES_DIR.exists():
        for d in sorted(config.CITIES_DIR.iterdir()):
            if not d.is_dir() or d.name in seen:
                continue
            if not (d / "hexes.geojson").exists():
                continue
            meta = load_meta(d) or {"slug": d.name, "name": d.name}
            cities.append(meta)
            db.upsert_city_from_dir(d)
    cities.sort(key=lambda m: (m.get("name") or m.get("slug") or "").lower())
    return {"cities": cities}


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

    # Prefer current DB entry (fast path without disk schema check).
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
    text = db.get_city_geojson_text(slug)
    if text is not None and db.is_db_city_current(slug):
        return Response(content=text, media_type="application/geo+json")
    path = _city_dir(slug) / "hexes.geojson"
    if path.exists():
        # Backfill DB while serving from disk.
        try:
            db.upsert_city_from_dir(_city_dir(slug))
        except Exception:  # noqa: BLE001
            traceback.print_exc()
        return FileResponse(path, media_type="application/geo+json")
    if text is not None:
        return Response(content=text, media_type="application/geo+json")
    raise HTTPException(status_code=404, detail="not generated")


@app.get("/api/suggest")
def suggest(q: str = "", limit: int = 8) -> dict:
    try:
        suggestions = photon_suggestions(q, limit=limit)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"suggest failed: {exc}") from exc
    return {"suggestions": suggestions}


@app.post("/api/cycleways")
def post_cycleways(req: CyclewaysRequest) -> dict:
    """Resolve the city and return its bbox. Fetch cycle infra only when needed."""
    try:
        ctx = resolve_city(req.q)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"geocoding failed: {exc}") from exc

    if cycleways_cache_ready(ctx.base_dir):
        log("cycleways", f"schema 2 cache hit {ctx.slug}")
        return _cycleways_payload(ctx, status="ready", cached=True, message="Radwege aus dem Cache")

    _submit_cycleways(ctx)
    job = jobs.snapshot(_cycle_job_id(ctx.slug)) or {}
    return _cycleways_payload(
        ctx,
        status="pending",
        cached=False,
        message=str(job.get("message") or "Radwege werden geladen …"),
        job=job,
    )


@app.get("/api/cycleways/status/{slug}")
def cycleways_status(slug: str) -> dict:
    city_dir = _city_dir(slug)
    if cycleways_cache_ready(city_dir):
        try:
            meta = json.loads((city_dir / config.CYCLEWAYS_META_FILE).read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            meta = {}
        return {
            "status": "ready",
            "cached": True,
            "slug": slug,
            "name": meta.get("name") or slug,
            "bbox": meta.get("bbox"),
            "center": meta.get("center"),
            "message": "Radwege aus dem Cache",
            "counts": meta.get("counts") or {},
        }
    job = jobs.snapshot(_cycle_job_id(slug))
    if job is None:
        raise HTTPException(status_code=404, detail="unknown cycleway city")
    return {
        "status": job.get("status"),
        "cached": False,
        "slug": slug,
        "message": job.get("message") or "",
        "step": job.get("step", 0),
        "total": job.get("total", 1),
    }


@app.get("/api/city/{slug}/cycleways.geojson")
def city_cycleways(slug: str):
    city_dir = _city_dir(slug)
    if cycleways_cache_ready(city_dir):
        return FileResponse(city_dir / config.CYCLEWAYS_GEOJSON_FILE, media_type="application/geo+json")
    ctx = _cycleways_context(slug)
    if ctx is not None:
        _submit_cycleways(ctx)
    raise HTTPException(status_code=404, detail="cycleways cache is not current")


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
