"""HTTP surface of the data API — no Overpass, no full pipeline."""

from __future__ import annotations

import importlib
import json

import pytest
from fastapi.testclient import TestClient

from pipeline.city import CityContext


def _ctx(slug: str, name: str, base_dir) -> CityContext:
    return CityContext(
        slug=slug,
        name=name,
        center=(53.55, 9.99),
        bbox=(53.4, 9.7, 53.7, 10.3),
        base_dir=base_dir,
    )


@pytest.fixture
def api(tmp_path, monkeypatch):
    from pipeline import config

    cities = tmp_path / "cities"
    cities.mkdir()
    monkeypatch.setattr(config, "DATA_DIR", tmp_path)
    monkeypatch.setattr(config, "CITIES_DIR", cities)

    from server import db as db_module

    db = importlib.reload(db_module)
    monkeypatch.setattr(db, "_DB_PATH", tmp_path / "test.db")
    db._initialized = False

    from server import jobs as jobs_module

    jobs = importlib.reload(jobs_module)
    jobs._initialized = False
    jobs._futures.clear()

    from server import app as app_module

    app_mod = importlib.reload(app_module)

    with TestClient(app_mod.app) as client:
        yield client, app_mod, cities, db


def test_health(api):
    client, _, _, _ = api
    resp = client.get("/api/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    assert body["jobs_running"] == 0


def test_list_cities_empty(api):
    client, _, _, _ = api
    assert client.get("/api/cities").json() == {"cities": []}


def test_missing_geojson_is_404(api):
    client, _, _, _ = api
    assert client.get("/api/city/nowhere.geojson").status_code == 404
    assert client.get("/api/city/nowhere/stats").status_code == 404
    assert client.get("/api/city/nowhere/hexes.parquet").status_code == 404
    assert client.get("/api/city/nowhere/cycleways.geojson").status_code == 404


def test_unknown_status_is_404(api):
    client, _, _, _ = api
    assert client.get("/api/status/nowhere").status_code == 404


def test_generate_rejects_empty_query(api, monkeypatch):
    client, app_mod, _, _ = api

    def boom(_query: str):
        raise ValueError("empty city query")

    monkeypatch.setattr(app_mod, "resolve_city", boom)
    resp = client.post("/api/generate", json={"q": "  "})
    assert resp.status_code == 400


def test_generate_unknown_city_is_404(api, monkeypatch):
    client, app_mod, _, _ = api

    def boom(_query: str):
        raise LookupError("no result for 'Atlantis'")

    monkeypatch.setattr(app_mod, "resolve_city", boom)
    resp = client.post("/api/generate", json={"q": "Atlantis"})
    assert resp.status_code == 404
    assert "Atlantis" in resp.json()["detail"]


def test_generate_geocoder_failure_is_502(api, monkeypatch):
    client, app_mod, _, _ = api

    def boom(_query: str):
        raise RuntimeError("nominatim timeout")

    monkeypatch.setattr(app_mod, "resolve_city", boom)
    resp = client.post("/api/generate", json={"q": "Hamburg"})
    assert resp.status_code == 502


def test_generate_regenerates_price_map_product(api, monkeypatch):
    client, app_mod, cities, db = api
    ctx = _ctx("rosenheim", "Rosenheim", cities / "rosenheim")
    monkeypatch.setattr(app_mod, "resolve_city", lambda _q: ctx)
    submitted = []
    monkeypatch.setattr(app_mod, "_submit_generate", lambda c: submitted.append(c.slug))

    db.upsert_city(
        "rosenheim",
        "Rosenheim",
        {
            "slug": "rosenheim",
            "name": "Rosenheim",
            "pipeline_version": 10_000,
            "noise_db_spread": 5.0,
            "product": "price-map",
        },
        json.dumps({"type": "FeatureCollection", "features": []}),
    )

    resp = client.post("/api/generate", json={"q": "Rosenheim"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "pending"
    assert body["slug"] == "rosenheim"
    assert submitted == ["rosenheim"]


def test_status_does_not_treat_price_map_as_ready(api):
    client, app_mod, _, db = api
    db.upsert_city(
        "rosenheim",
        "Rosenheim",
        {
            "slug": "rosenheim",
            "name": "Rosenheim",
            "pipeline_version": 10_000,
            "noise_db_spread": 5.0,
            "product": "price-map",
        },
        json.dumps({"type": "FeatureCollection", "features": []}),
    )
    app_mod.jobs.mark_ready("rosenheim", 17, {"slug": "rosenheim", "name": "Rosenheim"})

    resp = client.get("/api/status/rosenheim")
    assert resp.status_code == 404


def test_generate_returns_ready_when_db_is_current(api, monkeypatch):
    client, app_mod, cities, db = api
    ctx = _ctx("hamburg", "Hamburg", cities / "hamburg")
    monkeypatch.setattr(app_mod, "resolve_city", lambda _q: ctx)

    db.upsert_city(
        "hamburg",
        "Hamburg",
        {
            "slug": "hamburg",
            "name": "Hamburg",
            "pipeline_version": 10_000,
            "noise_db_spread": 5.0,
        },
        json.dumps({"type": "FeatureCollection", "features": []}),
    )

    resp = client.post("/api/generate", json={"q": "Hamburg"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ready"
    assert body["slug"] == "hamburg"


def test_generate_queues_when_city_is_missing(api, monkeypatch):
    client, app_mod, cities, _ = api
    ctx = _ctx("hamburg", "Hamburg", cities / "hamburg")
    monkeypatch.setattr(app_mod, "resolve_city", lambda _q: ctx)
    monkeypatch.setattr(app_mod, "_submit_generate", lambda _ctx: None)

    resp = client.post("/api/generate", json={"q": "Hamburg"})
    assert resp.status_code == 200
    assert resp.json() == {"status": "pending", "slug": "hamburg", "name": "Hamburg"}


def test_destinations_unknown_city_is_404(api):
    client, _, _, _ = api
    resp = client.post(
        "/api/destinations/matrix",
        json={"slug": "nowhere", "destinations": [{"lat": 53.5, "lng": 10.0}]},
    )
    assert resp.status_code == 404


def test_city_geojson_from_db(api):
    client, _, _, db = api
    payload = {"type": "FeatureCollection", "features": []}
    db.upsert_city(
        "koeln",
        "Köln",
        {"slug": "koeln", "name": "Köln", "pipeline_version": 10_000, "noise_db_spread": 4.0},
        json.dumps(payload),
    )
    resp = client.get("/api/city/koeln.geojson")
    assert resp.status_code == 200
    assert resp.json() == payload


def _schema2(city, *, schema: int = 2, kind: str = "eigenstaendig", side: str = "") -> None:
    city.mkdir(parents=True, exist_ok=True)
    overlay = {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "geometry": {"type": "LineString", "coordinates": [[11.5, 48.1], [11.51, 48.11]]},
                "properties": {"kind": kind, "side": side, "label": "Eigenständiger Radweg"},
            }
        ],
    }
    (city / "cycleways.geojson").write_text(json.dumps(overlay), encoding="utf-8")
    (city / "cycleways.meta.json").write_text(
        json.dumps(
            {
                "schema": schema,
                "fetched_at": "2026-01-01T00:00:00+00:00",
                "counts": {kind: 1},
                "name": "München",
                "bbox": [48.0, 11.3, 48.3, 11.8],
                "center": [48.14, 11.57],
            }
        ),
        encoding="utf-8",
    )


def test_city_cycleways_requires_schema_2(api):
    client, _, cities, _ = api
    city = cities / "muenchen"
    _schema2(city)
    resp = client.get("/api/city/muenchen/cycleways.geojson")
    assert resp.status_code == 200
    props = resp.json()["features"][0]["properties"]
    assert props["kind"] == "eigenstaendig"
    assert props["side"] == ""


def test_stale_cycleways_are_not_served_and_refresh_is_queued(api, monkeypatch):
    client, app_mod, cities, _ = api
    city = cities / "muenchen"
    _schema2(city, schema=1)
    (city / "meta.json").write_text(
        json.dumps(
            {
                "slug": "muenchen",
                "name": "München",
                "bbox": [48.0, 11.3, 48.3, 11.8],
                "center": [48.14, 11.57],
            }
        ),
        encoding="utf-8",
    )
    submitted = []
    monkeypatch.setattr(app_mod, "_submit_cycleways", lambda ctx: submitted.append(ctx.slug))
    monkeypatch.setattr(app_mod, "_submit_generate", lambda ctx: submitted.append(f"generate:{ctx.slug}"))

    resp = client.get("/api/city/muenchen/cycleways.geojson")
    assert resp.status_code == 404
    assert submitted == ["muenchen"]


def test_post_cycleways_does_not_generate_city(api, monkeypatch):
    client, app_mod, cities, _ = api
    ctx = _ctx("landshut", "Landshut", cities / "landshut")
    monkeypatch.setattr(app_mod, "resolve_city", lambda _q: ctx)
    submitted = []
    monkeypatch.setattr(app_mod, "_submit_cycleways", lambda c: submitted.append(("cycle", c.slug)))
    monkeypatch.setattr(app_mod, "_submit_generate", lambda c: submitted.append(("generate", c.slug)))

    resp = client.post("/api/cycleways", json={"q": "Landshut"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "pending"
    assert body["cached"] is False
    assert body["slug"] == "landshut"
    assert body["bbox"] == [53.4, 9.7, 53.7, 10.3]
    assert submitted == [("cycle", "landshut")]


def test_post_cycleways_ready_skips_overpass_job(api, monkeypatch):
    client, app_mod, cities, _ = api
    ctx = _ctx("freising", "Freising", cities / "freising")
    _schema2(cities / "freising")
    monkeypatch.setattr(app_mod, "resolve_city", lambda _q: ctx)
    submitted = []
    monkeypatch.setattr(app_mod, "_submit_cycleways", lambda c: submitted.append(c.slug))
    monkeypatch.setattr(app_mod, "_submit_generate", lambda c: submitted.append(f"generate:{c.slug}"))

    resp = client.post("/api/cycleways", json={"q": "Freising"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ready"
    assert body["cached"] is True
    assert body["message"] == "Radwege aus dem Cache"
    assert submitted == []


def test_suggest_endpoint(api, monkeypatch):
    client, app_mod, _, _ = api
    monkeypatch.setattr(
        app_mod,
        "photon_suggestions",
        lambda q, limit=8: [{"name": "Köln", "state": "Nordrhein-Westfalen", "type": "city", "label": "Köln, Nordrhein-Westfalen"}]
        if q == "Köl"
        else [],
    )
    resp = client.get("/api/suggest", params={"q": "Köl"})
    assert resp.status_code == 200
    rows = resp.json()["suggestions"]
    assert rows[0]["name"] == "Köln"
    assert rows[0]["state"] == "Nordrhein-Westfalen"
    assert client.get("/api/suggest", params={"q": "x"}).json() == {"suggestions": []}
