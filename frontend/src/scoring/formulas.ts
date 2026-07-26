// @ts-nocheck
/**
 * Living Score core formulas & weights (tune here).
 *
 * Composite:
 *   s_living = Σ (w_i × pillar_i) / Σ w_i
 *
 * Default pillar weights (must sum to 1):
 *   daily_life 0.20 · walk 0.20 · green 0.15 · transit 0.15
 *   centrality 0.10 · quiet 0.10 · housing_value 0.10
 *
 * Pillars (pipeline fields; frontend reweights / overlays):
 *   Alltag (s_daily_life) — walk-minute band per amenity → max in group →
 *     weighted groups (food 0.30, education 0.20, health/services 0.15,
 *     restaurants_cafes/other 0.10). Parks live in Green, not here.
 *   Gehqualität (s_walk) — network / safety / comfort / accessibility.
 *   Grün (s_green) — 40% park dist (+ area) + 30% share + 20% canopy + 10% water.
 *   ÖPNV (s_transit) — distance + frequency + connectivity.
 *   Zentralität (s_center) — polycentric center proximity.
 *   Ruhe (s_quiet) — noise → quiet (higher = quieter).
 *   Wohnwert (s_housing_value) — 0.50×affordability + 0.25×daily_life
 *     + 0.25×(0.5×transit + 0.5×walk).
 *
 * Walk-minute band: 0–5 → 100, 10 → 70, 15 → 30, ≥20 → 0 (piecewise linear).
 *
 * Profiles (PRESETS) renormalise pillar weights; optional dl_* group multipliers
 * and affordability_focus blend housing toward s_rent_relative_city (soft
 * penalty on cheapest-city-quartile rents when focus ≥ 0.45).
 *
 * With default weights / no group multipliers / focus≈0, livingScore short-circuits
 * to precomputed s_living from the pipeline.
 */

/** Fixed default Living Score weights (must sum to 1). */
export const LIVING_WEIGHTS = {
  daily_life: 0.20,
  walk: 0.20,
  green: 0.15,
  transit: 0.15,
  centrality: 0.10,
  quiet: 0.10,
  housing_value: 0.10,
};

export const PILLAR_KEYS = [
  'daily_life', 'walk', 'green', 'transit', 'centrality', 'quiet', 'housing_value',
];

/** When any Living Score pillar is at/above this share, map paints absolute score (not city rank). */
export const ABSOLUTE_PAINT_PILLAR_THRESHOLD = 0.5;

export const DAILY_LIFE_GROUP_WEIGHTS = {
  food: 0.30,
  health: 0.15,
  education: 0.20,
  services: 0.15,
  restaurants_cafes: 0.10,
  other: 0.10,
};

/** Amenity categories per daily-life group (max score within group). */
export const DAILY_LIFE_GROUPS = {
  food: ['bakery', 'supermarket', 'market'],
  health: ['pharmacy', 'doctor', 'clinic'],
  education: ['kita', 'school'],
  services: ['bank', 'administration'],
  restaurants_cafes: ['restaurant', 'cafe'],
  other: ['post', 'sports'],
};

/** Piecewise walk-minute knots: minutes → score. */
export const WALK_MINUTE_BAND_X = [0, 5, 10, 15, 20];
export const WALK_MINUTE_BAND_Y = [100, 100, 70, 30, 0];

/** Soft penalty when affordability_focus ≥ this and rent is in expensive city quartile. */
export const AFFORDABILITY_PENALTY_FOCUS = 0.45;

/** Legacy exponential walk-minute decay (diagnostics / back-compat; band score is primary). */
export const WALK_DECAY = {
  supermarket: 7.0, bakery: 4.5, market: 5.5, pharmacy: 6.0,
  doctor: 7.5, clinic: 8.0, kita: 6.5, school: 7.5,
  post: 5.5, bank: 5.5, administration: 8.0, park: 8.0,
  playground: 5.0, sports: 7.0, restaurant: 4.0, cafe: 4.0, default: 6.0,
};
export const WALK_PLATEAU = 2.0;

export const DAILY_NEED_CATS = [
  'supermarket', 'bakery', 'pharmacy', 'doctor', 'kita', 'school',
  'restaurant', 'cafe', 'bank', 'sports', 'post', 'park',
  'market', 'playground', 'administration', 'clinic',
];

