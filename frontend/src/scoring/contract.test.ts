/**
 * The frontend engine must never disagree with contracts/*.json.
 * These tests fail when someone hardcodes a weight instead of editing the contract.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  DAILY_LIFE_CATEGORY_WEIGHTS,
  DAILY_LIFE_GROUP_ALIASES,
  DAILY_LIFE_GROUP_WEIGHTS,
  DECLARED_HEX_PROPERTIES,
  FRONTEND_HEX_PROPERTIES,
  OBJECTIVE_PILLAR_KEYS,
  OBJECTIVE_WEIGHTS,
  PIPELINE_VERSION,
  SCORE_METHOD_VERSION,
  SCORE_PROPS,
  WALK_MINUTE_BANDS,
} from './generated/contract';
import { ACCESSIBILITY_BANDS, bandScore } from './normalization';
import * as objective from './objective';

const CONTRACT_DIR = join(__dirname, '..', '..', '..', 'contracts');

type ScoringContract = {
  score_method_version: string;
  objective_weights: Record<string, number>;
  objective_weight_aliases: Record<string, string>;
  daily_life: {
    group_weights: Record<string, number>;
    group_aliases: Record<string, string>;
    category_weights: Record<string, Record<string, number>>;
  };
  walk_minute_bands: Record<string, [number, number][]>;
};

function readJson<T>(name: string): T {
  return JSON.parse(readFileSync(join(CONTRACT_DIR, name), 'utf8')) as T;
}

describe('generated contract matches contracts/scoring.json', () => {
  const source = readJson<ScoringContract>('scoring.json');

  it('keeps the score method version in sync', () => {
    expect(SCORE_METHOD_VERSION).toBe(source.score_method_version);
  });

  it('keeps objective weights in sync', () => {
    expect(OBJECTIVE_WEIGHTS).toEqual(source.objective_weights);
    expect(OBJECTIVE_PILLAR_KEYS).toEqual(Object.keys(source.objective_weights));
  });

  it('keeps daily-life tables in sync', () => {
    expect(DAILY_LIFE_GROUP_WEIGHTS).toEqual(source.daily_life.group_weights);
    expect(DAILY_LIFE_CATEGORY_WEIGHTS).toEqual(source.daily_life.category_weights);
    expect(DAILY_LIFE_GROUP_ALIASES).toEqual(source.daily_life.group_aliases);
  });

  it('keeps SCORE_PROPS aligned with the metric registry', () => {
    expect(SCORE_PROPS.daily_life).toBe('s_daily_life');
    expect(SCORE_PROPS.housing_affordability).toBe('s_rent_kalt_benchmark');
  });
});

describe('scoring modules re-export the contract instead of redefining it', () => {
  it('objective.ts exposes the generated weights', () => {
    expect(objective.OBJECTIVE_WEIGHTS).toBe(OBJECTIVE_WEIGHTS);
    expect(objective.DAILY_LIFE_GROUP_WEIGHTS).toBe(DAILY_LIFE_GROUP_WEIGHTS);
    expect(objective.DAILY_LIFE_CATEGORY_WEIGHTS).toBe(DAILY_LIFE_CATEGORY_WEIGHTS);
  });

  it('objective weights sum to 1', () => {
    const sum = Object.values(OBJECTIVE_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 9);
  });

  it('daily-life group weights sum to 1 and every group has categories', () => {
    const sum = Object.values(DAILY_LIFE_GROUP_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 9);
    expect(Object.keys(DAILY_LIFE_CATEGORY_WEIGHTS).sort()).toEqual(
      Object.keys(DAILY_LIFE_GROUP_WEIGHTS).sort(),
    );
    for (const [group, cats] of Object.entries(DAILY_LIFE_CATEGORY_WEIGHTS)) {
      const total = Object.values(cats).reduce((a, b) => a + b, 0);
      expect(total, group).toBeCloseTo(1, 9);
    }
  });

  it('the default accessibility band is the contract band', () => {
    expect(ACCESSIBILITY_BANDS.default).toBe(WALK_MINUTE_BANDS.default);
    // Same knots the Python pipeline interpolates.
    expect(bandScore(5, ACCESSIBILITY_BANDS.default)).toBe(100);
    expect(bandScore(10, ACCESSIBILITY_BANDS.default)).toBe(70);
    expect(bandScore(15, ACCESSIBILITY_BANDS.default)).toBe(30);
    expect(bandScore(20, ACCESSIBILITY_BANDS.default)).toBe(0);
  });
});

describe('hex property contract holds for the bundled export', () => {
  const fixture = JSON.parse(
    readFileSync(join(__dirname, '..', '..', 'public', 'data', 'hexes.geojson'), 'utf8'),
  ) as {
    meta?: { pipeline_version?: number; score_method_version?: string };
    features: { properties: Record<string, unknown> }[];
  };

  it('declares every property the frontend reads', () => {
    const declared = new Set(DECLARED_HEX_PROPERTIES);
    const undeclared = FRONTEND_HEX_PROPERTIES.filter((key) => !declared.has(key));
    expect(undeclared).toEqual([]);
  });

  it('is not newer than the contract the frontend was built against', () => {
    const version = fixture.meta?.pipeline_version;
    if (version != null) expect(version).toBeLessThanOrEqual(PIPELINE_VERSION);
  });

  it('exposes the properties the frontend engine reads', () => {
    const props = fixture.features[0].properties;
    // Optional metrics legitimately vary per city; the core pillars do not.
    const core = [
      'h3',
      's_living',
      's_daily_life',
      's_walk',
      's_green',
      's_transit',
      's_quiet',
      's_housing_value',
      's_center',
      'center_min',
      'noise_db',
    ];
    for (const key of core) expect(props, key).toHaveProperty(key);
  });
});
