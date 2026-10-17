/**
 * 15-Minute Living Score engine (Germany-first).
 *
 * Default map colour = objective Living Score (absolute).
 * Profiles / sliders affect Personal Match only.
 *
 * Core weights & formulas: ./formulas, ./objective, ./locationScore.
 */

import {
  DEFAULT_MATCH_PREFS,
  computeMatchAlternatives,
  matchDisplayScore,
  normalizeMatchPrefs,
  rankMatchHexes,
  scoreMatchHex,
} from './match';
import {
  DAILY_NEED_CATS,
  LIVING_WEIGHTS,
  PILLAR_KEYS,
  PRESETS,
  buildCityObjectiveIndex,
  clamp100,
  extractGroupMultipliers,
  extractPillarWeights,
  livingScore,
  num,
  pillarScores,
  resolveCityPercentile,
  type CityObjectiveIndex,
} from './formulas';
import {
  MAP_VIEW_METRICS,
  METRIC_LABELS,
  PILLAR_LABELS as CONTRACT_PILLAR_LABELS,
  SCORE_PROPS as CONTRACT_SCORE_PROPS,
} from './generated/contract';
import type {
  HexEval,
  LocationScoreResult,
  MapMetricMode,
  PipelinePoint,
  ScoringContext,
  ScoringEngine,
} from './types';

export {
  AFFORDABILITY_PENALTY_FOCUS,
  ABSOLUTE_PAINT_PILLAR_THRESHOLD,
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
  PRESETS,
  SCORE_METHOD_VERSION,
  WALK_MINUTE_BAND_X,
  WALK_MINUTE_BAND_Y,
  clamp100,
  dailyLifeFromGroups,
  deriveUrbanForm,
  deriveWalkingQuality,
  extractGroupMultipliers,
  extractPillarWeights,
  hasCustomGroupMultipliers,
  isUrbanFormBroken,
  livingScore,
  locationScore,
  num,
  pillarScores,
  shouldPaintAbsolute,
  walkMinuteBandScore,
  walkMinuteDecayScore,
  buildCityObjectiveIndex,
  cityPercentileForScore,
  computePersonalMatchScore,
  confidenceLevel,
  LEGEND_BANDS,
} from './formulas';

export const IMPORTANCE_LABELS = ['Egal', 'Gering', 'Mittel', 'Wichtig', 'Kritisch'];
export const IMPORTANCE_TO_QUANTILE: Record<number, number> = { 1: 0.25, 2: 0.5, 3: 0.75, 4: 0.9 };
export const PREF_IMPORTANCE = 2;
export const DEFAULT_NEBENKOSTEN_EUR_M2 = 4.0;
export const PREF_PENALTY = 1.2;
export const DEFAULT_SIZE_M2 = 60;

/** Legacy importance keys — used for diagnose map views / rent filter. */
export const IMPORTANCE_KEYS = [
  'center', 'daily_needs', 'transit_service', 'green', 'noise',
  'heat', 'traffic_safety', 'price', 'custom_dest',
  'daily_life', 'walk', 'walking_quality', 'transit', 'centrality', 'quiet',
  'housing_value', 'housing_affordability',
  'urban_form',
];
export const PREF_KEYS = ['urban_activity', 'density', 'housing'];

export const SCORE_PROPS: Record<string, string> = { ...CONTRACT_SCORE_PROPS };
export { MAP_VIEW_METRICS };

const MAP_MODE_LABELS: Record<string, string> = {
  objective: 'Infrastruktur',
  personal_match: 'Your Match',
  city_percentile: 'City percentile',
  custom_dest: 'Ziele',
};

export const FACTOR_LABELS: Record<string, string> = {
  ...MAP_MODE_LABELS,
  ...METRIC_LABELS,
};

export const PILLAR_LABELS: Record<string, string> = { ...CONTRACT_PILLAR_LABELS };

export function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 50;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

