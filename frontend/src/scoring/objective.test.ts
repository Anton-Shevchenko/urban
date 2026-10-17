import { describe, expect, it } from 'vitest';
import {
  PRESETS,
  cityPercentileForScore,
  livingScore,
  locationScore,
  personalAffordabilityMultiplier,
  shouldPaintAbsolute,
} from './formulas';
import { OBJECTIVE_WEIGHTS, scoreHousingAffordability } from './objective';

const fullPoint = {
  h3: 'a',
  dn_supermarket_min: 6,
  dn_supermarket_avail: 90,
  dn_bakery_min: 4,
  dn_bakery_avail: 100,
  dn_market_min: 20,
  dn_market_avail: 20,
  dn_pharmacy_min: 8,
  dn_pharmacy_avail: 80,
  dn_doctor_min: 10,
  dn_doctor_avail: 70,
  dn_clinic_min: 25,
  dn_clinic_avail: 30,
  dn_kita_min: 5,
  dn_kita_avail: 100,
  dn_school_min: 10,
  dn_school_avail: 70,
  dn_administration_min: 12,
  dn_administration_avail: 50,
  dn_bank_min: 8,
  dn_bank_avail: 90,
  dn_post_min: 6,
  dn_post_avail: 90,
  dn_restaurant_min: 5,
  dn_restaurant_avail: 100,
  dn_cafe_min: 8,
  dn_cafe_avail: 90,
  dn_sports_min: 10,
  dn_sports_avail: 80,
  dn_playground_min: 5,
  dn_playground_avail: 100,
  walking_quality_score: 60,
  transit_service_score: 55,
  s_green_strict: 50,
  noise_db: 58,
  rent_eur_m2: 18,
  s_rent_relative_city: 40,
  s_center: 70,
  s_center_strict: 40,
  s_daily_life: 72,
  s_walk: 60,
  s_transit: 55,
  s_quiet: 42,
  s_housing_affordability: 65,
};

describe('objective vs personal independence', () => {
  it('preset change does not change objectiveScore', () => {
    const a = locationScore(fullPoint, { pillarWeights: PRESETS.standard });
    const b = locationScore(fullPoint, {
      pillarWeights: PRESETS.senior,
      affordabilityFocus: PRESETS.senior.affordability_focus,
      groupMultipliers: { dl_health: 1.8 },
    });
    expect(a.objectiveScore).toBe(b.objectiveScore);
    expect(a.objectiveScore).toBe(72);
    // Group multipliers do not recompute daily life; profiles share the contract weights.
    expect(a.personalMatchScore).toBe(b.personalMatchScore);
  });

  it('identical raw inputs yield identical objective across cities', () => {
    const munich = locationScore({ ...fullPoint, city: 'munich' });
    const berlin = locationScore({ ...fullPoint, city: 'berlin' });
    expect(munich.objectiveScore).toBe(berlin.objectiveScore);
  });
});

describe('missing data', () => {
  it('fully missing → null objective and zero confidence', () => {
    const r = locationScore({});
    expect(r.objectiveScore).toBeNull();
    expect(r.confidence).toBe(0);
    expect(r.score).toBeNull();
  });

  it('null / empty pillars do not become zero scores', () => {
    const r = locationScore({
      walking_quality_score: null,
      transit_service_score: '',
      noise_db: undefined,
      rent_eur_m2: null,
    });
    expect(r.pillars.walk).toBeNull();
    expect(r.pillars.transit).toBeNull();
    expect(r.pillars.quiet).toBeNull();
    expect(r.pillars.housing_affordability).toBeNull();
  });

  it('partial data without daily_life yields no objective score (infra-only)', () => {
    const r = locationScore({
      walking_quality_score: 70,
      transit_service_score: 60,
      noise_db: 55,
      s_green_strict: 50,
      // no rent, no daily life
    });
    // Objective is 100% daily_life — missing infra → no objective score.
    expect(r.objectiveScore).toBeNull();
    expect(r.pillars.daily_life).toBeNull();
    expect(r.pillars.housing_affordability).toBeNull();
    expect(r.confidence).toBe(0);
  });
});

describe('daily life pillar', () => {
  it('reads the exported pillar and ignores legacy dl_* group scores', () => {
    const scored = locationScore({
      s_daily_life: 40,
      dl_food: 100,
      dl_other: 100,
      dn_supermarket_min: 2,
    });
    expect(scored.objectiveScore).toBe(40);
    expect(scored.pillars.daily_life).toBe(40);
  });
});

describe('housing affordability', () => {
  it('does not blend walk/transit/daily into housing pillar', () => {
    const a = scoreHousingAffordability({
      rent_eur_m2: 20,
      s_walk: 100,
      s_transit: 100,
      s_daily_life: 100,
    });
    const b = scoreHousingAffordability({
      rent_eur_m2: 20,
      s_walk: 0,
      s_transit: 0,
      s_daily_life: 0,
    });
    expect(a.score).toBe(b.score);
  });
});

describe('affordability continuity', () => {
  it('has no cliff around focus 0.45', () => {
    const m44 = personalAffordabilityMultiplier(10, 0.449);
    const m45 = personalAffordabilityMultiplier(10, 0.450);
    expect(Math.abs(m44 - m45)).toBeLessThan(0.01);
  });
});

describe('map mode independence', () => {
  it('shouldPaintAbsolute always false (no auto rank switch)', () => {
    expect(shouldPaintAbsolute(OBJECTIVE_WEIGHTS as unknown as Record<string, number>)).toBe(false);
    expect(shouldPaintAbsolute({ green: 0.9 })).toBe(false);
  });
});

describe('city percentile', () => {
  it('is relative within the set and independent of absolute level', () => {
    const scores = [10, 20, 30, 40, 50];
    expect(cityPercentileForScore(50, scores)).toBe(100);
    expect(cityPercentileForScore(10, scores)).toBe(0);
  });
});

describe('livingScore compat', () => {
  it('exposes score === objectiveScore', () => {
    const r = livingScore(fullPoint);
    expect(r.score).toBe(r.objectiveScore);
    expect(r.scoreMethodVersion).toBe('objective-v2');
  });

  it('objective weights sum to 1', () => {
    const sum = Object.values(OBJECTIVE_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 5);
  });
});
