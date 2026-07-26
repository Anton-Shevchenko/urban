/* Wohn-Index — importance-aware hybrid scoring + metric taxonomy */

const CFG = {
  styleUrl: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
  dataUrl: 'data/hexes.geojson',
  apiBase: (window.API_BASE || '').replace(/\/$/, ''),
  center: [11.5755, 48.1374],
  zoom: 10.8,
};

const STEP_LABELS = ['Egal', 'Gering', 'Mittel', 'Wichtig', 'Kritisch'];
const IMPORTANCE_TO_QUANTILE = { 1: 0.25, 2: 0.5, 3: 0.75, 4: 0.9 };
const PREF_IMPORTANCE = 2;
const SCORE_FLOOR_SOFT = 0.1;
const NO_CRITERIA_COLOR = '#BDBDBD';
const DEFAULT_NEBENKOSTEN_EUR_M2 = 4.0;
const PREF_PENALTY = 1.2;

const METRIC_TYPES = {
  center: 'objective_positive',
  daily_needs: 'objective_positive',
  transit_service: 'objective_positive',
  green: 'objective_positive',
  price: 'objective_positive',
  custom_dest: 'objective_positive',
  noise: 'objective_negative',
  heat: 'objective_negative',
  traffic_safety: 'objective_negative',
  urban_activity: 'preference',
  density: 'preference',
  housing: 'preference',
};

const IMPORTANCE_KEYS = [
  'center', 'daily_needs', 'transit_service', 'green', 'noise',
  'heat', 'traffic_safety', 'price', 'custom_dest',
];
const PREF_KEYS = ['urban_activity', 'density', 'housing'];
const ALL_FACTOR_KEYS = [...IMPORTANCE_KEYS, ...PREF_KEYS];