export function thresholdForImportance(
  importance: number,
  percentiles: { p25: number; p50: number; p75: number; p90: number } | null,
): number | null {
  if (!importance) return null;
  const q = IMPORTANCE_TO_QUANTILE[importance];
  if (q == null || !percentiles) return null;
  if (q <= 0.25) return percentiles.p25;
  if (q <= 0.5) return percentiles.p50;
  if (q <= 0.75) return percentiles.p75;
  return percentiles.p90;
}

export function computeFactorPercentiles(values: number[]) {
  const sorted = [...values].filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) {
    return { p25: 25, p50: 50, p75: 75, p90: 90 };
  }
  return {
    p25: percentile(sorted, 0.25),
    p50: percentile(sorted, 0.5),
    p75: percentile(sorted, 0.75),
    p90: percentile(sorted, 0.9),
  };
}

function estimatedMonthlyRent(p: PipelinePoint, ctx: ScoringContext): number | null {
  const cold = num(p.rent_eur_m2);
  if (cold == null) return null;
  const area = ctx.desiredAreaM2 || DEFAULT_SIZE_M2;
  return cold * area;
}

function budgetAffordScalar(p: PipelinePoint, ctx: ScoringContext): number | null {
  const budget = ctx.maxMonthlyBudget;
  if (!budget || budget <= 0) return null;
  const monthly = estimatedMonthlyRent(p, ctx);
  if (monthly == null) return null;
  if (monthly <= budget) return 100;
  if (monthly <= budget * 1.15) {
    return clamp100(50 + 50 * (1 - (monthly - budget) / (budget * 0.15)));
  }
  if (monthly <= budget * 1.35) {
    return clamp100(50 * (1 - (monthly - budget * 1.15) / (budget * 0.2)));
  }
  return 0;
}

export function computeCityFactorStats(
  features: Array<{ properties: PipelinePoint }>,
  ctx: ScoringContext,
  factorScalarFn: (key: string, p: PipelinePoint) => number | null,
) {
  const stats: Record<string, ReturnType<typeof computeFactorPercentiles>> = {};
  const keys = [...PILLAR_KEYS, ...IMPORTANCE_KEYS, ...PREF_KEYS];
  keys.forEach((key) => {
    const vals = features
      .map((f) => factorScalarFn(key, f.properties))
      .filter((v): v is number => v != null && Number.isFinite(v));
    stats[key] = computeFactorPercentiles(vals);
  });
  void ctx;
  return stats;
}

function parseMapMetricMode(raw: string | null | undefined): MapMetricMode {
  if (!raw || raw === 'comfort' || raw === 'living') return 'objective';
  if (raw === 'objective' || raw === 'personal_match' || raw === 'city_percentile') {
    return raw;
  }
  if (raw.startsWith('pillar:')) return raw as MapMetricMode;
  if (MAP_VIEW_METRICS.includes(raw)) return raw as MapMetricMode;
  // Legacy diagnose / factor map views
  if (PILLAR_KEYS.includes(raw as typeof PILLAR_KEYS[number]) || SCORE_PROPS[raw]) {
    return `pillar:${raw}`;
  }
  return 'objective';
}

