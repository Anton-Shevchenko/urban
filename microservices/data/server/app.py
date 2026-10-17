"""Public API on :8000. Resolves a city once, then proxies the four map views.

Opening a city starts infrastructure and, in the same fan-out, cycleways,
walkability and rents. Each of those processes fetches and stores its own data.
"""

from __future__ import annotations

import os
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel, Field

from pipeline.city import CityContext, resolve_city
from pipeline.common import log
from pipeline.grid_store import (
    bind_grid,
    ensure_shared_grid,
    find_cached_city,
    grid_parquet_path,
    load_record,
    shared_root,
)
from server.destinations import load_or_compute

VIEWS = {
    "infrastructure": os.environ.get("INFRASTRUCTURE_URL", "http://127.0.0.1:8001"),
    "cycleways": os.environ.get("CYCLEWAYS_URL", "http://127.0.0.1:8002"),
    "walkability": os.environ.get("WALKABILITY_URL", "http://127.0.0.1:8003"),
    "rents": os.environ.get("RENTS_URL", "http://127.0.0.1:8004"),
}

SCORE_VIEWS = {
    "price": "rents",
    "cycleways": "cycleways",
    "walkability": "walkability",
}


def _cors_origins() -> list[str]:
    raw = os.environ.get("CORS_ORIGINS", "*").strip()
    if raw == "*":
        return ["*"]
    return [origin.strip() for origin in raw.split(",") if origin.strip()]


app = FastAPI(title="Living Score API")
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


def request_upstream(method: str, service: str, path: str, payload: dict | None = None, *, timeout: float = 60) -> requests.Response:
    url = VIEWS[service].rstrip("/") + path
    try:
        return requests.request(method, url, json=payload, timeout=timeout)
    except requests.RequestException as exc:
        raise HTTPException(status_code=502, detail=f"{service} unavailable: {exc}") from exc


def proxy(method: str, service: str, path: str, payload: dict | None = None) -> Response:
    resp = request_upstream(method, service, path, payload)
    media = resp.headers.get("content-type", "application/json")
    if resp.status_code >= 400:
        detail = resp.text[:300] or resp.reason
        raise HTTPException(status_code=resp.status_code, detail=detail)
    return Response(content=resp.content, media_type=media)


def fanout(ctx: CityContext) -> dict:
    """Ask every view service to generate this city. The map waits on infrastructure."""

    def one(name: str) -> dict:
        resp = request_upstream("POST", name, "/generate", {"slug": ctx.slug}, timeout=30)
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text[:300])
        return resp.json()

    results: dict[str, dict] = {}
    with ThreadPoolExecutor(max_workers=len(VIEWS)) as pool:
        futures = {pool.submit(one, name): name for name in VIEWS}
        for fut in as_completed(futures):
            name = futures[fut]
            try:
                results[name] = fut.result()
            except Exception as exc:  # noqa: BLE001
                log("router", f"{name} did not start: {exc}")
                if name == "infrastructure":
                    raise
    infra = results.get("infrastructure")
    if infra is None:
        raise HTTPException(status_code=502, detail="infrastructure did not start")
    return infra


def open_city(query: str) -> CityContext:
    cached = find_cached_city(query)
    if cached is not None:
        ensure_shared_grid(cached)
        return cached
    ctx = resolve_city(query)
    ensure_shared_grid(ctx)
    return ctx


@app.get("/api/health")
def health() -> dict:
    upstreams = {}
    for name in VIEWS:
        try:
            resp = request_upstream("GET", name, "/health", timeout=1.5)
            upstreams[name] = resp.status_code == 200
        except HTTPException:
            upstreams[name] = False
    return {"ok": True, "jobs_running": 0, "services": upstreams}


@app.get("/api/cities")
def list_cities() -> Response:
    return proxy("GET", "infrastructure", "/cities")


@app.post("/api/generate")
def generate(req: GenerateRequest) -> dict:
    try:
        ctx = open_city(req.q)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"geocoding failed: {exc}") from exc
    body = fanout(ctx)
    body.setdefault("slug", ctx.slug)
    body.setdefault("name", ctx.name)
    return body


@app.get("/api/status/{slug}")
def status(slug: str) -> Response:
    return proxy("GET", "infrastructure", f"/status/{slug}")


@app.get("/api/city/{slug}.geojson")
def city_geojson(slug: str) -> Response:
    return proxy("GET", "infrastructure", f"/city/{slug}.geojson")


@app.get("/api/city/{slug}/cycleways.geojson")
def city_cycleways(slug: str) -> Response:
    return proxy("GET", "cycleways", f"/city/{slug}/lines.geojson")


@app.get("/api/city/{slug}/views/{view}/status")
def view_status(slug: str, view: str) -> Response:
    service = SCORE_VIEWS.get(view)
    if service is None:
        raise HTTPException(status_code=404, detail="unknown map view")
    return proxy("GET", service, f"/status/{slug}")


@app.get("/api/city/{slug}/views/{view}/scores")
def view_scores(slug: str, view: str) -> Response:
    service = SCORE_VIEWS.get(view)
    if service is None:
        raise HTTPException(status_code=404, detail="unknown map view")
    return proxy("GET", service, f"/city/{slug}/scores")


@app.post("/api/destinations/matrix")
def destinations_matrix(req: DestinationsMatrixRequest) -> dict:
    ctx = load_record(req.slug)
    if ctx is None or not grid_parquet_path(req.slug).is_file():
        raise HTTPException(status_code=404, detail="city not found")
    ctx.base_dir = shared_root() / "cities" / req.slug
    bind_grid(ctx)
    dests = [point.model_dump() for point in req.destinations[:3]]
    if not dests:
        return {"destinations": [], "matrix": {}}
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
