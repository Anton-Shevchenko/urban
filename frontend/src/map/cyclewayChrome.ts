export type HexGridMeta = {
  count?: number | null;
  h3_res?: number | null;
};

/** Footer line for a real hex grid. Missing resolution or an empty grid stays hidden. */
export function hexGridSummary(meta: HexGridMeta, featureCount: number): string | null {
  const count = meta.count ?? featureCount;
  if (typeof count !== 'number' || !Number.isFinite(count) || count <= 0) return null;
  const res = meta.h3_res;
  if (typeof res !== 'number' || !Number.isFinite(res)) return null;
  return `${count} Hexagone · H3 res ${res}`;
}

export function displayCityChrome(input: {
  mapView: string;
  wohnindexName: string;
  wohnindexSlug: string;
  cyclewayName: string | null;
  cyclewaySlug: string | null;
  meta: HexGridMeta;
  featureCount: number;
}): { cityName: string; hexSummary: string | null } {
  const cyclewayActive = input.mapView === 'cycleways' && Boolean(input.cyclewayName);
  const cityName = cyclewayActive && input.cyclewayName
    ? input.cyclewayName
    : input.wohnindexName;
  const ownsGrid = !cyclewayActive
    || (input.cyclewaySlug != null && input.cyclewaySlug === input.wohnindexSlug);
  return {
    cityName,
    hexSummary: ownsGrid ? hexGridSummary(input.meta, input.featureCount) : null,
  };
}
