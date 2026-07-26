#!/usr/bin/env python3
"""Validate 15-Minute Living Score (7-metric city-normalized foundation).

Checks München (bundled) and optionally Rosenheim distributions + spot checks.
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

LIVING_WEIGHTS = {
    "daily_life": 0.20,
    "walk": 0.20,
    "green": 0.15,
    "transit": 0.15,
    "centrality": 0.10,
    "quiet": 0.10,
    "housing_value": 0.10,
}

PILLAR_KEYS = list(LIVING_WEIGHTS)

# Profile reweights (match frontend PRESETS)
PROFILES = {
    "standard": LIVING_WEIGHTS,
    "no_car": {
        "daily_life": 0.14, "walk": 0.28, "green": 0.06, "transit": 0.30,
        "centrality": 0.12, "quiet": 0.02, "housing_value": 0.08,
    },
    "family": {
        "daily_life": 0.24, "walk": 0.12, "green": 0.22, "transit": 0.10,
        "centrality": 0.03, "quiet": 0.12, "housing_value": 0.17,
    },
    "senior": {
        "daily_life": 0.18, "walk": 0.18, "green": 0.10, "transit": 0.12,
        "centrality": 0.02, "quiet": 0.14, "housing_value": 0.26,
    },
}

# Spot-check neighbourhoods (approx centroids)
MUNICH_SPOTS = {
    "Altstadt/Marienplatz": (48.13741, 11.57549),
    "Maxvorstadt": (48.1485, 11.5680),
    "Schwabing": (48.1680, 11.5860),
    "Pasing": (48.1480, 11.4610),
    "Moosach": (48.1800, 11.5080),
    "Trudering": (48.1230, 11.6700),
}

ROSENHEIM_SPOTS = {
    "Innenstadt": (47.8560, 12.1270),
    "Bahnhof": (47.8505, 12.1195),
    "Aising": (47.8300, 12.1000),
    "Happing": (47.8700, 12.1600),
}


def haversine_m(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dl = math.radians(lng2 - lng1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def centroid(geom: dict) -> tuple[float, float]:
    coords = geom["coordinates"][0]
    lng = sum(c[0] for c in coords) / len(coords)
    lat = sum(c[1] for c in coords) / len(coords)
    return lat, lng


def clamp(v: float, lo: float = 0.0, hi: float = 100.0) -> float:
    return max(lo, min(hi, v))


def pillar_scores(p: dict) -> dict[str, float]:
    walk = p.get("s_walk")
    if walk is None:
        walk = p.get("s_walking_quality", 50)
    quiet = p.get("s_quiet")
    if quiet is None:
        quiet = p.get("s_noise", 50)
    hv = p.get("s_housing_value")
    if hv is None:
        hv = p.get("s_rent_value") or p.get("s_rent_relative_city", 50)
    return {
        "daily_life": clamp(float(p.get("s_daily_life") or p.get("s_daily_needs") or 50)),
        "walk": clamp(float(walk)),
        "green": clamp(float(p.get("s_green") or 50)),
        "transit": clamp(float(p.get("s_transit") or p.get("s_transit_service") or 50)),
        "centrality": clamp(float(p.get("s_center") or 50)),
        "quiet": clamp(float(quiet)),
        "housing_value": clamp(float(hv)),
    }


def living_score(p: dict, weights: dict[str, float] | None = None) -> float:
    w = weights or LIVING_WEIGHTS
    # Use exported composite when weights match the default Living formula.
    if p.get("s_living") is not None and all(
        abs(w.get(k, 0) - LIVING_WEIGHTS[k]) < 1e-9 for k in PILLAR_KEYS
    ):
        return clamp(float(p["s_living"]))
    pil = pillar_scores(p)
    total_w = sum(w.values()) or 1.0
    return clamp(sum(w[k] * pil[k] for k in PILLAR_KEYS) / total_w)


def pct(vals: list[float], q: float) -> float:
    if not vals:
        return float("nan")
    s = sorted(vals)
    if len(s) == 1:
        return s[0]
    idx = q * (len(s) - 1)
    lo = int(math.floor(idx))
    hi = int(math.ceil(idx))
    if lo == hi:
        return s[lo]
    return s[lo] + (s[hi] - s[lo]) * (idx - lo)


def nearest_hex(features: list, lat: float, lng: float) -> dict:
    best = None
    best_d = 1e18
    for f in features:
        clat, clng = centroid(f["geometry"])
        d = haversine_m(lat, lng, clat, clng)
        if d < best_d:
            best_d = d
            best = f
    assert best is not None
    return best.get("properties") or {}


def validate_city(
    path: Path,
    *,
    label: str,
    center: tuple[float, float],
    spots: dict[str, tuple[float, float]],
    check_targets: bool,
) -> bool:
    if not path.exists():
        print(f"MISSING {path}", file=sys.stderr)
        return False

    data = json.loads(path.read_text(encoding="utf-8"))
    features = data.get("features") or []
    meta = data.get("meta") or {}
    print(f"\n=== {label} ===")
    print(
        f"hexes={len(features)} pipeline={meta.get('pipeline_version')} "
        f"city_type={meta.get('city_type')} population={meta.get('population')} "
        f"norm={meta.get('normalization')}"
    )

    if not features:
        print("FAIL: no features")
        return False

    scores = [living_score(f.get("properties") or {}) for f in features]
    metrics = {k: [] for k in PILLAR_KEYS}
    for f in features:
        pil = pillar_scores(f.get("properties") or {})
        for k in PILLAR_KEYS:
            metrics[k].append(pil[k])

    mean = sum(scores) / len(scores)
    median = pct(scores, 0.5)
    p10, p90 = pct(scores, 0.1), pct(scores, 0.9)
    share70 = sum(1 for s in scores if s >= 70) / len(scores)

    print(f"\ns_living: mean={mean:.1f} median={median:.1f} "
          f"p10={p10:.1f} p90={p90:.1f} spread={p90 - p10:.1f} "
          f"share≥70={share70 * 100:.1f}%")
    for k in PILLAR_KEYS:
        vals = metrics[k]
        print(
            f"  {k:14s} mean={sum(vals)/len(vals):5.1f} "
            f"p10={pct(vals, 0.1):5.1f} p90={pct(vals, 0.9):5.1f}"
        )

    ok = True
    if check_targets:
        checks = [
            ("mean ≈ 48–58", 48 <= mean <= 58),
            ("median ≈ 50–60", 50 <= median <= 60),
            ("p90−p10 ≥ 40", (p90 - p10) >= 40),
            ("share ≥70 ≤ 25%", share70 <= 0.25),
        ]
        print("\nMünchen distribution targets:")
        for name, passed in checks:
            print(f"  {'OK' if passed else 'FAIL'}: {name}")
            ok = ok and passed

        # Profile effect: city-wide mean shift is small when pillars correlate;
        # require meaningful per-hex reordering (mean |Δ| ≥ 3.5).
        std_mean = sum(living_score(f["properties"], PROFILES["standard"]) for f in features) / len(features)
        no_car_scores = [living_score(f["properties"], PROFILES["no_car"]) for f in features]
        fam_scores = [living_score(f["properties"], PROFILES["family"]) for f in features]
        no_car_mean = sum(no_car_scores) / len(no_car_scores)
        fam_mean = sum(fam_scores) / len(fam_scores)
        mean_abs = sum(abs(a - b) for a, b in zip(no_car_scores, fam_scores)) / len(features)
        city_delta = abs(no_car_mean - fam_mean)
        print(f"\nProfile means: standard={std_mean:.1f} no_car={no_car_mean:.1f} "
              f"family={fam_mean:.1f} city|Δ|={city_delta:.1f} mean|hexΔ|={mean_abs:.1f}")
        if mean_abs < 3.5:
            print("FAIL: profiles should move hex scores by mean|Δ| ≥ 3.5")
            ok = False
        else:
            print("OK: profile mean|hexΔ| ≥ 3.5")

    # Distance rings from primary center
    rows = []
    for f in features:
        p = f.get("properties") or {}
        lat, lng = centroid(f["geometry"])
        dist = haversine_m(center[0], center[1], lat, lng)
        rows.append((dist, living_score(p), pillar_scores(p)))

    print("\nMean Living Score by distance ring:")
    for label_r, lo, hi in [
        ("0–1.5 km", 0, 1500),
        ("1.5–4 km", 1500, 4000),
        ("4–8 km", 4000, 8000),
        (">8 km", 8000, 1e12),
    ]:
        subset = [r for r in rows if lo < r[0] <= hi] if lo else [r for r in rows if r[0] <= hi]
        if lo == 0:
            subset = [r for r in rows if r[0] <= hi]
        if not subset:
            print(f"  {label_r}: n=0")
            continue
        m = sum(r[1] for r in subset) / len(subset)
        print(f"  {label_r}: n={len(subset)} living={m:.1f}")

    print("\nNeighbourhood spot checks:")
    spot_scores = {}
    for name, (lat, lng) in spots.items():
        p = nearest_hex(features, lat, lng)
        sc = living_score(p)
        pil = pillar_scores(p)
        spot_scores[name] = sc
        print(
            f"  {name:22s} living={sc:5.1f} "
            f"daily={pil['daily_life']:4.0f} walk={pil['walk']:4.0f} "
            f"transit={pil['transit']:4.0f} center={pil['centrality']:4.0f}"
        )

    # Soft ordering expectations
    if "Altstadt/Marienplatz" in spot_scores and "Trudering" in spot_scores:
        if spot_scores["Altstadt/Marienplatz"] <= spot_scores["Trudering"]:
            print("WARN: Altstadt should usually beat Trudering")
    if "Innenstadt" in spot_scores and "Aising" in spot_scores:
        if spot_scores["Innenstadt"] <= spot_scores["Aising"]:
            print("FAIL: Rosenheim Innenstadt should beat Aising")
            ok = False
        else:
            print("OK: Innenstadt > Aising")

    return ok


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--munich",
        type=Path,
        default=ROOT / "frontend" / "public" / "data" / "hexes.geojson",
    )
    ap.add_argument(
        "--rosenheim",
        type=Path,
        default=ROOT / "data" / "cities" / "rosenheim" / "hexes.geojson",
    )
    args = ap.parse_args()

    ok_m = validate_city(
        args.munich,
        label="München",
        center=(48.13741, 11.57549),
        spots=MUNICH_SPOTS,
        check_targets=True,
    )
    ok_r = True
    if args.rosenheim.exists():
        ok_r = validate_city(
            args.rosenheim,
            label="Rosenheim",
            center=(47.8567, 12.1289),
            spots=ROSENHEIM_SPOTS,
            check_targets=False,
        )
    else:
        print(f"\nskip Rosenheim (missing {args.rosenheim})")

    return 0 if (ok_m and ok_r) else 2


if __name__ == "__main__":
    raise SystemExit(main())
