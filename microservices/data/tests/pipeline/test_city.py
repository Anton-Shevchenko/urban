"""CityContext helpers: slugs, cache rebuild, München bundle copy."""

from __future__ import annotations

import json

from pipeline import config
from pipeline.city import CityContext, ctx_from_cache, slugify, sync_munich_bundle
from tests.fixtures import build_fixture_city


def test_slugify_maps_umlauts_and_punctuation():
    assert slugify("München") == "muenchen"
    assert slugify("Frankfurt am Main") == "frankfurt-am-main"
    assert slugify("  ") == "city"


def test_ctx_from_cache_rebuilds_from_meta(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "CITIES_DIR", tmp_path)
    ctx = build_fixture_city(tmp_path, slug="testkirchen")
    ctx.meta_json.write_text(json.dumps(ctx.to_meta()), encoding="utf-8")

    loaded = ctx_from_cache("testkirchen")
    assert loaded is not None
    assert loaded.slug == "testkirchen"
    assert loaded.name == "Testkirchen"
    assert loaded.base_dir == ctx.base_dir


def test_ctx_from_cache_skips_missing_city(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "CITIES_DIR", tmp_path)
    assert ctx_from_cache("nowhere") is None


def test_sync_munich_bundle_copies_only_munich(tmp_path, monkeypatch):
    public = tmp_path / "frontend" / "public" / "data"
    public.mkdir(parents=True)
    monkeypatch.setattr(config, "FRONTEND_PUBLIC_DIR", tmp_path / "frontend" / "public")

    munich = CityContext(
        slug="muenchen",
        name="München",
        center=(48.1, 11.5),
        bbox=(48.0, 11.3, 48.2, 11.7),
        base_dir=tmp_path / "muenchen",
    )
    munich.out_geojson.write_text('{"type":"FeatureCollection","features":[]}', encoding="utf-8")
    sync_munich_bundle(munich)
    assert (public / "hexes.geojson").exists()

    other = CityContext(
        slug="hamburg",
        name="Hamburg",
        center=(53.5, 10.0),
        bbox=(53.4, 9.7, 53.7, 10.3),
        base_dir=tmp_path / "hamburg",
    )
    other.out_geojson.write_text("should-not-copy", encoding="utf-8")
    sync_munich_bundle(other)
    assert (public / "hexes.geojson").read_text(encoding="utf-8") != "should-not-copy"
