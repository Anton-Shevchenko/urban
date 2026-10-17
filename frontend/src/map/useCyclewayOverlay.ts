import { useEffect, useRef, type RefObject } from 'react';
import type { FeatureCollection } from 'geojson';
import maplibregl from 'maplibre-gl';
import type { GeoJSONSource, Map as MapLibreMap, MapLayerMouseEvent } from 'maplibre-gl';
import { fetchCyclewaysGeojson, fetchCyclewaysStatus, isAbortError } from '../api/client';
import {
  CYCLEWAY_LEGEND,
  CYCLEWAY_SOURCE_ID,
  cyclewayCasingLayerId,
  cyclewayKindLayer,
  cyclewayLineLayerId,
  labelForKind,
} from './cyclewayStyle';
import { firstSymbolLayerId } from './layerConfig';

const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] };
const cache = new Map<string, FeatureCollection>();
const POLL_MS = 1500;
const DEADLINE_MS = 8 * 60_000;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch] || ch
  ));
}

function setKindVisibility(map: MapLibreMap, visible: boolean, enabled: ReadonlySet<string>): void {
  for (const entry of CYCLEWAY_LEGEND) {
    const vis = visible && enabled.has(entry.kind) ? 'visible' : 'none';
    for (const id of [cyclewayCasingLayerId(entry.kind), cyclewayLineLayerId(entry.kind)]) {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', vis);
    }
  }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new DOMException('aborted', 'AbortError'));
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function loadCycleways(slug: string, signal: AbortSignal): Promise<FeatureCollection> {
  const cached = cache.get(slug);
  if (cached) return cached;
  const deadline = Date.now() + DEADLINE_MS;
  for (;;) {
    const fc = await fetchCyclewaysGeojson(slug, { signal });
    if (signal.aborted) throw new DOMException('aborted', 'AbortError');
    if (fc) {
      cache.set(slug, fc);
      return fc;
    }
    if (Date.now() > deadline) return EMPTY;
    try {
      const status = await fetchCyclewaysStatus(slug, { signal });
      if (status.status === 'error') return EMPTY;
      if (status.status === 'ready') continue;
    } catch (err) {
      if (isAbortError(err) || signal.aborted) throw err;
      return EMPTY;
    }
    await delay(POLL_MS, signal);
  }
}

export function useCyclewayOverlay(opts: {
  mapRef: RefObject<MapLibreMap | null>;
  citySlug: string;
  visible: boolean;
  enabledKinds: readonly string[];
  styleEpoch: number;
}): void {
  const { mapRef, citySlug, visible, enabledKinds, styleEpoch } = opts;
  const seqRef = useRef(0);
  const boundRef = useRef(new Set<string>());
  const mapSeenRef = useRef<MapLibreMap | null>(null);
  const popupRef = useRef<maplibregl.Popup | null>(null);
  const enabledRef = useRef(enabledKinds);
  enabledRef.current = enabledKinds;
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (mapSeenRef.current !== map) {
      mapSeenRef.current = map;
      boundRef.current = new Set();
      popupRef.current?.remove();
      popupRef.current = null;
    }

    const showPopup = (event: MapLayerMouseEvent) => {
      const feature = event.features?.[0];
      const props = feature?.properties as { kind?: string; label?: string } | undefined;
      const label = props?.label || labelForKind(props?.kind);
      popupRef.current?.remove();
      popupRef.current = new maplibregl.Popup({
        closeButton: true,
        closeOnClick: true,
        className: 'cycle-popup',
        maxWidth: '280px',
      })
        .setLngLat(event.lngLat)
        .setHTML(`<div class="cycle-popup-label">${escapeHtml(label)}</div>`)
        .addTo(map);
    };

    const ensureLayers = () => {
      if (!map.getSource(CYCLEWAY_SOURCE_ID)) {
        map.addSource(CYCLEWAY_SOURCE_ID, { type: 'geojson', data: EMPTY });
      }
      const before = firstSymbolLayerId(map);
      for (const entry of CYCLEWAY_LEGEND) {
        const casingId = cyclewayCasingLayerId(entry.kind);
        const lineId = cyclewayLineLayerId(entry.kind);
        if (!map.getLayer(casingId)) map.addLayer(cyclewayKindLayer(entry, 'casing'), before);
        if (!map.getLayer(lineId)) map.addLayer(cyclewayKindLayer(entry, 'line'), before);
        if (!boundRef.current.has(lineId)) {
          map.on('click', lineId, showPopup);
          map.on('mouseenter', lineId, () => {
            map.getCanvas().style.cursor = 'pointer';
          });
          map.on('mouseleave', lineId, () => {
            map.getCanvas().style.cursor = '';
          });
          boundRef.current.add(lineId);
        }
      }
    };

    const apply = (fc: FeatureCollection) => {
      const run = () => {
        ensureLayers();
        const source = map.getSource(CYCLEWAY_SOURCE_ID) as GeoJSONSource | undefined;
        source?.setData(fc);
        setKindVisibility(map, visibleRef.current, new Set(enabledRef.current));
      };
      if (map.isStyleLoaded()) run();
      else map.once('load', run);
    };

    if (!visible || !citySlug) {
      if (map.isStyleLoaded() && map.getSource(CYCLEWAY_SOURCE_ID)) {
        setKindVisibility(map, false, new Set(enabledRef.current));
      }
      return;
    }

    const seq = ++seqRef.current;
    const controller = new AbortController();
    void loadCycleways(citySlug, controller.signal)
      .then((fc) => {
        if (seq !== seqRef.current) return;
        apply(fc);
      })
      .catch((err) => {
        if (seq !== seqRef.current || isAbortError(err)) return;
        apply(EMPTY);
      });
    return () => {
      controller.abort();
    };
  }, [mapRef, citySlug, visible, styleEpoch]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded() || !map.getSource(CYCLEWAY_SOURCE_ID)) return;
    setKindVisibility(map, visible, new Set(enabledKinds));
  }, [mapRef, visible, enabledKinds, styleEpoch]);
}
