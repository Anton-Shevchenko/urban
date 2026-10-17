/**
 * Objective Living Score (objective-v2) — profile-independent.
 *
 * Pillar scores and s_living come from the pipeline export. This module does
 * not refit rent, noise, or green curves. Walk-minute bands remain only so
 * Personal Match can score a daily-life group whose exported dl_* is missing.
 */

import {
  ACCESSIBILITY_BANDS,
  CONFIDENCE_THRESHOLDS,
  SCORE_METHOD_VERSION,
  bandScore,
} from './normalization';
import { clamp100, finiteScore, num } from './num';
import type {
  ObjectivePillarKey,
  PersonalPillarKey,
  PipelinePoint,
  ScoredValue,
  ScoreDiagnostics,
} from './types';

/**
 * Objective weights, daily-life groups and walk bands are generated from
 * contracts/scoring.json — the same file the Python pipeline reads. Never
 * hardcode these numbers here; edit the contract and run `make contract-check`.
 */
import {
  DAILY_LIFE_CATEGORY_WEIGHTS,
  DAILY_LIFE_GROUP_ALIASES,
  DAILY_LIFE_GROUP_WEIGHTS,
  OBJECTIVE_PILLAR_KEYS,
  OBJECTIVE_WEIGHTS,
} from './generated/contract';

export {
  DAILY_LIFE_CATEGORY_WEIGHTS,
  DAILY_LIFE_GROUP_WEIGHTS,
  OBJECTIVE_PILLAR_KEYS,
  OBJECTIVE_WEIGHTS,
};

/** Personal Match may also weight centrality. */
export const PERSONAL_PILLAR_KEYS: PersonalPillarKey[] = [
  ...OBJECTIVE_PILLAR_KEYS,
  'centrality',
];

/** UI / active metric keys — infrastructure only on this branch. */
export const PILLAR_KEYS: PersonalPillarKey[] = ['daily_life'];

/** Default personal weights — infrastructure only (matches OBJECTIVE_WEIGHTS). */
export const LIVING_WEIGHTS: Record<PersonalPillarKey, number> = {
  ...OBJECTIVE_WEIGHTS,
  centrality: 0,
};

/** Legacy group name still emitted by the pipeline (dl_other). */
const GROUP_ALIAS: Record<string, string> = DAILY_LIFE_GROUP_ALIASES;

export const DAILY_LIFE_GROUPS: Record<string, string[]> = Object.fromEntries(
  Object.entries(DAILY_LIFE_CATEGORY_WEIGHTS).map(([g, cats]) => [g, Object.keys(cats)]),
);

export const DAILY_NEED_CATS = [
  'supermarket', 'bakery', 'pharmacy', 'doctor', 'kita', 'school',
  'restaurant', 'cafe', 'bank', 'sports', 'post', 'park',
  'market', 'playground', 'administration', 'clinic',
] as const;

export const DAILY_NEEDS_WEIGHTS: Record<string, number> = {
  supermarket: 1.2, bakery: 0.6, pharmacy: 1.0, doctor: 1.0,
  kita: 0.8, school: 0.8, restaurant: 0.5, cafe: 0.4,
  bank: 0.5, sports: 0.6, post: 0.4, park: 0.7,
  market: 0.8, playground: 0.6, administration: 0.5, clinic: 0.9,
};

export function emptyScored(missing: string[] = []): ScoredValue {
  return { score: null, coverage: 0, sourcesUsed: [], missingInputs: missing };
}

export function walkMinuteBandScore(minutes: unknown): number | null {
  return bandScore(num(minutes), ACCESSIBILITY_BANDS.default);
}

export function categoryAccessibilityScore(cat: string, minutes: unknown): number | null {
  const bands = ACCESSIBILITY_BANDS[cat] ?? ACCESSIBILITY_BANDS.default;
  return bandScore(num(minutes), bands);
}

