import { useEffect, useRef, type RefObject } from 'react';
import type { FeatureCollection } from 'geojson';
import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl';
import { fetchCyclewaysGeojson } from '../api/client';
import { isStreetOverlayView } from '../scoring/hexPaint';
import {
  CYCLEWAY_CASING_ID,
  CYCLEWAY_LAYER_ID,
  CYCLEWAY_SOURCE_ID,
  cyclewayCasingLayer,
  cyclewayLineLayer,
  firstSymbolLayerId,
} from './layerConfig';

const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] };
const cache = new Map<string, FeatureCollection>();

function setCyclewayVisibility(map: MapLibreMap, visible: boolean): void {
  const vis = visible ? 'visible' : 'none';
  if (map.getLayer(CYCLEWAY_CASING_ID)) {
    map.setLayoutProperty(CYCLEWAY_CASING_ID, 'visibility', vis);
  }
  if (map.getLayer(CYCLEWAY_LAYER_ID)) {
    map.setLayoutProperty(CYCLEWAY_LAYER_ID, 'visibility', vis);
  }
}

function applyCyclewayData(map: MapLibreMap, fc: FeatureCollection): void {
  const before = firstSymbolLayerId(map);
  if (!map.getSource(CYCLEWAY_SOURCE_ID)) {
    map.addSource(CYCLEWAY_SOURCE_ID, { type: 'geojson', data: fc });
  } else {
    (map.getSource(CYCLEWAY_SOURCE_ID) as GeoJSONSource).setData(fc);
  }
  if (!map.getLayer(CYCLEWAY_CASING_ID)) {
    map.addLayer(cyclewayCasingLayer(), before);
  }
  if (!map.getLayer(CYCLEWAY_LAYER_ID)) {
    map.addLayer(cyclewayLineLayer(), before);
  }
}

export function useCyclewayOverlay(opts: {
  mapRef: RefObject<MapLibreMap | null>;
  citySlug: string;
  paintMapView: string;
  styleEpoch: number;
}): void {
  const { mapRef, citySlug, paintMapView, styleEpoch } = opts;
  const seqRef = useRef(0);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !citySlug) return;
    const on = isStreetOverlayView(paintMapView);
    if (!on) {
      setCyclewayVisibility(map, false);
      return;
    }

    const seq = ++seqRef.current;
    const apply = (fc: FeatureCollection) => {
      if (seq !== seqRef.current) return;
      const current = mapRef.current;
      if (!current) return;
      const run = () => {
        applyCyclewayData(current, fc);
        setCyclewayVisibility(current, true);
      };
      if (current.isStyleLoaded()) run();
      else current.once('load', run);
    };

    const cached = cache.get(citySlug);
    if (cached) {
      apply(cached);
      return;
    }

    let cancelled = false;
    void fetchCyclewaysGeojson(citySlug)
      .then((fc) => {
        if (cancelled) return;
        if (fc.features.length > 0) cache.set(citySlug, fc);
        apply(fc);
      })
      .catch(() => {
        if (!cancelled) apply(EMPTY);
      });
    return () => {
      cancelled = true;
    };
  }, [mapRef, citySlug, paintMapView, styleEpoch]);
}
