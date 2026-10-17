/**
 * Objective Living Score (objective-v2) — absolute, profile-independent.
 */

import {
  ACCESSIBILITY_BANDS,
  CHOICE_WEIGHT,
  CONFIDENCE_THRESHOLDS,
  NEAREST_WEIGHT,
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
 * Category score = 0.75×nearest + 0.25×choice when choice (avail) exists;
 * otherwise nearest only with reduced coverage.
 */
export function categoryScoredValue(
  p: PipelinePoint,
  cat: string,
): ScoredValue {
  const mins = num(p[`dn_${cat}_min`]);
  const avail = num(p[`dn_${cat}_avail`]);
  const nearest = mins != null
    ? categoryAccessibilityScore(cat, mins)
    : (avail != null ? clamp100(avail) : null);

  if (nearest == null) {
    return emptyScored([`dn_${cat}_min`]);
  }

  const sourcesUsed = mins != null ? [`dn_${cat}_min`] : [`dn_${cat}_avail`];
  const missingInputs: string[] = [];

  if (avail != null && mins != null) {
    const choice = clamp100(avail);
    sourcesUsed.push(`dn_${cat}_avail`);
    return {
      score: clamp100(NEAREST_WEIGHT * nearest + CHOICE_WEIGHT * choice),
      coverage: 1,
      sourcesUsed,
      missingInputs,
    };
  }

  if (mins != null && avail == null) {
    missingInputs.push(`dn_${cat}_avail`);
    return {
      score: nearest,
      coverage: NEAREST_WEIGHT, // choice missing
      sourcesUsed,
      missingInputs,
    };
  }

  // avail-only path (proxy)
  return {
    score: nearest,
    coverage: 0.85,
    sourcesUsed,
    missingInputs: [`dn_${cat}_min`],
  };
}

export function scoreDailyLifeGroup(
  p: PipelinePoint,
  group: string,
): ScoredValue {
  const catWeights = DAILY_LIFE_CATEGORY_WEIGHTS[group];
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
 * Daily life from weighted categories (never max within group).
 * Does not use precomputed dl_* (those used max aggregation).
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
    const mult = groupMultipliers?.[multKey] ?? 1;
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

export function scoreDailyLife(p: PipelinePoint): ScoredValue {
  return scoredFromPrecomputed(num(p.s_daily_life), 's_daily_life');
}

export function scoreWalk(p: PipelinePoint): ScoredValue {
  return scoredFromPrecomputed(num(p.s_walk), 's_walk');
}

export function scoreGreen(p: PipelinePoint): ScoredValue {
  return scoredFromPrecomputed(num(p.s_green), 's_green');
}

export function scoreTransit(p: PipelinePoint): ScoredValue {
  return scoredFromPrecomputed(num(p.s_transit), 's_transit');
}

export function scoreQuiet(p: PipelinePoint): ScoredValue {
  return scoredFromPrecomputed(num(p.s_quiet), 's_quiet');
}

/**
 * Absolute housing affordability only — no daily_life/walk/transit blend.
 */
export function scoreHousingAffordability(p: PipelinePoint): ScoredValue {
  return scoredFromPrecomputed(num(p.s_housing_affordability), 's_housing_affordability');
}

/** Informational / personal-only centrality. */
export function scoreCentrality(p: PipelinePoint): ScoredValue {
  return scoredFromPrecomputed(num(p.s_center), 's_center');
}

export type ObjectivePillarBundle = {
  pillars: Record<PersonalPillarKey, number | null>;
  coverage: Record<PersonalPillarKey, number>;
  scored: Record<PersonalPillarKey, ScoredValue>;
  missingData: string[];
  proxiesUsed: string[];
};

/** Canonical exported pillar. Missing → null; no proxy and no alias. */
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
  // Schema ≥18 guarantees these fields. A missing pillar stays null.
  const daily = scoreDailyLife(p);
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
  const proxiesUsed: string[] = [];

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
    proxiesUsed: [...new Set(proxiesUsed)],
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
