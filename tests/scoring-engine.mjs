/**
 * Threshold-based scoring engine — kept in sync with web/assets/app.js (scoring section).
 * Importance levels map to city-relative percentile thresholds (pass/fail + margin ranking).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const IMPORTANCE_LABELS = ['Egal', 'Gering', 'Mittel', 'Wichtig', 'Kritisch'];
export const IMPORTANCE_TO_QUANTILE = { 1: 0.25, 2: 0.5, 3: 0.75, 4: 0.9 };
export const PREF_IMPORTANCE = 2;
export const DEFAULT_NEBENKOSTEN_EUR_M2 = 4.0;
export const PREF_PENALTY = 1.2;
export const DEFAULT_SIZE_M2 = 60;

export const IMPORTANCE_KEYS = [
  'center', 'daily_needs', 'transit_service', 'green', 'noise',
  'heat', 'traffic_safety', 'price', 'custom_dest',
];
export const PREF_KEYS = ['urban_activity', 'density', 'housing'];

export const SCORE_PROPS = {
  center: 's_center',
  daily_needs: 's_daily_needs',
  transit_service: 's_transit_service',
  green: 's_green',
  noise: 's_noise',
  heat: 's_heat',
  traffic_safety: 's_traffic_safety',
  urban_activity: 's_urban_activity',
  density: 's_density',
  housing: 's_housing',
};

export const FACTOR_LABELS = {
  center: 'Zentrum',
  daily_needs: 'Alltag',
  transit_service: 'ÖPNV',
  green: 'Grün',
  price: 'Miete',
  noise: 'Lärm',
  heat: 'Hitze',
  traffic_safety: 'Straßenrisiko',
  custom_dest: 'Ziele',
  urban_activity: 'Aktivität',
  density: 'Dichte',
  housing: 'Wohnalter',
};

export const DAILY_NEED_CATS = [
  'supermarket', 'bakery', 'pharmacy', 'doctor', 'kita', 'school',
  'restaurant', 'cafe', 'bank', 'sports', 'post', 'park',
];
export const DAILY_NEEDS_WEIGHTS = {
  supermarket: 1.2, bakery: 0.6, pharmacy: 1.0, doctor: 1.0,
  kita: 0.8, school: 0.8, restaurant: 0.5, cafe: 0.4,
  bank: 0.5, sports: 0.6, post: 0.4, park: 0.7,
};

export const PRESETS = {
  balanced: {
    center: 1, daily_needs: 3, transit_service: 3, green: 2, noise: 2,
    heat: 0, traffic_safety: 2, price: 2, custom_dest: 0,
    urban_activity: 50, density: 50, housing: 30,
  },
  quiet: {
    center: 1, daily_needs: 1, transit_service: 2, green: 3, noise: 4,
    heat: 0, traffic_safety: 1, price: 2, custom_dest: 0,
    urban_activity: 20, density: 35, housing: 40,
  },
  central: {
    center: 4, daily_needs: 2, transit_service: 3, green: 0, noise: 0,
    heat: 0, traffic_safety: 0, price: 0, custom_dest: 0,
    urban_activity: 70, density: 65, housing: 35,
  },
  business: {
    center: 2, daily_needs: 2, transit_service: 3, green: 1, noise: 1,
    heat: 0, traffic_safety: 1, price: 1, custom_dest: 0,
    urban_activity: 85, density: 70, housing: 50,
  },
  budget: {
    center: 2, daily_needs: 2, transit_service: 2, green: 2, noise: 2,
    heat: 0, traffic_safety: 1, price: 4, custom_dest: 0,
    urban_activity: 50, density: 40, housing: 60,
  },
};

const ABS_REF = {
  centerMin: { best: 5, worst: 45 },
  noiseDb: { best: 45, worst: 75 },
  heatScore: { best: 80, worst: 20 },
  safetyScore: { best: 80, worst: 20 },
  transitServiceSat: 25.0,
  buildingAge: { best: 2020, worst: 1900 },
};

function clamp100(v) {
  return Math.max(0, Math.min(100, v));
}

function factorRatioMatch(score, threshold) {
  return Math.min(1, score / Math.max(0.001, threshold));
}

function importanceWeight(importance) {
  return [0, 1, 2, 4, 8][importance] || 0;
}

function computeMatchScores(active, factors, passed) {
  const ratios = active.map((k) => factorRatioMatch(factors[k].score, factors[k].threshold));
  const matchScore = clamp100(100 * ratios.reduce((a, b) => a + b, 0) / ratios.length);
  const bottleneckMatch = clamp100(100 * Math.min(...ratios));
  let priorityScore = null;
  if (passed) {
    const margins = active.map((k) => {
      const { score, threshold } = factors[k];
      const denom = Math.max(1, 100 - threshold);
      return (score - threshold) / denom;
    });
    priorityScore = clamp100(100 * margins.reduce((a, b) => a + b, 0) / margins.length);
  }
  return { matchScore: passed ? 100 : matchScore, bottleneckMatch: passed ? 100 : bottleneckMatch, priorityScore };
}

function importanceWeightedScore(active, factors) {
  let sumW = 0;
  let sum = 0;
  active.forEach((k) => {
    const fac = factors[k];
    if (!fac) return;
    const w = importanceWeight(fac.importance);
    if (w <= 0) return;
    sumW += w;
    sum += w * fac.score;
  });
  return sumW > 0 ? clamp100(sum / sumW) : null;
}

function linScore(value, best, worst) {
  const v = Number(value);
  if (!Number.isFinite(v)) return 0;
  return clamp100(100 * (1 - (v - best) / (worst - best)));
}

function logSatScore(value, sat) {
  const v = Number(value);
  if (!Number.isFinite(v) || v <= 0) return 0;
  return clamp100((100 * Math.log1p(v)) / Math.log1p(sat));
}

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

function trafficSafetyStrict(p) {
  const s = Number(p.s_traffic_safety_strict);
  if (Number.isFinite(s)) return s;
  const r = Number(p.road_risk_index);
  if (Number.isFinite(r)) {
    if (r <= 0.17) return 100;
    if (r <= 0.22) return 68;
    if (r <= 0.30) return 42;
    if (r <= 0.38) return 22;
    if (r <= 0.48) return 8;
    return 0;
  }
  return linScore(p.traffic_safety_score ?? 50, ABS_REF.safetyScore.best, ABS_REF.safetyScore.worst);
}

function thresholdMinScore(minutes) {
  const m = Number(minutes);
  if (!Number.isFinite(m)) return 0;
  if (m <= 5) return 100;
  if (m <= 8) return 70;
  if (m <= 12) return 45;
  if (m <= 16) return 25;
  if (m <= 22) return 10;
  if (m <= 30) return 3;
  return 0;
}

function dailyNeedsAvailFromMin(minutes) {
  const m = Number(minutes);
  if (!Number.isFinite(m)) return 0;
  if (m <= 3) return 100;
  if (m <= 5) return 72;
  if (m <= 8) return 48;
  if (m <= 12) return 22;
  if (m <= 16) return 5;
  return 0;
}

function dailyNeedsWeightedCoverage(p, ctx, enabledCats = null) {
  const enabled = enabledCats || DAILY_NEED_CATS.filter((cat) => ctx.dailyNeedsCategories[cat] !== false);
  if (!enabled.length) return null;
  let sumW = 0;
  let sumV = 0;
  enabled.forEach((cat) => {
    const w = DAILY_NEEDS_WEIGHTS[cat] || 1;
    const avail = p[`dn_${cat}_avail`];
    const v = avail != null ? Number(avail) : dailyNeedsAvailFromMin(p[`dn_${cat}_min`]);
    if (!Number.isFinite(v)) return;
    sumW += w;
    sumV += w * v;
  });
  return sumW > 0 ? clamp100(sumV / sumW) : null;
}

function dailyNeedsScalar(p, ctx) {
  const enabled = DAILY_NEED_CATS.filter((cat) => ctx.dailyNeedsCategories[cat] !== false);
  if (!enabled.length) return +p.s_daily_needs || 50;
  if (enabled.length === DAILY_NEED_CATS.length) {
    const s = Number(p.s_daily_needs);
    if (Number.isFinite(s)) return s;
  }
  const coverage = dailyNeedsWeightedCoverage(p, ctx, enabled);
  if (coverage == null) return +p.s_daily_needs || 50;
  const penalty = Number(p.dn_cluster_penalty);
  const bonus = Number(p.dn_dispersion_bonus);
  return clamp100(coverage - (Number.isFinite(penalty) ? penalty : 0) + (Number.isFinite(bonus) ? bonus : 0));
}

function estimatedMonthlyRent(p, ctx) {
  const cold = Number(p.rent_eur_m2);
  if (!Number.isFinite(cold)) return null;
  const area = ctx.desiredAreaM2 || DEFAULT_SIZE_M2;
  const nk = Number(p.nebenkosten_eur_m2);
  const nkPerM2 = Number.isFinite(nk) ? nk : DEFAULT_NEBENKOSTEN_EUR_M2;
  return (cold + nkPerM2) * area;
}

function rentCityRelativeScalar(p, ctx) {
  const s = Number(p.s_rent_relative_city);
  if (Number.isFinite(s)) return s;
  const span = Math.max(0.001, ctx.rentMax - ctx.rentMin);
  const rent = Number(p.rent_eur_m2);
  if (!Number.isFinite(rent)) return 50;
  return Math.max(0, ((ctx.rentMax - rent) / span) * 100);
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

function customDestScalar(p, ctx) {
  if (!ctx.destinations?.length) return 50;
  const row = ctx.customDestMatrix?.[p.h3];
  if (!row) return 30;
  const scores = ctx.destinations.map((dest, i) => {
    const min = row[`dest_${i}_min`];
    return thresholdMinScore(min != null ? min : 99);
  });
  return scores.reduce((a, b) => a + b, 0) / scores.length;
}

function housingAgeScalar(p) {
  const pre = Number(p.share_pre_1949);
  const s50 = Number(p.share_1950_1979);
  const s80 = Number(p.share_1980_1999);
  const neu = Number(p.share_2000_plus);
  if ([pre, s50, s80, neu].every((v) => Number.isFinite(v))) {
    const yearProxy = pre * 1920 + s50 * 1965 + s80 * 1990 + neu * 2015;
    return linScore(yearProxy, ABS_REF.buildingAge.best, ABS_REF.buildingAge.worst);
  }
  const age = Number(p.building_age_median);
  if (Number.isFinite(age)) return linScore(age, ABS_REF.buildingAge.best, ABS_REF.buildingAge.worst);
  return +p.s_housing || 50;
}

function preferenceScalar(key, p, ctx) {
  const target = ctx.prefTargets[key] ?? 50;
  let actual = 50;
  if (key === 'urban_activity') {
    actual = logSatScore(p.urban_activity ?? p.business_count, 120);
  } else if (key === 'density') {
    actual = logSatScore(p.population_density ?? p.urban_activity, 5000);
  } else if (key === 'housing') {
    actual = housingAgeScalar(p);
  }
  return clamp100(100 - Math.abs(actual - target) * PREF_PENALTY);
}

function absScoreForKey(key, p) {
  switch (key) {
    case 'center':
      return thresholdMinScore(p.center_min);
    case 'daily_needs':
      return dailyNeedsScalar(p, { dailyNeedsCategories: {} });
    case 'transit_service':
      return logSatScore(p.transit_service_score ?? p.transport_score, ABS_REF.transitServiceSat);
    case 'green':
      return Number(p.s_green_strict) || Number(p.s_green) || 50;
    case 'noise':
      return linScore(p.noise_db, ABS_REF.noiseDb.best, ABS_REF.noiseDb.worst);
    case 'heat':
      return linScore(p.heat_resilience_score ?? 50, ABS_REF.heatScore.best, ABS_REF.heatScore.worst);
    case 'traffic_safety':
      return trafficSafetyStrict(p);
    case 'price':
      return rentCityRelativeScalar(p, { rentMin: 0, rentMax: 1 });
    default:
      return +p[SCORE_PROPS[key]] || 50;
  }
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

export function computeCityFactorStats(features, ctx, factorScalarFn) {
  const stats = {};
  const keys = [...IMPORTANCE_KEYS, ...PREF_KEYS];
  keys.forEach((key) => {
    const vals = features
      .map((f) => factorScalarFn(key, f.properties))
      .filter((v) => v != null && Number.isFinite(v));
    stats[key] = computeFactorPercentiles(vals);
  });
  return stats;
}

export function createScoringEngine(ctx, features = []) {
  let cityFactorStats = null;
  let passingCount = 0;

  function factorAvailable(key) {
    if (key === 'price') return ctx.hasRent;
    if (key === 'custom_dest') return (ctx.destinations?.length || 0) > 0;
    if (key === 'heat') return ctx.hasExtendedMetrics && ctx.heatHasVariation;
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
    return IMPORTANCE_KEYS.filter((k) => factorAvailable(k) && (ctx.weights[k] || 0) > 0);
  }

  function activePrefKeys() {
    if (!ctx.prefInclude) return [];
    return PREF_KEYS.filter((k) => factorAvailable(k));
  }

  function activeCriterionKeys() {
    const imp = activeImportanceKeys();
    if (imp.length <= 1) return imp;
    return [...imp, ...activePrefKeys()];
  }

  function factorScalar(key, p) {
    if (key === 'daily_needs') return dailyNeedsScalar(p, ctx);
    if (key === 'price') {
      const budget = budgetAffordScalar(p, ctx);
      if (budget != null) return budget;
      return rentCityRelativeScalar(p, ctx);
    }
    if (key === 'custom_dest') return customDestScalar(p, ctx);
    if (PREF_KEYS.includes(key)) return preferenceScalar(key, p, ctx);
    const prop = SCORE_PROPS[key];
    const s = prop ? Number(p[prop]) : NaN;
    if (Number.isFinite(s)) return s;
    return absScoreForKey(key, p);
  }

  function thresholdsForActiveKeys() {
    const out = {};
    activeCriterionKeys().forEach((key) => {
      const imp = importanceForKey(key);
      out[key] = thresholdForImportance(imp, cityFactorStats?.[key]);
    });
    return out;
  }

  function evaluateHex(p) {
    const keys = activeCriterionKeys();
    const factors = {};
    const active = keys.filter((k) => importanceForKey(k) > 0);

    if (!active.length) {
      return {
        passed: false,
        priorityScore: null,
        matchScore: null,
        factors,
        failedFactors: [],
        activeKeys: active,
      };
    }

    active.forEach((key) => {
      const importance = importanceForKey(key);
      const threshold = thresholdForImportance(importance, cityFactorStats?.[key]) ?? 0;
      const score = factorScalar(key, p);
      factors[key] = {
        score,
        threshold,
        passed: score >= threshold,
        importance,
      };
    });

    const passed = active.every((k) => factors[k].passed);
    const failedFactors = active.filter((k) => !factors[k].passed);
    const scores = computeMatchScores(active, factors, passed);

    return {
      passed,
      priorityScore: scores.priorityScore,
      matchScore: scores.matchScore,
      bottleneckMatch: scores.bottleneckMatch,
      factors,
      failedFactors,
      activeKeys: active,
    };
  }

  function rebuildCityStats() {
    cityFactorStats = computeCityFactorStats(features, ctx, factorScalar);
    passingCount = features.reduce((n, f) => n + (evaluateHex(f.properties).passed ? 1 : 0), 0);
    return { cityFactorStats, passingCount };
  }

  function hasPassingHexes() {
    return passingCount > 0;
  }

  function displayScalar(p) {
    const ev = evaluateHex(p);
    if (!ev.activeKeys.length) return null;

    if (ev.activeKeys.length === 1) {
      const fac = ev.factors[ev.activeKeys[0]];
      return fac ? clamp100(fac.score) : null;
    }

    return importanceWeightedScore(ev.activeKeys, ev.factors);
  }

  function comfortScalar(p) {
    return displayScalar(p);
  }

  function rawComfortScalar(p) {
    return displayScalar(p);
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
    const active = activeCriterionKeys().filter((k) => importanceForKey(k) > 0);
    if (!active.length) return null;

    const closest = findClosestMatch();
    if (!closest) {
      return 'Keine Viertel gefunden, die Ihren Kriterien entsprechen.';
    }

    const failed = closest.eval.failedFactors.map((k) => {
      const f = closest.eval.factors[k];
      const label = FACTOR_LABELS[k] || k;
      return `${label} (${Math.round(f.score)}/${Math.round(f.threshold)})`;
    });

    return `Keine Viertel erfüllen alle Kriterien. Nächstes Match: ${Math.round(closest.eval.matchScore)}%${failed.length ? ` — scheitert an: ${failed.join(', ')}` : ''}.`;
  }

  function applyPreset(preset) {
    IMPORTANCE_KEYS.forEach((k) => { ctx.weights[k] = preset[k] ?? 0; });
    PREF_KEYS.forEach((k) => { ctx.prefTargets[k] = preset[k] ?? 50; });
    return rebuildCityStats();
  }

  function onlyFactor(key, level) {
    IMPORTANCE_KEYS.forEach((k) => { ctx.weights[k] = k === key ? level : 0; });
    ctx.prefInclude = false;
    return rebuildCityStats();
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
    hasPassingHexes,
    getPassingCount: () => passingCount,
    closestMatchMessage,
    findClosestMatch,
    comfortScalar,
    rawComfortScalar,
    applyPreset,
    onlyFactor,
    absScoreForKey,
  };
}

export function createContextFromFeatures(features, meta = {}) {
  const rents = features.map((f) => Number(f.properties.rent_eur_m2)).filter(Number.isFinite);
  const dailyNeedsCategories = Object.fromEntries(DAILY_NEED_CATS.map((c) => [c, true]));
  const heatVals = features.map((f) => Number(f.properties.s_heat)).filter(Number.isFinite);
  const heatSpread = heatVals.length >= 2 ? Math.max(...heatVals) - Math.min(...heatVals) : 0;
  return {
    weights: {},
    prefTargets: { urban_activity: 50, density: 50, housing: 30 },
    prefInclude: false,
    centerAnchors: meta.center_anchors || [],
    rentMin: rents.length ? Math.min(...rents) : 0,
    rentMax: rents.length ? Math.max(...rents) : 1,
    hasRent: meta.has_rent !== false,
    hasExtendedMetrics: Number(meta.pipeline_version) >= 3,
    heatHasVariation: heatSpread > 1,
    destinations: [],
    customDestMatrix: {},
    dailyNeedsCategories,
    desiredAreaM2: DEFAULT_SIZE_M2,
    maxMonthlyBudget: null,
  };
}

export function loadMunichFixtures() {
  const path = join(__dirname, '..', 'frontend', 'public', 'data', 'hexes.geojson');
  const geo = JSON.parse(readFileSync(path, 'utf8'));
  return { features: geo.features, meta: geo.meta || {} };
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
