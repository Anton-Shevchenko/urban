"""HTTP shell for one map-view process."""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from services.jobs import JobBook
from services.runtime import city_dir, open_service_city, service_root

Runner = Callable  # (CityContext) -> dict | None


class GenerateRequest(BaseModel):
    q: str = ""
    slug: str = ""


def build_app(name: str, run: Runner, *, ready_name: str) -> tuple[FastAPI, JobBook]:
    service_root(name).mkdir(parents=True, exist_ok=True)
    book = JobBook(lambda: service_root(name) / "jobs.db")
    app = FastAPI(title=f"Living Score {name}")

    def _ready(slug: str) -> bool:
        return (city_dir(name, slug) / ready_name).is_file()

    @app.get("/health")
    def health() -> dict:
        return {"ok": True, "service": name}

    @app.get("/cities")
    def cities() -> dict:
        root = service_root(name)
        found = []
        if root.is_dir():
            for child in sorted(root.iterdir()):
                if child.is_dir() and (child / ready_name).is_file():
                    found.append({"slug": child.name, "name": child.name})
        return {"cities": found}

    @app.post("/generate")
    def generate(req: GenerateRequest) -> dict:
        try:
            ctx = open_service_city(name, slug=req.slug or None, query=req.q or None)
        except LookupError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=502, detail=f"geocoding failed: {exc}") from exc

        if _ready(ctx.slug):
            return {"status": "ready", "slug": ctx.slug, "name": ctx.name, "meta": ctx.to_meta()}
        if not book.is_running(ctx.slug):

            def work() -> dict:
                run(ctx)
                return ctx.to_meta()

            book.submit(ctx.slug, work)
        return {"status": "pending", "slug": ctx.slug, "name": ctx.name}

    @app.get("/status/{slug}")
    def status(slug: str) -> dict:
        if _ready(slug):
            return {"status": "ready", "slug": slug}
        job = book.snapshot(slug)
        if job is not None and job.get("status") != "ready":
            return {"slug": slug, **job}
        raise HTTPException(status_code=404, detail="unknown city")

    return app, book


def file_or_404(path: Path):
    from fastapi.responses import FileResponse

    if path.is_file():
        return FileResponse(path)
    raise HTTPException(status_code=404, detail="not generated")
