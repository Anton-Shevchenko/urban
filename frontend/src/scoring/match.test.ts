import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MATCH_PREFS,
  dominates,
  filterParetoFront,
  preferenceWeights,
  rankMatchHexes,
  scoreMatchHex,
  softThreshold,
  type MatchPrefs,
} from './match';

const maxvorstadt = {
  h3: 'maxvorstadt',
  s_match_centrality: 95,
  s_match_infrastructure: 95,
  s_match_walk: 80,
  s_match_green: 70,
  s_match_transit: 90,
  s_match_quiet: 40,
  s_match_price: 20,
};

const moosach = {
  h3: 'moosach',
  s_match_centrality: 75,
  s_match_infrastructure: 85,
  s_match_walk: 78,
  s_match_green: 80,
  s_match_transit: 80,
  s_match_quiet: 65,
  s_match_price: 85,
};

const dominatedSuburb = {
  h3: 'dominated',
  s_match_centrality: 70,
  s_match_infrastructure: 60,
  s_match_walk: 50,
  s_match_green: 70,
  s_match_transit: 55,
  s_match_quiet: 50,
  s_match_price: 30,
};

describe('soft thresholds & penalties', () => {
  it('maps preference 90 → threshold 70', () => {
    expect(softThreshold(90)).toBe(70);
    expect(softThreshold(0)).toBe(0);
  });

  it('penalises hexes below threshold, not above', () => {
    const prefs: MatchPrefs = {
      ...DEFAULT_MATCH_PREFS,
      centrality: 0,
      infrastructure: 0,
      walk: 0,
      green: 90,
      transit: 0,
      quiet: 0,
      price: 0,
    };
    const good = scoreMatchHex({ h3: 'a', s_match_green: 95 }, prefs);
    const bad = scoreMatchHex({ h3: 'b', s_match_green: 50 }, prefs);
    expect(good.penalties.green).toBe(0);
    expect(bad.penalties.green).toBeGreaterThan(10);
    expect(bad.finalScore).toBeLessThan(good.finalScore);
  });
});

describe('preference weights', () => {
  it('normalises to sum 1 over active dims', () => {
    const prefs: MatchPrefs = {
      centrality: 90,
      infrastructure: 90,
      walk: 0,
      green: 80,
      transit: 0,
      quiet: 0,
      price: 0,
    };
    const { weights, activeDims } = preferenceWeights(prefs);
    expect(activeDims).toEqual(['centrality', 'infrastructure', 'green']);
    const sum = activeDims.reduce((s, d) => s + weights[d], 0);
    expect(sum).toBeCloseTo(1, 5);
  });
});

describe('Pareto filter', () => {
  it('keeps distinct compromises and drops dominated hexes', () => {
    const a = {
      centrality: 90,
      infrastructure: 80,
      walk: 50,
      green: 90,
      transit: 50,
      quiet: 50,
      price: 40,
    };
    const b = {
      centrality: 75,
      infrastructure: 75,
      walk: 50,
      green: 80,
      transit: 50,
      quiet: 50,
      price: 70,
    };
    const c = {
      centrality: 60,
      infrastructure: 60,
      walk: 50,
      green: 70,
      transit: 50,
      quiet: 50,
      price: 30,
    };
    expect(dominates(a, c, ['green', 'price', 'infrastructure'])).toBe(true);
    expect(dominates(a, b, ['green', 'price', 'infrastructure'])).toBe(false);
    expect(dominates(b, a, ['green', 'price', 'infrastructure'])).toBe(false);

    const front = filterParetoFront(
      [
        { h3: 'a', attributes: a, props: {} },
        { h3: 'b', attributes: b, props: {} },
        { h3: 'c', attributes: c, props: {} },
      ],
      ['green', 'price', 'infrastructure'],
    );
    expect(front.has('a')).toBe(true);
    expect(front.has('b')).toBe(true);
    expect(front.has('c')).toBe(false);
  });
});

describe('Maxvorstadt vs Moosach trade-off', () => {
  const features = [
    { properties: maxvorstadt },
    { properties: moosach },
    { properties: dominatedSuburb },
  ];

  it('central-heavy prefs favour Maxvorstadt when price is unimportant', () => {
    const prefs: MatchPrefs = {
      centrality: 90,
      infrastructure: 90,
      walk: 0,
      green: 80,
      transit: 0,
      quiet: 0,
      price: 10,
    };
    const ranked = rankMatchHexes(features, prefs);
    const top = ranked.find((r) => !r.dominated);
    expect(top?.h3).toBe('maxvorstadt');
    expect(ranked.find((r) => r.h3 === 'dominated')?.dominated).toBe(true);
  });

  it('high price preference can make Moosach the winner', () => {
    const prefs: MatchPrefs = {
      centrality: 90,
      infrastructure: 90,
      walk: 0,
      green: 80,
      transit: 0,
      quiet: 0,
      price: 90,
    };
    const ranked = rankMatchHexes(features, prefs);
    const top = ranked.find((r) => !r.dominated);
    expect(top?.h3).toBe('moosach');

    const maxScore = ranked.find((r) => r.h3 === 'maxvorstadt')!.breakdown.finalScore;
    const mooScore = ranked.find((r) => r.h3 === 'moosach')!.breakdown.finalScore;
    expect(mooScore).toBeGreaterThan(maxScore);
  });
});