export const DAILY_NEEDS_WEIGHTS = {
  supermarket: 1.2, bakery: 0.6, pharmacy: 1.0, doctor: 1.0,
  kita: 0.8, school: 0.8, restaurant: 0.5, cafe: 0.4,
  bank: 0.5, sports: 0.6, post: 0.4, park: 0.7,
  market: 0.8, playground: 0.6, administration: 0.5, clinic: 0.9,
};

/**
 * Profile pillar weights (renormalised). Also carry optional daily-life
 * group multipliers and legacy importance/prefs for UI back-compat.
 */
export const PRESETS = {
  standard: {
    daily_life: 0.20, walk: 0.20, green: 0.15, transit: 0.15,
    centrality: 0.10, quiet: 0.10, housing_value: 0.10,
    affordability_focus: 0,
    center: 0, daily_needs: 0, transit_service: 0, noise: 0,
    heat: 0, traffic_safety: 0, price: 0, custom_dest: 0,
    urban_activity: 50, density: 55, housing: 40,
  },
  family: {
    // Families need space/budget — don't crown the expensive core.
    daily_life: 0.24, walk: 0.12, green: 0.22, transit: 0.10,
    centrality: 0.03, quiet: 0.12, housing_value: 0.17,
    affordability_focus: 0.55,
    dl_education: 1.8, dl_food: 1.3, dl_health: 1.2, dl_other: 0.7,
    center: 0, daily_needs: 0, transit_service: 0, noise: 0,
    heat: 0, traffic_safety: 0, price: 0, custom_dest: 0,
    urban_activity: 40, density: 45, housing: 25,
  },
  young_professional: {
    daily_life: 0.16, walk: 0.14, green: 0.08, transit: 0.28,
    centrality: 0.20, quiet: 0.04, housing_value: 0.10,
    affordability_focus: 0.15,
    dl_food: 1.1, dl_restaurants_cafes: 1.4, dl_services: 1.1,
    center: 0, daily_needs: 0, transit_service: 0, noise: 0,
    heat: 0, traffic_safety: 0, price: 0, custom_dest: 0,
    urban_activity: 80, density: 70, housing: 50,
  },
  senior: {
    // Pensioners: walkable daily life + quiet, but expensive centre must lose.
    daily_life: 0.18, walk: 0.18, green: 0.10, transit: 0.12,
    centrality: 0.02, quiet: 0.14, housing_value: 0.26,
    affordability_focus: 0.80,
    dl_health: 1.8, dl_services: 1.3, dl_food: 1.2,
    center: 0, daily_needs: 0, transit_service: 0, noise: 0,
    heat: 0, traffic_safety: 0, price: 0, custom_dest: 0,
    urban_activity: 30, density: 40, housing: 35,
  },
  no_car: {
    daily_life: 0.14, walk: 0.28, green: 0.06, transit: 0.30,
    centrality: 0.12, quiet: 0.02, housing_value: 0.08,
    affordability_focus: 0.25,
    dl_food: 1.3, dl_health: 1.1, dl_services: 1.2, dl_restaurants_cafes: 1.1,
    center: 0, daily_needs: 0, transit_service: 0, noise: 0,
    heat: 0, traffic_safety: 0, price: 0, custom_dest: 0,
    urban_activity: 60, density: 60, housing: 40,
  },
};
// Legacy preset aliases
PRESETS.balanced = PRESETS.standard;
PRESETS.quiet = PRESETS.senior;
PRESETS.central = PRESETS.no_car;
PRESETS.business = PRESETS.young_professional;
PRESETS.budget = PRESETS.standard;

export function clamp100(v) {
  return Math.max(0, Math.min(100, v));
}

function num(v, fallback = null) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** True when one pillar dominates — Living Score fill should use absolute 0–100, not rank. */
export function shouldPaintAbsolute(
  pillarWeights: Record<string, number> | null | undefined,
  threshold = ABSOLUTE_PAINT_PILLAR_THRESHOLD,
): boolean {
  if (!pillarWeights) return false;
  let max = 0;
  for (const k of PILLAR_KEYS) {
    const w = Number(pillarWeights[k]);
    if (Number.isFinite(w) && w > max) max = w;
  }
  return max >= threshold;
}

