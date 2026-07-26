#!/usr/bin/env node
/**
 * Profile Monte Carlo — 1000 synthetic users through the scoring engine.
 *
 * Usage:
 *   node scripts/profile_monte_carlo.mjs
 *   node scripts/profile_monte_carlo.mjs --profiles 500 --seed 42 --top 15
 *   node scripts/profile_monte_carlo.mjs --geojson data/cities/muenchen/hexes.geojson
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  IMPORTANCE_KEYS,
  PREF_KEYS,
  PRESETS,
  createContextFromFeatures,
  createScoringEngine,
} from '../tests/scoring-engine.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Approximate Munich district centroids (lat, lng) for win-rate aggregation. */
const MUNICH_ZONES = [
  { id: 'altstadt', label: 'Altstadt-Lehel', lat: 48.137, lng: 11.575 },
  { id: 'maxvorstadt', label: 'Maxvorstadt', lat: 48.150, lng: 11.565 },
  { id: 'schwabing', label: 'Schwabing', lat: 48.158, lng: 11.576 },
  { id: 'haidhausen', label: 'Haidhausen', lat: 48.128, lng: 11.598 },
  { id: 'bogenhausen', label: 'Bogenhausen', lat: 48.145, lng: 11.615 },
  { id: 'laim', label: 'Laim', lat: 48.145, lng: 11.520 },
  { id: 'pasing', label: 'Pasing', lat: 48.145, lng: 11.461 },
  { id: 'sendling', label: 'Sendling', lat: 48.122, lng: 11.555 },
  { id: 'giesing', label: 'Giesing', lat: 48.115, lng: 11.590 },
  { id: 'trudering', label: 'Trudering', lat: 48.125, lng: 11.665 },
  { id: 'riem', label: 'Riem', lat: 48.138, lng: 11.695 },
  { id: 'moosach', label: 'Moosach', lat: 48.183, lng: 11.505 },
  { id: 'feldmoching', label: 'Feldmoching', lat: 48.218, lng: 11.528 },
  { id: 'aubing', label: 'Aubing', lat: 48.158, lng: 11.420 },
  { id: 'forstenried', label: 'Forstenried', lat: 48.105, lng: 11.485 },
];

const ARCHETYPES = {
  family: {
    label: 'Familie',
    weights: { center: 2, daily_needs: 3, transit_service: 2, green: 3, noise: 2, price: 2, traffic_safety: 1 },
    prefs: { urban_activity: 45, density: 55, housing: 25 },
    prefInclude: true,
    budget: [1400, 1900],
  },
  student: {
    label: 'Student',
    weights: { center: 3, daily_needs: 2, transit_service: 3, green: 1, noise: 1, price: 3, traffic_safety: 0 },
    prefs: { urban_activity: 75, density: 70, housing: 40 },
    prefInclude: true,
    budget: [700, 1100],
  },
  business: {
    label: 'Business',
    weights: PRESETS.business,
    prefs: { urban_activity: 85, density: 70, housing: 50 },
    prefInclude: true,
    budget: [1500, 2400],
  },
  retiree: {
    label: 'Rentner',
    weights: { center: 1, daily_needs: 3, transit_service: 2, green: 3, noise: 3, price: 2, traffic_safety: 2 },
    prefs: { urban_activity: 25, density: 30, housing: 20 },
    prefInclude: true,
    budget: [1000, 1500],
  },
  cyclist: {
    label: 'Radfahrer',
    weights: { center: 2, daily_needs: 2, transit_service: 2, green: 3, noise: 2, price: 2, traffic_safety: 2 },
    prefs: { urban_activity: 55, density: 50, housing: 35 },
    prefInclude: true,
    budget: [1100, 1700],
  },
  nature: {
    label: 'Natur',
    weights: { center: 0, daily_needs: 1, transit_service: 1, green: 4, noise: 3, price: 2, traffic_safety: 1 },
    prefs: { urban_activity: 20, density: 25, housing: 40 },
    prefInclude: true,
    budget: [1200, 1800],
  },
  budget: {
    label: 'Budget',
    weights: PRESETS.budget,
    prefs: { urban_activity: 50, density: 40, housing: 60 },
    prefInclude: true,
    budget: [900, 1300],
  },
  central: {
    label: 'Zentrum',
    weights: PRESETS.central,
    prefs: { urban_activity: 70, density: 65, housing: 35 },
    prefInclude: true,
    budget: [1400, 2200],
  },
  quiet: {
    label: 'Ruhig',
    weights: PRESETS.quiet,
    prefs: { urban_activity: 20, density: 35, housing: 40 },
    prefInclude: true,
    budget: [1200, 1800],
  },
};

