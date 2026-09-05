/** Cancellation and timeout behaviour of the API client. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  TimeoutError,
  fetchCityGeojson,
  gatewayUrl,
  isAbortError,
  pollUntilReady,
  resetApiBase,
} from './client';

type FetchArgs = [input: string, init?: RequestInit];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** A fresh Response per call; a body can only be read once. */
function alwaysJson(body: unknown, status = 200) {
  return () => Promise.resolve(jsonResponse(body, status));
}

/** A fetch that never settles until its signal aborts. */
function hangingFetch(): (...args: FetchArgs) => Promise<Response> {
  return (_input, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () =>
        reject(new DOMException('aborted', 'AbortError')),
      );
    });
}

const realFetch = globalThis.fetch;

beforeEach(() => {
  resetApiBase();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe('gatewayUrl', () => {
  it('stays relative when no gateway URL is configured', () => {
    // Without VITE_GATEWAY_URL the reverse proxy handles /v1/*, as before.
    expect(gatewayUrl('/v1/chat')).toBe('/v1/chat');
  });
});

describe('timeouts', () => {
  it('turn a stalled request into a TimeoutError', async () => {
    globalThis.fetch = vi.fn(hangingFetch()) as unknown as typeof fetch;

    await expect(fetchCityGeojson('muenchen', { timeoutMs: 10 })).rejects.toBeInstanceOf(
      TimeoutError,
    );
  });

  it('leave a caller abort distinguishable from a timeout', async () => {
    globalThis.fetch = vi.fn(hangingFetch()) as unknown as typeof fetch;
    const controller = new AbortController();
    const pending = fetchCityGeojson('muenchen', { signal: controller.signal, timeoutMs: 5_000 });

    controller.abort();

    await expect(pending).rejects.toSatisfy(isAbortError);
  });
});

describe('pollUntilReady', () => {
  it('resolves once the city is ready', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ status: 'pending', step: 3, total: 17 }))
      .mockResolvedValueOnce(jsonResponse({ status: 'ready' })) as unknown as typeof fetch;
    const progress: string[] = [];

    await pollUntilReady('bonn', 'Bonn', (msg) => progress.push(msg), { intervalMs: 1 });

    expect(progress).toEqual(['Erzeuge Karte für Bonn … Schritt 3/17']);
  });

  it('surfaces the server-side failure message', async () => {
    globalThis.fetch = vi
      .fn()
      .mockImplementation(
        alwaysJson({ status: 'error', message: 'overpass down' }),
      ) as unknown as typeof fetch;

    await expect(
      pollUntilReady('essen', 'Essen', () => {}, { intervalMs: 1 }),
    ).rejects.toThrow('overpass down');
  });

  it('gives up instead of polling forever', async () => {
    globalThis.fetch = vi
      .fn()
      .mockImplementation(
        alwaysJson({ status: 'pending', step: 1, total: 17 }),
      ) as unknown as typeof fetch;

    await expect(
      pollUntilReady('mainz', 'Mainz', () => {}, { intervalMs: 1, deadlineMs: 20 }),
    ).rejects.toBeInstanceOf(TimeoutError);
  });

  it('stops immediately when the caller aborts', async () => {
    globalThis.fetch = vi
      .fn()
      .mockImplementation(alwaysJson({ status: 'pending' })) as unknown as typeof fetch;
    const controller = new AbortController();
    const pending = pollUntilReady('trier', 'Trier', () => {}, {
      intervalMs: 50,
      signal: controller.signal,
    });

    controller.abort();

    await expect(pending).rejects.toSatisfy(isAbortError);
  });

  it('rides out transient failures but not a dead backend', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('network error'));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      pollUntilReady('koeln', 'Köln', () => {}, { intervalMs: 1 }),
    ).rejects.toThrow('Verbindung zum Server verloren.');
    expect(fetchMock).toHaveBeenCalledTimes(10);
  });

  it('recovers when the API comes back', async () => {
    globalThis.fetch = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('network error'))
      .mockRejectedValueOnce(new TypeError('network error'))
      .mockImplementation(alwaysJson({ status: 'ready' })) as unknown as typeof fetch;

    await expect(
      pollUntilReady('kiel', 'Kiel', () => {}, { intervalMs: 1 }),
    ).resolves.toBeUndefined();
  });
});