const SCORE_PROPS = {
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

const FACTOR_LABELS = {
  center: 'Zentrum',
  daily_needs: 'Alltag',
  transit_service: 'ÖPNV',
  green: 'Grün',
  price: 'Miete',
  noise: 'Lärm',
  heat: 'Hitze (OSM)',
  traffic_safety: 'Straßenrisiko',
  custom_dest: 'Ziele',
  urban_activity: 'Aktivität',
  density: 'Dichte',
  housing: 'Wohnalter',
};

const DAILY_NEED_CATS = [
  ['supermarket', 'Supermarkt', 1.2],
  ['bakery', 'Bäckerei', 0.6],
  ['pharmacy', 'Apotheke', 1.0],
  ['doctor', 'Arzt', 1.0],
  ['kita', 'Kita', 0.8],
  ['school', 'Schule', 0.8],
  ['restaurant', 'Restaurant', 0.5],
  ['cafe', 'Café', 0.4],
  ['bank', 'Bank', 0.5],
  ['sports', 'Sport', 0.6],
  ['post', 'Post', 0.4],
  ['park', 'Park', 0.7],
];
const DAILY_NEEDS_WEIGHTS = Object.fromEntries(DAILY_NEED_CATS.map(([cat, , w]) => [cat, w]));
const DAILY_NEEDS_STORAGE = 'wohnindex.dailyNeedsCategories';
const BUDGET_STORAGE = 'wohnindex.maxMonthlyBudget';
const AREA_STORAGE = 'wohnindex.desiredAreaM2';
const MAP_VIEW_STORAGE = 'wohnindex.mapView';
const COMPARE_STORAGE_KEY = 'wohnindex.comparison';
const DEST_STORAGE_KEY = 'wohnindex.destinations';
const DEFAULT_SIZE_M2 = 60;

const PRESETS = {
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
  family: {
    center: 2, daily_needs: 4, transit_service: 2, green: 3, noise: 3,
    heat: 0, traffic_safety: 1, price: 3, custom_dest: 0,
    urban_activity: 40, density: 45, housing: 25,
  },
  budget: {
    center: 2, daily_needs: 2, transit_service: 2, green: 2, noise: 2,
    heat: 0, traffic_safety: 1, price: 4, custom_dest: 0,
    urban_activity: 50, density: 40, housing: 60,
  },
};

/** Presets that rely on personal preference sliders (urban activity, density, housing). */
const PRESET_USES_PREFS = new Set(['business', 'family', 'quiet', 'central', 'budget']);

function thresholdForImportance(importance, percentiles) {
  if (!importance || !percentiles) return null;
  const q = IMPORTANCE_TO_QUANTILE[importance];
  if (q == null) return null;
  if (q <= 0.25) return percentiles.p25;
  if (q <= 0.5) return percentiles.p50;
  if (q <= 0.75) return percentiles.p75;
  return percentiles.p90;
}

function computeFactorPercentiles(values) {
  const sorted = [...values].filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return { p25: 25, p50: 50, p75: 75, p90: 90 };
  return {
    p25: percentile(sorted, 0.25),
    p50: percentile(sorted, 0.5),
    p75: percentile(sorted, 0.75),
    p90: percentile(sorted, 0.9),
  };
}

function rebuildCityStats() {
  if (!state.features.length) {
    state.cityFactorStats = null;
    state.passingCount = 0;
    return;
  }
  const stats = {};
  [...IMPORTANCE_KEYS, ...PREF_KEYS].forEach((key) => {
    const vals = state.features
      .map((f) => factorScalar(key, f.properties))
      .filter((v) => v != null && Number.isFinite(v));
    stats[key] = computeFactorPercentiles(vals);
  });
  state.cityFactorStats = stats;
  state.passingCount = state.features.reduce(
    (n, f) => n + (evaluateHex(f.properties).passed ? 1 : 0),
    0,
  );
}

const state = {
  weights: {},
  prefTargets: { urban_activity: 50, density: 50, housing: 30 },
  features: [],
  rentMin: 0,
  rentMax: 1,
  hasRent: true,
  rentEstimated: false,
  rentSource: '',
  cityName: 'München',
  citySlug: 'muenchen',
  centers: [],
  centerAnchors: [],
  comparison: [],
  dailyNeedsCategories: {},
  destinations: [],
  customDestMatrix: {},
  hasExtendedMetrics: false,
  prefInclude: false,
  cityCenterStats: null,
  cityGreenStats: null,
  cityNoiseStats: null,
  desiredAreaM2: DEFAULT_SIZE_M2,
  maxMonthlyBudget: null,
  metricQuality: {},
  mapView: 'comfort',
  cityFactorStats: null,
  passingCount: 0,
  comfortColorLo: 0,
  comfortColorHi: 100,
};

let centerMarkers = [];
let destMarkers = [];
let map;
let searching = false;
let pickDestinationMode = false;

const $ = (id) => document.getElementById(id);
const LAYER_ID = 'hexes-fill';
const LINE_ID = 'hexes-line';
const SELECT_ID = 'hexes-selected';

// ---- init state from preset ------------------------------------------------
function resetStateFromPreset(presetId = 'balanced', preset = PRESETS.balanced) {
  IMPORTANCE_KEYS.forEach((k) => { state.weights[k] = preset[k] ?? 2; });
  PREF_KEYS.forEach((k) => { state.prefTargets[k] = preset[k] ?? 50; });
  state.prefInclude = PRESET_USES_PREFS.has(presetId);
  const prefInc = $('pref-include');
  if (prefInc) prefInc.checked = state.prefInclude;
}

// ---- utilities -------------------------------------------------------------
function clamp100(v) {
  return Math.max(0, Math.min(100, v));
}

function factorRatioMatch(score, threshold) {
  return Math.min(1, score / Math.max(0.001, threshold));
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

function centerAnchorLenientScore(minutes) {
  const m = Number(minutes);
  if (!Number.isFinite(m)) return 0;
  if (m <= 6) return 100;
  if (m <= 12) return 92;
  if (m <= 16) return 86;
  if (m <= 20) return 72;
  if (m <= 28) return 58;
  if (m <= 32) return 46;
  if (m <= 40) return 33;
  if (m <= 48) return 18;
  return 0;
}

function centerPolycentricLenient(p) {
  const anchors = state.centerAnchors || [];
  if (!anchors.length) return centerAnchorLenientScore(p.center_min);
  const scores = anchors.map((a) => {
    const m = Number(p[`center_min_${a.id}`] ?? (a.id === anchors[0].id ? p.center_min : NaN));
    const base = centerAnchorLenientScore(m);
    const w = Number(a.weight ?? 1);
    return a.id === anchors[0].id ? base : clamp100(base * w);
  }).filter((s) => Number.isFinite(s));
  return scores.length ? Math.max(...scores) : centerAnchorLenientScore(p.center_min);
}

function prefLabel(v) {
  if (v <= 20) return 'Niedrig';
  if (v <= 40) return 'Eher niedrig';
  if (v <= 60) return 'Mittel';
  if (v <= 80) return 'Eher hoch';
  return 'Hoch';
}

const ABS_REF = {
  centerMin: { best: 5, worst: 45 },
  greenDistM: { best: 100, worst: 1500 },
  greenAccess: { best: 80, worst: 5 },
  urbanActivitySat: 120,
  transportSat: 8.0,
  transitServiceSat: 25.0,
  noiseDb: { best: 45, worst: 75 },
  heatScore: { best: 80, worst: 20 },
  safetyScore: { best: 80, worst: 20 },
  housingScore: { best: 80, worst: 30 },
  densitySat: 5000,
  buildingAge: { best: 2020, worst: 1900 },
};

function percentile(sorted, p) {
  if (!sorted.length) return 45;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function computeCityCenterStats(features) {
  const mins = features
    .map((f) => Number(f.properties.center_min))
    .filter((v) => Number.isFinite(v))
    .sort((a, b) => a - b);
  if (!mins.length) return null;
  return {
    min: mins[0],
    p50: percentile(mins, 0.5),
    p95: percentile(mins, 0.95),
    max: mins[mins.length - 1],
  };
}

function computeCityGreenStats(features) {
  const access = features
    .map((f) => Number(f.properties.green_access))
    .filter((v) => Number.isFinite(v))
    .sort((a, b) => a - b);
  const dist = features
    .map((f) => Number(f.properties.green_dist_m))
    .filter((v) => Number.isFinite(v))
    .sort((a, b) => a - b);
  if (!access.length && !dist.length) return null;
  const stats = {};
  if (access.length) {
    stats.access = {
      p5: percentile(access, 0.05),
      p95: percentile(access, 0.95),
      max: access[access.length - 1],
    };
  }
  if (dist.length) {
    stats.dist = {
      p5: percentile(dist, 0.05),
      p50: percentile(dist, 0.5),
      p95: percentile(dist, 0.95),
      max: dist[dist.length - 1],
    };
  }
  return stats;
}

function computeCityNoiseStats(features) {
  const db = features
    .map((f) => Number(f.properties.noise_db))
    .filter((v) => Number.isFinite(v))
    .sort((a, b) => a - b);
  if (!db.length) return null;
  return { p5: percentile(db, 0.05), p95: percentile(db, 0.95) };
}

const NEUTRAL_PULL = [0, 0.08, 0.06, 0.03, 0]; // low importance → slight pull toward neutral (was 25% at Gering)

function factorEffectiveScore(cityRelFn, absStrictFn, p, sliderIdx, useNeutralPull = true) {
  const strict = absStrictFn(p);
  if (sliderIdx >= 4) return strict;
  const lenient = cityRelFn(p);
  if (sliderIdx <= 0) return lenient;
  const absW = absBlendWeight(sliderIdx);
  const blended = lenient * (1 - absW) + strict * absW;
  if (!useNeutralPull) return clamp100(blended);
  const pull = NEUTRAL_PULL[sliderIdx] ?? 0;
  return clamp100(blended * (1 - pull) + 50 * pull);
}

function greenCompositeRaw(p) {
  const access = Number(p.green_access);
  if (Number.isFinite(access)) return access;
  const d = Number(p.green_dist_m);
  if (!Number.isFinite(d)) return 30;
  return clamp100(100 - d / 15);
}

function greenAbsoluteLenient(p) {
  const s = Number(p.s_green);
  if (Number.isFinite(s)) return s;
  const d = Number(p.nearest_park_dist_m ?? p.green_dist_m);
  if (!Number.isFinite(d)) return 30;
  if (d <= 50) return 100;
  if (d <= 100) return 95;
  if (d <= 200) return 85;
  if (d <= 400) return 70;
  if (d <= 700) return 45;
  if (d <= 1000) return 20;
  return 0;
}

function greenAbsoluteStrict(p) {
  const s = Number(p.s_green_strict);
  if (Number.isFinite(s)) return s;
  const d = Number(p.nearest_park_dist_m ?? p.green_dist_m);
  if (!Number.isFinite(d)) return 0;
  if (d <= 100) return 100;
  if (d <= 300) return 75;
  if (d <= 500) return 40;
  if (d <= 800) return 15;
  return 0;
}

function greenEffectiveScore(p, sliderIdx) {
  return factorEffectiveScore(greenAbsoluteLenient, greenAbsoluteStrict, p, sliderIdx, false);
}

function noiseCityRelative(p) {
  const db = Number(p.noise_db);
  const st = state.cityNoiseStats;
  if (!Number.isFinite(db) || !st) return linScore(db, ABS_REF.noiseDb.best, ABS_REF.noiseDb.worst);
  const lo = Math.min(st.p5, 42);
  const hi = Math.max(st.p95, lo + 3);
  return linScore(db, lo, hi);
}

function noiseAbsoluteStrict(p) {
  const db = Number(p.noise_db);
  if (!Number.isFinite(db)) return 0;
  if (db <= 45) return 100;
  if (db <= 55) return 75;
  if (db <= 65) return 40;
  if (db <= 72) return 15;
  return 0;
}

function noiseEffectiveScore(p, sliderIdx) {
  return factorEffectiveScore(noiseCityRelative, noiseAbsoluteStrict, p, sliderIdx);
}

function centerCityRelative(p) {
  const s = Number(p.s_center);
  if (Number.isFinite(s)) return s;
  return centerPolycentricLenient(p);
}

function centerAbsoluteStrict(p) {
  const s = Number(p.s_center_strict);
  if (Number.isFinite(s)) return s;
  return thresholdMinScore(p.center_min);
}

function absBlendWeight(sliderIdx) {
  return [0, 0.05, 0.20, 0.55, 1.0][sliderIdx] ?? 0;
}

function centerEffectiveScore(p, sliderIdx) {
  return factorEffectiveScore(centerCityRelative, centerAbsoluteStrict, p, sliderIdx, false);
}

// ---- active factors --------------------------------------------------------
function factorScoreSpread(key) {
  const prop = SCORE_PROPS[key];
  if (!prop) return 1;
  const vals = state.features
    .map((f) => Number(f.properties[prop]))
    .filter((v) => Number.isFinite(v));
  if (vals.length < 2) return 0;
  return Math.max(...vals) - Math.min(...vals);
}

function factorAvailable(key) {
  if (key === 'price') return state.hasRent;
  if (key === 'custom_dest') return state.destinations.length > 0;
  if (key === 'heat') {
    if (!state.hasExtendedMetrics) return false;
    return factorScoreSpread('heat') > 1;
  }
  if (['daily_needs', 'transit_service', 'traffic_safety', 'density', 'housing'].includes(key)) {
    return state.hasExtendedMetrics;
  }
  return true;
}

function activeImportanceKeys() {
  return IMPORTANCE_KEYS.filter((k) => factorAvailable(k) && (state.weights[k] || 0) > 0);
}

function activePrefKeys() {
  if (!state.prefInclude) return [];
  return PREF_KEYS.filter((k) => factorAvailable(k));
}

function activeAllKeys() {
  const imp = activeImportanceKeys();
  if (imp.length <= 1) return imp;
  return [...imp, ...activePrefKeys()];
}

function importanceForKey(key) {
  if (PREF_KEYS.includes(key)) return state.prefInclude ? PREF_IMPORTANCE : 0;
  return state.weights[key] ?? 0;
}

function factorScalar(key, p) {
  if (key === 'daily_needs') return dailyNeedsScalar(p);
  if (key === 'price') {
    const budget = budgetAffordScalar(p);
    if (budget != null) return budget;
    return rentCityRelativeScalar(p);
  }
  if (key === 'custom_dest') return customDestScalar(p);
  if (PREF_KEYS.includes(key)) return preferenceScalar(key, p);
  const prop = SCORE_PROPS[key];
  const s = prop ? Number(p[prop]) : NaN;
  if (Number.isFinite(s)) return s;
  return absScoreForKey(key, p);
}

function evaluateHex(p) {
  const keys = activeAllKeys();
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
    const threshold = thresholdForImportance(importance, state.cityFactorStats?.[key]) ?? 0;
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

function comfortBreakdown(p) {
  const ev = evaluateHex(p);
  const scores = {};
  Object.entries(ev.factors).forEach(([k, f]) => { scores[k] = f.score; });
  const comfort = comfortScalar(p);
  return {
    comfort,
    keys: ev.activeKeys,
    scores,
    eval: ev,
  };
}

function comfortScalar(p) {
  const ev = evaluateHex(p);
  if (!ev.activeKeys.length) return null;
  return ev.passed ? ev.priorityScore : ev.bottleneckMatch;
}

function findClosestMatch() {
  let best = null;
  let bestMatch = -1;
  for (const f of state.features) {
    const ev = evaluateHex(f.properties);
    if (ev.matchScore == null) continue;
    if (ev.matchScore > bestMatch) {
      bestMatch = ev.matchScore;
      best = ev;
    }
  }
  return best;
}

function closestMatchMessage() {
  if (state.passingCount > 0) return null;
  const active = activeAllKeys().filter((k) => importanceForKey(k) > 0);
  if (!active.length) return null;

  const closest = findClosestMatch();
  if (!closest) {
    return 'Keine Viertel gefunden, die Ihren Kriterien entsprechen.';
  }

  const failed = closest.failedFactors.map((k) => {
    const f = closest.factors[k];
    return `${FACTOR_LABELS[k] || k} (${Math.round(f.score)}/${Math.round(f.threshold)})`;
  });

  return `Keine Viertel erfüllen alle Kriterien. Nächstes Match: ${Math.round(closest.matchScore)}%${failed.length ? ` — scheitert an: ${failed.join(', ')}` : ''}.`;
}

function thresholdLabel(key) {
  const imp = importanceForKey(key);
  if (!imp) return '';
  const thr = thresholdForImportance(imp, state.cityFactorStats?.[key]);
  if (thr == null) return STEP_LABELS[imp] || '';
  return `${STEP_LABELS[imp]} (≥${Math.round(thr)})`;
}

// ---- per-factor scores (scalar) --------------------------------------------
function dailyNeedsAvailFromMin(minutes) {
  const m = Number(minutes);
  if (!Number.isFinite(m)) return 0;
  if (m <= 3) return 100;
  if (m <= 5) return 85;
  if (m <= 7) return 65;
  if (m <= 10) return 40;
  if (m <= 15) return 15;
  return 0;
}

function dailyNeedsCategoryScores(p) {
  const enabled = DAILY_NEED_CATS.filter(([cat]) => state.dailyNeedsCategories[cat] !== false);
  if (!enabled.length) return null;
  return enabled.map(([cat]) => {
    const avail = p[`dn_${cat}_avail`];
    if (avail != null) return Number(avail);
    const min = p[`dn_${cat}_min`];
    if (min != null) return dailyNeedsAvailFromMin(min);
    return +p[`dn_${cat}_score`] || 0;
  });
}

function dailyNeedsWeightedCoverage(p, enabledCats = null) {
  const enabled = enabledCats || DAILY_NEED_CATS.filter(([cat]) => state.dailyNeedsCategories[cat] !== false);
  if (!enabled.length) return null;
  let sumW = 0;
  let sumV = 0;
  enabled.forEach(([cat, , w]) => {
    const avail = p[`dn_${cat}_avail`];
    const v = avail != null ? Number(avail) : dailyNeedsAvailFromMin(p[`dn_${cat}_min`]);
    if (!Number.isFinite(v)) return;
    sumW += w;
    sumV += w * v;
  });
  return sumW > 0 ? clamp100(sumV / sumW) : null;
}

function dailyNeedsScalar(p) {
  const enabled = DAILY_NEED_CATS.filter(([cat]) => state.dailyNeedsCategories[cat] !== false);
  if (!enabled.length) return +p.s_daily_needs || 50;
  if (enabled.length === DAILY_NEED_CATS.length) {
    const s = Number(p.s_daily_needs);
    if (Number.isFinite(s)) return s;
  }
  const coverage = dailyNeedsWeightedCoverage(p, enabled);
  if (coverage == null) return +p.s_daily_needs || 50;
  const clusterPenalty = Number(p.dn_cluster_penalty);
  const dispersion = Number(p.dn_dispersion_bonus);
  const penalty = Number.isFinite(clusterPenalty) ? clusterPenalty : 0;
  const bonus = Number.isFinite(dispersion) ? dispersion : 0;
  return clamp100(coverage - penalty + bonus);
}

function customDestScalar(p) {
  if (!state.destinations.length) return 50;
  const row = state.customDestMatrix[p.h3];
  if (!row) return 30;
  const scores = state.destinations.map((dest, i) => {
    const min = row[`dest_${i}_min`];
    return thresholdMinScore(min != null ? min : 99);
  });
  return scores.reduce((a, b) => a + b, 0) / scores.length;
}

function nebenkostenPerM2(p) {
  const nk = Number(p.nebenkosten_eur_m2);
  return Number.isFinite(nk) ? nk : DEFAULT_NEBENKOSTEN_EUR_M2;
}

function estimatedMonthlyRent(p) {
  const cold = Number(p.rent_eur_m2);
  if (!Number.isFinite(cold)) return null;
  const area = state.desiredAreaM2 || DEFAULT_SIZE_M2;
  return (cold + nebenkostenPerM2(p)) * area;
}

function estimatedColdMonthlyRent(p) {
  const cold = Number(p.rent_eur_m2);
  if (!Number.isFinite(cold)) return null;
  return cold * (state.desiredAreaM2 || DEFAULT_SIZE_M2);
}

function rentAbsoluteLenient(p) {
  const s = Number(p.s_rent_absolute);
  if (Number.isFinite(s)) return s;
  const rel = Number(p.s_rent_relative_city);
  if (Number.isFinite(rel)) return rel;
  const rent = Number(p.rent_eur_m2);
  if (!Number.isFinite(rent)) return 50;
  return 50;
}

function rentAbsoluteStrict(p) {
  const s = Number(p.s_rent_strict);
  if (Number.isFinite(s)) return s;
  const rent = Number(p.rent_eur_m2);
  if (!Number.isFinite(rent)) return 50;
  if (rent <= 12) return 100;
  if (rent <= 15) return 70;
  if (rent <= 18) return 45;
  if (rent <= 21) return 20;
  if (rent <= 24) return 5;
  return 0;
}

function rentAbsoluteScalar(p) {
  return rentAbsoluteLenient(p);
}

function rentCityRelativeScalar(p) {
  const s = Number(p.s_rent_relative_city);
  if (Number.isFinite(s)) return s;
  const span = Math.max(0.001, state.rentMax - state.rentMin);
  const rent = Number(p.rent_eur_m2);
  if (!Number.isFinite(rent)) return 50;
  return Math.max(0, ((state.rentMax - rent) / span) * 100);
}

function budgetAffordScalar(p) {
  const budget = state.maxMonthlyBudget;
  if (!budget || budget <= 0) return null;
  const monthly = estimatedMonthlyRent(p);
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

function priceStrictScalar(p) {
  const b = budgetAffordScalar(p);
  if (b != null) return clamp100(b);
  return rentAbsoluteStrict(p);
}

function priceLenientScalar(p) {
  const b = budgetAffordScalar(p);
  if (b != null) return clamp100(b);
  return rentAbsoluteLenient(p);
}

function affordScalar(p) {
  return priceStrictScalar(p);
}

function priceEffectiveScore(p, sliderIdx) {
  return factorEffectiveScore(priceLenientScalar, priceStrictScalar, p, sliderIdx, false);
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

function preferenceScalar(key, p) {
  const target = state.prefTargets[key] ?? 50;
  let actual = 50;
  if (key === 'urban_activity') {
    actual = logSatScore(p.urban_activity ?? p.business_count, ABS_REF.urbanActivitySat);
  } else if (key === 'density') {
    actual = logSatScore(p.population_density ?? p.urban_activity, ABS_REF.densitySat);
  } else if (key === 'housing') {
    actual = housingAgeScalar(p);
  }
  return clamp100(100 - Math.abs(actual - target) * PREF_PENALTY);
}

function absScoreForKey(key, p) {
  switch (key) {
    case 'center':
      return centerAbsoluteStrict(p);
    case 'daily_needs':
      return dailyNeedsScalar(p);
    case 'transit_service':
      return logSatScore(p.transit_service_score ?? p.transport_score, ABS_REF.transitServiceSat);
    case 'green':
      return greenAbsoluteStrict(p);
    case 'noise':
      return linScore(p.noise_db, ABS_REF.noiseDb.best, ABS_REF.noiseDb.worst);
    case 'heat':
      return linScore(p.heat_resilience_score ?? 50, ABS_REF.heatScore.best, ABS_REF.heatScore.worst);
    case 'traffic_safety':
      return trafficSafetyStrict(p);
    case 'urban_activity':
      return logSatScore(p.urban_activity ?? p.business_count, ABS_REF.urbanActivitySat);
    case 'density':
      return logSatScore(p.population_density ?? 0, ABS_REF.densitySat);
    case 'housing':
      return housingAgeScalar(p);
    case 'price':
      return rentAbsoluteStrict(p);
    case 'custom_dest':
      return customDestScalar(p);
    default:
      return +p[SCORE_PROPS[key]] || 50;
  }
}

function displayedComfortScalar(p) {
  return comfortScalar(p);
}

// ---- MapLibre paint expressions (synced with scalar scoring) ---------------
function mlGet(prop, fallback = 50) {
  return ['coalesce', ['get', prop], fallback];
}

function mlClamp01_100(expr) {
  return ['max', 0, ['min', 100, expr]];
}

function mlCenterStrict() {
  return ['step', ['get', 'center_min'],
    100,
    5, 100,
    10, 75,
    15, 40,
    20, 10,
    21, 0,
  ];
}

function mlCenterCityRelative() {
  const st = state.cityCenterStats;
  if (!st) return mlCenterStrict();
  const lo = Math.min(st.min, 5);
  const hi = Math.max(st.p95, lo + 5);
  const span = Math.max(0.001, hi - lo);
  return mlClamp01_100(['*', 100, ['/', ['-', hi, ['get', 'center_min']], span]]);
}

function mlCenterEffective(sliderIdx) {
  return mlBlendLenientStrict(mlCenterCityRelative(), mlCenterStrict(), sliderIdx, false);
}

function mlGreenParkDistLenient() {
  const d = ['coalesce', ['get', 'nearest_park_dist_m'], ['get', 'green_dist_m'], 2000];
  return ['step', d,
    0,
    50, 100,
    100, 95,
    200, 85,
    400, 70,
    700, 45,
    1000, 20,
  ];
}

function mlGreenParkDistStrict() {
  const d = ['coalesce', ['get', 'nearest_park_dist_m'], ['get', 'green_dist_m'], 2000];
  return ['step', d,
    0,
    100, 100,
    300, 75,
    500, 40,
    800, 15,
  ];
}

function mlGreenAbsoluteLenient() {
  return ['coalesce', ['get', 's_green'], mlGreenParkDistLenient()];
}

function mlGreenStrict() {
  return ['coalesce', ['get', 's_green_strict'], mlGreenParkDistStrict()];
}

function mlGreenEffective(sliderIdx) {
  return mlBlendLenientStrict(mlGreenAbsoluteLenient(), mlGreenStrict(), sliderIdx, false);
}

function mlBlendLenientStrict(lenientExpr, strictExpr, sliderIdx, useNeutralPull = true) {
  if (sliderIdx >= 4) return strictExpr;
  if (sliderIdx <= 0) return lenientExpr;
  const absW = absBlendWeight(sliderIdx);
  const blended = ['+', ['*', 1 - absW, lenientExpr], ['*', absW, strictExpr]];
  if (!useNeutralPull) return blended;
  const pull = NEUTRAL_PULL[sliderIdx] ?? 0;
  if (pull <= 0) return blended;
  return ['+', ['*', 1 - pull, blended], ['*', pull, 50]];
}

function mlNoiseStrict() {
  return ['step', ['get', 'noise_db'],
    100,
    45, 100,
    55, 75,
    65, 40,
    72, 15,
    73, 0,
  ];
}

function mlNoiseCityRelative() {
  const st = state.cityNoiseStats;
  if (!st) return mlNoiseStrict();
  const lo = Math.min(st.p5, 42);
  const hi = Math.max(st.p95, lo + 3);
  const span = Math.max(0.001, hi - lo);
  return mlClamp01_100(['*', 100, ['/', ['-', hi, ['get', 'noise_db']], span]]);
}

function mlNoiseEffective(sliderIdx) {
  return mlBlendLenientStrict(mlNoiseCityRelative(), mlNoiseStrict(), sliderIdx);
}

function mlFactorScore(key, sliderIdx) {
  if (key === 'center') return mlCenterEffective(sliderIdx);
  if (key === 'green') return mlGreenEffective(sliderIdx);
  if (key === 'noise') return mlNoiseEffective(sliderIdx);
  if (key === 'price') {
    const budget = state.maxMonthlyBudget;
    if (budget && budget > 0) {
      const area = state.desiredAreaM2 || DEFAULT_SIZE_M2;
      const monthly = ['+',
        ['*', mlGet('rent_eur_m2', 0), area],
        ['*', DEFAULT_NEBENKOSTEN_EUR_M2, area],
      ];
      const b15 = budget * 1.15;
      const b35 = budget * 1.35;
      return mlClamp01_100([
        'case',
        ['<=', monthly, budget], 100,
        ['<=', monthly, b15],
        ['+', 50, ['*', 50, ['-', 1, ['/', ['-', monthly, budget], budget * 0.15]]]],
        ['<=', monthly, b35],
        ['*', 50, ['-', 1, ['/', ['-', monthly, b15], budget * 0.2]]],
        0,
      ]);
    }
    const lenient = ['coalesce', ['get', 's_rent_absolute'], ['step', mlGet('rent_eur_m2', 20),
      0,
      12, 100,
      15, 85,
      18, 65,
      21, 45,
      24, 25,
      28, 10,
    ]];
    const strict = ['coalesce', ['get', 's_rent_strict'], ['step', mlGet('rent_eur_m2', 20),
      0,
      12, 100,
      15, 70,
      18, 45,
      21, 20,
      24, 5,
    ]];
    if (sliderIdx >= 4) return strict;
    const absW = absBlendWeight(sliderIdx);
    if (absW <= 0) return lenient;
    if (absW >= 1) return strict;
    return ['+', ['*', 1 - absW, lenient], ['*', absW, strict]];
  }
  const prop = SCORE_PROPS[key];
  if (!prop) return 50;
  const rel = mlGet(prop);
  const absW = absBlendWeight(sliderIdx);
  if (absW >= 1) return rel;
  if (absW <= 0) return rel;
  return ['+', ['*', 1 - absW, rel], ['*', absW, rel]];
}

function updateComfortColorDomain() {
  if (!state.features.length) {
    state.comfortColorLo = 0;
    state.comfortColorHi = 100;
    return;
  }
  const vals = state.features
    .map((f) => displayedComfortScalar(f.properties))
    .filter((v) => v != null && Number.isFinite(v))
    .sort((a, b) => a - b);
  if (vals.length < 10) {
    state.comfortColorLo = 0;
    state.comfortColorHi = 100;
    return;
  }
  let lo = percentile(vals, 0.08);
  let hi = percentile(vals, 0.92);
  if (hi - lo < 12) {
    const mid = (hi + lo) / 2;
    lo = Math.max(0, mid - 18);
    hi = Math.min(100, mid + 18);
  }
  state.comfortColorLo = lo;
  state.comfortColorHi = hi;
}

function refreshLiveComfortScores() {
  state.features.forEach((f) => {
    const ev = evaluateHex(f.properties);
    const c = comfortScalar(f.properties);
    f.properties._hex_passed = ev.passed ? 1 : 0;
    if (c != null && Number.isFinite(c)) {
      f.properties._comfort_live = Math.round(c * 10) / 10;
    } else {
      delete f.properties._comfort_live;
    }
  });
}

function comfortExpr() {
  return mlGet('_comfort_live');
}

function fillOpacityExpr() {
  if (state.passingCount > 0 && (!state.mapView || state.mapView === 'comfort')) {
    return [
      'case',
      ['==', ['get', '_hex_passed'], 1],
      ['case', ['==', ['get', 'data_quality'], 'high'], 0.9, ['==', ['get', 'data_quality'], 'mixed'], 0.77, 0.64],
      ['case', ['==', ['get', 'data_quality'], 'high'], 0.66, ['==', ['get', 'data_quality'], 'mixed'], 0.55, 0.44],
    ];
  }
  return [
    'case',
    ['==', ['get', 'data_quality'], 'high'], 0.78,
    ['==', ['get', 'data_quality'], 'mixed'], 0.65,
    0.52,
  ];
}

function diagnosticScoreExpr(key) {
  const prop = SCORE_PROPS[key];
  if (prop) return ['max', SCORE_FLOOR_SOFT, mlGet(prop)];
  return 50;
}

function fillColorExpr() {
  if (state.mapView && state.mapView !== 'comfort') {
    const key = state.mapView;
    const active = activeAllKeys().includes(key)
      || (IMPORTANCE_KEYS.includes(key) && (state.weights[key] || 0) > 0 && factorAvailable(key))
      || (PREF_KEYS.includes(key) && state.prefInclude && factorAvailable(key));
    if (!active) return NO_CRITERIA_COLOR;
    return ['interpolate', ['linear'], diagnosticScoreExpr(key), ...window.ColorRamp.maplibreStops(0, 100)];
  }

  if (!activeAllKeys().length) return NO_CRITERIA_COLOR;
  const comfort = comfortExpr();
  const lo = state.comfortColorLo ?? 0;
  const hi = state.comfortColorHi ?? 100;
  return ['interpolate', ['linear'], comfort, ...window.ColorRamp.maplibreStops(lo, hi)];
}

function updateLegendState() {
  const note = $('legend-note');
  if (!note) return;
  const hasCriteria = activeAllKeys().length > 0;
  if (state.mapView && state.mapView !== 'comfort') {
    note.textContent = `Diagnose: ${FACTOR_LABELS[state.mapView] || state.mapView}-Score (stadtrelativ)`;
    note.classList.toggle('is-warn', false);
    return;
  }
  if (!hasCriteria) {
    note.textContent = 'Keine Kriterien ausgewählt — Karte ist grau';
    note.classList.toggle('is-warn', true);
    return;
  }
  const noMatch = closestMatchMessage();
  if (noMatch) {
    note.textContent = noMatch;
    note.classList.toggle('is-warn', true);
    return;
  }
  const passHint = state.passingCount > 0
    ? `${state.passingCount} erfüllen alle Kriterien (heller) · `
    : '';
  note.textContent = `${passHint}Farbe: erfüllt = Puffer, sonst Engpass-Faktor (${Math.round(state.comfortColorLo)}–${Math.round(state.comfortColorHi)})`;
  note.classList.toggle('is-warn', state.passingCount === 0);
}

function applyPaint() {
  if (!map || !map.getLayer(LAYER_ID)) return;
  rebuildCityStats();
  if (!state.mapView || state.mapView === 'comfort') {
    refreshLiveComfortScores();
    updateComfortColorDomain();
    const src = map.getSource('hexes');
    if (src) src.setData({ type: 'FeatureCollection', features: state.features });
  }
  map.setPaintProperty(LAYER_ID, 'fill-color', fillColorExpr());
  map.setPaintProperty(LAYER_ID, 'fill-opacity', fillOpacityExpr());
  updateLegendState();
  updateCardOutputs();
}

// ---- persistence -----------------------------------------------------------
function saveComparison() {
  try { localStorage.setItem(COMPARE_STORAGE_KEY, JSON.stringify(state.comparison)); } catch (e) { /* */ }
}

function loadComparison() {
  try {
    const raw = localStorage.getItem(COMPARE_STORAGE_KEY);
    if (raw) state.comparison = JSON.parse(raw);
  } catch (e) { state.comparison = []; }
}

function loadDailyNeedsCategories() {
  try {
    const raw = localStorage.getItem(DAILY_NEEDS_STORAGE);
    if (raw) state.dailyNeedsCategories = JSON.parse(raw);
  } catch (e) { /* */ }
  DAILY_NEED_CATS.forEach(([cat]) => {
    if (state.dailyNeedsCategories[cat] === undefined) state.dailyNeedsCategories[cat] = true;
  });
}

function saveDailyNeedsCategories() {
  try { localStorage.setItem(DAILY_NEEDS_STORAGE, JSON.stringify(state.dailyNeedsCategories)); } catch (e) { /* */ }
}

function loadDestinations() {
  try {
    const raw = localStorage.getItem(DEST_STORAGE_KEY);
    if (raw) state.destinations = JSON.parse(raw);
  } catch (e) { state.destinations = []; }
}

function saveDestinations() {
  try { localStorage.setItem(DEST_STORAGE_KEY, JSON.stringify(state.destinations)); } catch (e) { /* */ }
}

// ---- map layers ------------------------------------------------------------
function firstSymbolLayerId() {
  const sym = (map.getStyle().layers || []).find((l) => l.type === 'symbol');
  return sym ? sym.id : undefined;
}

function addHexLayers(geojson) {
  map.addSource('hexes', { type: 'geojson', data: geojson });
  const before = firstSymbolLayerId();
  map.addLayer({ id: LAYER_ID, type: 'fill', source: 'hexes', paint: { 'fill-color': fillColorExpr(), 'fill-opacity': fillOpacityExpr() } }, before);
  map.addLayer({ id: LINE_ID, type: 'line', source: 'hexes', paint: { 'line-color': 'rgba(255,255,255,0.35)', 'line-width': 0.4 } }, before);
  map.addLayer({
    id: SELECT_ID, type: 'line', source: 'hexes',
    filter: ['in', ['get', 'h3'], ['literal', []]],
    paint: { 'line-color': '#1c2330', 'line-width': 3, 'line-opacity': 0.95 },
  }, before);
}

function selectedH3ForCity(cityName) {
  return state.comparison.filter((i) => i.cityName === cityName).map((i) => i.h3);
}

function updateHighlight() {
  if (!map || !map.getLayer(SELECT_ID)) return;
  map.setFilter(SELECT_ID, ['in', ['get', 'h3'], ['literal', selectedH3ForCity(state.cityName)]]);
}

// ---- markers ---------------------------------------------------------------
function clearCenterMarkers() {
  centerMarkers.forEach((m) => m.remove());
  centerMarkers = [];
}

function renderCenterMarkers() {
  clearCenterMarkers();
  (state.centerAnchors || []).forEach((a) => {
    if (typeof a.lat !== 'number') return;
    const el = document.createElement('div');
    el.className = 'center-marker is-anchor' + (a.id === 'marienplatz' || a.weight === 1 ? ' is-main' : '');
    el.title = a.label || a.id;
    centerMarkers.push(new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat([a.lng, a.lat]).addTo(map));
  });
  (state.centers || []).forEach((c) => {
    if (typeof c.lat !== 'number') return;
    const el = document.createElement('div');
    el.className = 'center-marker' + (c.primary ? ' is-main' : '');
    centerMarkers.push(new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat([c.lng, c.lat]).addTo(map));
  });
}

function clearDestMarkers() {
  destMarkers.forEach((m) => m.remove());
  destMarkers = [];
}

function renderDestMarkers() {
  clearDestMarkers();
  state.destinations.forEach((d, i) => {
    const el = document.createElement('div');
    el.className = 'dest-marker';
    el.textContent = String(i + 1);
    destMarkers.push(new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat([d.lng, d.lat]).addTo(map));
  });
}

function renderDestList() {
  const list = $('dest-list');
  if (!list) return;
  list.innerHTML = '';
  state.destinations.forEach((d, i) => {
    const row = document.createElement('div');
    row.className = 'dest-row';
    row.innerHTML = `<span>${d.label || 'Ziel ' + (i + 1)}</span><button type="button" data-i="${i}">×</button>`;
    row.querySelector('button').addEventListener('click', () => {
      state.destinations.splice(i, 1);
      saveDestinations();
      renderDestList();
      renderDestMarkers();
      fetchDestMatrix();
    });
    list.appendChild(row);
  });
}

// ---- city load -------------------------------------------------------------
function detectHasRent(geojson) {
  const meta = geojson.meta || {};
  if (typeof meta.has_rent === 'boolean') return meta.has_rent;
  const p = geojson.features[0] && geojson.features[0].properties;
  return !!(p && 'rent_eur_m2' in p);
}

function detectExtendedMetrics(features) {
  const p = features[0] && features[0].properties;
  return !!(p && ('dn_supermarket_min' in p || 's_daily_needs' in p || 'daily_needs_score' in p));
}

function setFactorVisibility() {
  const hide = (id, on) => { const el = $(id); if (el) el.hidden = !on; };
  hide('slider-price', state.hasRent);
  hide('rent-budget-panel', state.hasRent);
  hide('slider-daily-needs', false);
  hide('slider-transit', state.hasExtendedMetrics);
  hide('slider-heat', state.hasExtendedMetrics && factorScoreSpread('heat') > 1);
  hide('slider-safety', state.hasExtendedMetrics);
  hide('slider-density', state.hasExtendedMetrics);
  hide('slider-housing', state.hasExtendedMetrics);
  hide('daily-needs-toggles', state.hasExtendedMetrics);
  const dnHint = $('daily-needs-hint');
  if (dnHint) dnHint.hidden = state.hasExtendedMetrics;
}

function normalizeLegacyProps(features) {
  features.forEach((f) => {
    const p = f.properties;
    if (p.s_center == null && p.s_transit != null) p.s_center = p.s_transit;
    if (p.s_urban_activity == null && p.s_business != null) p.s_urban_activity = p.s_business;
    if (p.s_business == null && p.s_poi != null) p.s_business = p.s_poi;
    if (p.s_transport == null) p.s_transport = p.s_transit ?? 50;
    if (p.urban_activity == null && p.business_count != null) p.urban_activity = p.business_count;
    if (p.business_count == null && p.poi_count != null) p.business_count = p.poi_count;
    if (p.center_min == null && p.transit_min != null) p.center_min = p.transit_min;
    if (p.transport_score == null) p.transport_score = 0;
    if (p.s_daily_needs == null) p.s_daily_needs = 50;
    if (p.s_transit_service == null) p.s_transit_service = p.s_transport ?? 50;
    if (p.s_heat == null) p.s_heat = 50;
    if (p.s_traffic_safety == null) p.s_traffic_safety = 50;
    if (p.s_density == null) p.s_density = 50;
    if (p.s_housing == null) p.s_housing = 50;
    if (p.s_rent_absolute == null && p.rent_eur_m2 != null) {
      p.s_rent_absolute = rentAbsoluteLenient(p);
    }
    if (p.s_rent_strict == null && p.rent_eur_m2 != null) {
      p.s_rent_strict = rentAbsoluteStrict(p);
    }
    if (p.s_rent_relative_city == null && p.rent_eur_m2 != null) {
      p.s_rent_relative_city = rentCityRelativeScalar(p);
    }
    if (p.data_quality == null) p.data_quality = 'estimated';
    if (p.green_share_inside_500m == null) p.green_share_inside_500m = null;
    if (p.accident_density == null) p.accident_density = null;
  });
}

function loadCity(geojson) {
  const meta = geojson.meta || {};
  state.features = geojson.features;
  state.cityName = meta.name || state.cityName;
  state.citySlug = meta.slug || state.citySlug;
  state.centers = meta.centers || [];
  state.centerAnchors = meta.center_anchors || [];
  state.rentEstimated = meta.rent_estimated !== false;
  state.rentSource = meta.rent_source || '';
  state.metricQuality = meta.metric_quality || {};
  state.hasExtendedMetrics = detectExtendedMetrics(geojson.features);
  setRentAvailability(detectHasRent(geojson));
  setFactorVisibility();
  buildMapViewOptions();

  if (state.hasRent) {
    const rents = geojson.features.map((f) => f.properties.rent_eur_m2).filter((v) => typeof v === 'number');
    state.rentMin = rents.length ? Math.min(...rents) : 0;
    state.rentMax = rents.length ? Math.max(...rents) : 1;
  }

  normalizeLegacyProps(geojson.features);
  state.cityCenterStats = computeCityCenterStats(geojson.features);
  state.cityGreenStats = computeCityGreenStats(geojson.features);
  state.cityNoiseStats = computeCityNoiseStats(geojson.features);
  rebuildCityStats();

  if (meta.name) $('city-title').textContent = `${meta.name} Wohn-Index`;
  const count = meta.count ?? geojson.features.length;
  $('hex-count').textContent = `${count} Hexagone · H3 res ${meta.h3_res ?? '?'}`;

  if (map.getSource('hexes')) {
    map.getSource('hexes').setData(geojson);
    applyPaint();
  } else {
    addHexLayers(geojson);
    applyPaint();
    wireTooltip();
    wireHexClick();
    wireMapDestPick();
  }
  updateHighlight();
  renderCenterMarkers();
  renderDestMarkers();
  renderComparison();
  fetchDestMatrix();

  if (Array.isArray(meta.bbox) && meta.bbox.length === 4) {
    const [s, w, n, e] = meta.bbox;
    map.fitBounds([[w, s], [e, n]], { padding: 40, duration: 800 });
  } else if (meta.center) {
    map.flyTo({ center: [meta.center[1], meta.center[0]], zoom: CFG.zoom });
  }
}

function setRentAvailability(hasRent) {
  state.hasRent = hasRent;
}

let resolvedApiBase = CFG.apiBase;

function apiUrl(path) { return `${resolvedApiBase}${path}`; }

async function ensureApiBase() {
  if (resolvedApiBase) return resolvedApiBase;
  const candidates = [];
  // same-origin (if API is reverse-proxied)
  candidates.push('');
  if (location.port && location.port !== '8000') {
    candidates.push(`${location.protocol}//${location.hostname}:8000`);
    if (location.hostname === 'localhost' || location.hostname === '::1') {
      candidates.push(`${location.protocol}//127.0.0.1:8000`);
    }
  }
  if (!location.port || location.port === '80' || location.port === '443') {
    candidates.push(`${location.origin}`);
  }
  const seen = new Set();
  for (const base of candidates) {
    const key = base || '(same)';
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      const resp = await fetch(`${base}/api/cities`, { method: 'GET' });
      if (resp.ok) {
        resolvedApiBase = base.replace(/\/$/, '');
        return resolvedApiBase;
      }
    } catch (e) { /* try next */ }
  }
  return '';
}

function apiUnavailableMessage() {
  return 'Stadtsuche braucht den Backend-Server. Nutze http://localhost:8080 (docker compose up) oder starte uvicorn auf :8000.';
}

function parseApiError(payload, status) {
  const detail = payload?.detail;
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail)) return detail.map((d) => d.msg || JSON.stringify(d)).join('; ');
  return `Fehler ${status}`;
}

async function fetchDestMatrix() {
  if (!state.destinations.length || !state.citySlug) return;
  try {
    const resp = await fetch(apiUrl('/api/destinations/matrix'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: state.citySlug, destinations: state.destinations }),
    });
    if (!resp.ok) return;
    const data = await resp.json();
    state.customDestMatrix = data.matrix || {};
    applyPaint();
  } catch (e) { /* offline / stale cache */ }
}

function setStatus(msg, isError = false) {
  const el = $('search-status');
  if (!msg) { el.hidden = true; el.textContent = ''; return; }
  el.hidden = false;
  el.textContent = msg;
  el.classList.toggle('is-error', isError);
}

function setSearching(on) {
  searching = on;
  $('search-btn').disabled = on;
  $('search-input').disabled = on;
}

async function fetchCityGeojson(slug) {
  const resp = await fetch(apiUrl(`/api/city/${slug}.geojson`), { cache: 'no-store' });
  if (!resp.ok) throw new Error(`Karte konnte nicht geladen werden (${resp.status})`);
  return resp.json();
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function pollUntilReady(slug, name) {
  for (;;) {
    await sleep(2000);
    let data;
    try {
      const resp = await fetch(apiUrl(`/api/status/${slug}`));
      data = await resp.json();
    } catch (e) { continue; }
    if (data.status === 'ready') return;
    if (data.status === 'error') throw new Error(data.message || 'Generierung fehlgeschlagen');
    const step = data.step || 0;
    const total = data.total || 15;
    setStatus(`Erzeuge Karte für ${name} … Schritt ${step}/${total}`);
  }
}

async function runSearch(query) {
  if (!query.trim() || searching) return;
  setSearching(true);
  setStatus(`Suche „${query}“ …`);
  try {
    const apiBase = await ensureApiBase();
    if (!apiBase) throw new Error(apiUnavailableMessage());
    const resp = await fetch(apiUrl('/api/generate'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: query }),
    });
    const payload = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(parseApiError(payload, resp.status));
    const data = payload;
    const slug = data.slug;
    if (!slug) throw new Error('Keine Stadt-ID vom Server erhalten');
    const name = data.meta?.name || data.name || query;
    if (data.status !== 'ready') {
      setStatus(`Erzeuge Karte für ${name} …`);
      await pollUntilReady(slug, name);
    }
    loadCity(await fetchCityGeojson(slug));
    setStatus('');
  } catch (err) {
    setStatus(err.message || 'Suche fehlgeschlagen', true);
  } finally {
    setSearching(false);
  }
}

