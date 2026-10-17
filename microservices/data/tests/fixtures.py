"""A tiny synthetic city: enough factor caches to run normalize + export.

Real generation needs Overpass, so tests build the factor parquets directly.
The frames carry the same columns the factor steps write, which is what makes
the export round-trip meaningful: a renamed or dropped column shows up as a
contract violation instead of as a runtime error in Go or the browser.
"""

from __future__ import annotations

import json
from pathlib import Path

import geopandas as gpd
import pandas as pd
from shapely.geometry import LineString, Polygon

from pipeline import config
from pipeline.city import CityContext

HEX_COUNT = 24
CENTER_LAT, CENTER_LNG = 47.85, 12.13


def _cells() -> list[dict]:
    """A regular lattice of small square cells standing in for H3 hexes."""
    cells = []
    for i in range(HEX_COUNT):
        row, col = divmod(i, 6)
        lat = CENTER_LAT + row * 0.004
        lng = CENTER_LNG + col * 0.006
        size = 0.0018
        cells.append(
            {
                "h3_index": f"89{i:013x}",
                "lat": lat,
                "lng": lng,
                "geometry": Polygon(
                    [
                        (lng - size, lat - size),
                        (lng + size, lat - size),
                        (lng + size, lat + size),
                        (lng - size, lat + size),
                    ]
                ),
            }
        )
    return cells


