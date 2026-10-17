"""Admin-boundary clipping for the H3 grid."""

from __future__ import annotations

import json
from pathlib import Path

import geopandas as gpd
import pandas as pd
from shapely.geometry import Polygon, box

from pipeline import cache_status, config
from pipeline.city import CityContext
from pipeline.export.normalize_export import _clip_grid_to_admin_boundary
from pipeline.ingest import grid as grid_mod


def test_build_grid_keeps_only_centroids_inside_boundary(tmp_path: Path):
    # Tall thin city polygon; bbox fill would add cells to the east/west.
    boundary = Polygon(
        [
            (11.50, 48.10),
            (11.52, 48.10),
            (11.52, 48.16),
            (11.50, 48.16),
            (11.50, 48.10),
        ]
    )
    ctx = CityContext(
        slug="clipstadt",
        name="Clipstadt",
        center=(48.13, 11.51),
        bbox=(48.10, 11.50, 48.16, 11.52),
        base_dir=tmp_path / "clipstadt",
        boundary_geojson=json.loads(json.dumps(boundary.__geo_interface__)),
    )
    ctx.cache_dir.mkdir(parents=True, exist_ok=True)
    (ctx.cache(config.BOUNDARY_FILE)).write_text(
        json.dumps(boundary.__geo_interface__), encoding="utf-8"
    )

    from shapely.geometry import Point

    gdf = grid_mod.build_grid(ctx)
    assert len(gdf) > 0
    for _, row in gdf.iterrows():
        assert boundary.covers(Point(row.lng, row.lat))


def test_cache_status_flags_bbox_spill(tmp_path: Path):
    city = tmp_path / "spill"
    cache = city / "cache"
    cache.mkdir(parents=True)
    boundary = box(11.5, 48.1, 11.52, 48.12)
    (cache / config.BOUNDARY_FILE).write_text(
        json.dumps(boundary.__geo_interface__), encoding="utf-8"
    )
    # One inside, many outside — mimics a bbox-filled grid.
    rows = [{"lat": 48.11, "lng": 11.51}]
    rows += [{"lat": 48.11 + 0.01 * i, "lng": 11.60} for i in range(50)]
    pd.DataFrame(rows).to_parquet(cache / config.GRID_FILE)

    reason = cache_status._grid_outside_boundary(cache)
    assert reason and "outside admin boundary" in reason


def test_export_clip_drops_outside_centroids(tmp_path: Path):
    city = tmp_path / "clip"
    cache = city / "cache"
    cache.mkdir(parents=True)
    boundary = box(11.5, 48.1, 11.55, 48.15)
    (cache / config.BOUNDARY_FILE).write_text(
        json.dumps(boundary.__geo_interface__), encoding="utf-8"
    )
    grid = gpd.GeoDataFrame(
        {
            "h3_index": ["in", "out"],
            "lat": [48.12, 48.12],
            "lng": [11.52, 11.70],
        }
    )
    ctx = CityContext(
        slug="clip",
        name="Clip",
        center=(48.12, 11.52),
        bbox=(48.1, 11.5, 48.15, 11.55),
        base_dir=city,
    )
    clipped = _clip_grid_to_admin_boundary(ctx, grid)
    assert list(clipped["h3_index"]) == ["in"]
