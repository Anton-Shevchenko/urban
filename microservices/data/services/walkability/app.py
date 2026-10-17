"""Walkability service."""

from fastapi import HTTPException
from fastapi.responses import Response

from services.http import build_app
from services.runtime import city_dir
from services.walkability.ingest import run

app, jobs = build_app("walkability", run, ready_name="scores.json")


@app.get("/city/{slug}/scores")
def scores(slug: str) -> Response:
    path = city_dir("walkability", slug) / "scores.json"
    if not path.is_file():
        raise HTTPException(status_code=404, detail="not generated")
    return Response(content=path.read_text(encoding="utf-8"), media_type="application/json")
