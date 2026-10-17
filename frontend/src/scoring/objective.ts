/**
 * Objective Living Score (objective-v2) — absolute, profile-independent.
 */

import {
  ACCESSIBILITY_BANDS,
  CONFIDENCE_THRESHOLDS,
  OBJECTIVE_NORMALIZATION,
  SCORE_METHOD_VERSION,
  bandScore,
  normalizeByScale,
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
  WEIGHTED_PILLAR_KEYS,
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

/** UI / active metric keys: objective pillars whose contract weight is > 0. */
export const PILLAR_KEYS: ObjectivePillarKey[] = WEIGHTED_PILLAR_KEYS;

/** Default personal weights — copy of OBJECTIVE_WEIGHTS (centrality stays informational). */
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

export function scoreWalk(p: PipelinePoint): ScoredValue {
  const raw = num(p.walking_quality_raw);
  if (raw != null) {
    return {
      score: clamp100(raw),
      coverage: 1,
      sourcesUsed: ['walking_quality_raw'],
      missingInputs: [],
    };
  }
  const wq = num(p.wq_network);
  const ped = num(p.wq_ped_infra);
  const calm = num(p.wq_traffic_calm);
  const env = num(p.wq_environment);
  const parts = [wq, ped, calm, env].filter((v): v is number => v != null);
  if (parts.length) {
    const score = clamp100(parts.reduce((a, b) => a + b, 0) / parts.length);
    return {
      score,
      coverage: parts.length / 4,
      sourcesUsed: ['wq_*'],
      missingInputs: parts.length < 4 ? ['walking_quality_raw'] : [],
    };
  }
  const city = num(p.s_walk);
  if (city != null) {
    return {
      score: clamp100(city),
      coverage: 0.55,
      sourcesUsed: ['s_walk'],
      missingInputs: ['walking_quality_raw'],
    };
  }
  return emptyScored(['walking_quality_raw', 's_walk']);
}

export function scoreGreen(p: PipelinePoint): ScoredValue {
  const strict = num(p.s_green_strict);
  if (strict != null) {
    return {
      score: clamp100(strict),
      coverage: 1,
      sourcesUsed: ['s_green_strict'],
      missingInputs: [],
    };
  }
  const parkDist = num(p.nearest_park_dist_m) ?? num(p.green_dist_m);
  const share = num(p.green_share_inside_500m);
  const canopy = num(p.tree_canopy_pct);
  const parkScore = normalizeByScale(parkDist, OBJECTIVE_NORMALIZATION.park_dist_m);
  const shareScore = normalizeByScale(share, OBJECTIVE_NORMALIZATION.green_share_pct);
  const canopyScore = normalizeByScale(canopy, OBJECTIVE_NORMALIZATION.tree_canopy_pct);
  const parts: { s: number; w: number; src: string }[] = [];
  if (parkScore != null) parts.push({ s: parkScore, w: 0.4, src: 'nearest_park_dist_m' });
  if (shareScore != null) parts.push({ s: shareScore, w: 0.35, src: 'green_share_inside_500m' });
  if (canopyScore != null) parts.push({ s: canopyScore, w: 0.25, src: 'tree_canopy_pct' });
  if (!parts.length) {
    const city = num(p.s_green);
    if (city != null) {
      return {
        score: clamp100(city),
        coverage: 0.55,
        sourcesUsed: ['s_green'],
        missingInputs: ['s_green_strict'],
      };
    }
    return emptyScored(['s_green_strict', 'nearest_park_dist_m']);
  }
  const tw = parts.reduce((a, b) => a + b.w, 0);
  return {
    score: clamp100(parts.reduce((a, b) => a + b.s * b.w, 0) / tw),
    coverage: tw / 1.0,
    sourcesUsed: parts.map((p0) => p0.src),
    missingInputs: [],
  };
}

export function scoreTransit(p: PipelinePoint): ScoredValue {
  const raw = num(p.transit_service_raw) ?? num(p.transit_service_score);
  if (raw != null) {
    return {
      score: clamp100(raw),
      coverage: 1,
      sourcesUsed: [p.transit_service_raw != null ? 'transit_service_raw' : 'transit_service_score'],
      missingInputs: [],
    };
  }
  const city = num(p.s_transit) ?? num(p.s_transit_service);
  if (city != null) {
    return {
      score: clamp100(city),
      coverage: 0.55,
      sourcesUsed: ['s_transit'],
      missingInputs: ['transit_service_score'],
    };
  }
  return emptyScored(['transit_service_score', 's_transit']);
}

export function scoreQuiet(p: PipelinePoint): ScoredValue {
  const db = num(p.noise_db);
  if (db != null) {
    const score = normalizeByScale(db, OBJECTIVE_NORMALIZATION.noise_db);
    const conf = num(p.noise_confidence);
    const sourceFactor = conf != null ? Math.max(0.5, Math.min(1, conf)) : 0.85;
    return {
      score: score != null ? clamp100(score) : null,
      coverage: score != null ? sourceFactor : 0,
      sourcesUsed: ['noise_db'],
      missingInputs: [],
    };
  }
  const quiet = num(p.s_quiet);
  if (quiet != null) {
    return {
      score: clamp100(quiet),
      coverage: 0.55,
      sourcesUsed: ['s_quiet'],
      missingInputs: ['noise_db'],
    };
  }
  return emptyScored(['noise_db', 's_quiet']);
}

/**
 * Absolute housing affordability only — no daily_life/walk/transit blend.
 */
export function scoreHousingAffordability(p: PipelinePoint): ScoredValue {
  const rent = num(p.rent_eur_m2);
  if (rent != null) {
    const score = normalizeByScale(rent, OBJECTIVE_NORMALIZATION.rent_eur_m2);
    const rc = p.rent_confidence;
    let sourceConf = 0.75;
    if (rc === 'low') sourceConf = 0.55;
    else if (rc === 'high') sourceConf = 1;
    else if (typeof rc === 'number') sourceConf = Math.max(0.4, Math.min(1, rc));
    return {
      score: score != null ? clamp100(score) : null,
      coverage: score != null ? sourceConf : 0,
      sourcesUsed: ['rent_eur_m2'],
      missingInputs: [],
    };
  }
  return emptyScored(['rent_eur_m2', 's_housing_affordability']);
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

/**
 * Read pipeline absolute pillars. Daily life is only `s_daily_life`.
 * Other pillars fall back to raw inputs when the exported score is missing.
 */
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
  // Absolute pillars already on the hex (schema ≥ 17). No client-side recompute.
  const preDaily = num(p.s_daily_life);
  const daily = scoredFromPrecomputed(preDaily, 's_daily_life');

  const preWalk = num(p.s_walk);
  const walk = preWalk != null
    ? scoredFromPrecomputed(preWalk, 's_walk')
    : scoreWalk(p);

  const preGreen = num(p.s_green) ?? num(p.s_green_strict);
  const green = preGreen != null
    ? scoredFromPrecomputed(preGreen, 's_green')
    : scoreGreen(p);

  const preTransit = num(p.s_transit) ?? num(p.s_transit_service) ?? num(p.transit_service_score);
  const transit = preTransit != null
    ? scoredFromPrecomputed(preTransit, 's_transit')
    : scoreTransit(p);

  const preQuiet = num(p.s_quiet);
  const quiet = preQuiet != null
    ? scoredFromPrecomputed(preQuiet, 's_quiet')
    : scoreQuiet(p);

  const preHousing = num(p.s_housing_affordability);
  const housing = preHousing != null
    ? scoredFromPrecomputed(preHousing, 's_housing_affordability')
    : scoreHousingAffordability(p);

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
    if (s.sourcesUsed.some((src) => src.startsWith('s_') && !src.includes('strict') && !src.includes('kalt'))) {
      if (['s_walk', 's_green', 's_transit', 's_quiet', 's_center'].some((x) => s.sourcesUsed.includes(x))) {
        proxiesUsed.push(key);
      }
    }
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
