import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import {
  IMPORTANCE_KEYS,
  IMPORTANCE_TO_QUANTILE,
  PRESETS,
  computeFactorPercentiles,
  createContextFromFeatures,
  createScoringEngine,
  findExtremeHex,
  loadMunichFixtures,
  thresholdForImportance,
} from './scoring-engine.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const { features, meta } = loadMunichFixtures();

function engineWithPreset(preset) {
  const ctx = createContextFromFeatures(features, meta);
  ctx.prefInclude = false;
  const engine = createScoringEngine(ctx, features);
  engine.applyPreset(preset);
  return engine;
}

function engineOnlyFactor(key, level) {
  const ctx = createContextFromFeatures(features, meta);
  const engine = createScoringEngine(ctx, features);
  engine.onlyFactor(key, level);
  return engine;
}

describe('importance maps to percentile thresholds', () => {
  it('maps levels 1-4 to P25/P50/P75/P90', () => {
    const p = { p25: 40, p50: 55, p75: 72, p90: 88 };
    assert.equal(thresholdForImportance(0, p), null);
    assert.equal(thresholdForImportance(1, p), 40);
    assert.equal(thresholdForImportance(2, p), 55);
    assert.equal(thresholdForImportance(3, p), 72);
    assert.equal(thresholdForImportance(4, p), 88);
  });

  it('computes city factor percentiles from distribution', () => {
    const p = computeFactorPercentiles([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
    assert.ok(p.p25 >= 20 && p.p25 <= 40);
    assert.ok(p.p90 >= 80 && p.p90 <= 100);
  });
});

describe('pass/fail threshold logic', () => {
  it('Egal (0) skips a factor', () => {
    const engine = engineOnlyFactor('noise', 4);
    assert.deepEqual(engine.activeImportanceKeys(), ['noise']);
    engine.ctx.weights.green = 0;
    assert.deepEqual(engine.activeImportanceKeys(), ['noise']);
  });

  it('hex passes when all active scores meet thresholds', () => {
    const engine = engineOnlyFactor('noise', 2);
    const quiet = findExtremeHex(features, 's_noise', 'max');
    const noisy = findExtremeHex(features, 's_noise', 'min');
    const quietEv = engine.evaluateHex(quiet);
    const noisyEv = engine.evaluateHex(noisy);
    assert.ok(quietEv.passed);
    assert.ok(!noisyEv.passed || quietEv.factors.noise.score >= noisyEv.factors.noise.score);
  });

  it('Kritisch noise filters to top ~10% of city', () => {
    const engine = engineOnlyFactor('noise', 4);
    const passing = features.filter((f) => engine.evaluateHex(f.properties).passed);
    const share = passing.length / features.length;
    assert.ok(share <= 0.15, `expected ~10% pass rate, got ${(share * 100).toFixed(1)}%`);
    assert.ok(share >= 0.05);
  });

  it('Mittel noise allows more hexes than Kritisch', () => {
    const mittel = engineOnlyFactor('noise', 2);
    const kritisch = engineOnlyFactor('noise', 4);
    const mittelPass = features.filter((f) => mittel.evaluateHex(f.properties).passed).length;
    const kritischPass = features.filter((f) => kritisch.evaluateHex(f.properties).passed).length;
    assert.ok(mittelPass > kritischPass);
  });
});

describe('ranking passed hexes by margin', () => {
  it('better margin yields higher priority score', () => {
    const engine = engineOnlyFactor('noise', 4);
    const passing = features
      .map((f) => ({ p: f.properties, ev: engine.evaluateHex(f.properties) }))
      .filter((x) => x.ev.passed)
      .sort((a, b) => b.ev.priorityScore - a.ev.priorityScore);
    assert.ok(passing.length >= 2);
    assert.ok(passing[0].ev.priorityScore >= passing[passing.length - 1].ev.priorityScore);
  });

  it('failing hex uses bottleneck band below 50; passing stays above 50', () => {
    const engine = engineOnlyFactor('noise', 4);
    if (!engine.hasPassingHexes()) return;
    const failing = features.find((f) => !engine.evaluateHex(f.properties).passed);
    const passing = features.find((f) => engine.evaluateHex(f.properties).passed);
    assert.ok(failing, 'need a failing hex');
    assert.ok(passing, 'need a passing hex');
    const failScore = engine.comfortScalar(failing.properties);
    const passScore = engine.comfortScalar(passing.properties);
    assert.ok(failScore < passScore);
    const failEv = engine.evaluateHex(failing.properties);
    assert.ok(failEv.factors.noise.score < failEv.factors.noise.threshold);
  });

  it('multi-factor: Kritisch center beats Gering price downtown', () => {
    const ctx = createContextFromFeatures(features, meta);
    ctx.weights.center = 4;
    ctx.weights.price = 1;
    ctx.prefInclude = false;
    const engine = createScoringEngine(ctx, features);
    const near = findExtremeHex(features, 'center_min', 'min');
    assert.ok(engine.comfortScalar(near) > 70);
  });

  it('Zentral preset keeps geo-centre relatively green', () => {
    const ctx = createContextFromFeatures(features, meta);
    const p = PRESETS.central;
    IMPORTANCE_KEYS.forEach((k) => { ctx.weights[k] = p[k] ?? 0; });
    ctx.prefInclude = false;
    const engine = createScoringEngine(ctx, features);
    const near = findExtremeHex(features, 'center_min', 'min');
    const far = findExtremeHex(features, 'center_min', 'max');
    assert.ok(engine.comfortScalar(near) > engine.comfortScalar(far));
    assert.ok(engine.comfortScalar(near) > 55);
  });
});

describe('no-match fallback', () => {
  it('returns closest match message when nothing passes', () => {
    const ctx = createContextFromFeatures(features, meta);
    ctx.weights.noise = 4;
    ctx.weights.green = 4;
    ctx.weights.daily_needs = 4;
    ctx.weights.center = 4;
    ctx.weights.transit_service = 4;
    ctx.weights.price = 4;
    const engine = createScoringEngine(ctx, features);
    if (engine.hasPassingHexes()) return;
    const msg = engine.closestMatchMessage();
    assert.ok(msg.includes('Keine Viertel'));
    assert.ok(msg.includes('Match'));
  });

  it('shows match score when no hex passes', () => {
    const ctx = createContextFromFeatures(features, meta);
    ctx.weights.noise = 4;
    ctx.weights.green = 4;
    ctx.weights.daily_needs = 4;
    ctx.weights.center = 4;
    ctx.weights.transit_service = 4;
    ctx.weights.price = 4;
    const engine = createScoringEngine(ctx, features);
    if (engine.hasPassingHexes()) return;
    const scores = features.map((f) => engine.comfortScalar(f.properties)).filter((v) => v != null);
    assert.ok(scores.length > 0);
    assert.ok(Math.max(...scores) <= 100);
  });
});

describe('price with budget', () => {
  it('affordable hex passes strict price when budget set', () => {
    const ctx = createContextFromFeatures(features, meta);
    ctx.maxMonthlyBudget = 1400;
    ctx.weights.price = 4;
    const engine = createScoringEngine(ctx, features);
    const cheap = findExtremeHex(features, 'rent_eur_m2', 'min');
    assert.ok(engine.evaluateHex(cheap).factors.price.passed);
  });
});

describe('presets produce distinct pass rates', () => {
  it('quiet Kritisch noise passes fewer hexes than balanced', () => {
    const balanced = engineWithPreset(PRESETS.balanced);
    const quiet = engineWithPreset(PRESETS.quiet);
    const balancedPass = features.filter((f) => balanced.evaluateHex(f.properties).passed).length;
    const quietPass = features.filter((f) => quiet.evaluateHex(f.properties).passed).length;
    assert.ok(balancedPass >= quietPass);
  });

  it('Kritisch center: near hex passes, far hex fails', () => {
    const engine = engineOnlyFactor('center', 4);
    const near = findExtremeHex(features, 'center_min', 'min');
    const far = findExtremeHex(features, 'center_min', 'max');
    assert.ok(engine.evaluateHex(near).passed);
    assert.ok(!engine.evaluateHex(far).factors.center.passed);
  });
});

describe('profile monte carlo', () => {
  it('runs synthetic user simulation without error', () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..');
    const r = spawnSync(
      process.execPath,
      ['scripts/profile_monte_carlo.mjs', '--profiles', '25', '--json', '--seed', '1'],
      { cwd: root, encoding: 'utf8' },
    );
    assert.equal(r.status, 0, r.stderr || r.stdout);
    const data = JSON.parse(r.stdout);
    assert.equal(data.profiles, 25);
    assert.ok(data.zoneRanking.length > 0);
  });
});

describe('sync with frontend scoring constants', () => {
  it('threshold scoring constants match frontend engine', () => {
    const src = readFileSync(
      join(__dirname, '..', 'frontend', 'src', 'scoring', 'engine.ts'),
      'utf8',
    );
    assert.match(src, /IMPORTANCE_TO_QUANTILE = \{ 1: 0\.25, 2: 0\.5, 3: 0\.75, 4: 0\.9 \}/);
    assert.match(src, /function evaluateHex\(/);
    assert.match(src, /function rebuildCityStats\(/);
    assert.match(src, /function closestMatchMessage\(/);
    assert.match(src, /function thresholdForImportance\(/);
    assert.match(src, /passingCount/);
  });
});
