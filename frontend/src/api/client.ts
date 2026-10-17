const envBase = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') ?? '';

/** null = not resolved yet; string (maybe '') = resolved successfully; false = failed */
let resolvedApiBase: string | null | false = envBase ? envBase : null;

export function apiUrl(path: string): string {
  const base = typeof resolvedApiBase === 'string' ? resolvedApiBase : '';
  return `${base}${path}`;
}

/** Chat goes through the Go gateway, which is a different origin without a proxy. */
const gatewayBase = (import.meta.env.VITE_GATEWAY_URL as string | undefined)?.replace(/\/$/, '') ?? '';

export function gatewayUrl(path: string): string {
  return `${gatewayBase}${path}`;
}

export type RequestOptions = {
  /** Caller-owned cancellation, e.g. an unmounting component. */
  signal?: AbortSignal;
  /** Overrides the per-endpoint default. */
  timeoutMs?: number;
};

// Every request needs an upper bound: without one a stalled connection leaves
// the UI spinning forever, which is what used to happen while polling.
const TIMEOUT_PROBE_MS = 4_000;
const TIMEOUT_JSON_MS = 15_000;
const TIMEOUT_GENERATE_MS = 45_000;
/** A city GeoJSON is several MB, so it gets a much longer budget. */
const TIMEOUT_GEOJSON_MS = 120_000;
/** Full generation is Overpass-bound and can legitimately take ~30 min. */
const POLL_DEADLINE_MS = 45 * 60_000;
const POLL_INTERVAL_MS = 2_000;
const POLL_MAX_CONSECUTIVE_FAILURES = 10;

export class TimeoutError extends Error {
  constructor(message = 'Zeitüberschreitung — der Server antwortet nicht.') {
    super(message);
    this.name = 'TimeoutError';
  }
}

export function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

/** A signal that aborts on the caller's signal or when the timeout elapses. */
function timedSignal(opts: RequestOptions | undefined, fallbackMs: number) {
  const controller = new AbortController();
  const external = opts?.signal;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, opts?.timeoutMs ?? fallbackMs);

  const forward = () => controller.abort();
  if (external) {
    if (external.aborted) forward();
    else external.addEventListener('abort', forward, { once: true });
  }

  return {
    signal: controller.signal,
    /** True when we, not the caller, cancelled the request. */
    get timedOut() {
      return timedOut;
    },
    release() {
      clearTimeout(timer);
      external?.removeEventListener('abort', forward);
    },
  };
}

async function timedFetch(
  url: string,
  init: RequestInit,
  opts: RequestOptions | undefined,
  fallbackMs: number,
): Promise<Response> {
  const guard = timedSignal(opts, fallbackMs);
  try {
    return await fetch(url, { ...init, signal: guard.signal });
  } catch (err) {
    // Turn our own timeout into a message a user can act on, but let a
    // caller-initiated abort propagate so callers can ignore it silently.
    if (guard.timedOut) throw new TimeoutError();
    throw err;
  } finally {
    guard.release();
  }
}

async function probeCities(base: string): Promise<boolean> {
  try {
    const resp = await timedFetch(`${base}/api/cities`, { method: 'GET' }, undefined, TIMEOUT_PROBE_MS);
    return resp.ok;
  } catch {
    return false;
  }
}

export async function ensureApiBase(): Promise<string | null> {
  if (resolvedApiBase === false) return null;
  if (typeof resolvedApiBase === 'string') return resolvedApiBase;

  const candidates: string[] = [];
  candidates.push('');
  if (typeof location !== 'undefined') {
    const { protocol, hostname, port } = location;
    if (port && port !== '8000') {
      candidates.push(`${protocol}//${hostname}:8000`);
      if (hostname === 'localhost' || hostname === '::1') {
        candidates.push(`${protocol}//127.0.0.1:8000`);
      }
    }
    if (!port || port === '80' || port === '443') {
      candidates.push(location.origin);
    }
  }

  const seen = new Set<string>();
  for (const base of candidates) {
    const key = base || '(same-origin)';
    if (seen.has(key)) continue;
    seen.add(key);
    if (await probeCities(base)) {
      resolvedApiBase = base.replace(/\/$/, '');
      return resolvedApiBase;
    }
  }
  resolvedApiBase = false;
  return null;
}

/** Reset after backend comes online (e.g. user started compose). */
export function resetApiBase(): void {
  resolvedApiBase = envBase ? envBase : null;
}

export function apiUnavailableMessage(): string {
  return 'Stadtsuche braucht den Backend-Server. Öffne http://localhost:8080 nach «docker compose up», oder starte uvicorn auf :8000 und npm run dev.';
}

export function parseApiError(payload: unknown, status: number): string {
  const detail = (payload as { detail?: unknown })?.detail;
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail)) {
    return detail.map((d) => (d as { msg?: string }).msg || JSON.stringify(d)).join('; ');
  }
  return `Fehler ${status}`;
}

export type GenerateResponse = {
  status: string;
  slug: string;
  name?: string;
  meta?: { name?: string };
};

