"""Rent service."""

from fastapi import HTTPException
from fastapi.responses import Response

from services.http import build_app
from services.rents.run import run
from services.runtime import city_dir

app, jobs = build_app("rents", run, ready_name="scores.json")


@app.get("/city/{slug}/scores")
def scores(slug: str) -> Response:
    path = city_dir("rents", slug) / "scores.json"
    if not path.is_file():
        raise HTTPException(status_code=404, detail="not generated")
    return Response(content=path.read_text(encoding="utf-8"), media_type="application/json")