export function createScoringEngine(
  ctx: ScoringContext,
  rawFeatures: Array<{ properties?: PipelinePoint | null }> = [],
): ScoringEngine {
  const features = rawFeatures.map((f) => ({
    properties: (f.properties ?? {}) as PipelinePoint,
  }));
  let passingCount = 0;
  let pillarWeights = extractPillarWeights(ctx.pillarWeights || LIVING_WEIGHTS);
  let groupMultipliers = ctx.groupMultipliers || {};
  let affordabilityFocus = Number(ctx.affordabilityFocus) || 0;
  let matchPrefs = normalizeMatchPrefs(ctx.matchPrefs || DEFAULT_MATCH_PREFS);
  let matchRanking: ReturnType<typeof rankMatchHexes> = [];
  let matchByH3 = new Map<string, (typeof matchRanking)[number]>();
  let matchAlternatives: ReturnType<typeof computeMatchAlternatives> = [];
  let cityIndex: CityObjectiveIndex = { byH3: new Map(), sorted: [] };
  ctx.cityObjectiveByH3 = cityIndex.byH3;
  ctx.cityObjectiveSorted = cityIndex.sorted;
  ctx.mapMetricMode = parseMapMetricMode(ctx.mapMetricMode);
  /** Cache full location results; bump generation when personalization changes. */
  let locCache = new Map<string, LocationScoreResult>();
  let locCacheGen = 0;

  function clearLocCache() {
    locCache = new Map();
    locCacheGen += 1;
  }

  function rebuildMatchRanking() {
    matchPrefs = normalizeMatchPrefs(ctx.matchPrefs || matchPrefs);
    if (ctx.scoringMode !== 'match' || !features.length) {
      matchRanking = [];
      matchByH3 = new Map();
      matchAlternatives = [];
      return;
    }
    matchRanking = rankMatchHexes(features, matchPrefs);
    matchByH3 = new Map(matchRanking.map((r) => [r.h3, r]));
    matchAlternatives = computeMatchAlternatives(matchRanking, matchPrefs);
  }

  function factorAvailable(key: string): boolean {
    if (key === 'price') return ctx.hasRent;
    if (key === 'custom_dest') return (ctx.destinations?.length || 0) > 0;
    if (key === 'heat') return ctx.hasExtendedMetrics && ctx.heatHasVariation;
    if (key === 'noise') return ctx.noiseHasVariation !== false;
    if (PILLAR_KEYS.includes(key as typeof PILLAR_KEYS[number]) || key === 'living') return true;
    if (['daily_needs', 'transit_service', 'traffic_safety', 'density', 'housing'].includes(key)) {
      return ctx.hasExtendedMetrics;
    }
    return true;
  }

  function activeImportanceKeys(): string[] {
    return PILLAR_KEYS.filter((k) => factorAvailable(k));
  }

  function activeCriterionKeys(): string[] {
    return activeImportanceKeys();
  }

  function locationFor(p: PipelinePoint): LocationScoreResult {
    void locCacheGen;
    const h3 = String(p.h3 ?? p.h3_index ?? '');
    if (h3 && locCache.has(h3)) return locCache.get(h3)!;
    const cityPercentile = resolveCityPercentile(p, cityIndex);
    const loc = livingScore(p, pillarWeights, groupMultipliers, affordabilityFocus, cityPercentile);
    if (h3) locCache.set(h3, loc);
    return loc;
  }

  function factorScalar(key: string, p: PipelinePoint): number | null {
    if (key === 'living' || key === 'objective') {
      return locationFor(p).objectiveScore;
    }
    if (key === 'personal_match') return locationFor(p).personalMatchScore;
    if (key === 'city_percentile') return locationFor(p).cityPercentile;
    if (PILLAR_KEYS.includes(key as typeof PILLAR_KEYS[number])) {
      return pillarScores(p, groupMultipliers, affordabilityFocus)[key] ?? null;
    }
    if (key === 'daily_life') {
      return pillarScores(p, groupMultipliers, affordabilityFocus).daily_life ?? null;
    }
    if (key === 'transit') {
      return pillarScores(p, groupMultipliers, affordabilityFocus).transit ?? null;
    }
    if (key === 'urban_form') return num(p.s_urban_form);
    if (key === 'price') {
      // Observed city-relative Kaltmiete only. Budget dims in paintScalar
      // and must not replace this score with an affordability stand-in.
      return num(p.s_rent_relative_city);
    }
    const prop = SCORE_PROPS[key];
    if (prop) return num(p[prop]);
    return null;
  }

  function thresholdsForActiveKeys(): Record<string, number | null> {
    const out: Record<string, number | null> = {};
    PILLAR_KEYS.forEach((key) => { out[key] = 0; });
    return out;
  }

  function evaluateHex(p: PipelinePoint): HexEval {
    const loc = locationFor(p);
    const pillars = loc.pillars;
    const factors: HexEval['factors'] = {};
    PILLAR_KEYS.forEach((key) => {
      const s = pillars[key];
      factors[key] = {
        score: s ?? 0,
        threshold: 0,
        passed: s != null,
        importance: 2,
      };
    });
    const budget = budgetAffordScalar(p, ctx);
    let passed = true;
    if (budget != null && budget < 50) {
      passed = false;
      factors.price = { score: budget, threshold: 50, passed: false, importance: 3 };
    }

    if (ctx.scoringMode === 'match') {
      const h3 = String(p.h3 ?? p.h3_index ?? '');
      const cached = matchByH3.get(h3);
      const breakdown = cached?.breakdown ?? scoreMatchHex(p, matchPrefs);
      const dominated = cached?.dominated ?? false;
      breakdown.activeDims.forEach((dim) => {
        factors[`match_${dim}`] = {
          score: breakdown.attributes[dim],
          threshold: breakdown.thresholds[dim],
          passed: breakdown.attributes[dim] >= breakdown.thresholds[dim],
          importance: matchPrefs[dim] >= 70 ? 4 : matchPrefs[dim] >= 40 ? 3 : 2,
        };
      });
      return {
        passed: passed && !dominated,
        priorityScore: breakdown.finalScore,
        matchScore: breakdown.finalScore,
        bottleneckMatch: Math.min(
          ...breakdown.activeDims.map((d) => breakdown.attributes[d]),
          100,
        ),
        factors,
        failedFactors: passed ? (dominated ? ['dominated'] : []) : ['price'],
        activeKeys: breakdown.activeDims.map((d) => `match_${d}`),
        livingScore: loc.objectiveScore,
        objectiveScore: loc.objectiveScore,
        personalMatchScore: loc.personalMatchScore,
        cityPercentile: loc.cityPercentile,
        confidence: loc.confidence,
        pillars,
        matchBreakdown: breakdown,
        dominated,
        locationScore: loc,
      };
    }

    const knownPillarVals = PILLAR_KEYS
      .map((k) => pillars[k])
      .filter((v): v is number => v != null);
    return {
      passed,
      priorityScore: loc.objectiveScore,
      matchScore: loc.personalMatchScore,
      bottleneckMatch: knownPillarVals.length
        ? Math.min(...knownPillarVals)
        : undefined,
      factors,
      failedFactors: passed ? [] : ['price'],
      activeKeys: [...PILLAR_KEYS],
      livingScore: loc.objectiveScore,
      objectiveScore: loc.objectiveScore,
      personalMatchScore: loc.personalMatchScore,
      cityPercentile: loc.cityPercentile,
      confidence: loc.confidence,
      pillars,
      locationScore: loc,
    };
  }

  function rebuildCityStats() {
    rebuildMatchRanking();
    clearLocCache();
    // Objective index once (no personal match) — percentiles are O(log n) lookups after.
    cityIndex = buildCityObjectiveIndex(features);
    ctx.cityObjectiveByH3 = cityIndex.byH3;
    ctx.cityObjectiveSorted = cityIndex.sorted;
    // Skip full-city factor stats on the hot path (debug can recompute lazily).
    // Budget filter: only scan when a budget is set; otherwise all hexes pass.
    if (ctx.maxMonthlyBudget && ctx.maxMonthlyBudget > 0) {
      passingCount = 0;
      for (const f of features) {
        const budget = budgetAffordScalar(f.properties, ctx);
        if (budget == null || budget >= 50) passingCount += 1;
      }
    } else {
      passingCount = features.length;
    }
    return { passingCount };
  }

  function paintScalar(p: PipelinePoint): number | null {
    if (ctx._diagnoseKey) return factorScalar(ctx._diagnoseKey, p);
    if (ctx.scoringMode === 'match') {
      const h3 = String(p.h3 ?? p.h3_index ?? '');
      const cached = matchByH3.get(h3);
      const dominated = cached?.dominated ?? false;
      return matchDisplayScore(p, matchPrefs, dominated);
    }

    const mode = ctx.mapMetricMode || 'objective';
    let score: number | null = null;

    if (mode === 'objective') {
      // Infra-only: city index is rebuilt from daily_life weights, never stale s_living.
      const h3 = String(p.h3 ?? p.h3_index ?? '');
      const fromIndex = h3 ? cityIndex.byH3.get(h3) : undefined;
      score = fromIndex !== undefined
        ? fromIndex
        : locationFor(p).objectiveScore;
    } else if (mode === 'city_percentile') {
      score = resolveCityPercentile(p, cityIndex);
    } else if (typeof mode === 'string' && mode.startsWith('pillar:')) {
      const key = mode.slice('pillar:'.length);
      score = factorScalar(key, p);
    } else if (mode === 'personal_match') {
      score = locationFor(p).personalMatchScore;
    } else if (typeof mode === 'string' && (MAP_VIEW_METRICS.includes(mode) || SCORE_PROPS[mode])) {
      score = factorScalar(mode, p);
    } else {
      score = locationFor(p).objectiveScore;
    }

    // Soft budget dimming when over budget (does not invent a score).
    if (score != null) {
      const budget = budgetAffordScalar(p, ctx);
      if (budget != null && budget < 100) {
        return clamp100(score * (0.55 + 0.45 * (budget / 100)));
      }
    }
    return score;
  }

  function comfortScalar(p: PipelinePoint): number | null {
    return paintScalar(p);
  }

  function rawComfortScalar(p: PipelinePoint): number | null {
    if (ctx.scoringMode === 'match') {
      return scoreMatchHex(p, matchPrefs).finalScore;
    }
    return locationFor(p).objectiveScore;
  }

  function findClosestMatch() {
    let best: { properties: PipelinePoint; eval: HexEval } | null = null;
    let bestMatch = -1;
    for (const f of features) {
      const ev = evaluateHex(f.properties);
      if (ev.matchScore == null) continue;
      if (ev.matchScore > bestMatch) {
        bestMatch = ev.matchScore;
        best = { properties: f.properties, eval: ev };
      }
    }
    return best;
  }

  function closestMatchMessage(): string | null {
    if (passingCount > 0) return null;
    if (!ctx.maxMonthlyBudget) return null;
    return 'Keine Viertel im Budget — Infrastruktur trotzdem farbig (gedimmt).';
  }

  function applyPreset(preset: Record<string, number> | string) {
    const resolved = typeof preset === 'string' ? PRESETS[preset] : preset;
    if (!resolved) return rebuildCityStats();
    pillarWeights = extractPillarWeights(resolved);
    groupMultipliers = extractGroupMultipliers(resolved);
    affordabilityFocus = Number(resolved.affordability_focus) || 0;
    ctx.pillarWeights = pillarWeights;
    ctx.groupMultipliers = groupMultipliers;
    ctx.affordabilityFocus = affordabilityFocus;
    IMPORTANCE_KEYS.forEach((k) => { ctx.weights[k] = resolved[k] ?? 0; });
    clearLocCache();
    return rebuildCityStats();
  }

  function onlyFactor(key: string, level: number) {
    if (PILLAR_KEYS.includes(key as typeof PILLAR_KEYS[number]) || SCORE_PROPS[key]) {
      ctx._diagnoseKey = level > 0 ? key : null;
      if (level > 0) {
        ctx.mapMetricMode = `pillar:${key}`;
      }
    }
    return rebuildCityStats();
  }

  function absScoreForKey(key: string, p: PipelinePoint): number | null {
    return factorScalar(key, p);
  }

  if (features.length) rebuildCityStats();

  return {
    ctx,
    factorAvailable,
    activeImportanceKeys,
    activeCriterionKeys,
    activeAllKeys: activeCriterionKeys,
    factorScalar,
    evaluateHex,
    thresholdsForActiveKeys,
    rebuildCityStats,
    rebuildComfortRemap: rebuildCityStats,
    isComfortRemapActive: () => false,
    hasPassingHexes: () => passingCount > 0,
    getPassingCount: () => passingCount,
    closestMatchMessage,
    findClosestMatch,
    comfortScalar,
    rawComfortScalar,
    applyPreset,
    onlyFactor,
    absScoreForKey,
    livingScore: (p) => locationFor(p),
    locationScore: (p) => locationFor(p),
    pillarScores: (p) => pillarScores(p, groupMultipliers, affordabilityFocus),
    getPillarWeights: () => ({ ...pillarWeights }),
    getGroupMultipliers: () => ({ ...groupMultipliers }),
    getAffordabilityFocus: () => affordabilityFocus,
    getScoringMode: () => ctx.scoringMode || 'living',
    getMatchPrefs: () => ({ ...matchPrefs }),
    getMatchRanking: () => matchRanking,
    getMatchAlternatives: () => matchAlternatives,
    getMapMetricMode: () => ctx.mapMetricMode || 'objective',
    setMapMetricMode: (mode: MapMetricMode) => {
      ctx.mapMetricMode = mode;
      clearLocCache();
    },
  };
}

