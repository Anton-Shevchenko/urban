import { useEffect, useMemo, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import type { Map as MapLibreMap, MapLayerMouseEvent, Marker } from 'maplibre-gl';
import type { Feature, FeatureCollection } from 'geojson';
import { CFG } from '../scoring/constants';
import { cssGradient } from '../scoring/color';
import {
  useChat,
  useCityData,
  useCompare,
  useDestinations,
  useMapViewState,
  usePaint,
} from '../wohnindex';
import type { HexPaintSnapshot } from '../wohnindex/types';
import { HexTooltip } from './HexTooltip';
import { buildHexTooltipModel, type HexTooltipModel } from './hexTooltipModel';
import { LAYER_ID } from './layerConfig';
import { useHexPaint } from './useHexPaint';

type Props = {
  mapStyleUrl: string;
};

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

  const onHexMove = useRef((e: MapLayerMouseEvent) => {
    const s = snapshotRef.current;
    const model = buildHexTooltipModel(
      e,
      s.engine,
      s.paintMapView ?? s.mapView,
      s.showHiddenGems,
    );
    if (model) setTooltip(model);
  });

  const onHexClick = useRef((e: MapLayerMouseEvent) => {
    if (destRef.current.pickDestinationMode) return;
    const f = e.features?.[0] as Feature | undefined;
    if (!f) return;
    const shift = Boolean((e.originalEvent as MouseEvent | undefined)?.shiftKey);
    if (shift) {
      compareRef.current.toggleCompare(f);
      return;
    }
    chatRef.current.selectChatHex(f);
  });

  const bindLayerEvents = useRef((map: MapLibreMap) => {
    if (layerEventsBoundRef.current) return;
    map.on('mousemove', LAYER_ID, onHexMove.current);
    map.on('mouseleave', LAYER_ID, () => setTooltip(null));
    map.on('mouseenter', LAYER_ID, () => {
      map.getCanvas().style.cursor = 'pointer';
    });
    map.on('click', LAYER_ID, onHexClick.current);
    layerEventsBoundRef.current = true;
  });

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: mapStyleUrl,
      center: CFG.center,
      zoom: CFG.zoom,
      attributionControl: false,
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    mapRef.current = map;
    styleUrlRef.current = mapStyleUrl;
    layerEventsBoundRef.current = false;

    map.on('click', (e) => {
      if (destRef.current.pickDestinationMode) {
        destRef.current.addDestination(e.lngLat.lat, e.lngLat.lng);
      }
    });

    return () => {
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
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
  }, [city.citySlug]);

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

  useEffect(() => {
    const bar = document.getElementById('legend-bar');
    if (bar) bar.style.background = cssGradient();
  }, []);

  return (
    <>
      <div id="map" ref={containerRef} />
      {tooltip ? <HexTooltip model={tooltip} /> : null}
    </>
  );
}