// ---- tooltip ---------------------------------------------------------------
const tooltip = $('tooltip');

function metricBadge(p, key) {
  const src = p[`${key}_source`] || state.metricQuality[key]?.source;
  const conf = p[`${key}_confidence`] ?? state.metricQuality[key]?.confidence;
  if (!src && conf == null) return '';
  const low = typeof conf === 'number' ? conf < 0.5 : conf === 'low';
  const label = low ? '≈ ' : '';
  const confTxt = conf != null ? (typeof conf === 'number' ? conf.toFixed(2) : conf) : '';
  return `<span class="tt-badge tt-est">${label}${src || key}${confTxt ? ` (${confTxt})` : ''}</span>`;
}

function scoreBar(score) {
  const filled = Math.round(Math.max(0, Math.min(10, score / 10)));
  return '█'.repeat(filled) + '░'.repeat(10 - filled);
}

function showTooltip(e) {
  const f = e.features && e.features[0];
  if (!f) return;
  const p = f.properties;
  const breakdown = comfortBreakdown(p);
  const { comfort, keys, eval: ev } = breakdown;
  const warmMonthly = estimatedMonthlyRent(p);

  const dq = p.data_quality || 'estimated';
  const dqLabel = dq === 'high' ? '' : dq === 'mixed' ? ' <span class="tt-est">gemischte Datenqualität</span>' : ' <span class="tt-est">≈ geschätzt</span>';

  const factorRows = keys.map((k) => {
    const fac = ev.factors[k];
    if (!fac) return '';
    const detail = k === 'center' ? `${(+p.center_min).toFixed(0)} min`
      : k === 'green' ? `${Number(p.nearest_park_dist_m ?? p.green_dist_m ?? 0).toFixed(0)} m Park`
      : k === 'price' && state.hasRent
        ? `${(+p.rent_eur_m2).toFixed(1)} €/m² Kalt${warmMonthly != null ? ` · ~${Math.round(warmMonthly)} € warm` : ''}`
        : '–';
    const status = fac.passed ? '✓' : '✗';
    const level = STEP_LABELS[fac.importance] || '';
    return `<tr class="${fac.passed ? '' : 'tt-fail'}">
      <td>${FACTOR_LABELS[k] || k}</td>
      <td>${detail}</td>
      <td><span class="tt-bar">${scoreBar(fac.score)}</span> ${fac.score.toFixed(0)}/100</td>
      <td class="tt-weight">${status} ${level} (≥${Math.round(fac.threshold)})</td>
    </tr>`;
  }).join('');

  const statusLine = ev.activeKeys.length
    ? (ev.passed
      ? `<div class="tt-pass">Erfüllt alle Kriterien · Puffer-Score <b>${comfort.toFixed(0)}</b>/100</div>`
      : `<div class="tt-fail-msg">Engpass <b>${ev.bottleneckMatch.toFixed(0)}</b>% · Gesamt-Match <b>${ev.matchScore.toFixed(0)}</b>%</div>`)
    : '';

  tooltip.hidden = false;
  tooltip.style.left = e.point.x + 14 + 'px';
  tooltip.style.top = e.point.y + 14 + 'px';
  tooltip.innerHTML = `
    <div class="tt-score">${comfort == null && !ev.activeKeys.length
    ? 'Keine Kriterien ausgewählt'
    : statusLine || `Match <b>${comfort.toFixed(0)}</b>/100`}</div>
    ${keys.length ? `<table class="tt-breakdown">
      <thead><tr><td>Faktor</td><td>Daten</td><td>Score</td><td>Anforderung</td></tr></thead>
      <tbody>${factorRows}</tbody>
    </table>` : ''}
    <div class="tt-src">${metricBadge(p, 'noise')}${metricBadge(p, 'heat')}${metricBadge(p, 'safety')}${metricBadge(p, 'rent')}${dqLabel}</div>`;
}

