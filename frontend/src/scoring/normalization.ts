/**
 * Absolute cross-city normalization for Objective Living Score (objective-v2).
 *
 * Same raw input → same score in München, Berlin, etc.
 * Do not use city percentile / rank as input to Objective Score.
 */

import { SCORE_METHOD_VERSION, WALK_MINUTE_BANDS } from './generated/contract';

export { SCORE_METHOD_VERSION };

export type ScoreMethodVersion = typeof SCORE_METHOD_VERSION;

/** Piecewise [x, y] knots; direction encoded by y trend. */
export type NormalizationScale = {
  name: string;
  unit: string;
  /** higher-is-better | lower-is-better */
  direction: 'higher' | 'lower';
  /** Sorted knots: input → score 0–100 */
  bands: [number, number][];
  source: string;
  version: string;
};

export const OBJECTIVE_NORMALIZATION = {
  noise_db: {
    name: 'Ambient noise',
    unit: 'dB',
    direction: 'lower',
    bands: [[45, 100], [52, 85], [58, 65], [62, 45], [68, 25], [75, 10], [85, 0]],
    source: 'Absolute urban noise quiet curve',
    version: 'v2',
  },
  park_dist_m: {
    name: 'Park distance',
    unit: 'm',
    direction: 'lower',
    bands: [[50, 100], [200, 85], [500, 60], [1000, 35], [2000, 10]],
    source: 'green_quality_score reachable component',
    version: 'v2',
  },
  green_share_pct: {
    name: 'Green share within 500 m',
    unit: '%',
    direction: 'higher',
    bands: [[0, 0], [5, 25], [15, 50], [30, 75], [50, 100]],
    source: 'green_quality_score share component',
    version: 'v2',
  },
  tree_canopy_pct: {
    name: 'Tree canopy',
    unit: '%',
    direction: 'higher',
    bands: [[0, 0], [5, 20], [15, 50], [30, 80], [50, 100]],
    source: 'Canopy share',
    version: 'v2',
  },
  rent_eur_m2: {
    name: 'Cold rent',
    unit: '€/m²',
    direction: 'lower',
    bands: [[8, 100], [12, 90], [16, 80], [18, 65], [20, 50], [22, 35], [24, 20], [26, 10], [32, 0]],
    source: 'Absolute Germany cold-rent affordability (objective-v2)',
    version: 'v2',
  },
} as const satisfies Record<string, NormalizationScale>;

/**
 * Category-specific walk-minute bands. `default` is generated from
 * contracts/scoring.json so it stays identical to the pipeline's
 * score_scales.walk_minute_band_score; per-category curves are frontend-only.
 */
export const ACCESSIBILITY_BANDS: Record<string, [number, number][]> = {
  supermarket: [[0, 100], [5, 100], [10, 70], [15, 30], [20, 0]],
  bakery: [[0, 100], [5, 100], [8, 80], [12, 40], [18, 0]],
  market: [[0, 100], [5, 100], [10, 70], [15, 35], [25, 0]],
  pharmacy: [[0, 100], [5, 100], [10, 70], [15, 30], [20, 0]],
  doctor: [[0, 100], [5, 100], [10, 75], [15, 40], [25, 0]],
  clinic: [[0, 100], [8, 100], [15, 70], [25, 30], [35, 0]],
  kita: [[0, 100], [5, 100], [10, 70], [15, 30], [20, 0]],
  school: [[0, 100], [5, 100], [10, 75], [15, 40], [25, 0]],
  administration: [[0, 100], [8, 100], [15, 70], [25, 30], [35, 0]],
  bank: [[0, 100], [5, 100], [10, 70], [15, 30], [20, 0]],
  post: [[0, 100], [5, 100], [10, 70], [15, 30], [20, 0]],
  restaurant: [[0, 100], [8, 100], [12, 70], [20, 30], [30, 0]],
  cafe: [[0, 100], [10, 100], [15, 70], [25, 30], [35, 0]],
  sports: [[0, 100], [8, 100], [15, 70], [25, 30], [35, 0]],
  playground: [[0, 100], [5, 100], [10, 70], [15, 30], [20, 0]],
  park: [[0, 100], [5, 100], [10, 80], [15, 50], [25, 15], [40, 0]],
  default: WALK_MINUTE_BANDS.default,
};

export const CONFIDENCE_THRESHOLDS = {
  high: 0.80,
  medium: 0.60,
  /** Below this → objectiveScore = null */
  nullScore: 0.40,
} as const;

export const LEGEND_BANDS = [
  { min: 85, max: 100, label: 'Excellent' },
  { min: 70, max: 84, label: 'Good' },
  { min: 55, max: 69, label: 'Average' },
  { min: 40, max: 54, label: 'Below average' },
  { min: 0, max: 39, label: 'Poor' },
] as const;

/** Piecewise linear interpolate from sorted [x,y] bands. */
export function bandScore(
  value: number | null | undefined,
  bands: readonly [number, number][],
): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  const xs = bands.map((b) => b[0]);
  const ys = bands.map((b) => b[1]);
  if (value <= xs[0]) return ys[0];
  if (value >= xs[xs.length - 1]) return ys[ys.length - 1];
  for (let i = 1; i < xs.length; i++) {
    if (value <= xs[i]) {
      const t = (value - xs[i - 1]) / (xs[i] - xs[i - 1]);
      return ys[i - 1] + t * (ys[i] - ys[i - 1]);
    }
  }
  return ys[ys.length - 1];
}

export function normalizeByScale(
  value: number | null | undefined,
  scale: NormalizationScale,
): number | null {
  return bandScore(value, scale.bands);
}

export function confidenceLevel(
  confidence: number,
): 'high' | 'medium' | 'low' | 'insufficient' {
  if (confidence >= CONFIDENCE_THRESHOLDS.high) return 'high';
  if (confidence >= CONFIDENCE_THRESHOLDS.medium) return 'medium';
  if (confidence >= CONFIDENCE_THRESHOLDS.nullScore) return 'low';
  return 'insufficient';
}
