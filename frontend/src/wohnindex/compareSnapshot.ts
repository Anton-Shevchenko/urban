import type { Feature } from 'geojson';
import { DEFAULT_SIZE_M2 } from '../scoring/engine';
import type { ChatHex, CompareItem } from './types';

export const MAX_COMPARE = 6;

/** Canned prompt when the merkliste is sent to Hex-Chat for comparison. */
export const COMPARE_AI_PROMPT =
  'Compare the shortlisted hexes for daily life without a car. What are the main trade-offs? Use only the provided facts and say if something is missing.';

export type CompareCityRef = {
  citySlug: string;
  cityName: string;
  cityPercentile?: number | null;
};

export function compareItemId(citySlug: string, h3: string): string {
  return `${citySlug}:${h3}`;
}

/** JSON-safe hex facts so a pinned cell can be scored after the city unloads. */
export function snapshotHexProps(p: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(p)) {
    if (value == null) continue;
    const t = typeof value;
    if (t === 'number' || t === 'string' || t === 'boolean') out[key] = value;
  }
  return out;
}

export function featureCentroid(feature: Feature): { lng: number; lat: number } | null {
  const g = feature.geometry;
  if (!g) return null;
  let ring: number[][] = [];
  if (g.type === 'Polygon') ring = g.coordinates[0] ?? [];
  else if (g.type === 'MultiPolygon') ring = g.coordinates[0]?.[0] ?? [];
  else if (g.type === 'Point') {
    const [lng, lat] = g.coordinates;
    return Number.isFinite(lng) && Number.isFinite(lat) ? { lng, lat } : null;
  }
  if (ring.length < 3) return null;
  const last = ring[ring.length - 1];
  const first = ring[0];
  const pts =
    last && first && last[0] === first[0] && last[1] === first[1] ? ring.slice(0, -1) : ring;
  let lng = 0;
  let lat = 0;
  let n = 0;
  for (const c of pts) {
    if (c.length < 2 || !Number.isFinite(c[0]) || !Number.isFinite(c[1])) continue;
    lng += c[0];
    lat += c[1];
    n += 1;
  }
  if (!n) return null;
  return { lng: lng / n, lat: lat / n };
}

export function itemBelongsToCity(
  item: CompareItem,
  citySlug: string,
  cityName: string,
): boolean {
  if (item.citySlug) return item.citySlug === citySlug;
  return item.cityName === cityName;
}

export function compareListHas(
  items: CompareItem[],
  citySlug: string,
  h3: string,
  cityName?: string,
): boolean {
  return items.some((item) => {
    if (item.h3 !== h3) return false;
    if (item.citySlug) return item.citySlug === citySlug;
    if (cityName) return item.cityName === cityName;
    return item.id === compareItemId(citySlug, h3);
  });
}

function samePinnedHex(item: CompareItem, city: CompareCityRef, h3: string, id: string): boolean {
  if (item.id === id) return true;
  if (item.h3 !== h3) return false;
  return itemBelongsToCity(item, city.citySlug, city.cityName);
}

export function makeCompareItem(feature: Feature, city: CompareCityRef): CompareItem | null {
  const p = feature.properties as Record<string, unknown> | null;
  const h3 = String(p?.h3 ?? p?.h3_index ?? '');
  if (!h3 || !city.citySlug) return null;
  const rent = Number(p?.rent_eur_m2);
  const centroid = featureCentroid(feature);
  return {
    id: compareItemId(city.citySlug, h3),
    citySlug: city.citySlug,
    cityName: city.cityName,
    h3,
    props: snapshotHexProps(p ?? {}),
    sizeM2: DEFAULT_SIZE_M2,
    pricePerM2: Number.isFinite(rent) && rent > 0 ? rent : null,
    lng: centroid?.lng ?? null,
    lat: centroid?.lat ?? null,
    cityPercentile: city.cityPercentile ?? null,
  };
}

export function chatHexFromItem(item: CompareItem): ChatHex | null {
  if (!item.citySlug || !item.h3) return null;
  const living = Number(item.props.s_living);
  return {
    h3: item.h3,
    citySlug: item.citySlug,
    cityName: item.cityName,
    livingScore: Number.isFinite(living) ? living : null,
    props: item.props,
  };
}

export function toggleCompareList(
  prev: CompareItem[],
  feature: Feature,
  city: CompareCityRef,
): CompareItem[] {
  const item = makeCompareItem(feature, city);
  if (!item) return prev;
  const idx = prev.findIndex((i) => samePinnedHex(i, city, item.h3, item.id));
  if (idx >= 0) return prev.filter((_, i) => i !== idx);
  if (prev.length >= MAX_COMPARE) return prev;
  return [...prev, item];
}

/** Click-to-save: already pinned hexes stay; drop extras beyond MAX_COMPARE. */
export function addCompareList(
  prev: CompareItem[],
  feature: Feature,
  city: CompareCityRef,
): CompareItem[] {
  const item = makeCompareItem(feature, city);
  if (!item) return prev;
  if (prev.some((i) => samePinnedHex(i, city, item.h3, item.id))) return prev;
  if (prev.length >= MAX_COMPARE) return prev;
  return [...prev, item];
}

export function migrateCompareItems(raw: unknown): CompareItem[] {
  if (!Array.isArray(raw)) return [];
  const out: CompareItem[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const h3 = String(e.h3 ?? '');
    if (!h3) continue;
    const cityName = String(e.cityName ?? '');
    const citySlug = String(e.citySlug ?? '');
    const props =
      e.props && typeof e.props === 'object'
        ? snapshotHexProps(e.props as Record<string, unknown>)
        : {};
    const sizeM2 = Number(e.sizeM2);
    const price = Number(e.pricePerM2);
    const lng = Number(e.lng);
    const lat = Number(e.lat);
    const pct = Number(e.cityPercentile);
    out.push({
      id: citySlug ? compareItemId(citySlug, h3) : String(e.id ?? `${cityName}:${h3}`),
      citySlug,
      cityName,
      h3,
      props,
      sizeM2: Number.isFinite(sizeM2) && sizeM2 > 0 ? sizeM2 : DEFAULT_SIZE_M2,
      pricePerM2: Number.isFinite(price) && price > 0 ? price : null,
      lng: Number.isFinite(lng) ? lng : null,
      lat: Number.isFinite(lat) ? lat : null,
      cityPercentile: Number.isFinite(pct) ? pct : null,
    });
    if (out.length >= MAX_COMPARE) break;
  }
  return out;
}
