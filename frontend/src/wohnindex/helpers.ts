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
  return !!(p && ('dn_supermarket_min' in p || 's_daily_life' in p));
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
