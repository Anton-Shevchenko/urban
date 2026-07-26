import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  LIVING_WEIGHTS,
  PILLAR_KEYS,
  PRESETS,
  createContextFromFeatures,
  createScoringEngine,
  deriveWalkingQuality,
  findExtremeHex,
  livingScore,
  pillarScores,
  shouldPaintAbsolute,
  walkMinuteBandScore,
  walkMinuteDecayScore,
} from './engine';
import { explainLivingScore } from './explain';

const __dirname = dirname(fileURLToPath(import.meta.url));
const geo = JSON.parse(
  readFileSync(join(__dirname, '../../public/data/hexes.geojson'), 'utf8'),
);
const features = geo.features;
const meta = geo.meta || {};

function engineWithPreset(presetId: string) {
  const ctx = createContextFromFeatures(features, meta);
  const engine = createScoringEngine(ctx, features);
  engine.applyPreset(PRESETS[presetId as keyof typeof PRESETS] || PRESETS.standard);
  return engine;
}

describe('walk-minute band accessibility', () => {
  it('scores perfect within 5 minutes', () => {
    expect(walkMinuteBandScore(1)).toBe(100);
    expect(walkMinuteBandScore(5)).toBe(100);
    expect(walkMinuteDecayScore(1)).toBe(100);
  });

  it('falls off through walk-minute knots', () => {
    expect(walkMinuteBandScore(5)).toBe(100);
    expect(walkMinuteBandScore(10)).toBe(70);
    expect(walkMinuteBandScore(15)).toBe(30);
    expect(walkMinuteBandScore(20)).toBe(0);
    expect(walkMinuteBandScore(10)).toBeGreaterThan(walkMinuteBandScore(15));
  });
});

describe('absolute paint when a pillar dominates', () => {
  it('keeps rank paint for balanced defaults', () => {
    expect(shouldPaintAbsolute(LIVING_WEIGHTS)).toBe(false);
  });

  it('switches to absolute when one pillar is ≥50%', () => {
    expect(shouldPaintAbsolute({ ...LIVING_WEIGHTS, green: 0.5, walk: 0.1 })).toBe(true);
    expect(shouldPaintAbsolute({ centrality: 1 })).toBe(true);
    expect(shouldPaintAbsolute({ green: 0.49, walk: 0.51 })).toBe(true);
    expect(shouldPaintAbsolute({ green: 0.49, walk: 0.2, transit: 0.31 })).toBe(false);
  });
});

describe('15-Minute Living Score pillars', () => {
  it('uses fixed default weights summing to 1', () => {
    const sum = Object.values(LIVING_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 5);
    expect(PILLAR_KEYS).toEqual([
      'daily_life', 'walk', 'green', 'transit', 'centrality', 'quiet', 'housing_value',
    ]);
  });

  it('computes living score for Munich hexes with fallbacks', () => {
    const near = findExtremeHex(features, 's_daily_needs', 'max')
      || findExtremeHex(features, 'center_min', 'min');
    const { score, pillars } = livingScore(near);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
    for (const k of PILLAR_KEYS) {
      expect(pillars[k]).toBeGreaterThanOrEqual(0);
      expect(pillars[k]).toBeLessThanOrEqual(100);
    }
  });

  it('derives walking quality when walk pillar missing', () => {
    const p = { ...features[0].properties };
    delete p.s_walk;
    delete p.s_walking_quality;
    const wq = deriveWalkingQuality(p);
    expect(wq).toBeGreaterThanOrEqual(0);
    expect(wq).toBeLessThanOrEqual(100);
  });

  it('central hexes score higher than outer ones on average', () => {
    const engine = engineWithPreset('standard');
    const near = findExtremeHex(features, 'center_min', 'min');
    const far = findExtremeHex(features, 'center_min', 'max');
    const nearC = engine.comfortScalar(near)!;
    const farC = engine.comfortScalar(far)!;
    expect(nearC).toBeGreaterThan(farC);
  });

  it('no_car profile boosts walk + transit weights', () => {
    const engine = engineWithPreset('no_car');
    const w = engine.getPillarWeights();
    expect(w.walk).toBeGreaterThan(0.2);
    expect(w.transit).toBeGreaterThan(0.2);
  });

  it('switching presets changes living scores for many hexes', () => {
    const ctx = createContextFromFeatures(features, meta);
    const engine = createScoringEngine(ctx, features);
    engine.applyPreset(PRESETS.standard);
    const std = features.slice(0, 200).map((f) => engine.comfortScalar(f.properties)!);
    engine.applyPreset(PRESETS.no_car);
    const nc = features.slice(0, 200).map((f) => engine.comfortScalar(f.properties)!);
    engine.applyPreset(PRESETS.family);
    const fam = features.slice(0, 200).map((f) => engine.comfortScalar(f.properties)!);
    const changedNc = std.filter((s, i) => Math.abs(s - nc[i]) >= 2).length;
    const changedFam = std.filter((s, i) => Math.abs(s - fam[i]) >= 2).length;
    expect(changedNc).toBeGreaterThan(40);
    expect(changedFam).toBeGreaterThan(20);
  });

  it('senior profile penalises expensive centre vs affordable mid-city', () => {
    const engine = engineWithPreset('senior');
    const expensive = findExtremeHex(features, 'rent_eur_m2', 'max');
    // Prefer a cheap hex that still has decent daily life (not empty fringe).
    const affordable = [...features]
      .filter((f) => Number(f.properties.s_daily_life) >= 70)
      .sort(
        (a, b) => Number(a.properties.rent_eur_m2) - Number(b.properties.rent_eur_m2),
      )[0]?.properties;
    expect(expensive).toBeTruthy();
    expect(affordable).toBeTruthy();
    const expScore = engine.comfortScalar(expensive)!;
    const affScore = engine.comfortScalar(affordable)!;
    expect(Number(expensive.rent_eur_m2)).toBeGreaterThan(Number(affordable.rent_eur_m2));
    expect(affScore).toBeGreaterThan(expScore + 5);
    expect(engine.getAffordabilityFocus?.()).toBeGreaterThanOrEqual(0.7);
  });

  it('family profile raises education multipliers', () => {
    const engine = engineWithPreset('family');
    const gm = engine.getGroupMultipliers();
    expect(gm.dl_education).toBeGreaterThan(1);
    expect(gm.dl_food).toBeGreaterThan(1);
  });

  it('evaluateHex returns seven living metrics', () => {
    const engine = engineWithPreset('standard');
    const ev = engine.evaluateHex(features[0].properties);
    expect(ev.activeKeys).toEqual(PILLAR_KEYS);
    expect(ev.pillars).toBeTruthy();
    expect(ev.livingScore).toBeGreaterThanOrEqual(0);
  });
});

describe('German explanation', () => {
  it('builds a narrative with score and pillars', () => {
    const p = findExtremeHex(features, 's_daily_needs', 'max') || features[0].properties;
    const explained = explainLivingScore(p);
    expect(explained.score).toBeGreaterThanOrEqual(0);
    expect(explained.text.length).toBeGreaterThan(20);
    expect(explained.text).toMatch(/Auto|auto/);
  });
});

describe('pillarScores consistency', () => {
  it('daily_life prefers s_daily_life / s_daily_needs', () => {
    const p = { ...features[0].properties, s_daily_life: 88, s_daily_needs: 40 };
    expect(pillarScores(p).daily_life).toBe(88);
  });

  it('walk prefers s_walk over walking_quality', () => {
    const p = { ...features[0].properties, s_walk: 77, s_walking_quality: 40 };
    expect(pillarScores(p).walk).toBe(77);
  });
});
