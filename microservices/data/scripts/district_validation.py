#!/usr/bin/env python3
"""District-level sanity check + preset top/bottom hexes for Munich.

Usage:
  python microservices/data/scripts/district_validation.py microservices/data/data/cities/muenchen/hexes.geojson --top 10
  python microservices/data/scripts/district_validation.py frontend/public/data/hexes.geojson
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path


def haversine_m(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    r = 6_371_000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


WEIGHT_STEPS = [0, 1, 2, 4, 8]
OBJECTIVE_MAX_SHARE = 0.7
PREF_MAX_SHARE = 0.3
SCORE_FLOOR = 0.1
PREF_PENALTY = 1.2

IMPORTANCE_KEYS = [
    "center",
    "daily_needs",
    "transit_service",
    "green",
    "noise",
    "heat",
    "traffic_safety",
    "price",
]
PREF_KEYS = ["urban_activity", "density", "housing"]

SCORE_PROPS = {
    "center": "s_center",
    "daily_needs": "s_daily_needs",
    "transit_service": "s_transit_service",
    "green": "s_green",
    "noise": "s_noise",
    "heat": "s_heat",
    "traffic_safety": "s_traffic_safety",
    "price": "s_rent_absolute",
    "urban_activity": "s_urban_activity",
    "density": "s_density",
    "housing": "s_housing",
}

PRESETS = {
    "business": {
        "label": "Business",
        "center": 2,
        "daily_needs": 2,
        "transit_service": 3,
        "green": 1,
        "noise": 1,
        "heat": 0,
        "traffic_safety": 1,
        "price": 1,
        "urban_activity": 85,
        "density": 70,
        "housing": 50,
    },
    "family": {
        "label": "Familie",
        "center": 2,
        "daily_needs": 4,
        "transit_service": 2,
        "green": 3,
        "noise": 3,
        "heat": 0,
        "traffic_safety": 1,
        "price": 3,
        "urban_activity": 40,
        "density": 45,
        "housing": 25,
    },
    "quiet": {
        "label": "Ruhe",
        "center": 1,
        "daily_needs": 1,
        "transit_service": 2,
        "green": 3,
        "noise": 4,
        "heat": 0,
        "traffic_safety": 1,
        "price": 2,
        "urban_activity": 20,
        "density": 35,
        "housing": 40,
    },
    "budget": {
        "label": "Günstig",
        "center": 2,
        "daily_needs": 2,
        "transit_service": 2,
        "green": 2,
        "noise": 2,
        "heat": 0,
        "traffic_safety": 1,
        "price": 4,
        "urban_activity": 50,
        "density": 40,
        "housing": 60,
    },
}

# Named neighbourhoods (lat/lng centroids). Hexes assigned to nearest within MAX_DIST_M.
MAX_DIST_M = 2800
DISTRICTS: dict[str, dict] = {
    "Altstadt": {"lat": 48.1374, "lng": 11.5755, "bezirk": "Altstadt-Lehel"},
    "Maxvorstadt": {"lat": 48.1500, "lng": 11.5650, "bezirk": "Maxvorstadt"},
    "Schwabing": {"lat": 48.1620, "lng": 11.5780, "bezirk": "Schwabing-West"},
    "Haidhausen": {"lat": 48.1280, "lng": 11.5950, "bezirk": "Au-Haidhausen"},
    "Bogenhausen": {"lat": 48.1520, "lng": 11.6200, "bezirk": "Bogenhausen"},
    "Pasing": {"lat": 48.1450, "lng": 11.4550, "bezirk": "Pasing-Obermenzing"},
    "Sendling": {"lat": 48.1180, "lng": 11.5450, "bezirk": "Sendling"},
    "Moosach": {"lat": 48.1820, "lng": 11.5080, "bezirk": "Moosach"},
    "Riem": {"lat": 48.1280, "lng": 11.6950, "bezirk": "Trudering-Riem"},
    "Feldmoching": {"lat": 48.2180, "lng": 11.5350, "bezirk": "Feldmoching-Hasenbergl"},
    "Aubing": {"lat": 48.1580, "lng": 11.4080, "bezirk": "Aubing-Lochhausen-Langwied"},
    "Laim": {"lat": 48.1430, "lng": 11.4980, "bezirk": "Laim"},
    "Neuhausen": {"lat": 48.1550, "lng": 11.5350, "bezirk": "Neuhausen-Nymphenburg"},
    "Solln": {"lat": 48.0780, "lng": 11.5200, "bezirk": "Thalkirchen-Solln"},
    "Obermenzing": {"lat": 48.1680, "lng": 11.4680, "bezirk": "Pasing-Obermenzing"},
    "Grünwald": {"lat": 48.0540, "lng": 11.5240, "bezirk": "(suburb)"},
    "Milbertshofen": {"lat": 48.1950, "lng": 11.5650, "bezirk": "Milbertshofen-Am Hart"},
    "Ramersdorf": {"lat": 48.1080, "lng": 11.6150, "bezirk": "Ramersdorf-Perlach"},
    "Berg am Laim": {"lat": 48.1180, "lng": 11.6400, "bezirk": "Berg am Laim"},
}

# Qualitative expectations: districts that should rank in top/bottom tiers per preset.
EXPECTATIONS = {
    "business": {
        "top": ["Maxvorstadt", "Altstadt", "Schwabing", "Haidhausen"],
        "bottom": ["Feldmoching", "Aubing", "Riem"],
    },
    "family": {
        "top": ["Haidhausen", "Bogenhausen", "Schwabing", "Sendling"],
        "bottom": ["Feldmoching", "Moosach"],
    },
    "quiet": {
        "top": ["Grünwald", "Solln", "Obermenzing", "Bogenhausen"],
        "bottom": ["Altstadt", "Maxvorstadt", "Milbertshofen"],
    },
    "budget": {
        "top": ["Feldmoching", "Aubing", "Moosach", "Riem"],
        "bottom": ["Altstadt", "Maxvorstadt", "Bogenhausen"],
    },
}


def _centroid(coords: list) -> tuple[float, float]:
    ring = coords[0] if coords and isinstance(coords[0][0], (list, tuple)) else coords
    lngs = [c[0] for c in ring]
    lats = [c[1] for c in ring]
    return sum(lats) / len(lats), sum(lngs) / len(lngs)


def _clamp(v: float) -> float:
    return max(0.0, min(100.0, v))


def _factor_available(key: str, props: dict) -> bool:
    if key == "heat":
        return False
    if key == "price":
        return props.get("s_rent_absolute") is not None
    prop = SCORE_PROPS.get(key)
    return prop is None or props.get(prop) is not None


def _active_keys(preset: dict) -> list[str]:
    imp = [k for k in IMPORTANCE_KEYS if (preset.get(k) or 0) > 0 and _factor_available(k, {})]
    if len(imp) <= 1:
        return imp
    prefs = [k for k in PREF_KEYS if k in preset]
    return imp + prefs


def _shares(keys: list[str], preset: dict) -> dict[str, float]:
    objective = [k for k in keys if k not in PREF_KEYS]
    prefs = [k for k in keys if k in PREF_KEYS]
    shares: dict[str, float] = {}

    if not prefs:
        raw = {k: WEIGHT_STEPS[preset.get(k, 0)] for k in objective}
        total = sum(raw.values()) or 1
        return {k: raw[k] / total for k in objective}

    obj_raw = {k: WEIGHT_STEPS[preset.get(k, 0)] for k in objective}
    obj_sum = sum(obj_raw.values()) or 1
    pref_sum = len(prefs) * 2 or 1
    for k in objective:
        shares[k] = (obj_raw[k] / obj_sum) * OBJECTIVE_MAX_SHARE
    for k in prefs:
        shares[k] = (2 / pref_sum) * PREF_MAX_SHARE
    return shares


def _pref_score(key: str, target: float, props: dict) -> float:
    prop = SCORE_PROPS[key]
    actual = float(props.get(prop, 50))
    return _clamp(100 - abs(actual - target) * PREF_PENALTY)


def _factor_score(key: str, props: dict) -> float:
    if key in PREF_KEYS:
        return 50.0
    prop = SCORE_PROPS[key]
    return float(props.get(prop, 50))


def comfort_score(props: dict, preset: dict) -> float | None:
    keys = [k for k in IMPORTANCE_KEYS if (preset.get(k) or 0) > 0]
    if not keys:
        return None
    if len(keys) > 1:
        keys = keys + [k for k in PREF_KEYS if k in preset]
    keys = [k for k in keys if _factor_available(k, props)]
    if not keys:
        return None
    shares = _shares(keys, preset)
    scores = {}
    for k in keys:
        if k in PREF_KEYS:
            scores[k] = _pref_score(k, float(preset[k]), props)
        else:
            scores[k] = _factor_score(k, props)
    if len(keys) == 1:
        return scores[keys[0]]
    log_sum = sum(shares[k] * math.log(max(SCORE_FLOOR, scores[k])) for k in keys)
    return math.exp(log_sum)


def assign_district(lat: float, lng: float) -> str | None:
    best, best_d = None, float("inf")
    for name, d in DISTRICTS.items():
        dist = haversine_m(lat, lng, d["lat"], d["lng"])
        if dist < best_d:
            best, best_d = name, dist
    return best if best_d <= MAX_DIST_M else None


def load_hexes(path: Path) -> list[dict]:
    with open(path, encoding="utf-8") as fh:
        data = json.load(fh)
    rows = []
    for feat in data["features"]:
        props = feat["properties"]
        lat, lng = _centroid(feat["geometry"]["coordinates"])
        props = dict(props)
        props["_lat"] = lat
        props["_lng"] = lng
        props["_district"] = assign_district(lat, lng)
        rows.append(props)
    return rows


def report_district_table(hexes: list[dict]) -> None:
    by_dist: dict[str, list[dict]] = {}
    for h in hexes:
        d = h.get("_district")
        if d:
            by_dist.setdefault(d, []).append(h)

    factors = [
        "s_center",
        "s_transit_service",
        "s_daily_needs",
        "s_green",
        "s_noise",
        "s_traffic_safety",
        "s_rent_absolute",
        "s_urban_activity",
    ]
    print("\n=== District factor means (nearest-centroid assignment) ===\n")
    header = f"{'district':<16} {'n':>4} " + " ".join(f"{f[2:8]:>7}" for f in factors[:6])
    print(header)
    print("-" * len(header))

    rows_out = []
    for name in DISTRICTS:
        hs = by_dist.get(name, [])
        if not hs:
            continue
        means = {f: sum(float(h.get(f, 0) or 0) for h in hs) / len(hs) for f in factors}
        rows_out.append((name, len(hs), means))

    for name, n, means in sorted(rows_out, key=lambda r: r[2]["s_center"], reverse=True):
        vals = " ".join(f"{means[f]:7.1f}" for f in factors[:6])
        print(f"{name:<16} {n:4d} {vals}")


def report_preset_rankings(hexes: list[dict]) -> None:
    print("\n=== Preset comfort rankings by district ===\n")
    by_dist: dict[str, list[dict]] = {}
    for h in hexes:
        d = h.get("_district")
        if d:
            by_dist.setdefault(d, []).append(h)

    for preset_id, preset in PRESETS.items():
        dist_scores: list[tuple[str, float, int]] = []
        for name, hs in by_dist.items():
            scores = [comfort_score(h, preset) for h in hs]
            scores = [s for s in scores if s is not None]
            if scores:
                dist_scores.append((name, sum(scores) / len(scores), len(scores)))
        dist_scores.sort(key=lambda x: x[1], reverse=True)

        print(f"--- {preset['label']} ({preset_id}) ---")
        print(f"{'rank':<5} {'district':<16} {'comfort':>8} {'hexes':>6}")
        for i, (name, avg, n) in enumerate(dist_scores[:12], 1):
            print(f"{i:<5} {name:<16} {avg:8.1f} {n:6d}")
        print(f"    ... bottom: {', '.join(n for n, _, _ in dist_scores[-4:])}")

        exp = EXPECTATIONS.get(preset_id, {})
        ranked_names = [n for n, _, _ in dist_scores]
        top_hits = sum(1 for n in exp.get("top", []) if n in ranked_names[:6])
        bottom_hits = sum(1 for n in exp.get("bottom", []) if n in [x[0] for x in dist_scores[-6:]])
        top_total = len(exp.get("top", []))
        bottom_total = len(exp.get("bottom", []))
        print(
            f"    sanity: expected-top in top-6 = {top_hits}/{top_total}, "
            f"expected-bottom in bottom-6 = {bottom_hits}/{bottom_total}"
        )
        print()


def report_top_hexes(hexes: list[dict], n: int = 10) -> None:
    print(f"\n=== Top / bottom {n} hexes per preset ===\n")
    for preset in PRESETS.values():
        scored = []
        for h in hexes:
            c = comfort_score(h, preset)
            if c is not None:
                scored.append((c, h.get("_district") or "?", h.get("h3", "?")))
        scored.sort(key=lambda x: x[0], reverse=True)
        print(f"--- {preset['label']} ---")
        print("  TOP:")
        for c, dist, h3 in scored[:n]:
            print(f"    {c:5.1f}  {(dist or '?'):<14}  {h3}")
        print("  BOTTOM:")
        for c, dist, h3 in scored[-n:]:
            print(f"    {c:5.1f}  {(dist or '?'):<14}  {h3}")
        print()


def main() -> int:
    parser = argparse.ArgumentParser(description="Munich district validation report")
    parser.add_argument("geojson", type=Path)
    parser.add_argument("--top", type=int, default=10, help="Top/bottom hex count per preset")
    parser.add_argument("--no-hexes", action="store_true", help="Skip top/bottom hex listing")
    args = parser.parse_args()

    hexes = load_hexes(args.geojson)
    print(f"Loaded {len(hexes)} hexes; {sum(1 for h in hexes if h.get('_district'))} assigned to districts")

    report_district_table(hexes)
    report_preset_rankings(hexes)
    if not args.no_hexes:
        report_top_hexes(hexes, args.top)

    return 0


if __name__ == "__main__":
    sys.exit(main())
