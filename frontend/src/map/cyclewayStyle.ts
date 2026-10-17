import type { LineLayerSpecification } from 'maplibre-gl';

export const CYCLEWAY_SOURCE_ID = 'cycleways';

export type CycleLegendEntry = {
  kind: string;
  label: string;
  color: string;
  dashed?: boolean;
};

/** One street layer. The next layer is another entry: endpoint, legend, paint. */
export type StreetLayerSpec = {
  id: string;
  label: string;
  endpoint: (slug: string) => string;
  legend: CycleLegendEntry[];
};

export const CYCLEWAY_LEGEND: CycleLegendEntry[] = [
  { kind: 'eigenstaendig', label: 'Eigenständiger Radweg', color: '#0f766e' },
  { kind: 'track', label: 'Baulich getrennter Radweg', color: '#1d4ed8' },
  { kind: 'lane', label: 'Radfahrstreifen', color: '#7c3aed' },
  { kind: 'advisory', label: 'Schutzstreifen', color: '#d97706', dashed: true },
  { kind: 'shared_path', label: 'Gemeinsamer Geh- und Radweg', color: '#ea580c' },
  { kind: 'mixed', label: 'Mischverkehr', color: '#334155' },
];

export const STREET_LAYERS: StreetLayerSpec[] = [
  {
    id: 'cycleways',
    label: 'Radwege',
    endpoint: (slug) => `/api/city/${encodeURIComponent(slug)}/cycleways.geojson`,
    legend: CYCLEWAY_LEGEND,
  },
];

const LINE_WIDTH: unknown = ['interpolate', ['linear'], ['zoom'], 10, 1.8, 13, 3.1, 16, 5.2];
const CASING_WIDTH: unknown = ['interpolate', ['linear'], ['zoom'], 10, 3.6, 13, 5.6, 16, 8.4];

export function cyclewayLineLayerId(kind: string): string {
  return `cycleways-${kind}-line`;
}

export function cyclewayCasingLayerId(kind: string): string {
  return `cycleways-${kind}-casing`;
}

/** Centreline tags are shifted; own-geometry ways (`side` empty) stay put.

MapLibre allows only one zoom interpolate in a paint expression, so the
side match sits inside that single interpolate.
*/
export function lineOffsetExpression(): unknown {
  return [
    'interpolate',
    ['linear'],
    ['zoom'],
    11,
    ['match', ['get', 'side'], 'left', -2, 'right', 2, 0],
    14,
    ['match', ['get', 'side'], 'left', -5, 'right', 5, 0],
    17,
    ['match', ['get', 'side'], 'left', -9, 'right', 9, 0],
  ];
}

export function labelForKind(kind: string | null | undefined): string {
  return CYCLEWAY_LEGEND.find((entry) => entry.kind === kind)?.label || 'Radweg';
}

export function cyclewayKindLayer(
  entry: CycleLegendEntry,
  role: 'line' | 'casing',
): LineLayerSpecification {
  const dashed = Boolean(entry.dashed);
  const line = role === 'line';
  return {
    id: line ? cyclewayLineLayerId(entry.kind) : cyclewayCasingLayerId(entry.kind),
    type: 'line',
    source: CYCLEWAY_SOURCE_ID,
    filter: ['==', ['get', 'kind'], entry.kind],
    layout: {
      'line-cap': dashed ? 'butt' : 'round',
      'line-join': 'round',
      visibility: 'none',
    },
    paint: {
      'line-color': line ? entry.color : '#ffffff',
      'line-width': (line ? LINE_WIDTH : CASING_WIDTH) as never,
      'line-opacity': line ? 0.96 : 0.92,
      'line-offset': lineOffsetExpression() as never,
      ...(dashed ? { 'line-dasharray': [2, 1.6] as never } : {}),
    },
  };
}
