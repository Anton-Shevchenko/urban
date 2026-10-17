/**
 * Personal-match presets and scoring façade.
 *
 * Objective weights, daily-life groups and walk bands live in
 * contracts/scoring.json (generated into ./generated/contract).
 * PRESETS here only remix personalMatchScore.
 */

import { locationScore } from './locationScore';
import { ACCESSIBILITY_BANDS } from './normalization';
import { clamp100, num } from './num';
import {
  DAILY_LIFE_GROUP_WEIGHTS,
  LIVING_WEIGHTS,
  OBJECTIVE_WEIGHTS,
  PERSONAL_PILLAR_KEYS,
  computeObjectivePillars,
  dailyLifeForPersonalMatch,
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
  dailyLifeForPersonalMatch,
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

/** Default walk-minute knots, split out of the contract band for chart code. */
export const WALK_MINUTE_BAND_X = ACCESSIBILITY_BANDS.default.map(([minutes]) => minutes);
export const WALK_MINUTE_BAND_Y = ACCESSIBILITY_BANDS.default.map(([, score]) => score);

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

/** Infra-only: every profile is 100% daily_life (shops, cafés, services). */
const INFRA_ONLY_PRESET: PresetDefinition = {
  ...LIVING_WEIGHTS,
  affordability_focus: 0,
};

/**
 * Profile pillar weights for Personal Match only (renormalised at use).
 * Does not affect objectiveScore.
 */
export const PRESETS: Record<string, PresetDefinition> = {
  standard: { ...INFRA_ONLY_PRESET },
  family: { ...INFRA_ONLY_PRESET },
  young_professional: { ...INFRA_ONLY_PRESET },
  senior: { ...INFRA_ONLY_PRESET },
  no_car: { ...INFRA_ONLY_PRESET },
  budget: { ...INFRA_ONLY_PRESET },
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
  const pillars = { ...computeObjectivePillars(p).pillars };
  if (hasCustomGroupMultipliers(groupMultipliers)) {
    pillars.daily_life = dailyLifeForPersonalMatch(p, groupMultipliers).score;
  }

  return {
    ...pillars,
    // Legacy alias for older UI
    housing_value: pillars.housing_affordability,
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

/** Exported walk pillar. Raw wq_* components are not rescored on the client. */
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
