import { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import type { Map as MapLibreMap, MapLayerMouseEvent, Marker } from 'maplibre-gl';
import type { Feature, FeatureCollection } from 'geojson';
import { CFG, NO_CRITERIA_COLOR } from '../scoring/constants';
import { maplibreStops, cssGradient } from '../scoring/color';
import { FACTOR_LABELS } from '../scoring/engine';
import { explainLivingScore, pillarBreakdownRows } from '../scoring/explain';
import { formatVoiTooltipHtml } from '../scoring/valueOpportunity';
import type { WohnIndexState } from '../hooks/useWohnIndex';

const LAYER_ID = 'hexes-fill';
const LINE_ID = 'hexes-line';
const VOI_LINE_ID = 'hexes-voi';
const SELECT_ID = 'hexes-selected';
const PAINT_DEBOUNCE_MS = 0;

type Props = {
  state: WohnIndexState;
  mapStyleUrl: string;
};

function firstSymbolLayerId(map: MapLibreMap) {
  const sym = (map.getStyle().layers || []).find((l) => l.type === 'symbol');
  return sym ? sym.id : undefined;
}

export function MapView({ state, mapStyleUrl }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const centerMarkers = useRef<Marker[]>([]);
  const destMarkers = useRef<Marker[]>([]);
  /** Stable FeatureCollection — mutate only live score props on paint. */
  const liveFcRef = useRef<FeatureCollection | null>(null);
  const cityKeyRef = useRef<string>('');
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const paintSeqRef = useRef(0);
  const styleUrlRef = useRef(mapStyleUrl);
  const layerEventsBoundRef = useRef(false);
  const [styleEpoch, setStyleEpoch] = useState(0);
  const [tooltip, setTooltip] = useState<{
    x: number;
    y: number;
    html: string;
  } | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  const onHexMove = useRef((e: MapLayerMouseEvent) => {
    const s = stateRef.current;
    const f = e.features?.[0];
    if (!f) return;
    const p = f.properties as Record<string, unknown>;
    const weights = s.engine.getPillarWeights?.();
    const focus =
      (s.engine as { getAffordabilityFocus?: () => number }).getAffordabilityFocus?.() ?? 0;
    const loc = s.engine.locationScore
      ? s.engine.locationScore(p)
      : s.engine.livingScore(p);
    const explained = explainLivingScore(p, weights, focus);
    const modeRaw = String(s.engine.getMapMetricMode?.() ?? s.paintMapView ?? s.mapView ?? 'objective');
    const modeLabel =
      modeRaw === 'objective' || modeRaw === 'comfort' || modeRaw === 'living'
        ? 'Living Score'
        : modeRaw === 'personal_match'
          ? 'Your Match'
          : modeRaw === 'city_percentile'
            ? 'City percentile'
            : (FACTOR_LABELS[modeRaw.replace(/^pillar:/, '')] || modeRaw);

    if (loc.objectiveScore == null && (modeRaw === 'objective' || modeRaw === 'comfort' || modeRaw === 'living')) {
      setTooltip({
        x: e.point.x + 14,
        y: e.point.y + 14,
        html:
          `<div class="tt-score"><div class="tt-pass"><b>Insufficient data</b></div>`
          + `<div class="tt-fail-msg">Data confidence: ${Math.round((loc.confidence ?? 0) * 100)}%`
          + (loc.missingData?.length ? ` · missing: ${loc.missingData.slice(0, 4).join(', ')}` : '')
          + `</div></div>`,
      });
      return;
    }

    const rows = pillarBreakdownRows(explained.pillars)
      .map((row) => {
        const bar = '█'.repeat(Math.round(row.score / 10)) + '░'.repeat(10 - Math.round(row.score / 10));
        return `<tr><td>${row.label}</td><td class="tt-bar">${bar}</td><td>${row.score}</td></tr>`;
      })
      .join('');
    const obj = loc.objectiveScore != null ? Math.round(loc.objectiveScore) : '—';
    const match = loc.personalMatchScore != null ? Math.round(loc.personalMatchScore) : '—';
    const pct = loc.cityPercentile != null ? Math.round(loc.cityPercentile) : '—';
    const conf = Math.round((loc.confidence ?? 0) * 100);
    const statusLine =
      `<div class="tt-pass"><b>${obj}/100</b> Living Score · mode: ${modeLabel}</div>`
      + `<div class="tt-fail-msg">Your Match: ${match}/100 · City percentile: ${pct} · Data confidence: ${conf}%</div>`
      + `<div class="tt-fail-msg">${explained.text}</div>`;
    const voiHtml = s.showHiddenGems ? (formatVoiTooltipHtml(p) || '') : '';
    setTooltip({
      x: e.point.x + 14,
      y: e.point.y + 14,
      html:
        `<div class="tt-score">${voiHtml}${statusLine}</div>` +
        `<table class="tt-breakdown"><thead><tr><td>Metrik</td><td></td><td></td></tr></thead><tbody>${rows}</tbody></table>`,
    });
  });

  const onHexClick = useRef((e: MapLayerMouseEvent) => {
    const s = stateRef.current;
    if (s.pickDestinationMode) return;
    const f = e.features?.[0] as Feature | undefined;
    if (f) s.toggleCompare(f);
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
      const s = stateRef.current;
      if (s.pickDestinationMode) {
        s.addDestination(e.lngLat.lat, e.lngLat.lng);
      }
    });

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      map.remove();
      mapRef.current = null;
    };
    // Initial style only — theme switches handled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Swap basemap when theme changes; hex layers are re-attached via styleEpoch paint.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || mapStyleUrl === styleUrlRef.current) return;
    styleUrlRef.current = mapStyleUrl;
    layerEventsBoundRef.current = false;
    setTooltip(null);
    map.setStyle(mapStyleUrl);
    const onStyle = () => {
      setStyleEpoch((n) => n + 1);
      stateRef.current.setPainting(true);
    };
    map.once('style.load', onStyle);
    return () => {
      map.off('style.load', onStyle);
    };
  }, [mapStyleUrl]);

  // Rebuild live FC when city features identity changes
  useEffect(() => {
    const firstId =
      (state.features[0]?.properties as Record<string, unknown> | undefined)?.h3 ??
      (state.features[0]?.id ?? '');
    const key = `${state.citySlug}:${state.features.length}:${String(firstId)}`;
    if (key !== cityKeyRef.current || !liveFcRef.current) {
      cityKeyRef.current = key;
      liveFcRef.current = {
        type: 'FeatureCollection',
        features: state.features.map((f) => ({
          type: 'Feature',
          geometry: f.geometry,
          properties: { ...(f.properties as Record<string, unknown>) },
        })),
      };
    }
  }, [state.citySlug, state.features]);

  // Debounced paint: mutate live scores in place, then setData once
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !state.features.length) return;

    const seq = ++paintSeqRef.current;

    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      const run = () => {
        if (seq !== paintSeqRef.current) return;
        const s = stateRef.current;
        const engine = s.engine;
        const paintMapView = s.paintMapView ?? s.mapView;
        const t0 = performance.now();
        let finished = false;
        const finishEarly = () => {
          if (finished) return;
          finished = true;
          s.setPainting(false);
        };

        let fc = liveFcRef.current;
        if (!fc || fc.features.length !== s.features.length) {
          fc = {
            type: 'FeatureCollection',
            features: s.features.map((f) => ({
              type: 'Feature',
              geometry: f.geometry,
              properties: { ...(f.properties as Record<string, unknown>) },
            })),
          };
          liveFcRef.current = fc;
        }

        const isPrimaryPaint = !paintMapView
          || paintMapView === 'comfort'
          || paintMapView === 'living'
          || paintMapView === 'objective'
          || paintMapView === 'personal_match'
          || paintMapView === 'city_percentile';

        try {
        for (let i = 0; i < fc.features.length; i++) {
          const props = fc.features[i].properties as Record<string, unknown>;
          // Score against source feature props (full pipeline fields).
          const src = (s.features[i]?.properties ?? props) as Record<string, unknown>;
          let c: number | null;
          if (!isPrimaryPaint) {
            const pillarKey = paintMapView === 'housing_value' ? 'housing_affordability' : paintMapView;
            c = engine.factorScalar(pillarKey, src);
          } else {
            c = engine.comfortScalar(src);
          }
          // Budget dimming already applied in comfortScalar.
          props._hex_passed = c == null ? 0 : 1;
          props.data_quality = src.data_quality;
          const voiLevel = Number(src.voi_highlight);
          if (voiLevel === 1 || voiLevel === 2 || voiLevel === 3) {
            props._voi_level = voiLevel;
            props._voi_on = 1;
          } else if (src.voi_class === 'hidden_gem') {
            props._voi_level = 2;
            props._voi_on = 1;
          } else if (src.voi_class === 'good_value') {
            props._voi_level = 1;
            props._voi_on = 1;
          } else if (src.voi_class === 'overpriced') {
            props._voi_level = 3;
            props._voi_on = 1;
          } else {
            props._voi_level = 0;
            props._voi_on = 0;
          }
          const strength = Number(src.voi_gem_strength);
          if (props._voi_level === 3) {
            props._voi_width = 2.4;
          } else if (props._voi_on === 1 && Number.isFinite(strength)) {
            props._voi_width = strength >= 90 ? 3.6 : strength >= 80 ? 2.6 : strength >= 70 ? 1.8 : 1.3;
          } else if (props._voi_level === 2) {
            props._voi_width = 3.2;
          } else if (props._voi_level === 1) {
            props._voi_width = 1.4;
          } else {
            props._voi_width = 0;
          }
          if (c != null && Number.isFinite(c)) {
            const abs = Math.round(c * 10) / 10;
            props._comfort_abs = abs;
            props._comfort_live = abs;
          } else {
            delete props._comfort_live;
            delete props._comfort_abs;
          }
        }

        const lo = 0;
        const hi = 100;

        const activeKeys = engine.activeCriterionKeys();
        const passingCount = engine.getPassingCount();

        let fillColor: unknown = NO_CRITERIA_COLOR;
        if (activeKeys.length || isPrimaryPaint || (paintMapView && paintMapView !== 'comfort')) {
          fillColor = [
            'case',
            ['==', ['typeof', ['get', '_comfort_live']], 'number'],
            [
              'interpolate',
              ['linear'],
              ['get', '_comfort_live'],
              ...maplibreStops(lo, hi),
            ],
            NO_CRITERIA_COLOR,
          ];
        }

        const fillOpacity =
          passingCount > 0 && isPrimaryPaint
            ? [
                'case',
                ['==', ['get', '_hex_passed'], 1],
                [
                  'case',
                  ['==', ['get', 'data_quality'], 'high'],
                  0.9,
                  ['==', ['get', 'data_quality'], 'mixed'],
                  0.77,
                  0.64,
                ],
                [
                  'case',
                  ['==', ['get', 'data_quality'], 'high'],
                  0.66,
                  ['==', ['get', 'data_quality'], 'mixed'],
                  0.55,
                  0.44,
                ],
              ]
            : [
                'case',
                ['==', ['get', 'data_quality'], 'high'],
                0.78,
                ['==', ['get', 'data_quality'], 'mixed'],
                0.65,
                0.52,
              ];

        const finish = () => {
          if (seq !== paintSeqRef.current) return;
          if ((finish as { done?: boolean }).done) return;
          (finish as { done?: boolean }).done = true;
          finished = true;
          const ms = Math.round(performance.now() - t0);
          s.onPaintComplete({
            ms,
            lo,
            hi,
            passingCount,
            hexCount: fc!.features.length,
          });
          s.setPainting(false);
        };

        if (!map.getSource('hexes')) {
          map.addSource('hexes', { type: 'geojson', data: fc });
          const before = firstSymbolLayerId(map);
          map.addLayer(
            {
              id: LAYER_ID,
              type: 'fill',
              source: 'hexes',
              paint: { 'fill-color': fillColor as never, 'fill-opacity': fillOpacity as never },
            },
            before,
          );
          map.addLayer(
            {
              id: LINE_ID,
              type: 'line',
              source: 'hexes',
              paint: { 'line-color': 'rgba(255,255,255,0.35)', 'line-width': 0.4 },
            },
            before,
          );
          map.addLayer(
            {
              id: VOI_LINE_ID,
              type: 'line',
              source: 'hexes',
              filter: ['==', ['get', '_voi_on'], 1],
              paint: {
                'line-color': [
                  'match',
                  ['coalesce', ['get', '_voi_level'], 0],
                  3, '#c0392b',
                  1, '#3da86a',
                  '#1b8a4a',
                ],
                'line-opacity': 0.95,
                'line-width': ['coalesce', ['get', '_voi_width'], 1.4],
              },
              layout: { visibility: 'none' },
            },
            before,
          );
          map.addLayer(
            {
              id: SELECT_ID,
              type: 'line',
              source: 'hexes',
              filter: ['in', ['get', 'h3'], ['literal', []]],
              paint: { 'line-color': '#1c2330', 'line-width': 3, 'line-opacity': 0.95 },
            },
            before,
          );

          if (!layerEventsBoundRef.current) {
            map.on('mousemove', LAYER_ID, onHexMove.current);
            map.on('mouseleave', LAYER_ID, () => setTooltip(null));
            map.on('mouseenter', LAYER_ID, () => {
              map.getCanvas().style.cursor = 'pointer';
            });
            map.on('click', LAYER_ID, onHexClick.current);
            layerEventsBoundRef.current = true;
          }
        } else {
          // New FC wrapper so MapLibre always reprocesses mutated properties.
          (map.getSource('hexes') as maplibregl.GeoJSONSource).setData({
            type: 'FeatureCollection',
            features: fc.features,
          });
          map.setPaintProperty(LAYER_ID, 'fill-color', fillColor as never);
          map.setPaintProperty(LAYER_ID, 'fill-opacity', fillOpacity as never);
        }

        if (map.getLayer(VOI_LINE_ID)) {
          map.setLayoutProperty(
            VOI_LINE_ID,
            'visibility',
            s.showHiddenGems ? 'visible' : 'none',
          );
        }

        const selected = s.comparison
          .filter((i) => i.cityName === s.cityName)
          .map((i) => i.h3);
        if (map.getLayer(SELECT_ID)) {
          map.setFilter(SELECT_ID, ['in', ['get', 'h3'], ['literal', selected]]);
        }

        // Clear loader promptly — idle can stall on large GeoJSON uploads.
        const onIdle = () => {
          map.off('idle', onIdle);
          finish();
        };
        map.once('idle', onIdle);
        setTimeout(() => {
          map.off('idle', onIdle);
          finish();
        }, 600);
        } catch (err) {
          console.error('[map paint]', err);
          finishEarly();
        }
      };

      if (map.isStyleLoaded()) run();
      else map.once('load', run);
    }, PAINT_DEBOUNCE_MS);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [
    state.features,
    state.paintVersion,
    state.paintMapView,
    state.comparison,
    state.cityName,
    state.showHiddenGems,
    styleEpoch,
  ]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const bbox = state.meta.bbox;
    if (Array.isArray(bbox) && bbox.length === 4) {
      const [south, west, north, east] = bbox;
      map.fitBounds(
        [
          [west, south],
          [east, north],
        ],
        { padding: 40, duration: 800 },
      );
    } else if (state.meta.center) {
      map.flyTo({ center: [state.meta.center[1], state.meta.center[0]], zoom: CFG.zoom });
    }
  }, [state.citySlug]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    centerMarkers.current.forEach((m) => m.remove());
    centerMarkers.current = [];
    (state.meta.center_anchors || []).forEach((a) => {
      if (typeof a.lat !== 'number') return;
      const el = document.createElement('div');
      el.className =
        'center-marker is-anchor' + (a.id === 'marienplatz' || a.weight === 1 ? ' is-main' : '');
      el.title = a.label || a.id || '';
      centerMarkers.current.push(
        new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat([a.lng, a.lat]).addTo(map),
      );
    });
    (state.meta.centers || []).forEach((c) => {
      if (typeof c.lat !== 'number') return;
      const el = document.createElement('div');
      el.className = 'center-marker' + (c.primary ? ' is-main' : '');
      centerMarkers.current.push(
        new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat([c.lng, c.lat]).addTo(map),
      );
    });
  }, [state.meta.center_anchors, state.meta.centers]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    destMarkers.current.forEach((m) => m.remove());
    destMarkers.current = [];
    state.destinations.forEach((d, i) => {
      const el = document.createElement('div');
      el.className = 'dest-marker';
      el.textContent = String(i + 1);
      destMarkers.current.push(
        new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat([d.lng, d.lat]).addTo(map),
      );
    });
  }, [state.destinations]);

  useEffect(() => {
    const bar = document.getElementById('legend-bar');
    if (bar) bar.style.background = cssGradient();
  }, []);

  return (
    <>
      <div id="map" ref={containerRef} />
      {tooltip && (
        <div
          id="tooltip"
          className="tooltip"
          style={{ left: tooltip.x, top: tooltip.y }}
          dangerouslySetInnerHTML={{ __html: tooltip.html }}
        />
      )}
    </>
  );
}
