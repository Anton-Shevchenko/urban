/**
 * Living Score formulas & weights (tune here + normalization.ts / objective.ts).
 *
 * objective-v2 splits results into:
 *   objectiveScore — fixed absolute quality (no user profile)
 *   personalMatchScore — user weights / presets
 *   cityPercentile — within-city rank of objective
 *   confidence — data coverage / reliability
 *
 * Core math lives in objective.ts + locationScore.ts.
 */

import { locationScore } from './locationScore';
import { clamp100, num } from './num';
import {
  DAILY_LIFE_GROUP_WEIGHTS,
  LIVING_WEIGHTS,
  OBJECTIVE_WEIGHTS,
  PERSONAL_PILLAR_KEYS,
  dailyLifeFromGroups,
  scoreCentrality,
  scoreGreen,
  scoreHousingAffordability,
  scoreQuiet,
  scoreTransit,
  scoreWalk,
  walkMinuteBandScore,
} from './objective';
import type { LocationScoreResult, PipelinePoint } from './types';

export {
  ACCESSIBILITY_BANDS,
  CONFIDENCE_THRESHOLDS,
  LEGEND_BANDS,
  OBJECTIVE_NORMALIZATION,
  SCORE_METHOD_VERSION,
  bandScore,
  confidenceLevel,
  normalizeByScale,
} from './normalization';

export {
  DAILY_LIFE_CATEGORY_WEIGHTS,
  DAILY_LIFE_GROUPS,
  DAILY_LIFE_GROUP_WEIGHTS,
  DAILY_NEED_CATS,
  DAILY_NEEDS_WEIGHTS,
  LIVING_WEIGHTS,
  OBJECTIVE_PILLAR_KEYS,
  OBJECTIVE_WEIGHTS,
  PERSONAL_PILLAR_KEYS,
  PILLAR_KEYS,
  buildDiagnostics,
  categoryAccessibilityScore,
  categoryScoredValue,
  computeObjectivePillars,
  computeObjectiveScore,
  dailyLifeFromGroups,
  emptyScored,
  scoreCentrality,
  scoreDailyLifeGroup,
  scoreGreen,
  scoreHousingAffordability,
  scoreQuiet,
  scoreTransit,
  scoreWalk,
  walkMinuteBandScore,
} from './objective';

export {
  buildCityObjectiveIndex,
  buildCityObjectiveMap,
  cityPercentileForScore,
  computePersonalMatchScore,
  locationScore,
  objectivePillarScores,
  objectiveScoreOnly,
  personalAffordabilityMultiplier,
  resolveCityPercentile,
  type CityObjectiveIndex,
} from './locationScore';

export { clamp100, finiteScore, num } from './num';

/** Default walk-minute knots (same as ACCESSIBILITY_BANDS.default). */
export const WALK_MINUTE_BAND_X = [0, 5, 10, 15, 20];
export const WALK_MINUTE_BAND_Y = [100, 100, 70, 30, 0];

/**
 * @deprecated Absolute paint is always used for objective mode.
 * Kept as no-op false for back-compat imports/tests.
 */
export const ABSOLUTE_PAINT_PILLAR_THRESHOLD = 0.5;

/**
 * @deprecated Map no longer auto-switches rank/absolute by pillar weight.
 * Always returns false — use MapMetricMode instead.
 */
export function shouldPaintAbsolute(
  _pillarWeights?: Record<string, number> | null,
  _threshold?: number,
): boolean {
  void _pillarWeights;
  void _threshold;
  return false;
}

/** Soft personal affordability emphasis — continuous, no hard 0.45 cliff. */
export const AFFORDABILITY_PENALTY_FOCUS = 0;

export type PresetDefinition = Record<string, number> & {
  affordability_focus?: number;
  dl_food?: number;
  dl_health?: number;
  dl_education?: number;
  dl_services?: number;
  dl_restaurants_cafes?: number;
  dl_leisure?: number;
  dl_other?: number;
};

/**
 * Profile pillar weights for Personal Match only (renormalised at use).
 * Does not affect objectiveScore.
 */
export const PRESETS: Record<string, PresetDefinition> = {
  standard: {
    daily_life: 0.20,
    walk: 0.15,
    green: 0.15,
    transit: 0.15,
    quiet: 0.15,
    housing_affordability: 0.15,
    centrality: 0.05,
    affordability_focus: 0,
  },
  family: {
    daily_life: 0.24,
    walk: 0.12,
    green: 0.22,
    transit: 0.10,
    quiet: 0.12,
    housing_affordability: 0.17,
    centrality: 0.03,
    affordability_focus: 0.55,
    dl_education: 1.8,
    dl_food: 1.3,
    dl_health: 1.2,
    dl_leisure: 0.7,
    dl_other: 0.7,
  },
  young_professional: {
    daily_life: 0.16,
    walk: 0.14,
    green: 0.08,
    transit: 0.28,
    quiet: 0.04,
    housing_affordability: 0.10,
    centrality: 0.20,
    affordability_focus: 0.15,
    dl_food: 1.1,
    dl_restaurants_cafes: 1.4,
    dl_services: 1.1,
  },
  senior: {
    daily_life: 0.18,
    walk: 0.18,
    green: 0.10,
    transit: 0.12,
    quiet: 0.14,
    housing_affordability: 0.26,
    centrality: 0.02,
    affordability_focus: 0.80,
    dl_health: 1.8,
    dl_services: 1.3,
    dl_food: 1.2,
  },
  no_car: {
    daily_life: 0.14,
    walk: 0.28,
    green: 0.06,
    transit: 0.30,
    quiet: 0.02,
    housing_affordability: 0.08,
    centrality: 0.12,
    affordability_focus: 0.25,
    dl_food: 1.3,
    dl_health: 1.1,
    dl_services: 1.2,
    dl_restaurants_cafes: 1.1,
  },
  /** Budget-focused — not an alias of standard. */
  budget: {
    daily_life: 0.12,
    walk: 0.10,
    green: 0.08,
    transit: 0.12,
    quiet: 0.08,
    housing_affordability: 0.42,
    centrality: 0.08,
    affordability_focus: 0.85,
  },
};

