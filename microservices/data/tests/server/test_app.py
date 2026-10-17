"""Public router: geocode once, then fan out to the four map-view services."""

from __future__ import annotations

import importlib

import pytest
from fastapi.testclient import TestClient

from pipeline.city import CityContext


def _ctx() -> CityContext:
    return CityContext(
        slug="hamburg",
        name="Hamburg",
        center=(53.55, 9.99),
        bbox=(53.4, 9.7, 53.7, 10.3),
    )


class _Upstream:
    def __init__(self, status: int = 200, body: bytes = b"{}", content_type: str = "application/json") -> None:
        self.status_code = status
        self.content = body
        self.headers = {"content-type": content_type}
        self.text = body.decode()
        self.reason = "error" if status >= 400 else "OK"

    def json(self) -> dict:
        import json

        return json.loads(self.content)


@pytest.fixture
def api():
    from server import app as app_module

    app_mod = importlib.reload(app_module)
    with TestClient(app_mod.app) as client:
        yield client, app_mod


def test_health(api):
    client, app_mod = api

    def down(*_args, **_kwargs):
        from fastapi import HTTPException

        raise HTTPException(status_code=502, detail="down")

    app_mod.request_upstream = down
    resp = client.get("/api/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    assert body["jobs_running"] == 0
    assert body["services"]["infrastructure"] is False


def test_generate_rejects_empty_query(api, monkeypatch):
    client, app_mod = api

    def boom(_query: str):
        raise ValueError("empty city query")

    monkeypatch.setattr(app_mod, "resolve_city", boom)
    monkeypatch.setattr(app_mod, "find_cached_city", lambda _q: None)
    resp = client.post("/api/generate", json={"q": "  "})
    assert resp.status_code == 400


def test_generate_unknown_city_is_404(api, monkeypatch):
    client, app_mod = api

    def boom(_query: str):
        raise LookupError("no result for 'Atlantis'")

    monkeypatch.setattr(app_mod, "resolve_city", boom)
    monkeypatch.setattr(app_mod, "find_cached_city", lambda _q: None)
    resp = client.post("/api/generate", json={"q": "Atlantis"})
    assert resp.status_code == 404
    assert "Atlantis" in resp.json()["detail"]


def test_generate_geocoder_failure_is_502(api, monkeypatch):
    client, app_mod = api

    def boom(_query: str):
        raise RuntimeError("nominatim timeout")

    monkeypatch.setattr(app_mod, "resolve_city", boom)
    monkeypatch.setattr(app_mod, "find_cached_city", lambda _q: None)
    resp = client.post("/api/generate", json={"q": "Hamburg"})
    assert resp.status_code == 502


def test_generate_fans_out_and_returns_infrastructure(api, monkeypatch):
    client, app_mod = api
    ctx = _ctx()
    monkeypatch.setattr(app_mod, "open_city", lambda _q: ctx)
    seen: list[str] = []

    def fanout(city):
        seen.append(city.slug)
        return {"status": "pending", "slug": city.slug, "name": city.name}

    monkeypatch.setattr(app_mod, "fanout", fanout)
    resp = client.post("/api/generate", json={"q": "Hamburg"})
    assert resp.status_code == 200
    assert resp.json() == {"status": "pending", "slug": "hamburg", "name": "Hamburg"}
    assert seen == ["hamburg"]


def test_geojson_proxies_infrastructure(api, monkeypatch):
    client, app_mod = api
    calls: list[tuple[str, str]] = []

    def upstream(method, service, path, payload=None, timeout=60):
        calls.append((service, path))
        return _Upstream(body=b'{"type":"FeatureCollection","features":[]}', content_type="application/geo+json")

    monkeypatch.setattr(app_mod, "request_upstream", upstream)
    resp = client.get("/api/city/hamburg.geojson")
    assert resp.status_code == 200
    assert resp.json()["type"] == "FeatureCollection"
    assert calls == [("infrastructure", "/city/hamburg.geojson")]


def test_missing_geojson_is_404(api, monkeypatch):
    client, app_mod = api
    monkeypatch.setattr(app_mod, "request_upstream", lambda *a, **k: _Upstream(status=404, body=b"missing"))
    assert client.get("/api/city/nowhere.geojson").status_code == 404
    assert client.get("/api/city/nowhere/cycleways.geojson").status_code == 404
    assert client.get("/api/status/nowhere").status_code == 404


def test_cycleways_proxy_reads_lines(api, monkeypatch):
    client, app_mod = api
    calls: list[tuple[str, str]] = []

    def upstream(method, service, path, payload=None, timeout=60):
        calls.append((service, path))
        return _Upstream(
            body=b'{"type":"FeatureCollection","features":[{"type":"Feature","properties":{"kind":"cycleway"},"geometry":null}]}'
        )

    monkeypatch.setattr(app_mod, "request_upstream", upstream)
    resp = client.get("/api/city/muenchen/cycleways.geojson")
    assert resp.status_code == 200
    assert resp.json()["features"][0]["properties"]["kind"] == "cycleway"
    assert calls == [("cycleways", "/city/muenchen/lines.geojson")]


def test_view_scores_proxy(api, monkeypatch):
    client, app_mod = api
    calls: list[str] = []

    def upstream(method, service, path, payload=None, timeout=60):
        calls.append(f"{service} {path}")
        return _Upstream(body=b'{"scores":{"abc":{"s_walkability":81}}}')

    monkeypatch.setattr(app_mod, "request_upstream", upstream)
    resp = client.get("/api/city/hamburg/views/walkability/scores")
    assert resp.status_code == 200
    assert resp.json()["scores"]["abc"]["s_walkability"] == 81
    assert calls == ["walkability /city/hamburg/scores"]
    assert client.get("/api/city/hamburg/views/nope/scores").status_code == 404


def test_destinations_unknown_city_is_404(api):
    client, _ = api
    resp = client.post(
        "/api/destinations/matrix",
        json={"slug": "nowhere", "destinations": [{"lat": 53.5, "lng": 10.0}]},
    )
    assert resp.status_code == 404
