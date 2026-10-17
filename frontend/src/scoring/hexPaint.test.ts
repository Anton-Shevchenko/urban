import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  createContextFromFeatures,
  createScoringEngine,
  PRESETS,
} from './engine';
import { isPrimaryPaintView, isRentFillView, isStreetOverlayView, scoreHexPaint, serializeScoringContext } from './hexPaint';

const __dirname = dirname(fileURLToPath(import.meta.url));
const geo = JSON.parse(
  readFileSync(join(__dirname, 'fixtures/hexes.sample.geojson'), 'utf8'),
);
const features = geo.features;
const meta = geo.meta || {};

describe('isPrimaryPaintView', () => {
  it('treats objective / match / percentile as primary', () => {
    expect(isPrimaryPaintView('objective')).toBe(true);
    expect(isPrimaryPaintView('comfort')).toBe(true);
    expect(isPrimaryPaintView('personal_match')).toBe(true);
    expect(isPrimaryPaintView('city_percentile')).toBe(true);
    expect(isPrimaryPaintView('green')).toBe(false);
    expect(isPrimaryPaintView('housing_value')).toBe(false);
    expect(isPrimaryPaintView('cycleways')).toBe(false);
    expect(isPrimaryPaintView('price')).toBe(false);
  });

  it('treats cycleways as a street overlay and Kaltmiete as a hex fill', () => {
    expect(isStreetOverlayView('cycleways')).toBe(true);
    expect(isStreetOverlayView('objective')).toBe(false);
    expect(isStreetOverlayView('price')).toBe(false);
    expect(isRentFillView('price')).toBe(true);
    expect(isRentFillView('cycleways')).toBe(false);
  });
});

describe('scoreHexPaint', () => {
  it('matches engine.comfortScalar on the objective path', () => {
    const ctx = createContextFromFeatures(features, meta);
    const engine = createScoringEngine(ctx, features);
    const sample = features.slice(0, 80);
    const out = scoreHexPaint({
      ctx: serializeScoringContext(ctx),
      hexes: sample.map((f: { properties: Record<string, unknown> }) => f.properties),
      paintMapView: 'objective',
    });
    expect(out.scores.length).toBe(sample.length);
    for (let i = 0; i < sample.length; i++) {
      const expected = engine.comfortScalar(sample[i].properties);
      if (expected == null) {
        expect(Number.isNaN(out.scores[i])).toBe(true);
        expect(out.passed[i]).toBe(0);
      } else {
        expect(out.scores[i]).toBeCloseTo(expected, 5);
        expect(out.passed[i]).toBe(1);
      }
    }
  });

  it('matches engine.factorScalar for a cycleways overlay view', () => {
    const ctx = createContextFromFeatures(features, meta);
    const engine = createScoringEngine(ctx, features);
    const sample = features.slice(0, 40);
    const out = scoreHexPaint({
      ctx: serializeScoringContext(ctx),
      hexes: sample.map((f: { properties: Record<string, unknown> }) => f.properties),
      paintMapView: 'cycleways',
    });
    expect(isPrimaryPaintView('cycleways')).toBe(false);
    for (let i = 0; i < sample.length; i++) {
      const expected = engine.factorScalar('cycleways', sample[i].properties);
      if (expected == null) {
        expect(Number.isNaN(out.scores[i])).toBe(true);
      } else {
        expect(out.scores[i]).toBeCloseTo(expected, 5);
      }
    }
  });

  it('matches engine.factorScalar for a pillar map view', () => {
    const ctx = createContextFromFeatures(features, meta);
    const engine = createScoringEngine(ctx, features);
    const sample = features.slice(0, 40);
    const out = scoreHexPaint({
      ctx: serializeScoringContext(ctx),
      hexes: sample.map((f: { properties: Record<string, unknown> }) => f.properties),
      paintMapView: 'green',
    });
    for (let i = 0; i < sample.length; i++) {
      const expected = engine.factorScalar('green', sample[i].properties);
      if (expected == null) {
        expect(Number.isNaN(out.scores[i])).toBe(true);
      } else {
        expect(out.scores[i]).toBeCloseTo(expected, 5);
      }
    }
  });

  it('paints city-relative Kaltmiete and leaves unpublished hexes empty', () => {
    const ctx = createContextFromFeatures([], {});
    const hexes = [
      { h3: 'a', s_rent_relative_city: 80, rent_eur_m2: 12 },
      { h3: 'b' },
    ];
    const out = scoreHexPaint({
      ctx: serializeScoringContext(ctx),
      hexes,
      paintMapView: 'price',
    });
    expect(out.scores[0]).toBeCloseTo(80, 5);
    expect(out.passed[0]).toBe(1);
    expect(Number.isNaN(out.scores[1])).toBe(true);
    expect(out.passed[1]).toBe(0);
  });

  it('dims an over-budget Kaltmiete fill without replacing the rent score', () => {
    const ctx = createContextFromFeatures([], {});
    ctx.maxMonthlyBudget = 400;
    ctx.desiredAreaM2 = 50;
    const out = scoreHexPaint({
      ctx: serializeScoringContext(ctx),
      hexes: [{ h3: 'a', s_rent_relative_city: 80, rent_eur_m2: 20 }],
      paintMapView: 'price',
    });
    expect(out.scores[0]).toBeCloseTo(44, 5);
    expect(out.passed[0]).toBe(1);
  });

  it('preset does not change objective paint scores', () => {
    const stdCtx = createContextFromFeatures(features, meta);
    const seniorCtx = createContextFromFeatures(features, meta);
    createScoringEngine(stdCtx, features).applyPreset(PRESETS.standard);
    createScoringEngine(seniorCtx, features).applyPreset(PRESETS.senior);
    const sample = features.slice(0, 30).map(
      (f: { properties: Record<string, unknown> }) => f.properties,
    );
    const a = scoreHexPaint({
      ctx: serializeScoringContext(stdCtx),
      hexes: sample,
      paintMapView: 'objective',
    });
    const b = scoreHexPaint({
      ctx: serializeScoringContext(seniorCtx),
      hexes: sample,
      paintMapView: 'objective',
    });
    for (let i = 0; i < sample.length; i++) {
      if (Number.isNaN(a.scores[i]) && Number.isNaN(b.scores[i])) continue;
      expect(a.scores[i]).toBeCloseTo(b.scores[i], 5);
    }
  });
});