function wireTooltip() {
  map.on('mousemove', LAYER_ID, showTooltip);
  map.on('mouseleave', LAYER_ID, () => { tooltip.hidden = true; });
  map.on('mouseenter', LAYER_ID, () => { map.getCanvas().style.cursor = 'pointer'; });
}

// ---- comparison ------------------------------------------------------------
const COMPARE_PROPS = [
  's_center', 's_urban_activity', 's_daily_needs', 's_transit_service', 's_green', 's_noise',
  'center_min', 'urban_activity', 'green_access', 'noise_db', 'rent_eur_m2', 'rent_confidence',
];

function makeSnapshot(feature) {
  const p = feature.properties || {};
  const props = {};
  COMPARE_PROPS.forEach((k) => { if (p[k] != null) props[k] = p[k]; });
  return {
    id: `${state.cityName}:${p.h3}`,
    cityName: state.cityName,
    h3: p.h3,
    props,
    sizeM2: DEFAULT_SIZE_M2,
    pricePerM2: typeof p.rent_eur_m2 === 'number' ? p.rent_eur_m2 : null,
  };
}

function onHexClick(e) {
  if (pickDestinationMode) {
    const ll = e.lngLat;
    if (state.destinations.length < 3) {
      state.destinations.push({ lat: ll.lat, lng: ll.lng, label: `Ziel ${state.destinations.length + 1}`, weight: 2 });
      saveDestinations();
      renderDestList();
      renderDestMarkers();
      fetchDestMatrix();
    }
    pickDestinationMode = false;
    return;
  }
  const f = e.features && e.features[0];
  if (!f) return;
  const id = `${state.cityName}:${f.properties.h3}`;
  const idx = state.comparison.findIndex((i) => i.id === id);
  if (idx >= 0) state.comparison.splice(idx, 1);
  else state.comparison.push(makeSnapshot(f));
  saveComparison();
  updateHighlight();
  renderComparison();
}