export async function generateCity(q: string, opts?: RequestOptions): Promise<GenerateResponse> {
  const resp = await timedFetch(
    apiUrl('/api/generate'),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q }),
    },
    opts,
    TIMEOUT_GENERATE_MS,
  );
  const payload = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(parseApiError(payload, resp.status));
  return payload as GenerateResponse;
}

/** Sleep that rejects as soon as the caller aborts. */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new DOMException('aborted', 'AbortError'));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export type PollOptions = RequestOptions & { deadlineMs?: number; intervalMs?: number };

export async function pollUntilReady(
  slug: string,
  name: string,
  onProgress: (msg: string) => void,
  opts?: PollOptions,
): Promise<void> {
  const deadline = Date.now() + (opts?.deadlineMs ?? POLL_DEADLINE_MS);
  const interval = opts?.intervalMs ?? POLL_INTERVAL_MS;
  let consecutiveFailures = 0;

  for (;;) {
    await delay(interval, opts?.signal);

    if (Date.now() > deadline) {
      throw new TimeoutError(`Generierung für ${name} hat zu lange gedauert.`);
    }

    let data: { status?: string; message?: string; step?: number; total?: number };
    try {
      const resp = await timedFetch(
        apiUrl(`/api/status/${slug}`),
        { cache: 'no-store' },
        opts,
        TIMEOUT_JSON_MS,
      );
      data = await resp.json();
      consecutiveFailures = 0;
    } catch (err) {
      if (isAbortError(err)) throw err;
      // A restarting API is normal mid-generation, a permanently unreachable
      // one is not — give up instead of polling a dead endpoint forever.
      consecutiveFailures += 1;
      if (consecutiveFailures >= POLL_MAX_CONSECUTIVE_FAILURES) {
        throw new Error('Verbindung zum Server verloren.');
      }
      continue;
    }

    if (data.status === 'ready') return;
    if (data.status === 'error') throw new Error(data.message || 'Generierung fehlgeschlagen');
    const step = data.step || 0;
    const total = data.total || 17;
    onProgress(`Erzeuge Karte für ${name} … Schritt ${step}/${total}`);
  }
}

export type CityListItem = {
  slug: string;
  name?: string;
  count?: number;
  population?: number;
  city_type?: string;
  has_rent?: boolean;
  pipeline_version?: number;
  h3_res?: number;
};

export async function fetchCities(opts?: RequestOptions): Promise<CityListItem[]> {
  const base = await ensureApiBase();
  if (base === null) throw new Error(apiUnavailableMessage());
  const resp = await timedFetch(apiUrl('/api/cities'), { cache: 'no-store' }, opts, TIMEOUT_JSON_MS);
  const payload = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(parseApiError(payload, resp.status));
  const cities = (payload as { cities?: CityListItem[] }).cities;
  return Array.isArray(cities) ? cities : [];
}

export type CityStatus = {
  status: string;
  slug?: string;
  name?: string;
  message?: string;
  meta?: { name?: string };
  step?: number;
  total?: number;
};

export async function fetchCityStatus(slug: string, opts?: RequestOptions): Promise<CityStatus> {
  const resp = await timedFetch(
    apiUrl(`/api/status/${slug}`),
    { cache: 'no-store' },
    opts,
    TIMEOUT_JSON_MS,
  );
  const payload = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(parseApiError(payload, resp.status));
  return payload as CityStatus;
}

export type CityGeojson = GeoJSON.FeatureCollection & { meta?: Record<string, unknown> };

export async function fetchCityGeojson(slug: string, opts?: RequestOptions): Promise<CityGeojson> {
  const resp = await timedFetch(
    apiUrl(`/api/city/${slug}.geojson`),
    { cache: 'no-store' },
    opts,
    TIMEOUT_GEOJSON_MS,
  );
  if (!resp.ok) throw new Error(`Karte konnte nicht geladen werden (${resp.status})`);
  return resp.json();
}

export type PlaceSuggestion = {
  name: string;
  state: string;
  type: string;
  label: string;
};

export async function fetchPlaceSuggestions(
  q: string,
  opts?: RequestOptions,
): Promise<PlaceSuggestion[]> {
  await ensureApiBase();
  const resp = await timedFetch(
    apiUrl(`/api/suggest?q=${encodeURIComponent(q)}`),
    { cache: 'no-store' },
    opts,
    TIMEOUT_JSON_MS,
  );
  const payload = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(parseApiError(payload, resp.status));
  const rows = (payload as { suggestions?: PlaceSuggestion[] }).suggestions;
  return Array.isArray(rows) ? rows : [];
}

export type CyclewaysResponse = {
  status: string;
  slug: string;
  name?: string;
  bbox?: [number, number, number, number];
  center?: [number, number];
  message?: string;
  step?: number;
  total?: number;
  cached?: boolean;
};

export async function requestCycleways(q: string, opts?: RequestOptions): Promise<CyclewaysResponse> {
  await ensureApiBase();
  const resp = await timedFetch(
    apiUrl('/api/cycleways'),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q }),
    },
    opts,
    TIMEOUT_GENERATE_MS,
  );
  const payload = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(parseApiError(payload, resp.status));
  return payload as CyclewaysResponse;
}

