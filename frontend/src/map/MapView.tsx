import { useEffect, useMemo, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import type { Map as MapLibreMap, MapLayerMouseEvent, MapMouseEvent, Marker } from 'maplibre-gl';
import type { FeatureCollection } from 'geojson';
import { CFG } from '../scoring/constants';
import {
  useChat,
  useCityData,
  useCompare,
  useDestinations,
  useMapViewState,
  usePaint,
} from '../wohnindex';
import type { HexPaintSnapshot } from '../wohnindex/types';
import { CyclewayLegend } from './CyclewayLegend';
import { CYCLEWAY_LEGEND } from './cyclewayStyle';
import { HexTooltip } from './HexTooltip';
import { buildHexTooltipModel, type HexTooltipModel } from './hexTooltipModel';
import { LAYER_ID } from './layerConfig';
import { MapSearch } from './MapSearch';
import { queryHexAtPoint, resolveQueriedHex } from './queryHex';
import { useCyclewayOverlay } from './useCyclewayOverlay';
import { useCyclewaySearch } from './useCyclewaySearch';
import { useHexPaint } from './useHexPaint';

type Props = {
  mapStyleUrl: string;
};

// Module-level so Vite HMR re-evaluates it and the map is recreated instead of
// keeping a MapLibre instance that still has Shift-gated click / box-zoom.
const MAP_GENERATION = Date.now();

export function MapView({ mapStyleUrl }: Props) {
  const city = useCityData();
  const dest = useDestinations();
  const compare = useCompare();
  const mapView = useMapViewState();
  const chat = useChat();
  const paint = usePaint();

  const snapshot: HexPaintSnapshot = useMemo(() => ({
    features: city.features,
    engine: paint.engine,
    paintMapView: mapView.paintMapView,
    mapView: mapView.mapView,
    paintVersion: paint.paintVersion,
    comparison: compare.comparison,
    chatHex: chat.chatHex,
    cityName: city.cityName,
    citySlug: city.citySlug,
    showHiddenGems: mapView.showHiddenGems,
    setPainting: paint.setPainting,
    onPaintComplete: paint.onPaintComplete,
  }), [
    city.features,
    city.cityName,
    city.citySlug,
    paint.engine,
    paint.paintVersion,
    paint.setPainting,
    paint.onPaintComplete,
    mapView.paintMapView,
    mapView.mapView,
    mapView.showHiddenGems,
    compare.comparison,
    chat.chatHex,
  ]);

  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const centerMarkers = useRef<Marker[]>([]);
  const destMarkers = useRef<Marker[]>([]);
  const liveFcRef = useRef<FeatureCollection | null>(null);
  const cityKeyRef = useRef<string>('');
  const styleUrlRef = useRef(mapStyleUrl);
  const layerEventsBoundRef = useRef(false);
  const [styleEpoch, setStyleEpoch] = useState(0);
  const [tooltip, setTooltip] = useState<HexTooltipModel | null>(null);
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const destRef = useRef(dest);
  destRef.current = dest;
  const compareRef = useRef(compare);
  compareRef.current = compare;
  const chatRef = useRef(chat);
  chatRef.current = chat;

  const cyclewaysVisible = mapView.mapView === 'cycleways';
  const cyclewaySearch = useCyclewaySearch(mapView.setMapView);
  const [enabledKinds, setEnabledKinds] = useState(() => CYCLEWAY_LEGEND.map((entry) => entry.kind));
  const cycleLockRef = useRef(false);
  const mapViewRef = useRef(mapView.mapView);
  mapViewRef.current = mapView.mapView;
  const layerSlug = cyclewaySearch.holding
    ? ''
    : (cyclewaySearch.slug ?? (cyclewaysVisible ? city.citySlug : ''));

  const onHexMove = useRef<(e: MapLayerMouseEvent) => void>(() => {});
  onHexMove.current = (e) => {
    const s = snapshotRef.current;
    if (mapViewRef.current === 'cycleways' || (s.paintMapView ?? s.mapView) === 'cycleways') {
      setTooltip(null);
      return;
    }
    const model = buildHexTooltipModel(
      e,
      s.engine,
      s.paintMapView ?? s.mapView,
      s.showHiddenGems,
    );
    if (model) setTooltip(model);
  };

  const onHexClick = useRef<(e: MapMouseEvent) => void>(() => {});
  onHexClick.current = (e) => {
    if (destRef.current.pickDestinationMode) return;
    if (mapViewRef.current === 'cycleways') return;
    const hit = queryHexAtPoint(e.target, e.point);
    const f = resolveQueriedHex(hit, snapshotRef.current.features);
    if (!f) return;
    const s = snapshotRef.current;
    const loc = s.engine.locationScore?.(f.properties as never);
    compareRef.current.addCompare(f, {
      citySlug: s.citySlug,
      cityName: s.cityName,
      cityPercentile: loc?.cityPercentile ?? null,
    });
    chatRef.current.selectChatHex(f);
  };

  const bindLayerEvents = useRef((map: MapLibreMap) => {
    if (layerEventsBoundRef.current) return;
    map.on('mousemove', LAYER_ID, (e) => onHexMove.current(e));
    map.on('mouseleave', LAYER_ID, () => setTooltip(null));
    map.on('mouseenter', LAYER_ID, () => {
      map.getCanvas().style.cursor = 'pointer';
    });
    layerEventsBoundRef.current = true;
  });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return undefined;

    const map = new maplibregl.Map({
      container: el,
      style: mapStyleUrl,
      center: CFG.center,
      zoom: CFG.zoom,
      attributionControl: false,
      boxZoom: false,
      dragRotate: false,
      pitchWithRotate: false,
      clickTolerance: 12,
    });
    map.boxZoom.disable();
    map.dragRotate.disable();
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    map.on('click', (e: MapMouseEvent) => {
      if (destRef.current.pickDestinationMode) {
        destRef.current.addDestination(e.lngLat.lat, e.lngLat.lng);
        return;
      }
      onHexClick.current(e);
    });
    map.once('load', () => setStyleEpoch((n) => n + 1));
    mapRef.current = map;
    styleUrlRef.current = mapStyleUrl;
    layerEventsBoundRef.current = false;

    return () => {
      map.remove();
      if (mapRef.current === map) mapRef.current = null;
    };
    // MAP_GENERATION is a module constant: Vite HMR re-runs this module and
    // recreates the map so leftover Shift+click handlers cannot stick around.
    // Style URL changes go through setStyle below, not a full remap.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [MAP_GENERATION]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || mapStyleUrl === styleUrlRef.current) return;
    styleUrlRef.current = mapStyleUrl;
    layerEventsBoundRef.current = false;
    setTooltip(null);
    map.setStyle(mapStyleUrl);
    const onStyle = () => {
      setStyleEpoch((n) => n + 1);
      snapshotRef.current.setPainting(true);
    };
    map.once('style.load', onStyle);
    return () => {
      map.off('style.load', onStyle);
    };
  }, [mapStyleUrl]);

  useEffect(() => {
    const firstId =
      (city.features[0]?.properties as Record<string, unknown> | undefined)?.h3 ??
      (city.features[0]?.id ?? '');
    const key = `${city.citySlug}:${city.features.length}:${String(firstId)}`;
    if (key !== cityKeyRef.current || !liveFcRef.current) {
      cityKeyRef.current = key;
      liveFcRef.current = {
        type: 'FeatureCollection',
        features: city.features.map((f) => ({
          type: 'Feature',
          geometry: f.geometry,
          properties: { ...(f.properties as Record<string, unknown>) },
        })),
      };
    }
  }, [city.citySlug, city.features]);

  useHexPaint({
    mapRef,
    liveFcRef,
    state: snapshot,
    styleEpoch,
    onLayersCreated: (map) => bindLayerEvents.current(map),
  });

  useCyclewayOverlay({
    mapRef,
    citySlug: layerSlug,
    visible: cyclewaysVisible,
    enabledKinds,
    styleEpoch,
  });

  useEffect(() => {
    cycleLockRef.current = false;
  }, [city.citySlug]);

  useEffect(() => {
    const map = mapRef.current;
    const bbox = cyclewaySearch.bbox;
    if (!map || !bbox) return;
    cycleLockRef.current = true;
    const [south, west, north, east] = bbox;
    const run = () => {
      map.fitBounds(
        [
          [west, south],
          [east, north],
        ],
        { padding: 48, duration: 700 },
      );
    };
    if (map.isStyleLoaded()) run();
    else map.once('load', run);
  }, [cyclewaySearch.bbox, styleEpoch]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || city.loading) return;
    if (cycleLockRef.current) return;
    if (compare.pendingFocus?.citySlug === city.citySlug) return;
    const bbox = city.meta.bbox;
    if (Array.isArray(bbox) && bbox.length === 4) {
      const [south, west, north, east] = bbox;
      map.fitBounds(
        [
          [west, south],
          [east, north],
        ],
        { padding: 40, duration: 800 },
      );
    } else if (city.meta.center) {
      map.flyTo({ center: [city.meta.center[1], city.meta.center[0]], zoom: CFG.zoom });
    }
  }, [city.citySlug, city.loading, city.meta.bbox, city.meta.center, compare.pendingFocus]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || city.loading || city.features.length === 0) return;
    const focus = compare.pendingFocus;
    if (!focus || focus.citySlug !== city.citySlug) return;
    if (focus.lng != null && focus.lat != null) {
      map.flyTo({ center: [focus.lng, focus.lat], zoom: 14, duration: 900 });
    }
    compare.clearFocus();
  }, [city.citySlug, city.loading, city.features.length, compare.pendingFocus, compare.clearFocus]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    centerMarkers.current.forEach((m) => m.remove());
    centerMarkers.current = [];
    (city.meta.center_anchors || []).forEach((a) => {
      if (typeof a.lat !== 'number') return;
      const el = document.createElement('div');
      el.className =
        'center-marker is-anchor' + (a.id === 'marienplatz' || a.weight === 1 ? ' is-main' : '');
      el.title = a.label || a.id || '';
      centerMarkers.current.push(
        new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat([a.lng, a.lat]).addTo(map),
      );
    });
    (city.meta.centers || []).forEach((c) => {
      if (typeof c.lat !== 'number') return;
      const el = document.createElement('div');
      el.className = 'center-marker' + (c.primary ? ' is-main' : '');
      centerMarkers.current.push(
        new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat([c.lng, c.lat]).addTo(map),
      );
    });
  }, [city.meta.center_anchors, city.meta.centers]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    destMarkers.current.forEach((m) => m.remove());
    destMarkers.current = [];
    dest.destinations.forEach((d, i) => {
      const el = document.createElement('div');
      el.className = 'dest-marker';
      el.textContent = String(i + 1);
      destMarkers.current.push(
        new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat([d.lng, d.lat]).addTo(map),
      );
    });
  }, [dest.destinations]);

  const toggleKind = (kind: string) => {
    setEnabledKinds((prev) => (
      prev.includes(kind) ? prev.filter((item) => item !== kind) : [...prev, kind]
    ));
  };

  return (
    <>
      <div id="map" ref={containerRef} />
      <MapSearch
        busy={cyclewaySearch.busy}
        status={cyclewaySearch.statusText}
        error={cyclewaySearch.error}
        onSelect={cyclewaySearch.openCity}
      />
      {cyclewaysVisible ? (
        <CyclewayLegend enabled={enabledKinds} onToggle={toggleKind} />
      ) : null}
      {tooltip ? <HexTooltip model={tooltip} /> : null}
    </>
  );
}
