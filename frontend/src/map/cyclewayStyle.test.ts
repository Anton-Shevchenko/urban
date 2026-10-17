import { describe, expect, it } from 'vitest';
import {
  CYCLEWAY_LEGEND,
  STREET_LAYERS,
  cyclewayKindLayer,
  lineOffsetExpression,
} from './cyclewayStyle';

describe('cycleway layer registry', () => {
  it('registers one street layer with six legend classes', () => {
    expect(STREET_LAYERS.map((layer) => layer.id)).toEqual(['cycleways']);
    expect(CYCLEWAY_LEGEND.map((entry) => entry.label)).toEqual([
      'Eigenständiger Radweg',
      'Baulich getrennter Radweg',
      'Radfahrstreifen',
      'Schutzstreifen',
      'Gemeinsamer Geh- und Radweg',
      'Mischverkehr',
    ]);
    expect(new Set(CYCLEWAY_LEGEND.map((entry) => entry.color)).size).toBe(6);
    expect(CYCLEWAY_LEGEND.find((entry) => entry.kind === 'advisory')?.dashed).toBe(true);
    expect(STREET_LAYERS[0]?.endpoint('freising')).toBe('/api/city/freising/cycleways.geojson');
  });

  it('offsets left and right off the carriageway centreline', () => {
    const expr = lineOffsetExpression() as unknown[];
    expect(expr[0]).toBe('interpolate');
    const stops = expr.filter((part) => Array.isArray(part) && part[0] === 'match') as unknown[][];
    expect(stops).toHaveLength(3);
    expect(stops[0]).toContain('left');
    expect(stops[0]).toContain(-2);
    expect(stops[0]).toContain('right');
    expect(stops[0]).toContain(2);
    const advisory = cyclewayKindLayer(
      CYCLEWAY_LEGEND.find((entry) => entry.kind === 'advisory')!,
      'line',
    );
    expect(advisory.paint?.['line-dasharray']).toEqual([2, 1.6]);
    expect(advisory.paint?.['line-color']).toBe('#d97706');
  });
});