/**
 * Category score is the contract walk-minute band.
 * `dn_*_avail` is only a fallback when minutes were not exported: it is the
 * same accessibility score (often from an older plateau), not a separate
 * choice measure, so blending it back in flattens neighborhood differences.
 */
export function categoryScoredValue(
  p: PipelinePoint,
  cat: string,
): ScoredValue {
  const mins = num(p[`dn_${cat}_min`]);
  const avail = num(p[`dn_${cat}_avail`]);
  if (mins != null) {
    const nearest = categoryAccessibilityScore(cat, mins);
    if (nearest == null) return emptyScored([`dn_${cat}_min`]);
    return {
      score: clamp100(nearest),
      coverage: 1,
      sourcesUsed: [`dn_${cat}_min`],
      missingInputs: [],
    };
  }
  if (avail != null) {
    return {
      score: clamp100(avail),
      coverage: 0.85,
      sourcesUsed: [`dn_${cat}_avail`],
      missingInputs: [`dn_${cat}_min`],
    };
  }
  return emptyScored([`dn_${cat}_min`]);
}

export function scoreDailyLifeGroup(
  p: PipelinePoint,
  group: string,
): ScoredValue {
  const resolved = GROUP_ALIAS[group] ?? group;
  const catWeights = DAILY_LIFE_CATEGORY_WEIGHTS[resolved];
  if (!catWeights) return emptyScored([`group:${group}`]);

  let sum = 0;
  let totalW = 0;
  let covSum = 0;
  const sourcesUsed: string[] = [];
  const missingInputs: string[] = [];

  for (const [cat, w] of Object.entries(catWeights)) {
    const scored = categoryScoredValue(p, cat);
    sourcesUsed.push(...scored.sourcesUsed);
    missingInputs.push(...scored.missingInputs);
    if (scored.score == null) continue;
    sum += w * scored.score;
    totalW += w;
    covSum += w * scored.coverage;
  }

  if (totalW <= 0) {
    return emptyScored(missingInputs.length ? missingInputs : Object.keys(catWeights).map((c) => `dn_${c}_min`));
  }

  return {
    score: clamp100(sum / totalW),
    coverage: covSum / Object.values(catWeights).reduce((a, b) => a + b, 0),
    sourcesUsed,
    missingInputs,
  };
}

/**
 * Daily life from walk minutes and contract category weights.
 * Ignores exported dl_* — Personal Match uses those via dailyLifeForPersonalMatch.
 */
export function dailyLifeFromGroups(
  p: PipelinePoint,
  groupMultipliers: Record<string, number> | null = null,
): ScoredValue {
  let sum = 0;
  let totalW = 0;
  let covSum = 0;
  let weightSum = 0;
  const sourcesUsed: string[] = [];
  const missingInputs: string[] = [];

  for (const [group, baseW] of Object.entries(DAILY_LIFE_GROUP_WEIGHTS)) {
    const multKey = `dl_${group}`;
    const legacyKey = group === 'leisure' ? 'dl_other' : multKey;
    const mult = groupMultipliers?.[multKey]
      ?? groupMultipliers?.[legacyKey]
      ?? 1;
    const ww = baseW * (Number.isFinite(mult) ? mult : 1);
    weightSum += ww;
    const scored = scoreDailyLifeGroup(p, group);
    sourcesUsed.push(...scored.sourcesUsed);
    missingInputs.push(...scored.missingInputs);
    if (scored.score == null) continue;
    sum += ww * scored.score;
    totalW += ww;
    covSum += ww * scored.coverage;
  }

  if (totalW <= 0) {
    return emptyScored(missingInputs.length ? missingInputs : ['daily_life']);
  }

  return {
    score: clamp100(sum / totalW),
    coverage: weightSum > 0 ? covSum / weightSum : 0,
    sourcesUsed: [...new Set(sourcesUsed)],
    missingInputs: [...new Set(missingInputs)],
  };
}

