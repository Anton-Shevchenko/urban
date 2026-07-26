// @ts-nocheck
/**
 * 15-Minute Living Score engine (Germany-first).
 * Primary map colour = 7-metric living score with profile weight overlays.
 * Match mode kept dormant until foundation validates.
 *
 * Core weights & formulas live in ./formulas — tune them there.
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
  clamp100,
  extractGroupMultipliers,
  extractPillarWeights,
  livingScore,
  pillarScores,
} from './formulas';

export {
  AFFORDABILITY_PENALTY_FOCUS,
  ABSOLUTE_PAINT_PILLAR_THRESHOLD,
  DAILY_LIFE_GROUPS,
  DAILY_LIFE_GROUP_WEIGHTS,
  DAILY_NEED_CATS,
  DAILY_NEEDS_WEIGHTS,
  LIVING_WEIGHTS,
  PILLAR_KEYS,
  PRESETS,
  WALK_DECAY,
  WALK_MINUTE_BAND_X,
  WALK_MINUTE_BAND_Y,
  WALK_PLATEAU,
  clamp100,
  dailyLifeFromGroups,
  deriveUrbanForm,
  deriveWalkingQuality,
  extractGroupMultipliers,
  extractPillarWeights,
  hasCustomGroupMultipliers,
  isUrbanFormBroken,
  livingScore,
  pillarScores,
  shouldPaintAbsolute,
  walkMinuteBandScore,
  walkMinuteDecayScore,
} from './formulas';

export const IMPORTANCE_LABELS = ['Egal', 'Gering', 'Mittel', 'Wichtig', 'Kritisch'];
export const IMPORTANCE_TO_QUANTILE = { 1: 0.25, 2: 0.5, 3: 0.75, 4: 0.9 };
export const PREF_IMPORTANCE = 2;
export const DEFAULT_NEBENKOSTEN_EUR_M2 = 4.0;
export const PREF_PENALTY = 1.2;
export const DEFAULT_SIZE_M2 = 60;

/** Legacy importance keys — used for diagnose map views / rent filter. */
export const IMPORTANCE_KEYS = [
  'center', 'daily_needs', 'transit_service', 'green', 'noise',
  'heat', 'traffic_safety', 'price', 'custom_dest',
  'daily_life', 'walk', 'walking_quality', 'transit', 'centrality', 'quiet', 'housing_value',
  'urban_form',
];
export const PREF_KEYS = ['urban_activity', 'density', 'housing'];

export const SCORE_PROPS = {
  center: 's_center',
  centrality: 's_center',
  daily_needs: 's_daily_needs',
  daily_life: 's_daily_life',
  transit_service: 's_transit_service',
  transit: 's_transit',
  walk: 's_walk',
  walking_quality: 's_walking_quality',
  urban_form: 's_urban_form',
  green: 's_green',
  quiet: 's_quiet',
  noise: 's_noise',
  housing_value: 's_housing_value',
  heat: 's_heat',
  traffic_safety: 's_traffic_safety',
  urban_activity: 's_urban_activity',
  density: 's_density',
  housing: 's_housing',
  living: 's_living',
  price: 's_housing_value',
};

export const FACTOR_LABELS = {
  living: 'Living Score',
  daily_life: 'Alltag',
  walk: 'Gehqualität',
  walking_quality: 'Gehqualität',
  transit: 'ÖPNV',
  green: 'Grün',
  centrality: 'Zentralität',
  center: 'Zentralität',
  quiet: 'Ruhe',
  housing_value: 'Wohnwert',
  urban_form: 'Stadtform',
  daily_needs: 'Alltag',
  transit_service: 'ÖPNV',
  price: 'Wohnwert',
  noise: 'Ruhe',
  heat: 'Hitze',
  traffic_safety: 'Straßenrisiko',
  custom_dest: 'Ziele',
  urban_activity: 'Aktivität',
  density: 'Dichte',
  housing: 'Wohnalter',
};

export const PILLAR_LABELS = {
  daily_life: 'Alltag',
  walk: 'Gehqualität',
  green: 'Grün',
  transit: 'ÖPNV',
  centrality: 'Zentralität',
  quiet: 'Ruhe',
  housing_value: 'Wohnwert',
};