function wireHexClick() { map.on('click', LAYER_ID, onHexClick); }

function wireMapDestPick() {
  map.on('click', (e) => {
    if (!pickDestinationMode) return;
    if (state.destinations.length < 3) {
      state.destinations.push({ lat: e.lngLat.lat, lng: e.lngLat.lng, label: `Ziel ${state.destinations.length + 1}`, weight: 2 });
      saveDestinations();
      renderDestList();
      renderDestMarkers();
      fetchDestMatrix();
    }
    pickDestinationMode = false;
  });
}

function absScores(p) {
  return {
    center: absScoreForKey('center', p),
    urban_activity: absScoreForKey('urban_activity', p),
    daily_needs: absScoreForKey('daily_needs', p),
    transit_service: absScoreForKey('transit_service', p),
    green: absScoreForKey('green', p),
    noise: absScoreForKey('noise', p),
  };
}

function weightedGeomean(scores, shares, keys, floor) {
  let logSum = 0;
  keys.forEach((k) => {
    logSum += (shares[k] || 0) * Math.log(Math.max(floor, scores[k] || 0.001));
  });
  return Math.exp(logSum);
}

function comfortAbsScalar(p) {
  const keys = ['center', 'daily_needs', 'transit_service', 'green', 'noise'];
  const scores = keys.reduce((o, k) => ((o[k] = absScoreForKey(k, p)), o), {});
  const shares = keys.reduce((o, k) => ((o[k] = 1 / keys.length), o), {});
  return weightedGeomean(scores, shares, keys, SCORE_FLOOR_SOFT);
}

