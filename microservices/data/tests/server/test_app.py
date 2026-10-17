"""HTTP surface of the data API — no Overpass, no full pipeline."""

from __future__ import annotations

import importlib
import json
import os
import sqlite3
import time

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


def _current_meta(slug: str, name: str, **extra: object) -> dict:
    meta = {
        "slug": slug,
        "name": name,
        "pipeline_version": 10_000,
        "noise_db_spread": 5.0,
    }
    meta.update(extra)
    return meta


def _write_product(city_dir, meta: dict, payload: dict | None = None) -> None:
    """Write GeoJSON first, then meta, matching export order."""
    city_dir.mkdir(parents=True, exist_ok=True)
    body = payload or {"type": "FeatureCollection", "features": []}
    geo = city_dir / "hexes.geojson"
    sidecar = city_dir / "meta.json"
    geo.write_text(json.dumps(body), encoding="utf-8")
    sidecar.write_text(json.dumps(meta), encoding="utf-8")
    now = time.time()
    os.utime(geo, (now - 5, now - 5))
    os.utime(sidecar, (now, now))


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
    )
    app_mod.jobs.mark_ready("rosenheim", 17, {"slug": "rosenheim", "name": "Rosenheim"})

    resp = client.get("/api/status/rosenheim")
    assert resp.status_code == 404


