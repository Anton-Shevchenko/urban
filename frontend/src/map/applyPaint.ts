import type { Feature, FeatureCollection } from 'geojson';
import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl';
import { voiBorderWidth, voiHighlightLevel } from '../scoring/valueOpportunity';
import {
  CHAT_ID,
  LAYER_ID,
  LINE_ID,
  SELECT_ID,
  SOURCE_ID,
  VOI_LINE_ID,
  chatLayer,
  firstSymbolLayerId,
  hexFillLayer,
  hexLineLayer,
  selectLayer,
  voiLineLayer,
} from './layerConfig';

export function writeLiveScoreProps(
  fc: FeatureCollection,
  sourceFeatures: Feature[],
  scores: Float32Array,
  passed: Uint8Array,
): void {
  const n = Math.min(fc.features.length, scores.length, passed.length);
  for (let i = 0; i < n; i++) {
    const props = fc.features[i].properties as Record<string, unknown>;
    const src = (sourceFeatures[i]?.properties ?? props) as Record<string, unknown>;
    const c = scores[i];
    props._hex_passed = passed[i];
    props.data_quality = src.data_quality;
    const voiLevel = voiHighlightLevel(src);
    if (voiLevel === 0) {
      props._voi_level = 0;
      props._voi_on = 0;
      props._voi_width = 0;
    } else {
      props._voi_level = voiLevel;
      props._voi_on = 1;
      props._voi_width = voiBorderWidth(src);
    }
    if (Number.isFinite(c)) {
      const abs = Math.round(c * 10) / 10;
      props._comfort_abs = abs;
      props._comfort_live = abs;
    } else {
      delete props._comfort_live;
      delete props._comfort_abs;
    }
  }
}

export function applyHexLayers(
  map: MapLibreMap,
  fc: FeatureCollection,
  fillColor: unknown,
  fillOpacity: unknown,
): 'created' | 'updated' {
  if (!map.getSource(SOURCE_ID)) {
    map.addSource(SOURCE_ID, { type: 'geojson', data: fc });
    const before = firstSymbolLayerId(map);
    map.addLayer(hexFillLayer(fillColor, fillOpacity), before);
    map.addLayer(hexLineLayer(), before);
    map.addLayer(voiLineLayer(), before);
    map.addLayer(selectLayer(), before);
    map.addLayer(chatLayer(), before);
    return 'created';
  }
  (map.getSource(SOURCE_ID) as GeoJSONSource).setData({
    type: 'FeatureCollection',
    features: fc.features,
  });
  map.setPaintProperty(LAYER_ID, 'fill-color', fillColor as never);
  map.setPaintProperty(LAYER_ID, 'fill-opacity', fillOpacity as never);
  return 'updated';
}

export function applyHexOverlays(
  map: MapLibreMap,
  opts: {
    showHiddenGems: boolean;
    selectedH3s: string[];
    chatH3: string;
    hideHexGrid?: boolean;
  },
): void {
  if (map.getLayer(LINE_ID)) {
    map.setLayoutProperty(LINE_ID, 'visibility', opts.hideHexGrid ? 'none' : 'visible');
  }
  if (map.getLayer(VOI_LINE_ID)) {
    map.setLayoutProperty(
      VOI_LINE_ID,
      'visibility',
      opts.hideHexGrid || !opts.showHiddenGems ? 'none' : 'visible',
    );
  }
  if (map.getLayer(SELECT_ID)) {
    map.setFilter(SELECT_ID, ['in', ['get', 'h3'], ['literal', opts.selectedH3s]]);
  }
  if (map.getLayer(CHAT_ID)) {
    map.setFilter(CHAT_ID, ['==', ['get', 'h3'], opts.chatH3]);
  }
}