function computeCard(item) {
  const comfort = comfortAbsScalar(item.props);
  const size = Number(item.sizeM2);
  const price = Number(item.pricePerM2);
  const total = Number.isFinite(size) && size > 0 && Number.isFinite(price) && price > 0 ? size * price : null;
  const ratio = Number.isFinite(price) && price > 0 ? comfort / price : null;
  const [r, g, b] = window.ColorRamp.ramp(comfort);
  return { comfort, total, ratio, color: `rgb(${r},${g},${b})`, abs: absScores(item.props) };
}

const euro = (v) => v.toLocaleString('de-DE', { maximumFractionDigits: 0 }) + ' €';

function renderComparison() {
  const panel = $('compare-panel');
  const list = $('compare-list');
  const empty = $('compare-empty');
  if (!panel || !list) return;
  panel.hidden = state.comparison.length === 0;
  empty.hidden = state.comparison.length !== 0;
  const cards = state.comparison.map((item) => ({ item, m: computeCard(item) }));
  let bestId = null;
  let bestRatio = -Infinity;
  cards.forEach(({ item, m }) => {
    if (m.ratio != null && m.ratio > bestRatio) { bestRatio = m.ratio; bestId = item.id; }
  });
  list.innerHTML = '';
  cards.forEach(({ item, m }) => list.appendChild(buildCard(item, m, item.id === bestId)));
}

