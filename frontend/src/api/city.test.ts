/** The single generate -> poll -> load flow shared by the home page and the map. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetApiBase } from './client';
import { loadOrGenerateCity, resolveCityBySlug, resolveCityByQuery } from './city';

const realFetch = globalThis.fetch;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Route stubbed responses by URL so tests read like the real request order. */
function routes(table: Record<string, () => Response>) {
  const seen: string[] = [];
  const fetchMock = vi.fn((input: string) => {
    seen.push(input);
    const key = Object.keys(table).find((pattern) => input.includes(pattern));
    if (!key) return Promise.resolve(json({ detail: 'unexpected' }, 500));
    return Promise.resolve(table[key]!());
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return seen;
}

const emptyGeojson = { type: 'FeatureCollection', features: [] };
const fast = { intervalMs: 1 };

beforeEach(() => {
  resetApiBase();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe('resolveCityByQuery', () => {
  it('returns a cached city without polling', async () => {
    const seen = routes({
      '/api/cities': () => json({ cities: [] }),
      '/api/generate': () => json({ status: 'ready', slug: 'bonn', meta: { name: 'Bonn' } }),
    });

    const city = await resolveCityByQuery('Bonn', () => {}, fast);

    expect(city).toEqual({ slug: 'bonn', name: 'Bonn', generated: false });
    expect(seen.some((u) => u.includes('/api/status/'))).toBe(false);
  });

  it('polls until a fresh city is generated', async () => {
    let status = 'pending';
    routes({
      '/api/cities': () => json({ cities: [] }),
      '/api/generate': () => json({ status: 'pending', slug: 'kiel', name: 'Kiel' }),
      '/api/status/': () => {
        const body = json({ status, step: 4, total: 17 });
        status = 'ready';
        return body;
      },
    });
    const progress: string[] = [];

    const city = await resolveCityByQuery('Kiel', (m) => progress.push(m), fast);

    expect(city.generated).toBe(true);
    expect(progress[0]).toContain('Suche');
    expect(progress.at(-1)).toContain('Schritt 4/17');
  });

  it('reports a missing backend rather than a generic failure', async () => {
    routes({ '/api/cities': () => json({ detail: 'nope' }, 502) });

    await expect(resolveCityByQuery('Bonn', () => {}, fast)).rejects.toThrow(/Backend-Server/);
  });

  it('propagates a geocoding error from the API', async () => {
    routes({
      '/api/cities': () => json({ cities: [] }),
      '/api/generate': () => json({ detail: "no result for 'Atlantis'" }, 404),
    });

    await expect(resolveCityByQuery('Atlantis', () => {}, fast)).rejects.toThrow(/Atlantis/);
  });
});

describe('resolveCityBySlug', () => {
  it('uses the cached city when the slug is ready', async () => {
    routes({
      '/api/cities': () => json({ cities: [] }),
      '/api/status/': () => json({ status: 'ready', meta: { name: 'München' } }),
    });

    const city = await resolveCityBySlug('muenchen', () => {}, fast);

    expect(city).toEqual({ slug: 'muenchen', name: 'München', generated: false });
  });

  it('falls back to a search when the slug is unknown', async () => {
    const seen = routes({
      '/api/cities': () => json({ cities: [] }),
      '/api/status/': () => json({ detail: 'unknown city' }, 404),
      '/api/generate': () =>
        json({ status: 'ready', slug: 'bad-toelz', meta: { name: 'Bad Tölz' } }),
    });

    const city = await resolveCityBySlug('bad-toelz', () => {}, fast);

    expect(city.slug).toBe('bad-toelz');
    expect(seen.some((u) => u.includes('/api/generate'))).toBe(true);
  });

  it('surfaces a failed generation instead of retrying forever', async () => {
    routes({
      '/api/cities': () => json({ cities: [] }),
      '/api/status/': () => json({ status: 'error', message: 'interrupted by restart' }),
    });

    await expect(resolveCityBySlug('essen', () => {}, fast)).rejects.toThrow(
      'interrupted by restart',
    );
  });
});

describe('loadOrGenerateCity', () => {
  it('returns the hex layer together with the resolved city', async () => {
    routes({
      '/api/cities': () => json({ cities: [] }),
      '/api/status/': () => json({ status: 'ready', meta: { name: 'München' } }),
      '.geojson': () => json(emptyGeojson),
    });

    const { city, geojson } = await loadOrGenerateCity({ slug: 'muenchen' }, () => {}, fast);

    expect(city.slug).toBe('muenchen');
    expect(geojson.type).toBe('FeatureCollection');
  });

  it('does not download the map when generation failed', async () => {
    const seen = routes({
      '/api/cities': () => json({ cities: [] }),
      '/api/status/': () => json({ status: 'error', message: 'overpass down' }),
    });

    await expect(loadOrGenerateCity({ slug: 'essen' }, () => {}, fast)).rejects.toThrow(
      'overpass down',
    );
    expect(seen.some((u) => u.includes('.geojson'))).toBe(false);
  });
});
