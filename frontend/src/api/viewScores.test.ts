import { describe, expect, it } from 'vitest';

import { joinViewScores } from './client';

describe('joinViewScores', () => {
  it('writes a view score onto the matching hex', () => {
    const features = [
      {
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: [0, 0] },
        properties: { h3: 'abc', s_living: 10 },
      },
      {
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: [1, 1] },
        properties: { h3: 'def', s_living: 20 },
      },
    ];
    const joined = joinViewScores(features, { abc: { s_walkability: 81 } });
    expect(joined[0].properties).toMatchObject({ h3: 'abc', s_living: 10, s_walkability: 81 });
    expect(joined[1].properties).toEqual({ h3: 'def', s_living: 20 });
  });
});
