import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  LIVING_WEIGHTS,
  OBJECTIVE_WEIGHTS,
  PILLAR_KEYS,
  PRESETS,
  createContextFromFeatures,
  createScoringEngine,
  deriveWalkingQuality,
  findExtremeHex,
  livingScore,
  locationScore,
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
  engine.applyPreset(PRESETS[presetId] || PRESETS.standard);
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
    expect(walkMinuteBandScore(10)!).toBeGreaterThan(walkMinuteBandScore(15)!);
  });
});

describe('absolute paint gate deprecated', () => {
  it('never auto-switches by pillar dominance', () => {
    expect(shouldPaintAbsolute(LIVING_WEIGHTS)).toBe(false);
    expect(shouldPaintAbsolute({ green: 0.5, walk: 0.1 })).toBe(false);
    expect(shouldPaintAbsolute({ centrality: 1 })).toBe(false);
  });
});

describe('objective-v2 Living Score', () => {
  it('uses fixed objective weights summing to 1 (no centrality)', () => {
    const sum = Object.values(OBJECTIVE_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 5);
    expect(OBJECTIVE_WEIGHTS).not.toHaveProperty('centrality');
    expect(PILLAR_KEYS).toContain('housing_affordability');
    expect(PILLAR_KEYS).toContain('centrality');
  });

  it('computes objective score for Munich hexes', () => {
    const near = findExtremeHex(features, 'dn_supermarket_min', 'min')
      || findExtremeHex(features, 'center_min', 'min');
    const { objectiveScore, pillars, confidence } = livingScore(near!);
    if (objectiveScore != null) {
      expect(objectiveScore).toBeGreaterThanOrEqual(0);
      expect(objectiveScore).toBeLessThanOrEqual(100);
    }
    expect(confidence).toBeGreaterThanOrEqual(0);
    expect(confidence).toBeLessThanOrEqual(1);
    for (const k of Object.keys(pillars)) {
      const v = pillars[k as keyof typeof pillars];
      if (v != null) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(100);
      }
    }
  });

  it('derives walking quality when walk pillar missing', () => {
    const p = { ...features[0].properties };
    delete p.s_walk;
    delete p.s_walking_quality;
    delete p.walking_quality_score;
    delete p.wq_network;
    const wq = deriveWalkingQuality(p);
    // May be null if no inputs — that is correct (not fake 50).
    if (wq != null) {
      expect(wq).toBeGreaterThanOrEqual(0);
      expect(wq).toBeLessThanOrEqual(100);
    }
  });

  it('preset does not change objectiveScore on map default mode', () => {
    const std = engineWithPreset('standard');
    const senior = engineWithPreset('senior');
    const sample = features.slice(0, 50);
    for (const f of sample) {
      const a = std.locationScore(f.properties).objectiveScore;
      const b = senior.locationScore(f.properties).objectiveScore;
      expect(a).toBe(b);
    }
  });

  it('budget preset is not identical to standard', () => {
    expect(PRESETS.budget).not.toEqual(PRESETS.standard);
    expect(PRESETS.budget.housing_affordability).toBeGreaterThan(
      PRESETS.standard.housing_affordability,
    );
  });

  it('evaluateHex exposes objective / match / confidence', () => {
    const engine = engineWithPreset('standard');
    const ev = engine.evaluateHex(features[0].properties);
    expect(ev).toHaveProperty('objectiveScore');
    expect(ev).toHaveProperty('personalMatchScore');
    expect(ev).toHaveProperty('confidence');
    expect(ev.livingScore).toBe(ev.objectiveScore);
  });
});

describe('explainLivingScore', () => {
  it('returns narrative for a Munich hex', () => {
    const p = features[0].properties;
    const explained = explainLivingScore(p);
    expect(explained.text.length).toBeGreaterThan(10);
    expect(explained).toHaveProperty('confidence');
  });
});

describe('city percentile via engine', () => {
  it('assigns percentiles when many hexes scored', () => {
    const engine = engineWithPreset('standard');
    const loc = engine.locationScore(features[0].properties);
    if (loc.objectiveScore != null) {
      expect(loc.cityPercentile).not.toBeNull();
      expect(loc.cityPercentile!).toBeGreaterThanOrEqual(0);
      expect(loc.cityPercentile!).toBeLessThanOrEqual(100);
    }
  });
});

describe('locationScore empty', () => {
  it('handles empty props', () => {
    const r = locationScore({});
    expect(r.objectiveScore).toBeNull();
    expect(r.confidence).toBe(0);
  });
});
