"""Shared grid, Overpass file lock, and map-view service boundaries."""

from __future__ import annotations

import json
from pathlib import Path

import geopandas as gpd
import pandas as pd
from shapely.geometry import box

from pipeline import config
from pipeline.city import CityContext
from pipeline.grid_store import bind_grid, ensure_shared_grid, grid_parquet_path
from pipeline.providers import Provider
from services.infrastructure.run import export_hexes


def _ctx(tmp_path: Path, slug: str = "probe") -> CityContext:
    boundary = box(11.50, 48.10, 11.55, 48.14).__geo_interface__
    return CityContext(
        slug=slug,
        name="Probe",
        center=(48.12, 11.525),
        bbox=(48.10, 11.50, 48.14, 11.55),
        boundary_geojson=boundary,
        base_dir=tmp_path / "services" / "infrastructure" / slug,
    )


def test_shared_grid_is_stable_across_service_dirs(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "SHARED_DIR", tmp_path)
    monkeypatch.setattr(config, "DATA_DIR", tmp_path)
    first = _ctx(tmp_path, "probe")
    second = _ctx(tmp_path / "other", "probe")
    second.base_dir = tmp_path / "services" / "cycleways" / "probe"
    ensure_shared_grid(first)
    bind_grid(first)
    bind_grid(second)
    left = set(gpd.read_parquet(grid_parquet_path("probe"))["h3_index"])
    right = set(gpd.read_parquet(second.cache(config.GRID_FILE))["h3_index"])
    assert left
    assert left == right


def test_infrastructure_export_paints_daily_life(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "SHARED_DIR", tmp_path)
    monkeypatch.setattr(config, "DATA_DIR", tmp_path)
    ctx = _ctx(tmp_path)
    ensure_shared_grid(ctx)
    bind_grid(ctx)
    grid = gpd.read_parquet(ctx.cache(config.GRID_FILE))
    pd.DataFrame(
        {
            "h3_index": grid["h3_index"],
            "s_daily_life": 80.0,
            "dn_supermarket_min": 4.0,
        }
    ).to_parquet(ctx.cache(config.DAILY_NEEDS_FILE))
    export_hexes(ctx)
    doc = json.loads((ctx.base_dir / "hexes.geojson").read_text(encoding="utf-8"))
    props = doc["features"][0]["properties"]
    assert props["s_daily_life"] == 80.0
    assert props["s_living"] == 80.0
    assert props["dn_supermarket_min"] == 4.0
    assert {f["properties"]["h3"] for f in doc["features"]} == set(grid["h3_index"])


def test_overpass_lock_records_a_shared_timestamp(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "SHARED_DIR", tmp_path)

    class _Resp:
        status_code = 200
        text = "{}"

        def json(self):
            return {}

        def raise_for_status(self):
            return None

    monkeypatch.setattr("pipeline.providers.requests.request", lambda *a, **k: _Resp())
    provider = Provider(name="overpass", min_interval_s=0.0, shared_lock=True, attempts=1)
    provider.min_interval_s = 0.01
    provider.get("https://example.test")
    stamp = float((tmp_path / "overpass.lock").read_text(encoding="utf-8"))
    assert stamp > 0


def test_view_services_do_not_read_each_others_files():
    root = Path(__file__).resolve().parents[2] / "services"
    forbidden = ("services/infrastructure", "services/rents", "factor_daily_needs", "services/cycleways")
    for name in ("walkability", "cycleways"):
        for path in (root / name).rglob("*.py"):
            text = path.read_text(encoding="utf-8")
            for token in forbidden:
                if name in token:
                    continue
                assert token not in text, f"{path.name} mentions {token}"


def test_walkability_module_fetches_its_own_layers():
    text = (Path(__file__).resolve().parents[2] / "services" / "walkability" / "ingest.py").read_text(
        encoding="utf-8"
    )
    for token in ("load_roads", "load_stations", "fetch_landuse", "load_green", "osm_housing_proxy"):
        assert token in text
