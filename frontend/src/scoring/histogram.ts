/** Score histogram helpers for debug distribution charts (0–100). */

export type HistBin = {
  lo: number;
  hi: number;
  label: string;
  count: number;
  pct: number;
};

export type ScoreDistribution = {
  key: string;
  label: string;
  n: number;
  mean: number;
  p50: number;
  min: number;
  max: number;
  ge70: number;
  lt30: number;
  bins: HistBin[];
};

const BIN_EDGES: [number, number][] = [
  [0, 10],
  [10, 20],
  [20, 30],
  [30, 40],
  [40, 50],
  [50, 60],
  [60, 70],
  [70, 80],
  [80, 90],
  [90, 100],
];

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const i = Math.floor(p * (sorted.length - 1));
  return sorted[i]!;
}

export function buildHistogram(vals: number[]): HistBin[] {
  const counts = BIN_EDGES.map(() => 0);
  for (const v of vals) {
    if (!Number.isFinite(v)) continue;
    const clamped = Math.min(100, Math.max(0, v));
    let idx = Math.min(9, Math.floor(clamped / 10));
    if (clamped === 100) idx = 9;
    counts[idx]! += 1;
  }
  const n = vals.length || 1;
  return BIN_EDGES.map(([lo, hi], i) => ({
    lo,
    hi,
    label: `${lo}–${hi}`,
    count: counts[i]!,
    pct: (100 * counts[i]!) / n,
  }));
}

export function summarizeScores(
  key: string,
  label: string,
  vals: number[],
): ScoreDistribution | null {
  const clean = vals.filter((v) => Number.isFinite(v));
  if (!clean.length) return null;
  const sorted = [...clean].sort((a, b) => a - b);
  const n = clean.length;
  return {
    key,
    label,
    n,
    mean: clean.reduce((a, b) => a + b, 0) / n,
    p50: percentile(sorted, 0.5),
    min: sorted[0]!,
    max: sorted[n - 1]!,
    ge70: (100 * clean.filter((v) => v >= 70).length) / n,
    lt30: (100 * clean.filter((v) => v < 30).length) / n,
    bins: buildHistogram(clean),
  };
}