/**
 * Personal Match daily life. Exported dl_* already include pipeline bonuses;
 * a group falls back to walk-minute bands only when its dl_* score is absent.
 */
export function dailyLifeForPersonalMatch(
  p: PipelinePoint,
  groupMultipliers: Record<string, number> | null = null,
): ScoredValue {
  let sum = 0;
  let totalW = 0;
  let covSum = 0;
  let weightSum = 0;
  const sourcesUsed: string[] = [];
  const missingInputs: string[] = [];

  for (const [group, baseW] of Object.entries(DAILY_LIFE_GROUP_WEIGHTS)) {
    const multKey = `dl_${group}`;
    const legacyKey = group === 'leisure' ? 'dl_other' : multKey;
    const mult = groupMultipliers?.[multKey]
      ?? groupMultipliers?.[legacyKey]
      ?? 1;
    const ww = baseW * (Number.isFinite(mult) ? mult : 1);
    weightSum += ww;

    const exported = num(p[multKey]) ?? (group === 'leisure' ? num(p.dl_other) : null);
    const scored = exported != null
      ? scoredFromPrecomputed(exported, multKey)
      : scoreDailyLifeGroup(p, group);
    sourcesUsed.push(...scored.sourcesUsed);
    missingInputs.push(...scored.missingInputs);
    if (scored.score == null) continue;
    sum += ww * scored.score;
    totalW += ww;
    covSum += ww * scored.coverage;
  }

  if (totalW <= 0) {
    return emptyScored(missingInputs.length ? missingInputs : ['daily_life']);
  }

  return {
    score: clamp100(sum / totalW),
    coverage: weightSum > 0 ? covSum / weightSum : 0,
    sourcesUsed: [...new Set(sourcesUsed)],
    missingInputs: [...new Set(missingInputs)],
  };
}

export function scoreWalk(p: PipelinePoint): ScoredValue {
  const value = num(p.s_walk) ?? num(p.s_walking_quality) ?? num(p.walking_quality_score);
  return scoredFromPrecomputed(value, 's_walk');
}

export function scoreGreen(p: PipelinePoint): ScoredValue {
  const value = num(p.s_green);
  if (value != null) return scoredFromPrecomputed(value, 's_green');
  return scoredFromPrecomputed(num(p.s_green_strict), 's_green_strict');
}

export function scoreTransit(p: PipelinePoint): ScoredValue {
  const value = num(p.s_transit) ?? num(p.s_transit_service) ?? num(p.transit_service_score);
  return scoredFromPrecomputed(value, 's_transit');
}

export function scoreQuiet(p: PipelinePoint): ScoredValue {
  const value = num(p.s_quiet) ?? num(p.s_noise);
  return scoredFromPrecomputed(value, 's_quiet');
}

/**
 * Exported cold-rent benchmark only. rent_eur_m2 is not rescored here.
 */
export function scoreHousingAffordability(p: PipelinePoint): ScoredValue {
  const value = num(p.s_housing_affordability)
    ?? num(p.s_rent_kalt_benchmark)
    ?? num(p.s_rent_strict);
  return scoredFromPrecomputed(value, 's_housing_affordability');
}

/** Informational / personal-only centrality. */
export function scoreCentrality(p: PipelinePoint): ScoredValue {
  const strict = num(p.s_center_strict);
  if (strict != null) {
    return {
      score: clamp100(strict),
      coverage: 1,
      sourcesUsed: ['s_center_strict'],
      missingInputs: [],
    };
  }
  const city = num(p.s_center);
  if (city != null) {
    return {
      score: clamp100(city),
      coverage: 0.7,
      sourcesUsed: ['s_center'],
      missingInputs: ['s_center_strict'],
    };
  }
  return emptyScored(['s_center']);
}