/** Piecewise walk accessibility: 5→100, 10→70, 15→30, ≥20→0. */
export function walkMinuteBandScore(minutes) {
  const m = Number(minutes);
  if (!Number.isFinite(m)) return 0;
  const xs = WALK_MINUTE_BAND_X;
  const ys = WALK_MINUTE_BAND_Y;
  if (m <= xs[0]) return ys[0];
  if (m >= xs[xs.length - 1]) return ys[ys.length - 1];
  for (let i = 1; i < xs.length; i++) {
    if (m <= xs[i]) {
      const t = (m - xs[i - 1]) / (xs[i] - xs[i - 1]);
      return clamp100(ys[i - 1] + t * (ys[i] - ys[i - 1]));
    }
  }
  return 0;
}

export function walkMinuteDecayScore(minutes, decay = 6, plateau = WALK_PLATEAU) {
  // Prefer Match/Living band curve; decay args kept for call-site back-compat.
  void decay;
  void plateau;
  return walkMinuteBandScore(minutes);
}

function logSatScore(value, sat) {
  const v = Number(value);
  if (!Number.isFinite(v) || v <= 0) return 0;
  return clamp100((100 * Math.log1p(v)) / Math.log1p(sat));
}

/** Derive walking quality when pipeline pillar is missing (schema < 11). */
export function deriveWalkingQuality(p) {
  const safety = num(p.s_traffic_safety, 55);
  const green = num(p.s_green, 50);
  const quiet = num(p.s_noise, 50);
  return clamp100(0.45 * safety + 0.30 * green + 0.25 * quiet);
}

/** True when pipeline urban-form / density inputs are flat or missing. */
export function isUrbanFormBroken(p) {
  const pop = num(p.population_density, null);
  const ufDens = num(p.uf_density, null);
  const dens = num(p.s_density, null);
  // Bundled Munich data: population_density=0 and uf_density≈3–5 (not 0–100).
  if (pop != null && pop <= 0) return true;
  if (ufDens != null && ufDens < 15) return true;
  // Constant 50 is the normalize placeholder when Zensus density is missing.
  if (dens === 50 && (pop == null || pop <= 0)) return true;
  return false;
}

/** Derive urban form when pipeline pillar is missing or density is broken. */
export function deriveUrbanForm(p) {
  const pop = num(p.population_density, null);
  const dens = num(p.s_density, null);
  let densScore;
  if (pop != null && pop > 0) {
    densScore = logSatScore(pop, 8000);
  } else if (dens != null && dens !== 50) {
    // Constant 50 is the normalize placeholder when density is missing.
    densScore = dens;
  } else {
    // Proxy: activity + centrality stand in for missing Zensus density.
    densScore = clamp100(
      0.55 * (num(p.s_urban_activity, null) ?? logSatScore(p.urban_activity ?? p.business_count, 120))
      + 0.45 * num(p.s_center, 50),
    );
  }
  const act = num(p.s_urban_activity, null) ?? logSatScore(p.urban_activity ?? p.business_count, 120);
  const green = num(p.s_green, 50);
  return clamp100(0.45 * densScore + 0.35 * act + 0.20 * green);
}

export function dailyLifeFromGroups(p, groupMultipliers = null) {
  const scores = {};
  Object.entries(DAILY_LIFE_GROUPS).forEach(([group, cats]) => {
    const precomputed = num(p[`dl_${group}`], null);
    if (precomputed != null) {
      scores[group] = precomputed;
      return;
    }
    let best = 0;
    cats.forEach((cat) => {
      const avail = num(p[`dn_${cat}_avail`], null);
      if (avail != null) {
        best = Math.max(best, avail);
        return;
      }
      const mins = num(p[`dn_${cat}_min`], null);
      if (mins != null) {
        best = Math.max(best, walkMinuteDecayScore(mins, WALK_DECAY[cat] || WALK_DECAY.default));
      }
    });
    scores[group] = best;
  });

  let totalW = 0;
  let sum = 0;
  Object.entries(DAILY_LIFE_GROUP_WEIGHTS).forEach(([g, w]) => {
    const mult = groupMultipliers?.[`dl_${g}`] ?? 1;
    const ww = w * mult;
    totalW += ww;
    sum += ww * (scores[g] || 0);
  });
  return totalW > 0 ? clamp100(sum / totalW) : num(p.s_daily_needs, 50);
}

