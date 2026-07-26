#!/usr/bin/env python3
"""Enrich bundled hexes.geojson with living-score pillars + Match attributes.

Uses the same fallbacks as the frontend when walking_quality / urban_form
pipeline factors are not yet present. Bumps pipeline_version meta to 12.
"""
from __future__ import annotations

import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PATHS = [
    ROOT / "frontend" / "public" / "data" / "hexes.geojson",
    ROOT / "data" / "cities" / "muenchen" / "hexes.geojson",
]


def clamp(v: float) -> float:
    return max(0.0, min(100.0, float(v)))


def derive_walking(p: dict) -> float:
    safety = float(p.get("s_traffic_safety", 55) or 55)
    green = float(p.get("s_green", 50) or 50)
    quiet = float(p.get("s_noise", 50) or 50)
    # Approximate Match WQ blend when pipeline factor missing.
    return clamp(0.40 * safety + 0.30 * green + 0.20 * quiet + 0.10 * float(p.get("s_daily_life", 50) or 50))


def derive_form(p: dict) -> float:
    """Rebuild urban form when Zensus density is missing/zero."""
    pop = float(p.get("population_density") or 0)
    dens_raw = p.get("s_density")
    dens = float(dens_raw) if dens_raw is not None else None
    act = float(p.get("s_urban_activity", 50) or 50)
    center = float(p.get("s_center", 50) or 50)
    green = float(p.get("s_green", 50) or 50)
    uf_dens = float(p.get("uf_density") or 0)
    broken = pop <= 0 or uf_dens < 15 or dens == 50.0
    if broken:
        dens_score = clamp(0.55 * act + 0.45 * center)
    elif pop > 0:
        dens_score = clamp(100.0 * math.log1p(pop) / math.log1p(8000))
    else:
        dens_score = dens if dens is not None else 55.0
    return clamp(0.45 * dens_score + 0.35 * act + 0.20 * green)


def _group_score(p: dict, keys: list[str]) -> float | None:
    vals = []
    for k in keys:
        v = p.get(k)
        if v is not None:
            try:
                vals.append(float(v))
            except (TypeError, ValueError):
                pass
    if not vals:
        return None
    return max(vals)


def derive_match_infrastructure(p: dict) -> float:
    """Rebuild Match infrastructure from dl_* groups when present."""
    groups = {
        "food": 0.25,
        "health": 0.15,
        "education": 0.20,
        "services": 0.15,
        "lifestyle": 0.15,
        "shopping": 0.10,
    }
    # Prefer precomputed group scores; fall back to amenity avails.
    amenity_map = {
        "food": ["dl_food", "dn_bakery_avail"],
        "health": ["dl_health", "dn_pharmacy_avail", "dn_doctor_avail"],
        "education": ["dl_education", "dn_kita_avail", "dn_school_avail"],
        "services": ["dl_services", "dn_bank_avail", "dn_post_avail"],
        "lifestyle": ["dl_lifestyle", "dn_restaurant_avail", "dn_cafe_avail"],
        "shopping": ["dl_shopping", "dn_supermarket_avail", "dn_market_avail"],
    }
    total_w = 0.0
    acc = 0.0
    for g, w in groups.items():
        score = _group_score(p, amenity_map[g])
        if score is None:
            continue
        total_w += w
        acc += w * score
    if total_w <= 0:
        return clamp(float(p.get("s_daily_life") or p.get("s_daily_needs") or 50))
    return clamp(acc / total_w)


def enrich(path: Path) -> None:
    data = json.loads(path.read_text(encoding="utf-8"))
    for f in data.get("features") or []:
        p = f.setdefault("properties", {})
        daily = p.get("s_daily_life")
        if daily is None:
            daily = p.get("s_daily_needs", 50)
        daily = clamp(daily)
        transit = p.get("s_transit")
        if transit is None:
            transit = p.get("s_transit_service", 50)
        transit = clamp(transit)
        walking = p.get("s_walking_quality")
        if walking is None:
            walking = derive_walking(p)
        walking = clamp(walking)
        # Always rebuild form when density inputs are broken (common in bundled data).
        form = derive_form(p)
        living = clamp(0.40 * daily + 0.25 * walking + 0.20 * transit + 0.15 * form)
        p["s_daily_life"] = round(daily, 1)
        p["s_walking_quality"] = round(walking, 1)
        p["s_transit"] = round(transit, 1)
        p["s_urban_form"] = round(form, 1)
        p["s_living"] = round(living, 1)

        center = clamp(float(p.get("s_center", 50) or 50))
        green = clamp(float(p.get("s_green", 50) or 50))
        quiet = clamp(float(p.get("s_noise", 50) or 50))
        price = p.get("s_rent_relative_city")
        if price is None:
            price = p.get("s_rent_absolute", 50)
        price = clamp(float(price or 50))
        infra = p.get("s_match_infrastructure")
        if infra is None:
            infra = derive_match_infrastructure(p)
        else:
            infra = clamp(float(infra))

        p["s_match_centrality"] = round(center, 1)
        p["s_match_infrastructure"] = round(infra, 1)
        p["s_match_walk"] = round(walking, 1)
        p["s_match_green"] = round(green, 1)
        p["s_match_transit"] = round(transit, 1)
        p["s_match_quiet"] = round(quiet, 1)
        p["s_match_price"] = round(price, 1)

    meta = data.setdefault("meta", {})
    meta["pipeline_version"] = 12
    meta["product"] = "15-minute-living-score"
    meta["living_score_weights"] = {
        "daily_life": 0.40,
        "walking_quality": 0.25,
        "transit": 0.20,
        "urban_form": 0.15,
    }
    meta["match_infrastructure_group_weights"] = {
        "food": 0.25,
        "health": 0.15,
        "education": 0.20,
        "services": 0.15,
        "lifestyle": 0.15,
        "shopping": 0.10,
    }
    path.write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")
    print(f"enriched {path} ({len(data.get('features') or [])} features)")


def main() -> None:
    for p in PATHS:
        if p.exists():
            enrich(p)
        else:
            print(f"skip missing {p}")


if __name__ == "__main__":
    main()
