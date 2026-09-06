import type { Feature, FeatureCollection } from 'geojson';
import { MAP_VIEW_METRICS, SCORE_PROPS } from '../scoring/engine';
import type { CityMeta } from './types';

export function readDebugFlag(): boolean {
  try {
    const q = new URLSearchParams(window.location.search);
    const v = q.get('debug');
    return v === '1' || v === 'true' || v === 'yes';
  } catch {
    return false;
  }
}

export function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw) return JSON.parse(raw) as T;
  } catch {
    /* */
  }
  return fallback;
}

/** Kartenansicht entries. Overlays stay listed even when a city has no scores yet. */
export function buildMapViewOptions(
  labels: Record<string, string>,
): { value: string; label: string }[] {
  return [
    { value: 'objective', label: labels.daily_life || 'Infrastruktur' },
    ...MAP_VIEW_METRICS.map((id) => ({ value: id, label: labels[id] || id })),
  ];
}

export function detectHasRent(geojson: FeatureCollection & { meta?: CityMeta }) {
  const meta = geojson.meta || {};
  if (typeof meta.has_rent === 'boolean') return meta.has_rent;
  const p = geojson.features[0]?.properties as Record<string, unknown> | undefined;
  return !!(p && 'rent_eur_m2' in p);
}

export function detectExtendedMetrics(features: Feature[]) {
  const p = features[0]?.properties as Record<string, unknown> | undefined;
  return !!(p && ('dn_supermarket_min' in p || 's_daily_needs' in p || 'daily_needs_score' in p));
}

export function normalizeLegacyProps(features: Feature[]) {
  features.forEach((f) => {
    const p = f.properties as Record<string, unknown>;
    if (p.s_center == null && p.s_transit != null) p.s_center = p.s_transit;
    if (p.s_urban_activity == null && p.s_business != null) p.s_urban_activity = p.s_business;
    if (p.s_business == null && p.s_poi != null) p.s_business = p.s_poi;
    if (p.s_transport == null && p.s_transit != null) p.s_transport = p.s_transit;
    if (p.urban_activity == null && p.business_count != null) p.urban_activity = p.business_count;
    if (p.business_count == null && p.poi_count != null) p.business_count = p.poi_count;
    if (p.center_min == null && p.transit_min != null) p.center_min = p.transit_min;
    if (p.transport_score == null) p.transport_score = 0;
    if (p.s_transit_service == null && p.s_transport != null) p.s_transit_service = p.s_transport;
    if (p.s_heat == null) p.s_heat = 50;
    if (p.s_traffic_safety == null) p.s_traffic_safety = 50;
    if (p.s_density == null) p.s_density = 50;
    if (p.s_housing == null) p.s_housing = 50;
    if (p.data_quality == null) p.data_quality = 'estimated';
  });
}

export function factorScoreSpread(features: Feature[], key: string) {
  const prop = SCORE_PROPS[key as keyof typeof SCORE_PROPS];
  if (!prop) return 0;
  const vals = features
    .map((f) => Number((f.properties as Record<string, unknown>)[prop]))
    .filter(Number.isFinite);
  if (vals.length < 2) return 0;
  return Math.max(...vals) - Math.min(...vals);
}