export function hasCustomGroupMultipliers(groupMultipliers) {
  return !!(
    groupMultipliers
    && Object.keys(groupMultipliers).some((k) => k.startsWith('dl_') && groupMultipliers[k] !== 1)
  );
}

/**
 * @param {number} affordabilityFocus 0–1: blend housing pillar toward pure
 *   city-relative cheapness (s_rent_relative_city). Senior/Family use high focus
 *   so expensive centres stop winning.
 */
export function pillarScores(p, groupMultipliers = null, affordabilityFocus = 0) {
  const daily = hasCustomGroupMultipliers(groupMultipliers)
    ? dailyLifeFromGroups(p, groupMultipliers)
    : (
      num(p.s_daily_life, null)
      ?? num(p.s_daily_needs, null)
      ?? dailyLifeFromGroups(p, groupMultipliers)
    );

  const walk = num(p.s_walk, null) ?? num(p.s_walking_quality, null) ?? deriveWalkingQuality(p);
  const transit = num(p.s_transit, null) ?? num(p.s_transit_service, 50);
  const green = num(p.s_green, 50);
  const centrality = num(p.s_center, 50);
  const quiet = num(p.s_quiet, null) ?? num(p.s_noise, 50);
  let housingValue = num(p.s_housing_value, null)
    ?? num(p.s_rent_value, null)
    ?? num(p.s_rent_relative_city, 50);
  const afford = num(p.s_rent_relative_city, null);
  const focus = Math.max(0, Math.min(1, Number(affordabilityFocus) || 0));
  if (afford != null && focus > 0) {
    housingValue = focus * afford + (1 - focus) * housingValue;
  }

  return {
    daily_life: clamp100(daily),
    walk: clamp100(walk),
    green: clamp100(green),
    transit: clamp100(transit),
    centrality: clamp100(centrality),
    quiet: clamp100(quiet),
    housing_value: clamp100(housingValue),
  };
}

export function livingScore(
  p,
  pillarWeights = LIVING_WEIGHTS,
  groupMultipliers = null,
  affordabilityFocus = 0,
) {
  const focus = Math.max(0, Math.min(1, Number(affordabilityFocus) || 0));
  const pillars = pillarScores(p, groupMultipliers, focus);
  const hasGroupMult = hasCustomGroupMultipliers(groupMultipliers);
  const weightsMatchDefault = PILLAR_KEYS.every(
    (k) => Math.abs((pillarWeights[k] ?? 0) - (LIVING_WEIGHTS[k] ?? 0)) < 0.001,
  );
  const pre = num(p.s_living, null);
  // Price-sensitive profiles must never short-circuit to the generic composite.
  if (pre != null && weightsMatchDefault && !hasGroupMult && focus < 0.01) {
    return { score: clamp100(pre), pillars };
  }

  let totalW = 0;
  let sum = 0;
  PILLAR_KEYS.forEach((k) => {
    const w = pillarWeights[k] ?? 0;
    if (w <= 0) return;
    totalW += w;
    sum += w * pillars[k];
  });
  let score = totalW > 0 ? clamp100(sum / totalW) : 50;

  // Extra soft penalty in the most expensive city quartile when price-focused.
  if (focus >= AFFORDABILITY_PENALTY_FOCUS) {
    const rel = num(p.s_rent_relative_city, null);
    if (rel != null && rel < 25) {
      const pen = 0.82 + 0.18 * (rel / 25);
      score = clamp100(score * pen);
    }
  }
  return { score, pillars };
}

/** Renormalise pillar weights from a preset or slider map. */
export function extractPillarWeights(presetOrWeights) {
  const w = {};
  let sum = 0;
  PILLAR_KEYS.forEach((k) => {
    const v = Number(presetOrWeights[k]);
    w[k] = Number.isFinite(v) && v > 0 ? v : 0;
    sum += w[k];
  });
  if (sum <= 0) return { ...LIVING_WEIGHTS };
  PILLAR_KEYS.forEach((k) => { w[k] /= sum; });
  return w;
}

export function extractGroupMultipliers(preset) {
  const out = {};
  Object.keys(DAILY_LIFE_GROUP_WEIGHTS).forEach((g) => {
    const key = `dl_${g}`;
    if (preset[key] != null) out[key] = Number(preset[key]) || 1;
  });
  return out;
}