def test_generate_returns_ready_when_disk_product_is_current(api, monkeypatch):
    client, app_mod, cities, _ = api
    ctx = _ctx("hamburg", "Hamburg", cities / "hamburg")
    monkeypatch.setattr(app_mod, "resolve_city", lambda _q: ctx)
    submitted = []
    monkeypatch.setattr(app_mod, "_submit_generate", lambda c: submitted.append(c.slug))
    # Empty features would fail the full contract check. Ready must come from
    # the metadata index plus the file, without parsing the GeoJSON body.
    _write_product(cities / "hamburg", _current_meta("hamburg", "Hamburg"))

    resp = client.post("/api/generate", json={"q": "Hamburg"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ready"
    assert body["slug"] == "hamburg"
    assert body["meta"]["name"] == "Hamburg"
    assert submitted == []


def test_generate_db_row_without_file_is_not_ready(api, monkeypatch):
    client, app_mod, cities, db = api
    ctx = _ctx("hamburg", "Hamburg", cities / "hamburg")
    monkeypatch.setattr(app_mod, "resolve_city", lambda _q: ctx)
    submitted = []
    monkeypatch.setattr(app_mod, "_submit_generate", lambda c: submitted.append(c.slug))
    db.upsert_city("hamburg", "Hamburg", _current_meta("hamburg", "Hamburg"))

    resp = client.post("/api/generate", json={"q": "Hamburg"})
    assert resp.status_code == 200
    assert resp.json()["status"] == "pending"
    assert submitted == ["hamburg"]


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


def test_city_geojson_is_the_file_on_disk(api):
    client, _, cities, _ = api
    payload = {"type": "FeatureCollection", "features": [{"type": "Feature", "properties": {"h3": "a"}}]}
    _write_product(cities / "koeln", _current_meta("koeln", "Köln"), payload)
    resp = client.get("/api/city/koeln.geojson")
    assert resp.status_code == 200
    assert resp.json() == payload


def test_city_geojson_db_row_without_file_is_404(api):
    client, _, _, db = api
    db.upsert_city("koeln", "Köln", _current_meta("koeln", "Köln"))
    assert client.get("/api/city/koeln.geojson").status_code == 404


def test_newer_meta_json_refreshes_index(api):
    client, _, cities, db = api
    city = cities / "hamburg"
    _write_product(city, _current_meta("hamburg", "Hamburg", pipeline_version=1))
    db.upsert_city(
        "hamburg",
        "Hamburg",
        _current_meta("hamburg", "Hamburg", pipeline_version=1),
        updated_at="2000-01-01T00:00:00+00:00",
    )
    (city / "meta.json").write_text(
        json.dumps(_current_meta("hamburg", "Hamburg Neu")),
        encoding="utf-8",
    )

    listed = client.get("/api/cities").json()["cities"]
    assert [c["name"] for c in listed] == ["Hamburg Neu"]
    conn = db.connect()
    try:
        cols = {row["name"] for row in conn.execute("PRAGMA table_info(cities)")}
    finally:
        conn.close()
    assert "geojson" not in cols


def test_legacy_export_backfills_meta_json(api):
    client, _, cities, _ = api
    city = cities / "ulm"
    city.mkdir()
    meta = _current_meta("ulm", "Ulm")
    payload = {"type": "FeatureCollection", "meta": meta, "features": []}
    (city / "hexes.geojson").write_text(json.dumps(payload), encoding="utf-8")

    listed = client.get("/api/cities").json()["cities"]
    assert listed[0]["name"] == "Ulm"
    assert json.loads((city / "meta.json").read_text(encoding="utf-8"))["slug"] == "ulm"


def test_generate_skips_ready_when_geojson_is_newer_than_meta(api, monkeypatch):
    client, app_mod, cities, _ = api
    ctx = _ctx("hamburg", "Hamburg", cities / "hamburg")
    monkeypatch.setattr(app_mod, "resolve_city", lambda _q: ctx)
    submitted = []
    monkeypatch.setattr(app_mod, "_submit_generate", lambda c: submitted.append(c.slug))
    city = cities / "hamburg"
    _write_product(city, _current_meta("hamburg", "Hamburg"))
    now = time.time()
    os.utime(city / "meta.json", (now - 30, now - 30))
    os.utime(city / "hexes.geojson", (now, now))

    resp = client.post("/api/generate", json={"q": "Hamburg"})
    assert resp.status_code == 200
    assert resp.json()["status"] == "pending"
    assert submitted == ["hamburg"]


def test_legacy_geojson_column_is_dropped(tmp_path, monkeypatch):
    from pipeline import config

    cities = tmp_path / "cities"
    cities.mkdir()
    monkeypatch.setattr(config, "DATA_DIR", tmp_path)
    monkeypatch.setattr(config, "CITIES_DIR", cities)

    from server import db as db_module

    db = importlib.reload(db_module)
    monkeypatch.setattr(db, "_DB_PATH", tmp_path / "legacy.db")
    db._initialized = False

    conn = sqlite3.connect(tmp_path / "legacy.db")
    conn.execute(
        """
        CREATE TABLE cities (
            slug TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            meta_json TEXT NOT NULL,
            geojson TEXT NOT NULL,
            pipeline_version INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT NOT NULL
        )
        """
    )
    conn.execute(
        "INSERT INTO cities VALUES (?, ?, ?, ?, ?, ?)",
        (
            "ulm",
            "Ulm",
            json.dumps({"slug": "ulm", "name": "FromBlob"}),
            "{\"type\":\"FeatureCollection\",\"features\":[]}",
            1,
            "2020-01-01T00:00:00+00:00",
        ),
    )
    conn.execute("CREATE TABLE jobs (slug TEXT PRIMARY KEY, status TEXT NOT NULL)")
    conn.execute("INSERT INTO jobs VALUES ('ulm', 'pending')")
    conn.commit()
    conn.close()

    _write_product(cities / "ulm", _current_meta("ulm", "Ulm"))
    db.init_db()

    conn = db.connect()
    try:
        cols = {row["name"] for row in conn.execute("PRAGMA table_info(cities)")}
        meta = json.loads(conn.execute("SELECT meta_json FROM cities WHERE slug = 'ulm'").fetchone()["meta_json"])
        job = conn.execute("SELECT status FROM jobs WHERE slug = 'ulm'").fetchone()
    finally:
        conn.close()
    assert "geojson" not in cols
    assert meta["name"] == "Ulm"
    assert job["status"] == "pending"


def test_city_cycleways_from_disk(api):
    client, _, cities, _ = api
    city = cities / "muenchen"
    city.mkdir()
    overlay = {"type": "FeatureCollection", "features": [{"type": "Feature", "geometry": {"type": "LineString", "coordinates": [[11.5, 48.1], [11.51, 48.11]]}, "properties": {"kind": "cycleway"}}]}
    (city / "cycleways.geojson").write_text(json.dumps(overlay), encoding="utf-8")
    resp = client.get("/api/city/muenchen/cycleways.geojson")
    assert resp.status_code == 200
    assert resp.json()["features"][0]["properties"]["kind"] == "cycleway"