export function createContextFromFeatures(
  features: Array<{ properties?: PipelinePoint | null }> = [],
  meta: Record<string, unknown> = {},
): ScoringContext {
  const propsList = features.map((f) => (f.properties ?? {}) as PipelinePoint);
  const rents = propsList
    .map((p) => num(p.rent_eur_m2))
    .filter((v): v is number => v != null);
  const dailyNeedsCategories = Object.fromEntries(DAILY_NEED_CATS.map((c) => [c, true]));
  const heatVals = propsList
    .map((p) => num(p.s_heat))
    .filter((v): v is number => v != null);
  const heatSpread = heatVals.length >= 2 ? Math.max(...heatVals) - Math.min(...heatVals) : 0;
  const noiseDbs = propsList
    .map((p) => num(p.noise_db))
    .filter((v): v is number => v != null);
  const noiseScores = propsList
    .map((p) => num(p.s_quiet))
    .filter((v): v is number => v != null);
  const noiseSpread =
    noiseDbs.length >= 2
      ? Math.max(...noiseDbs) - Math.min(...noiseDbs)
      : noiseScores.length >= 2
        ? Math.max(...noiseScores) - Math.min(...noiseScores)
        : 0;
  return {
    weights: {},
    prefTargets: { urban_activity: 50, density: 50, housing: 30 },
    prefInclude: false,
    pillarWeights: { ...LIVING_WEIGHTS },
    groupMultipliers: {},
    affordabilityFocus: 0,
    activeProfile: 'standard',
    _diagnoseKey: null,
    centerAnchors: (meta.center_anchors as unknown[]) || [],
    rentMin: rents.length ? Math.min(...rents) : 0,
    rentMax: rents.length ? Math.max(...rents) : 1,
    hasRent: meta.has_rent !== false,
    hasExtendedMetrics: Number(meta.pipeline_version) >= 3,
    heatHasVariation: heatSpread > 1,
    noiseHasVariation: noiseSpread > 1,
    destinations: [],
    customDestMatrix: {},
    dailyNeedsCategories,
    desiredAreaM2: DEFAULT_SIZE_M2,
    maxMonthlyBudget: null,
    scoringMode: 'living',
    matchPrefs: { ...DEFAULT_MATCH_PREFS },
    mapMetricMode: 'objective',
  };
}

