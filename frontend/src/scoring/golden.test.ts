/**
 * Exported pillar scores win over raw fields that used to feed a second curve.
 * Expected numbers are frozen from the Python pipeline in scoring_golden.json.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { locationScore } from './locationScore';
import type { PipelinePoint } from './types';

const FIXTURE_PATH = join(__dirname, '../../../contracts/fixtures/scoring_golden.json');

type GoldenHex = {
  id: string;
  raw: PipelinePoint;
  expected: {
    s_housing_affordability: number;
    s_quiet: number;
    s_green: number;
    s_daily_life: number;
    s_living: number;
  };
};

type GoldenFixture = {
  distractors: PipelinePoint;
  hexes: GoldenHex[];
  personal_match: {
    hex_id: string;
    group_multipliers: Record<string, number>;
    expected_score: number;
  };
};

const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as GoldenFixture;

function propsOf(hex: GoldenHex): PipelinePoint {
  return {
    h3: hex.id,
    ...fixture.distractors,
    ...hex.raw,
    ...hex.expected,
  };
}

describe('scoring golden fixture', () => {
  it('reads exported scores and ignores raw rent, noise, green, and walk minutes', () => {
    for (const hex of fixture.hexes) {
      const loc = locationScore(propsOf(hex));
      expect(loc.objectiveScore, hex.id).toBe(hex.expected.s_living);
      expect(loc.pillars.daily_life, hex.id).toBe(hex.expected.s_daily_life);
      expect(loc.pillars.quiet, hex.id).toBe(hex.expected.s_quiet);
      expect(loc.pillars.green, hex.id).toBe(hex.expected.s_green);
      expect(loc.pillars.housing_affordability, hex.id).toBe(hex.expected.s_housing_affordability);
    }
  });

  it('keeps 12 €/m² at the pipeline score of 100', () => {
    const twelve = fixture.hexes.find((hex) => hex.id === 'twelve');
    expect(twelve?.raw.rent_eur_m2).toBe(12);
    expect(locationScore(propsOf(twelve!)).pillars.housing_affordability).toBe(100);
  });

  it('reweights exported daily-life groups for personal match', () => {
    const hex = fixture.hexes.find((item) => item.id === fixture.personal_match.hex_id);
    const loc = locationScore(propsOf(hex!), {
      groupMultipliers: fixture.personal_match.group_multipliers,
    });
    expect(loc.objectiveScore).toBe(hex!.expected.s_living);
    expect(loc.personalMatchScore).toBeCloseTo(fixture.personal_match.expected_score, 5);
  });
});
