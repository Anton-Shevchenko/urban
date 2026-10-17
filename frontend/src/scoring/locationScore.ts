/**
 * Assembles LocationScoreResult: objective + personal match + city percentile.
 */

import { SCORE_METHOD_VERSION } from './normalization';
import { clamp100, num } from './num';
import {
  LIVING_WEIGHTS,
  OBJECTIVE_PILLAR_KEYS,
  PERSONAL_PILLAR_KEYS,
  buildDiagnostics,
  computeObjectivePillars,
  computeObjectiveScore,
  dailyLifeFromGroups,
} from './objective';
import type {
  LocationScoreResult,
  PersonalPillarKey,
  PipelinePoint,
} from './types';

/** Precomputed city objective index for O(log n) percentiles. */
export type CityObjectiveIndex = {
  byH3: Map<string, number | null>;
  /** Sorted finite objective scores ascending. */
  sorted: number[];
};

export type PersonalScoreOptions = {
  pillarWeights?: Record<string, number>;
  groupMultipliers?: Record<string, number> | null;
  affordabilityFocus?: number;
  /** Precomputed city percentile 0–100, or null. */
  cityPercentile?: number | null;
};

/**
 * Smooth affordability penalty for Personal Match only.
 * No hard threshold at 0.45 — strength scales continuously with focus × expensiveLevel.
 */
export function personalAffordabilityMultiplier(
  relativeAffordability: number | null,
  affordabilityFocus: number,
): number {
  const focus = Math.max(0, Math.min(1, affordabilityFocus || 0));
  if (focus <= 0 || relativeAffordability == null) return 1;
  const expensiveLevel = Math.max(0, (25 - relativeAffordability) / 25);
  const penaltyStrength = focus * expensiveLevel;
  return 1 - 0.18 * penaltyStrength;
}

export function computePersonalMatchScore(
  pillars: Record<PersonalPillarKey, number | null>,
  pillarWeights: Record<string, number>,
  p: PipelinePoint,
  options: {
    groupMultipliers?: Record<string, number> | null;
    affordabilityFocus?: number;
  } = {},
): { score: number | null; coverage: number } {
  const focus = Math.max(0, Math.min(1, Number(options.affordabilityFocus) || 0));
  const weights = { ...pillarWeights };

  // When group multipliers present, recompute daily_life with personal weights.
  let dailyLife = pillars.daily_life;
  if (options.groupMultipliers && Object.keys(options.groupMultipliers).length) {
    const dl = dailyLifeFromGroups(p, options.groupMultipliers);
    dailyLife = dl.score;
  }

  // Personal affordability: blend housing toward city-relative cheapness when focused.
  let housing = pillars.housing_affordability;
  const rel = num(p.s_rent_relative_city);
  if (housing != null && rel != null && focus > 0) {
    housing = focus * rel + (1 - focus) * housing;
  } else if (housing == null && rel != null && focus > 0) {
    housing = rel;
  }

  const effective: Record<string, number | null> = {
    ...pillars,
    daily_life: dailyLife,
    housing_affordability: housing,
  };

  let sum = 0;
  let totalW = 0;
  let covW = 0;
  let covDen = 0;

  for (const key of PERSONAL_PILLAR_KEYS) {
    const w = Number(weights[key]) || 0;
    if (w <= 0) continue;
    covDen += w;
    const score = effective[key];
    if (score == null || !Number.isFinite(score)) continue;
    sum += w * score;
    totalW += w;
    covW += w;
  }

  if (totalW <= 0) {
    return { score: null, coverage: 0 };
  }

  let score = clamp100(sum / totalW);
  score = clamp100(score * personalAffordabilityMultiplier(rel, focus));
  return {
    score,
    coverage: covDen > 0 ? covW / covDen : 0,
  };
}

