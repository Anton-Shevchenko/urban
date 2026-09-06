import type {
  FillLayerSpecification,
  LineLayerSpecification,
  Map as MapLibreMap,
} from 'maplibre-gl';
import { NO_CRITERIA_COLOR } from '../scoring/constants';
import { maplibreStops } from '../scoring/color';

export const LAYER_ID = 'hexes-fill';
export const LINE_ID = 'hexes-line';
export const VOI_LINE_ID = 'hexes-voi';
export const SELECT_ID = 'hexes-selected';
export const CHAT_ID = 'hexes-chat';
export const SOURCE_ID = 'hexes';
export const CYCLEWAY_SOURCE_ID = 'cycleways';
export const CYCLEWAY_CASING_ID = 'cycleways-casing';
export const CYCLEWAY_LAYER_ID = 'cycleways-line';

export function firstSymbolLayerId(map: MapLibreMap): string | undefined {
  const sym = (map.getStyle().layers || []).find((l) => l.type === 'symbol');
  return sym ? sym.id : undefined;
}

export function hexFillColor(
  isPrimaryPaint: boolean,
  paintMapView: string | null | undefined,
  hasActiveKeys: boolean,
): unknown {
  if (!(hasActiveKeys || isPrimaryPaint || (paintMapView && paintMapView !== 'comfort'))) {
    return NO_CRITERIA_COLOR;
  }
  return [
    'case',
    ['==', ['typeof', ['get', '_comfort_live']], 'number'],
    [
      'interpolate',
      ['linear'],
      ['get', '_comfort_live'],
      ...maplibreStops(0, 100),
    ],
    NO_CRITERIA_COLOR,
  ];
}

export function hexFillOpacity(passingCount: number, isPrimaryPaint: boolean): unknown {
  if (passingCount > 0 && isPrimaryPaint) {
    return [
      'case',
      ['==', ['get', '_hex_passed'], 1],
      [
        'case',
        ['==', ['get', 'data_quality'], 'high'],
        0.9,
        ['==', ['get', 'data_quality'], 'mixed'],
        0.77,
        0.64,
      ],
      [
        'case',
        ['==', ['get', 'data_quality'], 'high'],
        0.66,
        ['==', ['get', 'data_quality'], 'mixed'],
        0.55,
        0.44,
      ],
    ];
  }
  return [
    'case',
    ['==', ['get', 'data_quality'], 'high'],
    0.78,
    ['==', ['get', 'data_quality'], 'mixed'],
    0.65,
    0.52,
  ];
}

export function hexFillLayer(
  fillColor: unknown,
  fillOpacity: unknown,
): FillLayerSpecification {
  return {
    id: LAYER_ID,
    type: 'fill',
    source: SOURCE_ID,
    paint: { 'fill-color': fillColor as never, 'fill-opacity': fillOpacity as never },
  };
}

export function hexLineLayer(): LineLayerSpecification {
  return {
    id: LINE_ID,
    type: 'line',
    source: SOURCE_ID,
    paint: { 'line-color': 'rgba(255,255,255,0.35)', 'line-width': 0.4 },
  };
}

export function voiLineLayer(): LineLayerSpecification {
  return {
    id: VOI_LINE_ID,
    type: 'line',
    source: SOURCE_ID,
    filter: ['==', ['get', '_voi_on'], 1],
    paint: {
      'line-color': [
        'match',
        ['coalesce', ['get', '_voi_level'], 0],
        3, '#c0392b',
        1, '#3da86a',
        '#1b8a4a',
      ],
      'line-opacity': 0.95,
      'line-width': ['coalesce', ['get', '_voi_width'], 1.4],
    },
    layout: { visibility: 'none' },
  };
}

export function selectLayer(): LineLayerSpecification {
  return {
    id: SELECT_ID,
    type: 'line',
    source: SOURCE_ID,
    filter: ['in', ['get', 'h3'], ['literal', []]],
    paint: { 'line-color': '#1c2330', 'line-width': 3, 'line-opacity': 0.95 },
  };
}

export function chatLayer(): LineLayerSpecification {
  return {
    id: CHAT_ID,
    type: 'line',
    source: SOURCE_ID,
    filter: ['==', ['get', 'h3'], '__none__'],
    paint: { 'line-color': '#e6a817', 'line-width': 3.5, 'line-opacity': 0.95 },
  };
}

export function cyclewayCasingLayer(): LineLayerSpecification {
  return {
    id: CYCLEWAY_CASING_ID,
    type: 'line',
    source: CYCLEWAY_SOURCE_ID,
    layout: { 'line-cap': 'round', 'line-join': 'round', visibility: 'none' },
    paint: {
      'line-color': '#064e3b',
      'line-width': ['interpolate', ['linear'], ['zoom'], 10, 2.4, 13, 4.2, 16, 7.5],
      'line-opacity': 0.9,
    },
  };
}

export function cyclewayLineLayer(): LineLayerSpecification {
  return {
    id: CYCLEWAY_LAYER_ID,
    type: 'line',
    source: CYCLEWAY_SOURCE_ID,
    layout: { 'line-cap': 'round', 'line-join': 'round', visibility: 'none' },
    paint: {
      'line-color': '#10b981',
      'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1.3, 13, 2.6, 16, 4.8],
      'line-opacity': 0.95,
    },
  };
}