def build_fixture_city(tmp_path: Path, slug: str = "testkirchen") -> CityContext:
    """Write every cache file `normalize_export` and `cache_status` expect."""
    ctx = CityContext(
        slug=slug,
        name="Testkirchen",
        center=(CENTER_LAT, CENTER_LNG),
        bbox=(CENTER_LAT - 0.05, CENTER_LNG - 0.05, CENTER_LAT + 0.05, CENTER_LNG + 0.05),
        base_dir=tmp_path / slug,
        has_rent=True,
        rent_estimated=True,
        rent_source="Schätzung (Test)",
    )
    cells = _cells()
    h3 = [c["h3_index"] for c in cells]
    cache = ctx.cache_dir
    last = len(h3) - 1

    def ramp(low: float, high: float) -> list[float]:
        """Linear gradient so percentile-based scales see real variation."""
        return [low + (high - low) * i / last for i in range(len(h3))]

    gpd.GeoDataFrame(cells, crs=config.WGS84).to_parquet(cache / config.GRID_FILE)

    counts = [int(v) for v in ramp(1, 180)]
    pd.DataFrame({"h3_index": h3, "business_count": counts, "urban_activity": counts}).to_parquet(
        cache / config.BUSINESS_FILE
    )

    park_dist = ramp(60, 1800)
    pd.DataFrame(
        {
            "h3_index": h3,
            "green_dist_m": park_dist,
            "nearest_park_dist_m": park_dist,
            "dist_water_m": ramp(200, 2500),
            "green_access": ramp(90, 10),
            "green_area_m2": ramp(400, 90000),
            "nearest_park_area_ha": ramp(0.2, 12.0),
            "green_quality": ramp(30, 95),
            "green_share_inside_500m": ramp(2, 60),
            "tree_canopy_pct": ramp(4, 45),
        }
    ).to_parquet(cache / config.GREEN_FILE)

    pd.DataFrame(
        {
            "h3_index": h3,
            "noise_db": ramp(42, 71),
            "noise_source": ["osm_proxy"] * len(h3),
            "noise_confidence": [0.5] * len(h3),
        }
    ).to_parquet(cache / config.NOISE_FILE)

    center_min = ramp(2, 34)
    pd.DataFrame(
        {
            "h3_index": h3,
            "center_min": center_min,
            "center_min_best": center_min,
            "center_min_main": center_min,
        }
    ).to_parquet(cache / config.CENTER_FILE)

    pd.DataFrame({"h3_index": h3, "transport_score": ramp(0.05, 3.4)}).to_parquet(
        cache / config.TRANSPORT_FILE
    )

    pd.DataFrame(
        {
            "h3_index": h3,
            "daily_needs_score": ramp(15, 96),
            "daily_life_raw": ramp(18, 94),
            "dn_coverage": ramp(0.2, 1.0),
            "dn_supermarket_min": ramp(3, 26),
            "dn_bakery_min": ramp(3, 24),
            "dn_pharmacy_min": ramp(4, 28),
            "dn_doctor_min": ramp(5, 30),
            "dn_kita_min": ramp(4, 27),
            "dn_school_min": ramp(5, 29),
            "dn_playground_min": ramp(2, 22),
            "dn_supermarket_avail": ramp(100, 10),
            "dn_bakery_avail": ramp(100, 10),
            "dn_pharmacy_avail": ramp(100, 5),
            "dn_doctor_avail": ramp(100, 5),
            "dn_kita_avail": ramp(100, 8),
        }
    ).to_parquet(cache / config.DAILY_NEEDS_FILE)

    pd.DataFrame(
        {
            "h3_index": h3,
            "transit_service_score": ramp(12, 92),
            "transit_service_raw": ramp(12, 92),
            "station_proximity_score": ramp(10, 95),
        }
    ).to_parquet(cache / config.TRANSIT_SERVICE_FILE)

    pd.DataFrame(
        {
            "h3_index": h3,
            "heat_resilience_score": ramp(22, 88),
            "heat_source": ["osm_proxy"] * len(h3),
            "heat_confidence": [0.5] * len(h3),
        }
    ).to_parquet(cache / config.HEAT_FILE)

    pd.DataFrame(
        {
            "h3_index": h3,
            "traffic_safety_score": ramp(25, 90),
            "road_risk_index": ramp(0.1, 0.9),
            "speed_risk_index": ramp(0.1, 0.8),
            "ped_infra_index": ramp(0.2, 0.9),
            "road_length_m": ramp(200, 4200),
            "accident_density": ramp(0.0, 2.0),
            "safety_source": ["osm_proxy"] * len(h3),
            "safety_confidence": [0.5] * len(h3),
        }
    ).to_parquet(cache / config.TRAFFIC_SAFETY_FILE)

    pd.DataFrame(
        {
            "h3_index": h3,
            "housing_quality_score": ramp(35, 85),
            "building_age_median": ramp(1935, 2010),
            "population_density": ramp(400, 9000),
            "population": ramp(120, 2600),
        }
    ).to_parquet(cache / config.HOUSING_FILE)

    pd.DataFrame(
        {
            "h3_index": h3,
            "walking_quality_raw": ramp(28, 91),
            "intersection_density": ramp(20, 140),
            "mean_block_length_m": ramp(60, 320),
        }
    ).to_parquet(cache / config.WALKING_QUALITY_FILE)

    pd.DataFrame(
        {
            "h3_index": h3,
            "urban_form_score": ramp(30, 88),
            "uf_density": ramp(25, 90),
            "uf_activity": ramp(20, 92),
        }
    ).to_parquet(cache / config.URBAN_FORM_FILE)

    pd.DataFrame(
        {
            "h3_index": h3,
            "cycleway_length_m": ramp(0, 420),
            "cycleway_km_per_km2": ramp(0.0, 4.2),
            "nearest_cycleway_m": ramp(20, 1400),
            "s_cycleways": ramp(8, 92),
        }
    ).to_parquet(cache / config.CYCLEWAYS_FILE)

    gpd.GeoDataFrame(
        {
            "geometry": [
                LineString(
                    [
                        (CENTER_LNG - 0.01, CENTER_LAT),
                        (CENTER_LNG + 0.01, CENTER_LAT + 0.008),
                    ]
                )
            ],
            "highway": ["cycleway"],
            "kind": ["cycleway"],
            "foot": [""],
            "segregated": [""],
            "cycleway": [""],
        },
        crs=config.WGS84,
    ).to_parquet(cache / config.OSM_CYCLEWAYS_FILE)

    pd.DataFrame(
        {
            "h3_index": h3,
            "rent_eur_m2": ramp(9.5, 19.5),
            "rent_source": ["Schätzung (Test)"] * len(h3),
            "rent_confidence": ["low"] * len(h3),
            "rent_year": [2025] * len(h3),
        }
    ).to_parquet(cache / config.RENTS_FILE)

    centers = {
        "main": [CENTER_LAT + 0.008, CENTER_LNG + 0.012],
        "centers": [
            {
                "lat": CENTER_LAT + 0.008,
                "lng": CENTER_LNG + 0.012,
                "strength": 1.0,
                "primary": True,
            }
        ],
    }
    (cache / config.CENTERS_FILE).write_text(json.dumps(centers), encoding="utf-8")

    # cache_status rejects empty road parquets, so write non-empty stand-ins.
    for name in (config.OSM_ROADS_FILE, "osm_roads_safety.parquet"):
        pd.DataFrame({"cls": ["residential"] * 3}).to_parquet(cache / name)

    return ctx