export function locationScore(
  p: PipelinePoint,
  options: PersonalScoreOptions = {},
): LocationScoreResult {
  const pillarWeights = options.pillarWeights ?? LIVING_WEIGHTS;
  const groupMultipliers = options.groupMultipliers ?? null;
  const focus = options.affordabilityFocus ?? 0;

  const bundle = computeObjectivePillars(p, null);
  // Always recompute from OBJECTIVE_WEIGHTS (infra-only ≡ daily_life).
  // Do not prefer stale pipeline s_objective / s_living composites.
  const { objectiveScore, confidence, weightedContributions } = computeObjectiveScore(bundle);

  const personal = computePersonalMatchScore(
    bundle.pillars,
    pillarWeights,
    p,
    { groupMultipliers, affordabilityFocus: focus },
  );

  const cityPercentile = options.cityPercentile ?? null;

  const diagnostics = buildDiagnostics(
    objectiveScore,
    personal.score,
    cityPercentile,
    confidence,
    weightedContributions,
    bundle.missingData,
    bundle.proxiesUsed,
  );

  return {
    objectiveScore,
    personalMatchScore: personal.score,
    cityPercentile,
    confidence,
    pillars: bundle.pillars,
    pillarCoverage: bundle.coverage,
    missingData: bundle.missingData,
    diagnostics,
    scoreMethodVersion: SCORE_METHOD_VERSION,
    // TODO: deprecate — older clients expect `score`
    score: objectiveScore,
  };
}

/**
 * City percentile: share of points with lower objectiveScore (0–100).
 * Pass `sorted: true` when `scores` is already ascending finite numbers.
 */
export function cityPercentileForScore(
  objectiveScore: number | null,
  scores: Array<number | null>,
  opts: { sorted?: boolean } = {},
): number | null {
  if (objectiveScore == null || !Number.isFinite(objectiveScore)) return null;
  let known: number[];
  if (opts.sorted) {
    known = scores as number[];
  } else {
    known = scores.filter((v): v is number => v != null && Number.isFinite(v));
    known.sort((a, b) => a - b);
  }
  if (known.length < 2) return null;
  // Binary search: count of values strictly < objectiveScore
  let lo = 0;
  let hi = known.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (known[mid]! < objectiveScore) lo = mid + 1;
    else hi = mid;
  }
  return clamp100((lo / (known.length - 1)) * 100);
}

/** Objective-only score for city index (no personal match work). */
export function objectiveScoreOnly(p: PipelinePoint): number | null {
  // Infra-only: recompute from weights (= daily_life), ignore stale composites.
  const bundle = computeObjectivePillars(p, null);
  return computeObjectiveScore(bundle).objectiveScore;
}

export function buildCityObjectiveIndex(
  features: Array<{ properties: PipelinePoint }>,
): CityObjectiveIndex {
  const byH3 = new Map<string, number | null>();
  const sorted: number[] = [];
  for (const f of features) {
    const p = f.properties;
    const h3 = String(p.h3 ?? p.h3_index ?? '');
    // Infra-only: objectiveScoreOnly ≡ daily_life from current weights.
    const objectiveScore = objectiveScoreOnly(p);
    if (h3) byH3.set(h3, objectiveScore);
    if (objectiveScore != null) sorted.push(objectiveScore);
  }
  sorted.sort((a, b) => a - b);
  return { byH3, sorted };
}

/** @deprecated Prefer CityObjectiveIndex; kept for Map-shaped callers. */
export function buildCityObjectiveMap(
  features: Array<{ properties: PipelinePoint }>,
): Map<string, number | null> {
  return buildCityObjectiveIndex(features).byH3;
}

export function resolveCityPercentile(
  p: PipelinePoint,
  index: CityObjectiveIndex | Map<string, number | null> | undefined,
): number | null {
  if (!index) return null;
  const h3 = String(p.h3 ?? p.h3_index ?? '');
  if (index instanceof Map) {
    if (index.size < 2) return null;
    const mine = index.get(h3);
    if (mine == null) return null;
    const known = [...index.values()].filter((v): v is number => v != null && Number.isFinite(v));
    known.sort((a, b) => a - b);
    return cityPercentileForScore(mine, known);
  }
  if (index.sorted.length < 2) return null;
  const mine = index.byH3.get(h3);
  if (mine == null) return null;
  return cityPercentileForScore(mine, index.sorted, { sorted: true });
}

/** Objective pillars only (nulls preserved). */
export function objectivePillarScores(p: PipelinePoint): Record<string, number | null> {
  const { pillars } = computeObjectivePillars(p);
  const out: Record<string, number | null> = {};
  for (const k of OBJECTIVE_PILLAR_KEYS) out[k] = pillars[k];
  out.centrality = pillars.centrality;
  return out;
}
