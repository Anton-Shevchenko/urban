import { describe, expect, it } from 'vitest';
import { locationScore } from '../scoring/formulas';
import { buildMapViewOptions, normalizeLegacyProps } from './helpers';

describe('buildMapViewOptions', () => {
  it('always lists contract map-view overlays', () => {
    const opts = buildMapViewOptions({
      daily_life: 'Infrastruktur',
      price: 'Kaltmiete',
      cycleways: 'Radwege',
      walkability: 'Walkability',
    });
    expect(opts.map((o) => o.value)).toEqual(['objective', 'price', 'cycleways', 'walkability']);
    expect(opts[1]?.label).toBe('Kaltmiete');
    expect(opts[2]?.label).toBe('Radwege');
    expect(opts[3]?.label).toBe('Walkability');
  });
});

describe('normalizeLegacyProps', () => {
  it('does not invent a 50 daily-needs score when infrastructure is missing', () => {
    const features = [{
      type: 'Feature' as const,
      geometry: { type: 'Polygon' as const, coordinates: [] },
      properties: {
        h3: '891f89d6ec3ffff',
        rent_eur_m2: 14,
        s_housing_affordability: 100,
        s_living: 100,
      },
    }];

    normalizeLegacyProps(features);

    const p = features[0].properties as Record<string, unknown>;
    expect(p.s_daily_needs).toBeUndefined();
    expect(p.s_daily_life).toBeUndefined();
    expect(locationScore(p).objectiveScore).toBeNull();
  });

  it('still copies real transit onto the legacy transport alias', () => {
    const features = [{
      type: 'Feature' as const,
      geometry: { type: 'Polygon' as const, coordinates: [] },
      properties: { h3: 'a', s_transit: 72 },
    }];

    normalizeLegacyProps(features);

    const p = features[0].properties as Record<string, unknown>;
    expect(p.s_transport).toBe(72);
    expect(p.s_transit_service).toBe(72);
  });
});
