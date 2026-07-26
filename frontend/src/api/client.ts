const envBase = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') ?? '';

/** null = not resolved yet; string (maybe '') = resolved successfully; false = failed */
let resolvedApiBase: string | null | false = envBase ? envBase : null;

export function apiUrl(path: string): string {
  const base = typeof resolvedApiBase === 'string' ? resolvedApiBase : '';
  return `${base}${path}`;
}

async function probeCities(base: string): Promise<boolean> {
  try {
    const resp = await fetch(`${base}/api/cities`, { method: 'GET' });
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

export async function generateCity(q: string): Promise<{
  status: string;
  slug: string;
  name?: string;
  meta?: { name?: string };
}> {
  const resp = await fetch(apiUrl('/api/generate'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ q }),
  });
  const payload = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(parseApiError(payload, resp.status));
  return payload;
}

export async function pollUntilReady(
  slug: string,
  name: string,
  onProgress: (msg: string) => void,
): Promise<void> {
  for (;;) {
    await new Promise((r) => setTimeout(r, 2000));
    let data: { status?: string; message?: string; step?: number; total?: number };
    try {
      const resp = await fetch(apiUrl(`/api/status/${slug}`));
      data = await resp.json();
    } catch {
      continue;
    }
    if (data.status === 'ready') return;
    if (data.status === 'error') throw new Error(data.message || 'Generierung fehlgeschlagen');
    const step = data.step || 0;
    const total = data.total || 15;
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

export async function fetchCities(): Promise<CityListItem[]> {
  const base = await ensureApiBase();
  if (base === null) throw new Error(apiUnavailableMessage());
  const resp = await fetch(apiUrl('/api/cities'), { cache: 'no-store' });
  const payload = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(parseApiError(payload, resp.status));
  const cities = (payload as { cities?: CityListItem[] }).cities;
  return Array.isArray(cities) ? cities : [];
}

export async function fetchCityStatus(slug: string): Promise<{
  status: string;
  slug?: string;
  name?: string;
  message?: string;
  meta?: { name?: string };
  step?: number;
  total?: number;
}> {
  const resp = await fetch(apiUrl(`/api/status/${slug}`), { cache: 'no-store' });
  const payload = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(parseApiError(payload, resp.status));
  return payload;
}

export async function fetchCityGeojson(
  slug: string,
): Promise<GeoJSON.FeatureCollection & { meta?: Record<string, unknown> }> {
  const resp = await fetch(apiUrl(`/api/city/${slug}.geojson`), { cache: 'no-store' });
  if (!resp.ok) throw new Error(`Karte konnte nicht geladen werden (${resp.status})`);
  return resp.json();
}

export async function fetchDestMatrix(
  slug: string,
  destinations: { lat: number; lng: number; weight?: number; label?: string }[],
): Promise<Record<string, Record<string, number>>> {
  const resp = await fetch(apiUrl('/api/destinations/matrix'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug, destinations }),
  });
  if (!resp.ok) return {};
  const data = await resp.json();
  return data.matrix || {};
}
