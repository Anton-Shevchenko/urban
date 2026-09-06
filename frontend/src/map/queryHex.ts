import type { Feature } from 'geojson';
import type { Map as MapLibreMap, PointLike } from 'maplibre-gl';
import { CHAT_ID, LAYER_ID, LINE_ID, SELECT_ID } from './layerConfig';

const HEX_QUERY_LAYERS = [LAYER_ID, LINE_ID, SELECT_ID, CHAT_ID];

export function featureH3(feature: Feature | undefined): string {
  const p = feature?.properties as Record<string, unknown> | null | undefined;
  return String(p?.h3 ?? p?.h3_index ?? '');
}

/** Prefer the in-memory city feature — MapLibre query payloads can omit unused props. */
export function resolveQueriedHex(
  queried: Feature | undefined,
  features: Feature[],
): Feature | undefined {
  const h3 = featureH3(queried);
  if (!h3) return queried;
  return features.find((f) => featureH3(f) === h3) ?? queried;
}

/** Hex under a map point — fill, outline, or selection stroke. */
export function queryHexAtPoint(map: MapLibreMap, point: PointLike): Feature | undefined {
  const layers = HEX_QUERY_LAYERS.filter((id) => map.getLayer(id));
  if (!layers.length) return undefined;
  const feats = map.queryRenderedFeatures(point, { layers });
  return feats[0] as Feature | undefined;
}
