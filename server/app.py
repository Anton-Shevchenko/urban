"""FastAPI backend: on-demand, cached, multi-city comfort-index generation.

Endpoints
---------
GET  /api/cities            -> list already-generated (cached) cities
POST /api/generate {q}      -> geocode + (re)use cache or start a background job
GET  /api/status/{slug}     -> job/cache status for polling
GET  /api/city/{slug}.geojson -> the generated hex GeoJSON
POST /api/destinations/matrix -> per-hex travel minutes to custom destinations

Generation is expensive (Overpass-bound, minutes) so it runs in a background
thread; results are written to data/cities/<slug>/ and persisted in SQLite
(data/wohnindex.db). Frontend is served separately (React + nginx).
"""
from __future__ import annotations

import os
import threading
import traceback

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel, Field

from pipeline import config, normalize_export
from pipeline.cache_status import has_factor_cache, is_cache_current
from pipeline.city import CityContext, load_meta, resolve_city
from pipeline.run_all import STEPS, generate_city
from server import db
from server.destinations import load_or_compute

TOTAL_STEPS = len(STEPS)

app = FastAPI(title="Spatial Value Index - multi-city API")


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

# --- in-memory job registry ------------------------------------------------
_jobs: dict[str, dict] = {}
_lock = threading.Lock()


@app.on_event("startup")
def _startup() -> None:
    db.init_db()


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


def _job_snapshot(slug: str) -> dict | None:
    with _lock:
        job = _jobs.get(slug)
        return dict(job) if job else None


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


def _run_normalize_job(ctx: CityContext) -> None:
    """Re-export GeoJSON from existing factor parquets (fast path)."""
    slug = ctx.slug
    with _lock:
        _jobs[slug] = {
            "status": "pending",
            "step": 14,
            "total": TOTAL_STEPS,
            "message": "normalize + export",
        }
    try:
        normalize_export.main(ctx)
        meta = _persist_city(slug) or _cached_meta(slug) or {**ctx.to_meta()}
        with _lock:
            _jobs[slug] = {
                "status": "ready",
                "step": TOTAL_STEPS,
                "total": TOTAL_STEPS,
                "message": "done",
                "meta": meta,
            }
    except Exception as exc:  # noqa: BLE001
        traceback.print_exc()
        with _lock:
            _jobs[slug] = {
                "status": "error",
                "message": f"{type(exc).__name__}: {exc}",
            }


def _run_job(ctx: CityContext) -> None:
    slug = ctx.slug

    def on_step(i: int, total: int, name: str) -> None:
        with _lock:
            _jobs[slug] = {
                "status": "pending",
                "step": i,
                "total": total,
                "message": name,
            }

    try:
        generate_city(ctx, on_step=on_step)
        meta = _persist_city(slug) or {**ctx.to_meta()}
        with _lock:
            _jobs[slug] = {
                "status": "ready",
                "step": TOTAL_STEPS,
                "total": TOTAL_STEPS,
                "message": "done",
                "meta": meta,
            }
    except Exception as exc:  # noqa: BLE001
        traceback.print_exc()
        with _lock:
            _jobs[slug] = {
                "status": "error",
                "message": f"{type(exc).__name__}: {exc}",
            }


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
            print(f"[api] quick refresh for {slug}: {reason}")
            with _lock:
                job = _jobs.get(slug)
                if job and job.get("status") == "pending":
                    return {"status": "pending", "slug": slug, "name": ctx.name}
                _jobs[slug] = {
                    "status": "pending",
                    "step": 14,
                    "total": TOTAL_STEPS,
                    "message": "normalize + export",
                }
            thread = threading.Thread(target=_run_normalize_job, args=(ctx,), daemon=True)
            thread.start()
            return {"status": "pending", "slug": slug, "name": ctx.name}
        print(f"[api] stale cache for {slug}: {reason}; regenerating")

    with _lock:
        job = _jobs.get(slug)
        if job and job.get("status") == "pending":
            return {"status": "pending", "slug": slug, "name": ctx.name}
        _jobs[slug] = {"status": "pending", "step": 0, "total": TOTAL_STEPS, "message": "queued"}

    thread = threading.Thread(target=_run_job, args=(ctx,), daemon=True)
    thread.start()
    return {"status": "pending", "slug": slug, "name": ctx.name}


@app.get("/api/status/{slug}")
def status(slug: str) -> dict:
    job = _job_snapshot(slug)
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
    if job is not None:
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
    return {"ok": True, "db": str(db._DB_PATH)}
