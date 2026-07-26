"""Default source / confidence metadata for exported metrics."""
from __future__ import annotations

METRIC_META = {
    "living": {"source": "composite", "confidence": 0.7, "year": 2026, "note": "15-Minute Living Score"},
    "daily_life": {"source": "osm", "confidence": 0.75, "year": 2026},
    "walking_quality": {"source": "osm_roads+green+noise", "confidence": 0.55, "year": 2026},
    "transit": {"source": "gtfs_or_osm", "confidence": 0.6, "year": 2026},
    "urban_form": {"source": "zensus_osm_landuse", "confidence": 0.55, "year": 2026},
    "center": {"source": "ors_or_osm", "confidence": 0.65, "year": 2026},
    "daily_needs": {"source": "osm", "confidence": 0.75, "year": 2026},
    "transit_service": {"source": "gtfs_or_osm", "confidence": 0.6, "year": 2026},
    "green": {"source": "osm", "confidence": 0.7, "year": 2026},
    "noise": {"source": "osm_proxy", "confidence": 0.5, "year": 2026},
    "heat": {"source": "osm_proxy", "confidence": 0.35, "year": 2026, "note": "satellite preferred when available", "enabled": False},
    "traffic_safety": {"source": "osm_roads+accidents", "confidence": 0.4, "year": 2026, "metric": "accident_density", "note": "Straßenrisiko — keine Kriminalitätsdaten"},
    "housing": {"source": "zensus_or_osm", "confidence": 0.45, "year": 2022},
    "rent": {"source": "mixed", "confidence": 0.5, "year": 2026},
}
