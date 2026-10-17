/**
 * Walk-minute interpolation shared with the pipeline via contracts/scoring.json.
 *
 * Rent, noise, and green curves are not reimplemented here. Those pillar
 * scores are exported by the Python pipeline and read from the hex.
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
  supermarket_walk_minutes: {
    name: 'Supermarket walk time',
    unit: 'minutes',
    direction: 'lower',
    bands: [[0, 100], [1, 88], [3, 70], [5, 52], [8, 32], [12, 15], [16, 5], [20, 0]],
    source: 'contracts/scoring.json walk_minute_bands.default',
    version: 'v2',
  },
  cafe_walk_minutes: {
    name: 'Cafe walk time',
    unit: 'minutes',
    direction: 'lower',
    bands: [[0, 100], [1, 88], [3, 70], [5, 52], [8, 32], [12, 15], [16, 5], [20, 0]],
    source: 'contracts/scoring.json walk_minute_bands.default',
    version: 'v2',
  },
  transit_stop_walk_minutes: {
    name: 'Transit stop walk time',
    unit: 'minutes',
    direction: 'lower',
    bands: [[0, 100], [5, 100], [10, 75], [15, 40], [25, 0]],
    source: 'PT accessibility bands',
    version: 'v2',
  },
  transit_frequency: {
    name: 'Transit service score',
    unit: 'score 0–100',
    direction: 'higher',
    bands: [[0, 0], [25, 25], [50, 50], [75, 75], [100, 100]],
    source: 'Pipeline transit_service_raw / score (absolute)',
    version: 'v2',
  },
  park_walk_minutes: {
    name: 'Park walk time',
    unit: 'minutes',
    direction: 'lower',
    bands: [[0, 100], [5, 100], [10, 80], [15, 50], [25, 15], [40, 0]],
    source: 'Green accessibility',
    version: 'v2',
  },
} as const satisfies Record<string, NormalizationScale>;

/**
 * Walk-minute accessibility. `default` is generated from contracts/scoring.json
 * so it stays identical to the pipeline's score_scales.walk_minute_band_score.
 * Every daily-life category uses that one curve — a per-category plateau
 * (5 or 10 minutes still scoring 100) painted dense cities as one green field.
 */
export const ACCESSIBILITY_BANDS: Record<string, [number, number][]> = {
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
