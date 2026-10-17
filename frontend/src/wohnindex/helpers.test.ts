import { describe, expect, it } from 'vitest';
import { buildMapViewOptions, detectExtendedMetrics } from './helpers';

describe('buildMapViewOptions', () => {
  it('always lists contract map-view overlays', () => {
    const opts = buildMapViewOptions({
      daily_life: 'Infrastruktur',
      price: 'Kaltmiete',
      cycleways: 'Radwege',
    });
    expect(opts.map((o) => o.value)).toEqual(['objective', 'price', 'cycleways']);
    expect(opts[1]?.label).toBe('Kaltmiete');
    expect(opts[2]?.label).toBe('Radwege');
  });
});

describe('detectExtendedMetrics', () => {
  const feature = (properties: Record<string, unknown>) => ({
    type: 'Feature' as const,
    geometry: { type: 'Polygon' as const, coordinates: [] },
    properties,
  });

  it('reads the canonical daily-life pillar', () => {
    expect(detectExtendedMetrics([feature({ s_daily_life: 80 })])).toBe(true);
    expect(detectExtendedMetrics([feature({ dn_supermarket_min: 6 })])).toBe(true);
  });

  it('does not treat a legacy alias as extended metrics', () => {
    expect(detectExtendedMetrics([feature({ s_daily_needs: 80, s_transit: 72 })])).toBe(false);
  });
});