export function summarizeComfort(
  features: Array<{ properties: PipelinePoint }>,
  comfortFn: (p: PipelinePoint) => number | null,
  threshold = 40,
) {
  let red = 0;
  let yellow = 0;
  let green = 0;
  let sum = 0;
  let count = 0;
  for (const f of features) {
    const c = comfortFn(f.properties);
    if (c == null) continue;
    count += 1;
    sum += c;
    if (c < threshold) red += 1;
    else if (c < 70) yellow += 1;
    else green += 1;
  }
  return {
    mean: count ? sum / count : 0,
    red,
    yellow,
    green,
    count,
  };
}

export function findExtremeHex(
  features: Array<{ properties: PipelinePoint }>,
  key: string,
  mode: 'min' | 'max' = 'min',
) {
  const sorted = [...features].sort((a, b) => {
    const av = num(a.properties[key]) ?? (mode === 'min' ? Infinity : -Infinity);
    const bv = num(b.properties[key]) ?? (mode === 'min' ? Infinity : -Infinity);
    return mode === 'min' ? av - bv : bv - av;
  });
  return sorted[0]?.properties;
}

export function countPassingHexes(
  features: Array<{ properties: PipelinePoint }>,
  engine: ScoringEngine,
) {
  return features.filter((f) => engine.evaluateHex(f.properties).passed).length;
}