export type ObjectivePillarBundle = {
  pillars: Record<PersonalPillarKey, number | null>;
  coverage: Record<PersonalPillarKey, number>;
  scored: Record<PersonalPillarKey, ScoredValue>;
  missingData: string[];
  proxiesUsed: string[];
};

/** Use an exported 0–100 pillar. Missing stays missing — no second curve. */
function scoredFromPrecomputed(
  value: number | null,
  source: string,
  coverage = 1,
): ScoredValue {
  if (value == null) return emptyScored([source]);
  return {
    score: clamp100(value),
    coverage,
    sourcesUsed: [source],
    missingInputs: [],
  };
}

export function computeObjectivePillars(
  p: PipelinePoint,
  groupMultipliers: Record<string, number> | null = null,
): ObjectivePillarBundle {
  void groupMultipliers;
  // Exported pillars, including when walk minutes are also present.
  // A contract change shows up after re-export; recomputing here disagreed
  // with the s_living hex-svc sends to chat.
  const daily = scoredFromPrecomputed(
    num(p.s_daily_life) ?? num(p.s_daily_needs),
    's_daily_life',
  );
  const walk = scoreWalk(p);
  const green = scoreGreen(p);
  const transit = scoreTransit(p);
  const quiet = scoreQuiet(p);
  const housing = scoreHousingAffordability(p);
  const centrality = scoreCentrality(p);

  const scored: Record<PersonalPillarKey, ScoredValue> = {
    daily_life: daily,
    walk,
    green,
    transit,
    quiet,
    housing_affordability: housing,
    centrality,
  };

  const pillars = {} as Record<PersonalPillarKey, number | null>;
  const coverage = {} as Record<PersonalPillarKey, number>;
  const missingData: string[] = [];

  for (const key of PERSONAL_PILLAR_KEYS) {
    const s = scored[key];
    pillars[key] = finiteScore(s.score);
    coverage[key] = s.coverage;
    missingData.push(...s.missingInputs);
  }

  return {
    pillars,
    coverage,
    scored,
    missingData: [...new Set(missingData)],
    proxiesUsed: [],
  };
}

export function computeObjectiveScore(
  bundle: ObjectivePillarBundle,
  weights: Record<ObjectivePillarKey, number> = OBJECTIVE_WEIGHTS,
): {
  objectiveScore: number | null;
  confidence: number;
  weightedContributions: Partial<Record<ObjectivePillarKey, number>>;
} {
  let sum = 0;
  let totalW = 0;
  let confNum = 0;
  let confDen = 0;
  const weightedContributions: Partial<Record<ObjectivePillarKey, number>> = {};

  for (const key of OBJECTIVE_PILLAR_KEYS) {
    const w = weights[key] ?? 0;
    if (w <= 0) continue;
    confDen += w;
    const cov = bundle.coverage[key] ?? 0;
    confNum += w * cov;
    const score = bundle.pillars[key];
    if (score == null) continue;
    sum += w * score;
    totalW += w;
    weightedContributions[key] = w * score;
  }

  const confidence = confDen > 0 ? confNum / confDen : 0;
  if (confidence < CONFIDENCE_THRESHOLDS.nullScore || totalW <= 0) {
    return { objectiveScore: null, confidence, weightedContributions };
  }
  return {
    objectiveScore: clamp100(sum / totalW),
    confidence,
    weightedContributions,
  };
}

export function buildDiagnostics(
  objectiveScore: number | null,
  personalMatchScore: number | null,
  cityPercentile: number | null,
  confidence: number,
  weightedContributions: Partial<Record<ObjectivePillarKey, number>>,
  missingInputs: string[],
  proxiesUsed: string[],
): ScoreDiagnostics {
  return {
    objectiveScore,
    personalMatchScore,
    cityPercentile,
    confidence,
    weightedContributions,
    missingInputs,
    proxiesUsed,
    scoreMethodVersion: SCORE_METHOD_VERSION,
  };
}

export { SCORE_METHOD_VERSION };
