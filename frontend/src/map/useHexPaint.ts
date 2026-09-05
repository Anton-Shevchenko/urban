import { useEffect, useRef, type MutableRefObject, type RefObject } from 'react';
import type { FeatureCollection } from 'geojson';
import type { Map as MapLibreMap } from 'maplibre-gl';
import { isPrimaryPaintView, serializeScoringContext } from '../scoring/hexPaint';
import type { PipelinePoint } from '../scoring/types';
import type { HexPaintSnapshot } from '../wohnindex/types';
import { applyHexLayers, applyHexOverlays, writeLiveScoreProps } from './applyPaint';
import { hexFillColor, hexFillOpacity } from './layerConfig';
import type { HexPaintRequest, HexPaintResult } from './hexPaintWorker.types';

export const PAINT_DEBOUNCE_MS = 180;

type PaintBuffers = {
  scores: Float32Array;
  passed: Uint8Array;
};

function overlayState(s: HexPaintSnapshot) {
  const selectedH3s = s.comparison
    .filter((i) => i.cityName === s.cityName)
    .map((i) => i.h3);
  const chatH3 = s.chatHex && s.chatHex.citySlug === s.citySlug ? s.chatHex.h3 : '__none__';
  return { showHiddenGems: s.showHiddenGems, selectedH3s, chatH3 };
}

function paintExpressions(s: HexPaintSnapshot, paintMapView: string) {
  const primary = isPrimaryPaintView(paintMapView);
  const fillColor = hexFillColor(
    primary,
    paintMapView,
    s.engine.activeCriterionKeys().length > 0,
  );
  const fillOpacity = hexFillOpacity(s.engine.getPassingCount(), primary);
  return { fillColor, fillOpacity, passingCount: s.engine.getPassingCount() };
}

export function useHexPaint(opts: {
  mapRef: RefObject<MapLibreMap | null>;
  liveFcRef: MutableRefObject<FeatureCollection | null>;
  state: HexPaintSnapshot;
  styleEpoch: number;
  onLayersCreated: (map: MapLibreMap) => void;
}): void {
  const { mapRef, liveFcRef, state, styleEpoch, onLayersCreated } = opts;
  const workerRef = useRef<Worker | null>(null);
  const requestIdRef = useRef(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastScoreKeyRef = useRef('');
  const lastStyleEpochRef = useRef(-1);
  const lastResultRef = useRef<PaintBuffers | null>(null);
  const requestStartedRef = useRef(0);
  const stateRef = useRef(state);
  stateRef.current = state;
  const onLayersCreatedRef = useRef(onLayersCreated);
  onLayersCreatedRef.current = onLayersCreated;
  const styleEpochRef = useRef(styleEpoch);
  styleEpochRef.current = styleEpoch;

  const applyBuffers = useRef((map: MapLibreMap, buffers: PaintBuffers, t0: number) => {
    const s = stateRef.current;
    const paintMapView = s.paintMapView ?? s.mapView;
    let fc = liveFcRef.current;
    if (!fc || fc.features.length !== s.features.length) {
      fc = {
        type: 'FeatureCollection',
        features: s.features.map((f) => ({
          type: 'Feature' as const,
          geometry: f.geometry,
          properties: { ...(f.properties as Record<string, unknown>) },
        })),
      };
      liveFcRef.current = fc;
    }
    writeLiveScoreProps(fc, s.features, buffers.scores, buffers.passed);
    const { fillColor, fillOpacity, passingCount } = paintExpressions(s, paintMapView);
    const created = applyHexLayers(map, fc, fillColor, fillOpacity);
    if (created === 'created') onLayersCreatedRef.current(map);
    applyHexOverlays(map, overlayState(s));
    lastStyleEpochRef.current = styleEpochRef.current;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      s.onPaintComplete({
        ms: Math.round(performance.now() - t0),
        lo: 0,
        hi: 100,
        passingCount,
        hexCount: fc.features.length,
      });
      s.setPainting(false);
    };
    const onIdle = () => {
      map.off('idle', onIdle);
      finish();
    };
    map.once('idle', onIdle);
    setTimeout(() => {
      map.off('idle', onIdle);
      finish();
    }, 600);
  });

  useEffect(() => {
    const worker = new Worker(new URL('./hexPaintWorker.ts', import.meta.url), {
      type: 'module',
    });
    workerRef.current = worker;
    worker.onmessage = (event: MessageEvent<HexPaintResult>) => {
      if (event.data.requestId !== requestIdRef.current) return;
      const s = stateRef.current;
      const paintMapView = s.paintMapView ?? s.mapView;
      lastScoreKeyRef.current = `${s.citySlug}:${s.features.length}:${s.paintVersion}:${paintMapView}`;
      lastResultRef.current = { scores: event.data.scores, passed: event.data.passed };
      const map = mapRef.current;
      if (!map) return;
      const t0 = requestStartedRef.current || performance.now();
      const run = () => applyBuffers.current(map, lastResultRef.current!, t0);
      if (map.isStyleLoaded()) run();
      else map.once('load', run);
    };
    worker.onerror = (err) => {
      console.error('[map paint worker]', err);
      stateRef.current.setPainting(false);
    };
    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, [mapRef, liveFcRef]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !state.features.length) return;
    const s = stateRef.current;
    const paintMapView = s.paintMapView ?? s.mapView;
    const scoreKey = `${s.citySlug}:${s.features.length}:${s.paintVersion}:${paintMapView}`;
    const needsScore = scoreKey !== lastScoreKeyRef.current || !lastResultRef.current;
    const needsRestyle = styleEpoch !== lastStyleEpochRef.current;

    if (!needsScore && !needsRestyle) {
      applyHexOverlays(map, overlayState(s));
      return;
    }

    if (!needsScore && needsRestyle && lastResultRef.current) {
      const t0 = performance.now();
      const buffers = lastResultRef.current;
      const run = () => applyBuffers.current(map, buffers, t0);
      if (map.isStyleLoaded()) run();
      else map.once('load', run);
      return;
    }

    if (debounceRef.current) clearTimeout(debounceRef.current);
    const seq = ++requestIdRef.current;
    debounceRef.current = setTimeout(() => {
      const worker = workerRef.current;
      if (!worker) return;
      const latest = stateRef.current;
      const latestView = latest.paintMapView ?? latest.mapView;
      const request: HexPaintRequest = {
        requestId: seq,
        ctx: serializeScoringContext(latest.engine.ctx),
        hexes: latest.features.map((f) => (f.properties ?? {}) as PipelinePoint),
        paintMapView: latestView,
      };
      requestStartedRef.current = performance.now();
      worker.postMessage(request);
    }, PAINT_DEBOUNCE_MS);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [
    mapRef,
    state.features,
    state.paintVersion,
    state.paintMapView,
    state.comparison,
    state.chatHex,
    state.cityName,
    state.citySlug,
    state.showHiddenGems,
    styleEpoch,
  ]);
}
