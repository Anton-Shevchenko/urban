#!/usr/bin/env python3
"""Histogram + percentile + correlation report for s_* scores.

Usage:
  python microservices/data/scripts/distribution_report.py microservices/data/data/cities/muenchen/hexes.geojson --factors
  python microservices/data/scripts/distribution_report.py frontend/public/data/hexes.geojson --correlations
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

TARGET_COMFORT = [
    (90, 100, 1.5),
    (80, 90, 5.0),
    (70, 80, 10.0),
    (60, 70, 15.0),
    (50, 60, 20.0),
    (40, 50, 20.0),
    (30, 40, 15.0),
    (0, 30, 13.5),
]

FACTOR_KEYS = [
    "s_center",
    "s_transit_service",
    "s_daily_needs",
    "s_green",
    "s_quiet",
    "s_heat",
    "s_traffic_safety",
    "s_rent_absolute",
]

# Short labels for correlation output.
FACTOR_LABELS = {
    "s_center": "center",
    "s_transit_service": "transit",
    "s_daily_needs": "daily_needs",
    "s_green": "green",
    "s_quiet": "quiet",
    "s_heat": "heat",
    "s_traffic_safety": "safety",
    "s_rent_absolute": "price",
}


def _percentile(vals: list[float], p: float) -> float:
    if not vals:
        return 0.0
    s = sorted(vals)
    i = int(p * (len(s) - 1))
    return s[i]


def _histogram(vals: list[float], width: int = 22) -> list[tuple[str, int, float]]:
    bins = [
        (0, 10),
        (10, 20),
        (20, 30),
        (30, 40),
        (40, 50),
        (50, 60),
        (60, 70),
        (70, 80),
        (80, 90),
        (90, 100.01),
    ]
    counts = dict.fromkeys(bins, 0)
    for v in vals:
        for lo, hi in bins:
            if v >= lo and v < hi:
                counts[(lo, hi)] += 1
                break
    max_c = max(counts.values()) or 1
    rows = []
    for (lo, hi), c in counts.items():
        hi_disp = 100 if hi == 100.01 else hi
        bar = "█" * int(width * c / max_c)
        rows.append((f"{lo:3d}-{hi_disp:3d}", c, 100 * c / len(vals), bar))
    return rows


def _summary(vals: list[float]) -> dict:
    return {
        "n": len(vals),
        "mean": sum(vals) / len(vals),
        "min": min(vals),
        "max": max(vals),
        "p10": _percentile(vals, 0.10),
        "p25": _percentile(vals, 0.25),
        "p50": _percentile(vals, 0.50),
        "p75": _percentile(vals, 0.75),
        "p90": _percentile(vals, 0.90),
        "ge70": 100 * sum(1 for v in vals if v >= 70) / len(vals),
        "ge80": 100 * sum(1 for v in vals if v >= 80) / len(vals),
        "lt30": 100 * sum(1 for v in vals if v < 30) / len(vals),
    }


def _factor_matrix(props: list[dict], keys: list[str]) -> dict[str, list[float]]:
    """Aligned factor vectors (same length, drop rows with any missing value)."""
    rows: list[list[float]] = []
    for p in props:
        row = []
        ok = True
        for k in keys:
            v = p.get(k)
            if v is None:
                ok = False
                break
            row.append(float(v))
        if ok:
            rows.append(row)
    if not rows:
        return {k: [] for k in keys}
    cols = list(zip(*rows, strict=True))
    return {k: list(col) for k, col in zip(keys, cols, strict=True)}


def _pearson(a: list[float], b: list[float]) -> float:
    n = len(a)
    if n < 3:
        return 0.0
    ma = sum(a) / n
    mb = sum(b) / n
    num = sum((x - ma) * (y - mb) for x, y in zip(a, b, strict=True))
    da = math.sqrt(sum((x - ma) ** 2 for x in a))
    db = math.sqrt(sum((y - mb) ** 2 for y in b))
    if da < 1e-12 or db < 1e-12:
        return 0.0
    return num / (da * db)


def _rank(vals: list[float]) -> list[float]:
    order = sorted(range(len(vals)), key=lambda i: vals[i])
    ranks = [0.0] * len(vals)
    i = 0
    while i < len(order):
        j = i
        while j + 1 < len(order) and vals[order[j + 1]] == vals[order[i]]:
            j += 1
        avg_rank = (i + j) / 2.0 + 1.0
        for k in range(i, j + 1):
            ranks[order[k]] = avg_rank
        i = j + 1
    return ranks


def _spearman(a: list[float], b: list[float]) -> float:
    return _pearson(_rank(a), _rank(b))


def _vif(columns: dict[str, list[float]], key: str) -> float:
    """Variance inflation factor via OLS R² of key on all other factors."""
    y = columns[key]
    others = [k for k in columns if k != key]
    if len(y) < len(others) + 2:
        return 1.0
    n = len(y)
    p = len(others) + 1  # intercept + predictors
    # Design matrix [1, x1, x2, ...]
    x_cols = [[1.0] * n]
    for ok in others:
        x_cols.append(columns[ok])
    # Normal equations: beta = (X'X)^-1 X'y
    xtx = [[0.0] * p for _ in range(p)]
    xty = [0.0] * p
    for i in range(p):
        for j in range(p):
            xtx[i][j] = sum(x_cols[i][k] * x_cols[j][k] for k in range(n))
        xty[i] = sum(x_cols[i][k] * y[k] for k in range(n))
    # Gaussian elimination
    aug = [xtx[i] + [xty[i]] for i in range(p)]
    for col in range(p):
        pivot = max(range(col, p), key=lambda r: abs(aug[r][col]))
        aug[col], aug[pivot] = aug[pivot], aug[col]
        div = aug[col][col]
        if abs(div) < 1e-12:
            return float("inf")
        for j in range(col, p + 1):
            aug[col][j] /= div
        for row in range(p):
            if row == col:
                continue
            factor = aug[row][col]
            for j in range(col, p + 1):
                aug[row][j] -= factor * aug[col][j]
    beta = [aug[i][p] for i in range(p)]
    y_mean = sum(y) / n
    ss_tot = sum((v - y_mean) ** 2 for v in y)
    if ss_tot < 1e-12:
        return 1.0
    y_hat = [sum(beta[j] * x_cols[j][k] for j in range(p)) for k in range(n)]
    ss_res = sum((y[k] - y_hat[k]) ** 2 for k in range(n))
    r2 = 1.0 - ss_res / ss_tot
    if r2 >= 1.0 - 1e-12:
        return float("inf")
    return 1.0 / (1.0 - r2)


def report_correlations(props: list[dict]) -> None:
    keys = [k for k in FACTOR_KEYS if any(p.get(k) is not None for p in props)]
    # Drop constant factors (e.g. heat).
    keys = [k for k in keys if len({float(p[k]) for p in props if p.get(k) is not None}) > 1]
    cols = _factor_matrix(props, keys)
    n = len(cols[keys[0]]) if keys else 0
    if n < 10:
        print("Not enough complete rows for correlation analysis.")
        return

    print(f"\n=== Correlation matrix (n={n} hexes, complete cases) ===\n")

    # Effective range table.
    print(f"{'factor':<14} {'min':>6} {'max':>6} {'spread':>7} {'VIF':>7}")
    print("-" * 44)
    for k in keys:
        vals = cols[k]
        spread = max(vals) - min(vals)
        vif = _vif(cols, k)
        label = FACTOR_LABELS.get(k, k)
        vif_s = "∞" if math.isinf(vif) else f"{vif:6.2f}"
        print(f"{label:<14} {min(vals):6.1f} {max(vals):6.1f} {spread:7.1f} {vif_s:>7}")

    print("\n--- Pearson r (|r| >= 0.5 highlighted) ---\n")
    pairs: list[tuple[str, str, float, float]] = []
    for i, ka in enumerate(keys):
        for kb in keys[i + 1 :]:
            r_p = _pearson(cols[ka], cols[kb])
            r_s = _spearman(cols[ka], cols[kb])
            pairs.append((ka, kb, r_p, r_s))

    pairs.sort(key=lambda t: abs(t[2]), reverse=True)
    print(f"{'pair':<28} {'pearson':>8} {'spearman':>9} {'flag':>6}")
    print("-" * 55)
    for ka, kb, r_p, r_s in pairs:
        la = FACTOR_LABELS.get(ka, ka)
        lb = FACTOR_LABELS.get(kb, kb)
        flag = "HIGH" if abs(r_p) >= 0.8 else ("med" if abs(r_p) >= 0.5 else "")
        print(f"{la + ' vs ' + lb:<28} {r_p:+8.3f} {r_s:+9.3f} {flag:>6}")

    high = [(a, b, r) for a, b, r, _ in pairs if abs(r) >= 0.8]
    if high:
        print("\n⚠ Factors with |r| >= 0.8 likely describe the same latent dimension.")
        print("  Consider clustering (e.g. Accessibility) or down-weighting correlated sliders.")
    print()


def report_factors(props: list[dict]) -> None:
    print(f"Hexes: {len(props)}\n")
    print(
        f"{'factor':<22} {'mean':>6} {'p50':>6} {'eff_lo':>7} {'eff_hi':>7} "
        f"{'spread':>7} {'>=70%':>7} {'>=80%':>7}"
    )
    print("-" * 78)
    for key in FACTOR_KEYS:
        vals = [float(p[key]) for p in props if p.get(key) is not None]
        if not vals:
            continue
        s = _summary(vals)
        print(
            f"{key:<22} {s['mean']:6.1f} {s['p50']:6.1f} {s['min']:7.1f} {s['max']:7.1f} "
            f"{s['max'] - s['min']:7.1f} {s['ge70']:6.1f}% {s['ge80']:6.1f}%"
        )

    print("\n=== Histograms ===\n")
    for key in FACTOR_KEYS:
        vals = [float(p[key]) for p in props if p.get(key) is not None]
        if not vals:
            continue
        s = _summary(vals)
        print(f"--- {key} (mean={s['mean']:.1f}, spread={max(vals) - min(vals):.1f}) ---")
        for label, c, pct, bar in _histogram(vals):
            print(f"  {label}  {bar:<22} {c:4d} ({pct:5.1f}%)")
        print()


def report_target(vals: list[float], label: str = "comfort") -> None:
    s = _summary(vals)
    print(f"\n=== {label} vs target distribution ===")
    print(f"mean={s['mean']:.1f}  p50={s['p50']:.1f}  >=70={s['ge70']:.1f}%  <30={s['lt30']:.1f}%\n")
    print(f"{'band':<10} {'actual':>8} {'target':>8} {'delta':>8}")
    print("-" * 38)
    for lo, hi, target in TARGET_COMFORT:
        actual = 100 * sum(1 for v in vals if lo <= v < hi) / len(vals)
        print(f"{lo:3d}-{hi:3d}   {actual:7.1f}% {target:7.1f}% {actual - target:+7.1f}pp")


def main() -> int:
    parser = argparse.ArgumentParser(description="Score distribution report")
    parser.add_argument("geojson", type=Path)
    parser.add_argument("--factors", action="store_true", help="Show per-factor histograms")
    parser.add_argument("--correlations", action="store_true", help="Pearson/Spearman/VIF matrix")
    args = parser.parse_args()

    with open(args.geojson, encoding="utf-8") as fh:
        data = json.load(fh)
    props = [f["properties"] for f in data["features"]]

    if args.factors or not args.correlations:
        report_factors(props)
        if not args.factors and props and "comfort" in props[0]:
            vals = [float(p["comfort"]) for p in props if p.get("comfort") is not None]
            if vals:
                report_target(vals)

    if args.correlations:
        report_correlations(props)

    heat = [float(p["s_heat"]) for p in props if p.get("s_heat") is not None]
    if heat and max(heat) - min(heat) < 1:
        print("\n⚠ s_heat is constant — exclude from scoring until pipeline produces variation.")

    return 0


if __name__ == "__main__":
    sys.exit(main())