export async function fetchCyclewaysStatus(
  slug: string,
  opts?: RequestOptions,
): Promise<CyclewaysResponse> {
  const resp = await timedFetch(
    apiUrl(`/api/cycleways/status/${encodeURIComponent(slug)}`),
    { cache: 'no-store' },
    opts,
    TIMEOUT_JSON_MS,
  );
  const payload = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(parseApiError(payload, resp.status));
  return payload as CyclewaysResponse;
}

/** Poll the cycle-infra job. Does not touch Wohnindex generation status. */
export async function pollCycleways(
  slug: string,
  onProgress: (msg: string) => void,
  opts?: PollOptions,
): Promise<void> {
  const deadline = Date.now() + (opts?.deadlineMs ?? 8 * 60_000);
  const interval = opts?.intervalMs ?? POLL_INTERVAL_MS;
  for (;;) {
    await delay(interval, opts?.signal);
    if (Date.now() > deadline) {
      throw new TimeoutError('Radwege haben zu lange zum Laden gebraucht.');
    }
    let data: CyclewaysResponse;
    try {
      data = await fetchCyclewaysStatus(slug, opts);
    } catch (err) {
      if (isAbortError(err)) throw err;
      continue;
    }
    if (data.status === 'ready') return;
    if (data.status === 'error') throw new Error(data.message || 'Radwege konnten nicht geladen werden');
    onProgress(data.message || 'Radwege werden geladen …');
  }
}

/** Schema-2 cycle infrastructure. `null` means the cache is not ready yet. */
export async function fetchCyclewaysGeojson(
  slug: string,
  opts?: RequestOptions,
): Promise<GeoJSON.FeatureCollection | null> {
  const resp = await timedFetch(
    apiUrl(`/api/city/${encodeURIComponent(slug)}/cycleways.geojson`),
    { cache: 'no-store' },
    opts,
    TIMEOUT_GEOJSON_MS,
  );
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`Radwege konnten nicht geladen werden (${resp.status})`);
  return resp.json();
}

export async function fetchDestMatrix(
  slug: string,
  destinations: { lat: number; lng: number; weight?: number; label?: string }[],
  opts?: RequestOptions,
): Promise<Record<string, Record<string, number>>> {
  const resp = await timedFetch(
    apiUrl('/api/destinations/matrix'),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug, destinations }),
    },
    opts,
    TIMEOUT_GENERATE_MS,
  );
  if (!resp.ok) return {};
  const data = await resp.json();
  return data.matrix || {};
}

export type ChatTurn = { role: 'user' | 'assistant'; content: string };

export function chatUnavailableMessage(): string {
  return 'Hex-Chat braucht den Go-Gateway (:8081) und Ollama auf diesem Rechner (:11434). Installiere Ollama, dann «make ollama» (llama3.2:3b).';
}

/** The gateway answers errors as `{ error, request_id }`. */
async function gatewayErrorText(resp: Response): Promise<string> {
  const text = (await resp.text().catch(() => '')).trim();
  if (!text) return '';
  try {
    const parsed = JSON.parse(text) as { error?: string };
    return parsed.error?.trim() || text;
  } catch {
    return text;
  }
}

function applySseBlock(
  block: string,
  onToken: (token: string) => void,
): 'done' | 'error' | null {
  let event = 'message';
  const dataLines: string[] = [];
  for (const raw of block.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
  }
  const data = dataLines.join('\n');
  if (event === 'done') return 'done';
  if (event === 'error') {
    let msg = data || 'Chat-Fehler';
    try {
      const parsed = JSON.parse(data) as { error?: string };
      if (parsed.error) msg = parsed.error;
    } catch {
      /* keep msg */
    }
    throw new Error(msg);
  }
  if (!data) return null;
  try {
    const parsed = JSON.parse(data) as { token?: string };
    if (parsed.token) onToken(parsed.token);
  } catch {
    /* ignore comments / keep-alives */
  }
  return null;
}

export async function streamHexChat(
  body: {
    city_slug: string;
    h3: string;
    message: string;
    history?: ChatTurn[];
    compare?: { city_slug: string; h3: string }[];
  },
  onToken: (token: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  let resp: Response;
  try {
    resp = await fetch(gatewayUrl('/v1/chat'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (isAbortError(err)) throw err;
    throw new Error(chatUnavailableMessage());
  }
  if (!resp.ok) {
    const detail = await gatewayErrorText(resp);
    if (resp.status === 404) {
      throw new Error(detail || 'Hexagon nicht im Go-Service gefunden.');
    }
    if (resp.status === 429) {
      throw new Error(detail || 'Zu viele Chat-Anfragen — bitte kurz warten.');
    }
    if (resp.status >= 500) {
      throw new Error(detail || chatUnavailableMessage());
    }
    throw new Error(detail || `Chat-Fehler ${resp.status}`);
  }
  const reader = resp.body?.getReader();
  if (!reader) throw new Error('Kein Stream vom Gateway');
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split('\n\n');
    buf = parts.pop() ?? '';
    for (const block of parts) {
      if (applySseBlock(block, onToken) === 'done') return;
    }
  }
  if (buf.trim()) applySseBlock(buf, onToken);
}
