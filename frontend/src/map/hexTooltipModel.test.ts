import type { MapLayerMouseEvent } from 'maplibre-gl';
import { describe, expect, it } from 'vitest';
import { createContextFromFeatures, createScoringEngine } from '../scoring/engine';
import { buildHexTooltipModel } from './hexTooltipModel';

function hover(props: Record<string, unknown>): MapLayerMouseEvent {
  return {
    features: [{ properties: props }],
    point: { x: 4, y: 8 },
  } as unknown as MapLayerMouseEvent;
}

describe('price map tooltip', () => {
  it('does not invent a rent when the hex has no observation', () => {
    const ctx = createContextFromFeatures([], {});
    ctx.mapMetricMode = 'price';
    const engine = createScoringEngine(ctx, []);
    const model = buildHexTooltipModel(hover({ h3: 'abc' }), engine, 'price', false);
    expect(model?.insufficient).toBe(true);
    expect(model?.insufficientTitle).toBe('Keine Beobachtung');
    expect(model?.caption).toBe('');
  });

  it('shows the published cold rent next to the city-relative score', () => {
    const props = {
      h3: 'abc',
      s_daily_life: 70,
      s_rent_relative_city: 40,
      rent_eur_m2: 18.2,
      rent_source: 'Zensus 2022, 100 m',
      rent_as_of: '2022-05',
    };
    const ctx = createContextFromFeatures([{ properties: props }], {});
    ctx.mapMetricMode = 'price';
    const engine = createScoringEngine(ctx, [{ properties: props }]);
    const model = buildHexTooltipModel(hover(props), engine, 'price', false);
    expect(model?.insufficient).toBe(false);
    expect(model?.headlineScore).toBe('40');
    expect(model?.headlineLabel).toBe('Kaltmiete');
    expect(model?.caption).toBe('Kaltmiete: 18,2 €/m² · Zensus 2022, 100 m, 2022-05');
  });
});