const ARCHETYPE_IDS = Object.keys(ARCHETYPES);
const ARCHETYPE_WEIGHTS = {
  family: 0.18,
  student: 0.12,
  business: 0.14,
  retiree: 0.10,
  cyclist: 0.08,
  nature: 0.10,
  budget: 0.14,
  central: 0.08,
  quiet: 0.06,
};

function parseArgs(argv) {
  const opts = {
    geojson: join(__dirname, '..', 'web', 'data', 'hexes.geojson'),
    profiles: 1000,
    seed: 20260714,
    top: 10,
    json: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--geojson') opts.geojson = argv[++i];
    else if (a === '--profiles') opts.profiles = Number(argv[++i]);
    else if (a === '--seed') opts.seed = Number(argv[++i]);
    else if (a === '--top') opts.top = Number(argv[++i]);
    else if (a === '--json') opts.json = true;
    else if (a === '--help') {
      console.log('Usage: node scripts/profile_monte_carlo.mjs [--profiles N] [--seed N] [--top N] [--geojson PATH] [--json]');
      process.exit(0);
    }
  }
  return opts;
}

function mulberry32(seed) {
  let t = seed >>> 0;
  return () => {
    t += 0x6D2B79F5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function clampIdx(v) {
  return Math.max(0, Math.min(4, Math.round(v)));
}

function hexCentroid(feature) {
  const ring = feature.geometry?.coordinates?.[0];
  if (!ring?.length) return null;
  let lng = 0;
  let lat = 0;
  for (const [x, y] of ring) {
    lng += x;
    lat += y;
  }
  return { lat: lat / ring.length, lng: lng / ring.length };
}

function dist2(lat1, lng1, lat2, lng2) {
  const dlat = lat1 - lat2;
  const dlng = lng1 - lng2;
  return dlat * dlat + dlng * dlng;
}

function assignZones(features) {
  return features.map((f) => {
    const c = hexCentroid(f);
    if (!c) return { feature: f, zone: null };
    let best = MUNICH_ZONES[0];
    let bestD = Infinity;
    for (const z of MUNICH_ZONES) {
      const d = dist2(c.lat, c.lng, z.lat, z.lng);
      if (d < bestD) {
        bestD = d;
        best = z;
      }
    }
    return { feature: f, zone: best, lat: c.lat, lng: c.lng };
  });
}

function pickArchetype(rng) {
  const r = rng();
  let acc = 0;
  for (const id of ARCHETYPE_IDS) {
    acc += ARCHETYPE_WEIGHTS[id] ?? 1 / ARCHETYPE_IDS.length;
    if (r <= acc) return id;
  }
  return ARCHETYPE_IDS[ARCHETYPE_IDS.length - 1];
}

function sampleProfile(rng) {
  const archetypeId = pickArchetype(rng);
  const archetype = ARCHETYPES[archetypeId];
  const weights = {};
  for (const k of IMPORTANCE_KEYS) {
    const base = archetype.weights[k] ?? 0;
    const jitter = rng() < 0.35 ? (rng() < 0.5 ? -1 : 1) : 0;
    weights[k] = clampIdx(base + jitter);
  }
  // Occasional Kritisch on one random active factor (~8%).
  if (rng() < 0.08) {
    const active = IMPORTANCE_KEYS.filter((k) => weights[k] > 0);
    if (active.length) {
      const k = active[Math.floor(rng() * active.length)];
      weights[k] = 4;
    }
  }
  const prefTargets = {};
  for (const k of PREF_KEYS) {
    const base = archetype.prefs?.[k] ?? 50;
    const jitter = (rng() - 0.5) * 24;
    prefTargets[k] = Math.max(10, Math.min(90, Math.round(base + jitter)));
  }
  const prefInclude = archetype.prefInclude && rng() < 0.75;
  let maxMonthlyBudget = null;
  if ((weights.price ?? 0) >= 2 && archetype.budget) {
    const [lo, hi] = archetype.budget;
    maxMonthlyBudget = Math.round(lo + rng() * (hi - lo));
  }
  return {
    archetypeId,
    archetypeLabel: archetype.label,
    weights,
    prefTargets,
    prefInclude,
    maxMonthlyBudget,
    desiredAreaM2: rng() < 0.3 ? 45 : rng() < 0.6 ? 60 : 80,
  };
}

function applyProfile(engine, profile) {
  const { ctx } = engine;
  IMPORTANCE_KEYS.forEach((k) => { ctx.weights[k] = profile.weights[k] ?? 0; });
  PREF_KEYS.forEach((k) => { ctx.prefTargets[k] = profile.prefTargets[k] ?? 50; });
  ctx.prefInclude = profile.prefInclude;
  ctx.maxMonthlyBudget = profile.maxMonthlyBudget;
  ctx.desiredAreaM2 = profile.desiredAreaM2;
}

function topHexes(engine, hexes, n) {
  const scored = hexes.map((h) => ({
    h,
    comfort: engine.comfortScalar(h.feature.properties),
  })).filter((x) => x.comfort != null);
  scored.sort((a, b) => b.comfort - a.comfort);
  return scored.slice(0, n);
}

function dominantFactor(engine) {
  const keys = engine.activeImportanceKeys();
  if (!keys.length) return null;
  let best = null;
  let bestImp = -1;
  keys.forEach((k) => {
    const imp = engine.ctx.weights[k] ?? 0;
    if (imp > bestImp) {
      bestImp = imp;
      best = k;
    }
  });
  return { factor: best, importance: bestImp };
}

function comfortHistogram(values) {
  const bins = [
    [0, 30], [30, 40], [40, 50], [50, 60], [60, 70], [70, 80], [80, 90], [90, 100.01],
  ];
  return bins.map(([lo, hi]) => ({
    lo,
    hi: hi === 100.01 ? 100 : hi,
    pct: 100 * values.filter((v) => v >= lo && v < hi).length / values.length,
  }));
}

function run(opts) {
  const geo = JSON.parse(readFileSync(opts.geojson, 'utf8'));
  const features = geo.features;
  const meta = geo.meta || {};
  const hexes = assignZones(features);
  const ctx = createContextFromFeatures(features, meta);
  const engine = createScoringEngine(ctx, features);
  const rng = mulberry32(opts.seed);

  const zoneTopN = Object.fromEntries(MUNICH_ZONES.map((z) => [z.id, 0]));
  const zoneTop1 = Object.fromEntries(MUNICH_ZONES.map((z) => [z.id, 0]));
  const factorWins = Object.fromEntries(IMPORTANCE_KEYS.map((k) => [k, 0]));
  const archetypeCounts = Object.fromEntries(ARCHETYPE_IDS.map((k) => [k, 0]));
  const topComforts = [];
  const profileMeans = [];

  for (let i = 0; i < opts.profiles; i += 1) {
    const profile = sampleProfile(rng);
    archetypeCounts[profile.archetypeId] += 1;
    applyProfile(engine, profile);
    engine.rebuildCityStats();

    const top = topHexes(engine, hexes, opts.top);
    if (!top.length) continue;

    topComforts.push(...top.map((t) => t.comfort));
    const allComforts = hexes.map((h) => engine.comfortScalar(h.feature.properties)).filter((c) => c != null);
    profileMeans.push(allComforts.reduce((a, b) => a + b, 0) / allComforts.length);

    const zonesInTop = new Set();
    top.forEach((t) => {
      if (!t.h.zone) return;
      zonesInTop.add(t.h.zone.id);
    });
    zonesInTop.forEach((zid) => { zoneTopN[zid] += 1; });

    const winner = top[0];
    if (winner?.h?.zone) zoneTop1[winner.h.zone.id] += 1;

    const dom = dominantFactor(engine);
    if (dom?.factor) factorWins[dom.factor] += 1;
  }

  const neverTop = MUNICH_ZONES.filter((z) => zoneTopN[z.id] === 0).map((z) => z.label);
  const zoneRanking = [...MUNICH_ZONES]
    .map((z) => ({
      id: z.id,
      label: z.label,
      topN: zoneTopN[z.id],
      top1: zoneTop1[z.id],
      topNPct: 100 * zoneTopN[z.id] / opts.profiles,
      top1Pct: 100 * zoneTop1[z.id] / opts.profiles,
    }))
    .sort((a, b) => b.topN - a.topN);

  const factorRanking = IMPORTANCE_KEYS
    .map((k) => ({ factor: k, wins: factorWins[k], pct: 100 * factorWins[k] / opts.profiles }))
    .sort((a, b) => b.wins - a.wins);

  const result = {
    city: meta.name || 'unknown',
    profiles: opts.profiles,
    seed: opts.seed,
    topK: opts.top,
    hexes: features.length,
    comfortTopK: {
      mean: topComforts.reduce((a, b) => a + b, 0) / topComforts.length,
      p50: percentile(topComforts, 0.5),
      ge70: 100 * topComforts.filter((v) => v >= 70).length / topComforts.length,
      ge80: 100 * topComforts.filter((v) => v >= 80).length / topComforts.length,
    },
    comfortCityMean: profileMeans.reduce((a, b) => a + b, 0) / profileMeans.length,
    zoneRanking,
    neverInTop10: neverTop,
    factorDominance: factorRanking,
    archetypes: archetypeCounts,
    comfortHistogram: comfortHistogram(topComforts),
  };

  return result;
}

function percentile(vals, p) {
  const s = [...vals].sort((a, b) => a - b);
  const i = Math.floor(p * (s.length - 1));
  return s[i];
}

function printReport(r) {
  console.log(`\n=== Profile Monte Carlo: ${r.city} ===`);
  console.log(`${r.profiles} profiles · seed ${r.seed} · top-${r.topK} · ${r.hexes} hexes\n`);

  console.log('--- Top-K comfort (winners) ---');
  console.log(`mean=${r.comfortTopK.mean.toFixed(1)}  p50=${r.comfortTopK.p50.toFixed(1)}  >=70=${r.comfortTopK.ge70.toFixed(1)}%  >=80=${r.comfortTopK.ge80.toFixed(1)}%`);
  console.log(`city-wide mean comfort per profile: ${r.comfortCityMean.toFixed(1)}\n`);

  console.log('--- Comfort histogram (top-K picks) ---');
  for (const b of r.comfortHistogram) {
    const bar = '█'.repeat(Math.round(b.pct / 2));
    console.log(`  ${String(b.lo).padStart(3)}-${String(b.hi).padStart(3)}  ${bar.padEnd(50)} ${b.pct.toFixed(1)}%`);
  }

  console.log('\n--- Zone win rates (appears in top-K) ---');
  console.log(`${'zone'.padEnd(16)} ${'top-K'.padStart(8)} ${'%'.padStart(7)}  ${'#1'.padStart(6)} ${'%'.padStart(6)}`);
  console.log('-'.repeat(48));
  for (const z of r.zoneRanking) {
    if (z.topN === 0) continue;
    console.log(
      `${z.label.padEnd(16)} ${String(z.topN).padStart(8)} ${z.topNPct.toFixed(1).padStart(6)}%  `
      + `${String(z.top1).padStart(6)} ${z.top1Pct.toFixed(1).padStart(5)}%`,
    );
  }

  if (r.neverInTop10.length) {
    console.log(`\nNever in top-${r.topK}: ${r.neverInTop10.join(', ')}`);
  } else {
    console.log(`\nAll zones appeared in top-${r.topK} at least once.`);
  }

  console.log('\n--- Dominant factor (highest weight share, #1 pick) ---');
  for (const f of r.factorDominance.filter((x) => x.wins > 0)) {
    console.log(`  ${f.factor.padEnd(18)} ${String(f.wins).padStart(5)}  (${f.pct.toFixed(1)}%)`);
  }

  console.log('\n--- Archetype mix ---');
  for (const [id, count] of Object.entries(r.archetypes).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${ARCHETYPES[id].label.padEnd(12)} ${count}  (${(100 * count / r.profiles).toFixed(1)}%)`);
  }
}

const opts = parseArgs(process.argv);
const result = run(opts);
if (opts.json) {
  console.log(JSON.stringify(result, null, 2));
} else {
  printReport(result);
}