function buildCard(item, m, isBest) {
  const card = document.createElement('div');
  card.className = 'compare-card' + (isBest ? ' is-best' : '');
  card.dataset.id = item.id;
  const p = item.props || {};
  card.innerHTML = `
    <div class="cc-head"><div class="cc-title"><b>${item.cityName}</b><span class="cc-h3">#${String(item.h3).slice(-6)}</span></div>
    <button class="cc-remove">×</button></div>
    <div class="cc-badge" style="background:${m.color}"><span>Objektive Bewertung</span><b>${m.comfort.toFixed(0)}</b></div>
    <table class="cc-factors">
      <tr><td>🏙️ Zentrum</td><td>${p.center_min ?? '–'} min</td><td>${m.abs.center.toFixed(0)}</td></tr>
      <tr><td>🛒 Alltag</td><td>–</td><td>${m.abs.daily_needs.toFixed(0)}</td></tr>
      <tr><td>🚇 ÖPNV</td><td>–</td><td>${m.abs.transit_service.toFixed(0)}</td></tr>
    </table>
    <div class="cc-inputs">
      <label>m²<input type="number" class="cc-size" value="${item.sizeM2 ?? ''}" /></label>
      <label>€/m²<input type="number" class="cc-price" value="${item.pricePerM2 ?? ''}" /></label>
    </div>
    <div class="cc-out">
      <div><span>Gesamtpreis</span><b>${m.total != null ? euro(m.total) : '–'}</b></div>
      <div><span>Komfort/Preis</span><b>${m.ratio != null ? m.ratio.toFixed(1) : '–'}</b></div>
    </div>
    ${isBest ? '<div class="cc-flag">Bestes Preis-Leistungs-Verhältnis</div>' : ''}`;
  card.querySelector('.cc-remove').addEventListener('click', () => {
    state.comparison = state.comparison.filter((i) => i.id !== item.id);
    saveComparison();
    updateHighlight();
    renderComparison();
  });
  return card;
}

