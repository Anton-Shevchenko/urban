import { useCallback, useRef, useState } from 'react';
import { isAbortError, pollCycleways, requestCycleways } from '../api/client';

export function cityNameFromQuery(query: string): string {
  const head = query.split(',')[0]?.trim() ?? '';
  return head || query.trim();
}

export function useCyclewaySearch(setMapView: (view: string) => void) {
  const [slug, setSlug] = useState<string | null>(null);
  const [name, setName] = useState<string | null>(null);
  const [holding, setHolding] = useState(false);
  const [bbox, setBbox] = useState<[number, number, number, number] | null>(null);
  const [statusText, setStatusText] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const seqRef = useRef(0);

  const openCity = useCallback(async (query: string) => {
    const q = query.trim();
    if (q.length < 2) return;
    const seq = ++seqRef.current;
    setBusy(true);
    setError(false);
    setHolding(true);
    setSlug(null);
    setName(cityNameFromQuery(q));
    setStatusText('Stadt wird gesucht …');
    setMapView('cycleways');
    try {
      const res = await requestCycleways(q);
      if (seqRef.current !== seq) return;
      setSlug(res.slug);
      if (res.name?.trim()) setName(res.name.trim());
      setHolding(false);
      if (res.bbox && res.bbox.length === 4) {
        setBbox([res.bbox[0], res.bbox[1], res.bbox[2], res.bbox[3]]);
      }
      if (res.status === 'ready') {
        setStatusText(res.cached ? 'Radwege aus dem Cache' : 'Radwege geladen');
        return;
      }
      setStatusText(res.message || 'Radwege werden geladen …');
      await pollCycleways(res.slug, (msg) => {
        if (seqRef.current === seq) setStatusText(msg);
      });
      if (seqRef.current !== seq) return;
      setStatusText('Radwege geladen');
    } catch (err) {
      if (seqRef.current !== seq || isAbortError(err)) return;
      setError(true);
      setHolding(false);
      setStatusText(err instanceof Error ? err.message : 'Radwege konnten nicht geladen werden');
    } finally {
      if (seqRef.current === seq) setBusy(false);
    }
  }, [setMapView]);

  return { slug, name, holding, bbox, statusText, error, busy, openCity };
}

export type CyclewaySearchState = ReturnType<typeof useCyclewaySearch>;