// Legacy preset aliases
PRESETS.balanced = PRESETS.standard;
PRESETS.quiet = PRESETS.senior;
PRESETS.central = PRESETS.no_car;
PRESETS.business = PRESETS.young_professional;

export function hasCustomGroupMultipliers(
  groupMultipliers: Record<string, number> | null | undefined,
): boolean {
  return !!(
    groupMultipliers
    && Object.keys(groupMultipliers).some(
      (k) => k.startsWith('dl_') && groupMultipliers[k] !== 1,
    )
  );
}

/**
 * Pillar scores for UI / personal match (null when missing — never fake 50).
 */
export function pillarScores(
  p: PipelinePoint,
  groupMultipliers: Record<string, number> | null = null,
  _affordabilityFocus = 0,
): Record<string, number | null> {
  void _affordabilityFocus;
  const daily = hasCustomGroupMultipliers(groupMultipliers)
    ? dailyLifeFromGroups(p, groupMultipliers)
    : dailyLifeFromGroups(p, null);

  return {
    daily_life: daily.score,
    walk: scoreWalk(p).score,
    green: scoreGreen(p).score,
    transit: scoreTransit(p).score,
    quiet: scoreQuiet(p).score,
    housing_affordability: scoreHousingAffordability(p).score,
    centrality: scoreCentrality(p).score,
    // Legacy alias for older UI
    housing_value: scoreHousingAffordability(p).score,
  };
}

/**
 * Full location score. `score` === objectiveScore (deprecated alias).
 * Presets / weights only affect personalMatchScore.
 */
export function livingScore(
  p: PipelinePoint,
  pillarWeights: Record<string, number> = LIVING_WEIGHTS,
  groupMultipliers: Record<string, number> | null = null,
  affordabilityFocus = 0,
  cityPercentile: number | null = null,
): LocationScoreResult {
  return locationScore(p, {
    pillarWeights,
    groupMultipliers,
    affordabilityFocus,
    cityPercentile,
  });
}

/** Renormalise personal pillar weights from a preset or slider map. */
export function extractPillarWeights(
  presetOrWeights: Record<string, number>,
): Record<string, number> {
  const w: Record<string, number> = {};
  let sum = 0;
  // Accept housing_value as alias for housing_affordability
  const src = { ...presetOrWeights };
  if (src.housing_value != null && src.housing_affordability == null) {
    src.housing_affordability = src.housing_value;
  }
  for (const k of PERSONAL_PILLAR_KEYS) {
    const v = Number(src[k]);
    w[k] = Number.isFinite(v) && v > 0 ? v : 0;
    sum += w[k];
  }
  if (sum <= 0) return { ...LIVING_WEIGHTS };
  for (const k of PERSONAL_PILLAR_KEYS) w[k] /= sum;
  return w;
}

export function extractGroupMultipliers(
  preset: Record<string, number>,
): Record<string, number> {
  const out: Record<string, number> = {};
  const groups = [...Object.keys(DAILY_LIFE_GROUP_WEIGHTS), 'other'];
  for (const g of groups) {
    const key = `dl_${g}`;
    if (preset[key] != null) out[key] = Number(preset[key]) || 1;
  }
  return out;
}

/** @deprecated Prefer categoryAccessibilityScore — bands replace exponential decay. */
export function walkMinuteDecayScore(minutes: unknown): number | null {
  return walkMinuteBandScore(minutes);
}

/** Derive walking quality when pipeline pillar is missing (schema < 11). */
export function deriveWalkingQuality(p: PipelinePoint): number | null {
  return scoreWalk(p).score;
}

export function isUrbanFormBroken(p: PipelinePoint): boolean {
  const pop = num(p.population_density, null);
  const ufDens = num(p.uf_density, null);
  const dens = num(p.s_density, null);
  if (pop != null && pop <= 0) return true;
  if (ufDens != null && ufDens < 15) return true;
  if (dens === 50 && (pop == null || pop <= 0)) return true;
  return false;
}

export function deriveUrbanForm(p: PipelinePoint): number | null {
  const pop = num(p.population_density, null);
  const dens = num(p.s_density, null);
  let densScore: number | null;
  if (pop != null && pop > 0) {
    densScore = clamp100((100 * Math.log1p(pop)) / Math.log1p(8000));
  } else if (dens != null && dens !== 50) {
    densScore = dens;
  } else {
    const act = num(p.s_urban_activity);
    const center = num(p.s_center);
    if (act == null && center == null) return null;
    densScore = clamp100(0.55 * (act ?? 50) + 0.45 * (center ?? 50));
  }
  const act = num(p.s_urban_activity);
  const green = num(p.s_green);
  if (densScore == null && act == null && green == null) return null;
  return clamp100(
    0.45 * (densScore ?? 50)
    + 0.35 * (act ?? 50)
    + 0.20 * (green ?? 50),
  );
}

// Re-export OBJECTIVE_WEIGHTS sum check helper for tests
export function objectiveWeightsSum(): number {
  return Object.values(OBJECTIVE_WEIGHTS).reduce((a, b) => a + b, 0);
}