function updateCardOutputs() { renderComparison(); }

function clearComparison() {
  state.comparison = [];
  saveComparison();
  updateHighlight();
  renderComparison();
}

// ---- UI wiring -------------------------------------------------------------
function refreshSliderLabels() {
  IMPORTANCE_KEYS.forEach((k) => {
    const el = $(`w-${k}-val`);
    if (!el) return;
    const label = STEP_LABELS[state.weights[k]] || STEP_LABELS[0];
    if ((state.weights[k] || 0) > 0) {
      el.textContent = thresholdLabel(k) || label;
    } else {
      el.textContent = label;
    }
  });
  PREF_KEYS.forEach((k) => {
    const el = $(`pref-${k}-val`);
    if (el) el.textContent = prefLabel(state.prefTargets[k]);
  });
}

function syncSlidersFromState() {
  IMPORTANCE_KEYS.forEach((k) => {
    const el = $(`w-${k}`);
    if (el) el.value = state.weights[k] ?? 0;
  });
  PREF_KEYS.forEach((k) => {
    const el = $(`pref-${k}`);
    if (el) el.value = state.prefTargets[k] ?? 50;
  });
  refreshSliderLabels();
}

function buildDailyNeedsToggles() {
  const wrap = $('daily-needs-toggles');
  if (!wrap) return;
  wrap.innerHTML = '';
  DAILY_NEED_CATS.forEach(([cat, label]) => {
    const lbl = document.createElement('label');
    lbl.className = 'cat-toggle';
    const checked = state.dailyNeedsCategories[cat] !== false;
    lbl.innerHTML = `<input type="checkbox" data-cat="${cat}" ${checked ? 'checked' : ''} /> ${label}`;
    lbl.querySelector('input').addEventListener('change', (e) => {
      state.dailyNeedsCategories[cat] = e.target.checked;
      saveDailyNeedsCategories();
      applyPaint();
    });
    wrap.appendChild(lbl);
  });
}

function wireSliders() {
  IMPORTANCE_KEYS.forEach((k) => {
    const el = $(`w-${k}`);
    if (!el) return;
    el.addEventListener('input', (e) => {
      state.weights[k] = Number(e.target.value);
      refreshSliderLabels();
      applyPaint();
    });
  });
  PREF_KEYS.forEach((k) => {
    const el = $(`pref-${k}`);
    if (!el) return;
    el.addEventListener('input', (e) => {
      state.prefTargets[k] = Number(e.target.value);
      refreshSliderLabels();
      applyPaint();
    });
  });
  const prefInc = $('pref-include');
  if (prefInc) {
    prefInc.addEventListener('change', (e) => {
      state.prefInclude = e.target.checked;
      applyPaint();
    });
  }
}

function wirePresets() {
  document.querySelectorAll('.preset').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.preset;
      resetStateFromPreset(id, PRESETS[id]);
      syncSlidersFromState();
      applyPaint();
    });
  });
}

function wireSearch() {
  $('search-form').addEventListener('submit', (e) => {
    e.preventDefault();
    runSearch($('search-input').value);
  });
}

function wireCompare() {
  const clearBtn = $('compare-clear');
  if (clearBtn) clearBtn.addEventListener('click', clearComparison);
}

function wireDestinations() {
  const section = $('dest-section');
  if (section) {
    section.addEventListener('dblclick', () => {
      pickDestinationMode = true;
      setStatus('Klicke auf die Karte für ein neues Ziel …');
      setTimeout(() => setStatus(''), 4000);
    });
  }
}

function loadBudgetPrefs() {
  try {
    const area = localStorage.getItem(AREA_STORAGE);
    if (area) state.desiredAreaM2 = Number(area) || DEFAULT_SIZE_M2;
    const budget = localStorage.getItem(BUDGET_STORAGE);
    if (budget) state.maxMonthlyBudget = Number(budget) || null;
  } catch (e) { /* */ }
}

function saveBudgetPrefs() {
  try {
    localStorage.setItem(AREA_STORAGE, String(state.desiredAreaM2));
    if (state.maxMonthlyBudget) {
      localStorage.setItem(BUDGET_STORAGE, String(state.maxMonthlyBudget));
    } else {
      localStorage.removeItem(BUDGET_STORAGE);
    }
  } catch (e) { /* */ }
}

function wireBudgetInputs() {
  const areaEl = $('rent-area');
  const budgetEl = $('rent-budget');
  if (areaEl) {
    areaEl.value = state.desiredAreaM2;
    areaEl.addEventListener('input', (e) => {
      state.desiredAreaM2 = Math.max(20, Number(e.target.value) || DEFAULT_SIZE_M2);
      saveBudgetPrefs();
      applyPaint();
    });
  }
  if (budgetEl) {
    budgetEl.value = state.maxMonthlyBudget || '';
    budgetEl.addEventListener('input', (e) => {
      const v = Number(e.target.value);
      state.maxMonthlyBudget = v > 0 ? v : null;
      saveBudgetPrefs();
      applyPaint();
    });
  }
}

function setupLegend() {
  $('legend-bar').style.background = window.ColorRamp.cssGradient();
  const title = $('legend-title');
  if (title) title.textContent = 'Persönliche Standortbewertung';
}

// ---- init ------------------------------------------------------------------
function wireMapView() {
  const sel = $('map-view');
  if (!sel) return;
  sel.value = state.mapView || 'comfort';
  sel.addEventListener('change', (e) => {
    state.mapView = e.target.value;
    try { localStorage.setItem(MAP_VIEW_STORAGE, state.mapView); } catch (err) { /* */ }
    applyPaint();
  });
}

function loadMapViewPref() {
  try {
    const v = localStorage.getItem(MAP_VIEW_STORAGE);
    if (v) state.mapView = v;
  } catch (e) { /* */ }
}

function buildMapViewOptions() {
  const sel = $('map-view');
  if (!sel) return;
  const options = [{ value: 'comfort', label: 'Gesamtbewertung' }];
  IMPORTANCE_KEYS.forEach((k) => {
    if (factorAvailable(k)) options.push({ value: k, label: FACTOR_LABELS[k] });
  });
  PREF_KEYS.forEach((k) => {
    if (factorAvailable(k)) options.push({ value: k, label: FACTOR_LABELS[k] });
  });
  sel.innerHTML = options.map((o) => `<option value="${o.value}">${o.label}</option>`).join('');
  sel.value = state.mapView || 'comfort';
}

function showLoadError(msg) {
  const loading = $('loading');
  if (!loading) return;
  loading.hidden = false;
  loading.textContent = msg;
}

async function init() {
  if (location.protocol === 'file:') {
    showLoadError('Bitte über einen Webserver öffnen (z. B. python3 -m http.server im Ordner web/).');
    return;
  }

  try {
    resetStateFromPreset('balanced', PRESETS.balanced);
    setupLegend();
    loadComparison();
    loadDailyNeedsCategories();
    loadDestinations();
    loadBudgetPrefs();
    loadMapViewPref();
    buildDailyNeedsToggles();
    syncSlidersFromState();
    wireBudgetInputs();

    map = new maplibregl.Map({
      container: 'map',
      style: CFG.styleUrl,
      center: CFG.center,
      zoom: CFG.zoom,
      attributionControl: false,
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');

    wireSliders();
    wirePresets();
    wireSearch();
    wireCompare();
    wireDestinations();
    wireMapView();
    renderDestList();

    let geojson;
    try {
      const resp = await fetch(CFG.dataUrl, { cache: 'no-store' });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      geojson = await resp.json();
    } catch (err) {
      showLoadError('Fehler beim Laden der Kartendaten. Bitte über einen Webserver öffnen.');
      console.error(err);
      return;
    }

    map.on('load', () => {
      try {
        loadCity(geojson);
        const loading = $('loading');
        if (loading) loading.hidden = true;
      } catch (err) {
        console.error(err);
        showLoadError(`Fehler beim Aufbau der Karte: ${err.message}`);
      }
    });
  } catch (err) {
    console.error(err);
    showLoadError(`Fehler beim Start: ${err.message}`);
  }
}

init();
