"""Infrastructure service: daily-life hexes."""

from fastapi.responses import FileResponse

from services.http import build_app, file_or_404
from services.infrastructure.run import run
from services.runtime import city_dir

app, jobs = build_app("infrastructure", run, ready_name="hexes.geojson")


@app.get("/city/{slug}.geojson")
def city_geojson(slug: str) -> FileResponse:
    return file_or_404(city_dir("infrastructure", slug) / "hexes.geojson")