export function percentile(sorted, p) {
  if (!sorted.length) return 50;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

export function thresholdForImportance(importance, percentiles) {
  if (!importance) return null;
  const q = IMPORTANCE_TO_QUANTILE[importance];
  if (q == null || !percentiles) return null;
  if (q <= 0.25) return percentiles.p25;
  if (q <= 0.5) return percentiles.p50;
  if (q <= 0.75) return percentiles.p75;
  return percentiles.p90;
}

export function computeFactorPercentiles(values) {
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

function num(v, fallback = null) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function estimatedMonthlyRent(p, ctx) {
  const cold = Number(p.rent_eur_m2);
  if (!Number.isFinite(cold)) return null;
  const area = ctx.desiredAreaM2 || DEFAULT_SIZE_M2;
  const nk = Number(p.nebenkosten_eur_m2);
  const nkPerM2 = Number.isFinite(nk) ? nk : DEFAULT_NEBENKOSTEN_EUR_M2;
  return (cold + nkPerM2) * area;
}

function budgetAffordScalar(p, ctx) {
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

export function computeCityFactorStats(features, ctx, factorScalarFn) {
  const stats = {};
  const keys = [...PILLAR_KEYS, ...IMPORTANCE_KEYS, ...PREF_KEYS];
  keys.forEach((key) => {
    const vals = features
      .map((f) => factorScalarFn(key, f.properties))
      .filter((v) => v != null && Number.isFinite(v));
    stats[key] = computeFactorPercentiles(vals);
  });
  return stats;
}

export function createScoringEngine(ctx, features) {
  features = features || [];
  let cityFactorStats = null;
  let passingCount = 0;
  let activeProfile = ctx.activeProfile || 'standard';
  let pillarWeights = extractPillarWeights(ctx.pillarWeights || LIVING_WEIGHTS);
  let groupMultipliers = ctx.groupMultipliers || {};
  let affordabilityFocus = Number(ctx.affordabilityFocus) || 0;
  let matchPrefs = normalizeMatchPrefs(ctx.matchPrefs || DEFAULT_MATCH_PREFS);
  let matchRanking = [];
  let matchByH3 = new Map();
  let matchAlternatives = [];

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

  function factorAvailable(key) {
    if (key === 'price') return ctx.hasRent;
    if (key === 'custom_dest') return (ctx.destinations?.length || 0) > 0;
    if (key === 'heat') return ctx.hasExtendedMetrics && ctx.heatHasVariation;
    if (key === 'noise') return ctx.noiseHasVariation !== false;
    if (PILLAR_KEYS.includes(key) || key === 'living') return true;
    if (['daily_needs', 'transit_service', 'traffic_safety', 'density', 'housing'].includes(key)) {
      return ctx.hasExtendedMetrics;
    }
    return true;
  }

  function importanceForKey(key) {
    if (PREF_KEYS.includes(key)) return ctx.prefInclude ? PREF_IMPORTANCE : 0;
    return ctx.weights[key] ?? 0;
  }

  function activeImportanceKeys() {
    // Living-score mode: pillars are always the active breakdown.
    return PILLAR_KEYS.filter((k) => factorAvailable(k));
  }

  function activePrefKeys() {
    return [];
  }

  function activeCriterionKeys() {
    return activeImportanceKeys();
  }

  function factorScalar(key, p) {
    if (key === 'living') return livingScore(p, pillarWeights, groupMultipliers, affordabilityFocus).score;
    if (PILLAR_KEYS.includes(key)) return pillarScores(p, groupMultipliers, affordabilityFocus)[key];
    if (key === 'daily_needs' || key === 'daily_life') {
      return pillarScores(p, groupMultipliers, affordabilityFocus).daily_life;
    }
    if (key === 'transit_service' || key === 'transit') {
      return pillarScores(p, groupMultipliers, affordabilityFocus).transit;
    }
    if (key === 'walking_quality') return pillarScores(p, groupMultipliers, affordabilityFocus).walk;
    if (key === 'urban_form') return num(p.s_urban_form, 50);
    if (key === 'price') {
      const budget = budgetAffordScalar(p, ctx);
      if (budget != null) return budget;
      return num(p.s_rent_relative_city, 50);
    }
    const prop = SCORE_PROPS[key];
    const s = prop ? Number(p[prop]) : NaN;
    if (Number.isFinite(s)) return s;
    return 50;
  }

  function thresholdsForActiveKeys() {
    const out = {};
    PILLAR_KEYS.forEach((key) => { out[key] = 0; });
    return out;
  }

  function evaluateHex(p) {
    const { score, pillars } = livingScore(p, pillarWeights, groupMultipliers, affordabilityFocus);
    const factors = {};
    PILLAR_KEYS.forEach((key) => {
      factors[key] = {
        score: pillars[key],
        threshold: 0,
        passed: true,
        importance: 2,
      };
    });
    // Budget filter: mark as failed if over budget (optional overlay).
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
        livingScore: score,
        pillars,
        matchBreakdown: breakdown,
        dominated,
      };
    }

    return {
      passed,
      priorityScore: score,
      matchScore: score,
      bottleneckMatch: Math.min(...PILLAR_KEYS.map((k) => pillars[k])),
      factors,
      failedFactors: passed ? [] : ['price'],
      activeKeys: PILLAR_KEYS,
      livingScore: score,
      pillars,
    };
  }

  function rebuildCityStats() {
    rebuildMatchRanking();
    cityFactorStats = computeCityFactorStats(features, ctx, factorScalar);
    passingCount = features.reduce((n, f) => n + (evaluateHex(f.properties).passed ? 1 : 0), 0);
    return { cityFactorStats, passingCount };
  }

  function hasPassingHexes() {
    return passingCount > 0;
  }

  function displayScalar(p) {
    if (ctx.scoringMode === 'match') {
      const h3 = String(p.h3 ?? p.h3_index ?? '');
      const cached = matchByH3.get(h3);
      const dominated = cached?.dominated ?? false;
      return matchDisplayScore(p, matchPrefs, dominated);
    }
    const { score } = livingScore(p, pillarWeights, groupMultipliers, affordabilityFocus);
    // Soft budget dimming when over budget
    const budget = budgetAffordScalar(p, ctx);
    if (budget != null && budget < 100) {
      return clamp100(score * (0.55 + 0.45 * (budget / 100)));
    }
    return score;
  }

  function comfortScalar(p) {
    return displayScalar(p);
  }

  function rawComfortScalar(p) {
    if (ctx.scoringMode === 'match') {
      return scoreMatchHex(p, matchPrefs).finalScore;
    }
    return livingScore(p, pillarWeights, groupMultipliers, affordabilityFocus).score;
  }

  function findClosestMatch() {
    let best = null;
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

  function closestMatchMessage() {
    if (passingCount > 0) return null;
    if (!ctx.maxMonthlyBudget) return null;
    return 'Keine Viertel im Budget — Living Score trotzdem farbig (gedimmt).';
  }

  function applyPreset(preset) {
    const resolved = typeof preset === 'string' ? PRESETS[preset] : preset;
    if (!resolved) return rebuildCityStats();
    pillarWeights = extractPillarWeights(resolved);
    groupMultipliers = extractGroupMultipliers(resolved);
    affordabilityFocus = Number(resolved.affordability_focus) || 0;
    ctx.pillarWeights = pillarWeights;
    ctx.groupMultipliers = groupMultipliers;
    ctx.affordabilityFocus = affordabilityFocus;
    activeProfile = resolved._id || activeProfile;
    IMPORTANCE_KEYS.forEach((k) => { ctx.weights[k] = resolved[k] ?? 0; });
    PREF_KEYS.forEach((k) => { ctx.prefTargets[k] = resolved[k] ?? 50; });
    return rebuildCityStats();
  }

  function onlyFactor(key, level) {
    // Diagnose: colour by a single pillar/factor.
    if (PILLAR_KEYS.includes(key) || SCORE_PROPS[key]) {
      ctx._diagnoseKey = level > 0 ? key : null;
    }
    return rebuildCityStats();
  }

  function absScoreForKey(key, p) {
    return factorScalar(key, p);
  }

  if (features.length) rebuildCityStats();

  // Diagnose override on display
  const baseDisplay = displayScalar;
  function comfortWithDiagnose(p) {
    if (ctx._diagnoseKey) return factorScalar(ctx._diagnoseKey, p);
    return baseDisplay(p);
  }

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
    hasPassingHexes,
    getPassingCount: () => passingCount,
    closestMatchMessage,
    findClosestMatch,
    comfortScalar: comfortWithDiagnose,
    rawComfortScalar,
    applyPreset,
    onlyFactor,
    absScoreForKey,
    livingScore: (p) => livingScore(p, pillarWeights, groupMultipliers, affordabilityFocus),
    pillarScores: (p) => pillarScores(p, groupMultipliers, affordabilityFocus),
    getPillarWeights: () => ({ ...pillarWeights }),
    getGroupMultipliers: () => ({ ...groupMultipliers }),
    getAffordabilityFocus: () => affordabilityFocus,
    getScoringMode: () => ctx.scoringMode || 'living',
    getMatchPrefs: () => ({ ...matchPrefs }),
    getMatchRanking: () => matchRanking,
    getMatchAlternatives: () => matchAlternatives,
  };
}

export function createContextFromFeatures(features, meta = {}) {
  const rents = features.map((f) => Number(f.properties.rent_eur_m2)).filter(Number.isFinite);
  const dailyNeedsCategories = Object.fromEntries(DAILY_NEED_CATS.map((c) => [c, true]));
  const heatVals = features.map((f) => Number(f.properties.s_heat)).filter(Number.isFinite);
  const heatSpread = heatVals.length >= 2 ? Math.max(...heatVals) - Math.min(...heatVals) : 0;
  const noiseDbs = features.map((f) => Number(f.properties.noise_db)).filter(Number.isFinite);
  const noiseScores = features.map((f) => Number(f.properties.s_noise)).filter(Number.isFinite);
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
    centerAnchors: meta.center_anchors || [],
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
    scoringMode: 'living', // Match Score deferred until foundation validates
    matchPrefs: { ...DEFAULT_MATCH_PREFS },
  };
}

export function summarizeComfort(features, comfortFn, threshold = 40) {
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

export function findExtremeHex(features, key, mode = 'min') {
  const sorted = [...features].sort((a, b) => {
    const av = Number(a.properties[key]);
    const bv = Number(b.properties[key]);
    return mode === 'min' ? av - bv : bv - av;
  });
  return sorted[0]?.properties;
}

export function countPassingHexes(features, engine) {
  return features.filter((f) => engine.evaluateHex(f.properties).passed).length;
}
