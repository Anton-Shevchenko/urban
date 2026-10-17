#!/usr/bin/env python3
"""Validate the objective 15-Minute Living Score against generated exports.

Checks München (bundled) and optionally Rosenheim distributions + spot checks.
Weights come from contracts/scoring.json via pipeline.contract — this script
must never carry its own copy. Personal profile presets are frontend-owned and
are exercised by frontend/src/scoring tests, not here.

Run with PYTHONPATH=microservices/data.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

from pipeline import contract
from pipeline.common import haversine_m

SERVICE = Path(__file__).resolve().parents[1]  # microservices/data
REPO = SERVICE.parents[1]

OBJECTIVE_WEIGHTS: dict[str, float] = dict(contract.generated.OBJECTIVE_WEIGHTS)
PILLAR_KEYS = list(OBJECTIVE_WEIGHTS)

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


def centroid(geom: dict) -> tuple[float, float]:
    coords = geom["coordinates"][0]
    lng = sum(c[0] for c in coords) / len(coords)
    lat = sum(c[1] for c in coords) / len(coords)
    return lat, lng


def clamp(v: float, lo: float = 0.0, hi: float = 100.0) -> float:
    return max(lo, min(hi, v))


# Canonical exported pillar. A missing field stays missing — no alias, no 50.
_PILLAR_SOURCES: dict[str, str] = {
    "daily_life": "s_daily_life",
    "walk": "s_walk",
    "green": "s_green",
    "transit": "s_transit",
    "quiet": "s_quiet",
    "housing_affordability": "s_housing_affordability",
}


def pillar_scores(p: dict) -> dict[str, float | None]:
    out: dict[str, float | None] = {}
    for pillar, key in _PILLAR_SOURCES.items():
        raw = p.get(key)
        out[pillar] = None if raw is None else clamp(float(raw))
    return out


def living_score(p: dict, weights: dict[str, float] | None = None) -> float:
    w = weights or OBJECTIVE_WEIGHTS
    # The pipeline already computed this composite; recomputing is only for
    # what-if weights, where the exported value would be wrong.
    if p.get("s_living") is not None and w is OBJECTIVE_WEIGHTS:
        return clamp(float(p["s_living"]))
    pil = pillar_scores(p)
    num = 0.0
    den = 0.0
    for key in PILLAR_KEYS:
        value = pil[key]
        weight = float(w.get(key, 0) or 0)
        if value is None or weight <= 0:
            continue
        num += weight * value
        den += weight
    if den <= 0:
        raise ValueError("living score has no canonical pillar values")
    return clamp(num / den)


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

    print(
        f"\ns_living: mean={mean:.1f} median={median:.1f} "
        f"p10={p10:.1f} p90={p90:.1f} spread={p90 - p10:.1f} "
        f"share≥70={share70 * 100:.1f}%"
    )
    for k in PILLAR_KEYS:
        vals = [v for v in metrics[k] if v is not None]
        if not vals:
            print(f"  {k:14s} missing")
            continue
        print(
            f"  {k:14s} mean={sum(vals) / len(vals):5.1f} p10={pct(vals, 0.1):5.1f} p90={pct(vals, 0.9):5.1f}"
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
        def _fmt(value: float | None) -> str:
            return "  —" if value is None else f"{value:4.0f}"

        print(
            f"  {name:22s} living={sc:5.1f} "
            f"daily={_fmt(pil['daily_life'])} walk={_fmt(pil['walk'])} "
            f"transit={_fmt(pil['transit'])} green={_fmt(pil['green'])}"
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
        default=REPO / "frontend" / "public" / "data" / "hexes.geojson",
    )
    ap.add_argument(
        "--rosenheim",
        type=Path,
        default=SERVICE / "data" / "cities" / "rosenheim" / "hexes.geojson",
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
