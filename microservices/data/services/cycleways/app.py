"""Cycleways service: line overlay and hex scores."""

from fastapi import HTTPException
from fastapi.responses import FileResponse, Response

from services.cycleways.run import run
from services.http import build_app, file_or_404
from services.runtime import city_dir

app, jobs = build_app("cycleways", run, ready_name="scores.json")


@app.get("/city/{slug}/lines.geojson")
def lines(slug: str) -> FileResponse:
    return file_or_404(city_dir("cycleways", slug) / "lines.geojson")


@app.get("/city/{slug}/scores")
def scores(slug: str) -> Response:
    path = city_dir("cycleways", slug) / "scores.json"
    if not path.is_file():
        raise HTTPException(status_code=404, detail="not generated")
    return Response(content=path.read_text(encoding="utf-8"), media_type="application/json")
