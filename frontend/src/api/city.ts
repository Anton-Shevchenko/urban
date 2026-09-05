/** One place that turns "the user wants this city" into a ready slug.
 *
 * The home page and the map hook used to carry near-identical
 * resolve -> generate -> poll flows that drifted apart (different error
 * strings, different step totals, no cancellation in one of them).
 */
import {
  apiUnavailableMessage,
  ensureApiBase,
  fetchCityGeojson,
  fetchCityStatus,
  generateCity,
  pollUntilReady,
  resetApiBase,
  type CityGeojson,
  type PollOptions,
} from './client';

export type CityRequestOptions = PollOptions;

export type CityProgress = (message: string) => void;

export type ResolvedCity = {
  slug: string;
  name: string;
  /** True when the API had to run (or finish) a generation for us. */
  generated: boolean;
};

async function requireApi(): Promise<void> {
  resetApiBase();
  if ((await ensureApiBase()) === null) throw new Error(apiUnavailableMessage());
}

/**
 * Resolve a free-text query to a ready city, generating it if needed.
 *
 * @param query free-text place name, e.g. "Hamburg".
 */
export async function resolveCityByQuery(
  query: string,
  onProgress: CityProgress,
  opts?: CityRequestOptions,
): Promise<ResolvedCity> {
  await requireApi();
  onProgress(`Suche „${query}“ …`);

  const data = await generateCity(query, opts);
  const slug = data.slug;
  if (!slug) throw new Error('Keine Stadt-ID vom Server erhalten');
  const name = data.meta?.name || data.name || query;

  if (data.status === 'ready') return { slug, name, generated: false };

  onProgress(`Erzeuge Karte für ${name} …`);
  await pollUntilReady(slug, name, onProgress, opts);
  return { slug, name, generated: true };
}

/**
 * Resolve a slug from the URL, falling back to a query when it is unknown.
 *
 * A slug can be pending (someone else is generating it), stale, or entirely
 * unknown — for example a hand-typed or shared link.
 */
export async function resolveCityBySlug(
  slug: string,
  onProgress: CityProgress,
  opts?: CityRequestOptions,
): Promise<ResolvedCity> {
  await requireApi();
  onProgress(`Lade „${slug}“ …`);

  let status;
  try {
    status = await fetchCityStatus(slug, opts);
  } catch {
    // Not in the API at all: treat the slug as a search term.
    return resolveCityByQuery(slug.replace(/-/g, ' '), onProgress, opts);
  }

  const name = status.meta?.name || status.name || slug;
  if (status.status === 'ready') return { slug, name, generated: false };
  if (status.status === 'error') {
    throw new Error(status.message || 'Generierung fehlgeschlagen');
  }
  if (status.status !== 'pending') {
    throw new Error(status.message || 'Stadt nicht bereit');
  }

  onProgress(`Erzeuge Karte für ${name} …`);
  await pollUntilReady(slug, name, onProgress, opts);
  return { slug, name, generated: true };
}

/** Resolve a city and download its hex layer in one step. */
export async function loadOrGenerateCity(
  target: { slug: string } | { query: string },
  onProgress: CityProgress,
  opts?: CityRequestOptions,
): Promise<{ city: ResolvedCity; geojson: CityGeojson }> {
  const city =
    'slug' in target
      ? await resolveCityBySlug(target.slug, onProgress, opts)
      : await resolveCityByQuery(target.query, onProgress, opts);
  const geojson = await fetchCityGeojson(city.slug, opts);
  return { city, geojson };
}
