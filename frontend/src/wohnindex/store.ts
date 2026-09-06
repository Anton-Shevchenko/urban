import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Feature, FeatureCollection } from 'geojson';
import {
  createContextFromFeatures,
  createScoringEngine,
  IMPORTANCE_KEYS,
  LIVING_WEIGHTS,
  PILLAR_KEYS,
  PREF_KEYS,
  PRESETS,
  DEFAULT_SIZE_M2,
  DAILY_NEED_CATS,
  FACTOR_LABELS,
  SCORE_PROPS,
  MAP_VIEW_METRICS,
} from '../scoring/engine';
import {
  DEFAULT_MATCH_PREFS,
  normalizeMatchPrefs,
  type MatchPrefs,
} from '../scoring/match';
import type { ScoringContext, ScoringEngine, ScoringMode } from '../scoring/types';
import { CFG, PRESET_USES_PREFS, STORAGE } from '../scoring/constants';
import { summarizeScores, type ScoreDistribution } from '../scoring/histogram';
import { ensureApiBase, fetchDestMatrix, isAbortError } from '../api/client';
import { loadOrGenerateCity } from '../api/city';
import {
  buildMapViewOptions,
  detectExtendedMetrics,
  detectHasRent,
  factorScoreSpread,
  loadJson,
  normalizeLegacyProps,
  readDebugFlag,
} from './helpers';
import { snapshotHexProps } from './compareSnapshot';
import type {
  ChatHex,
  CityMeta,
  Destination,
  PaintStats,
  UseWohnIndexOptions,
} from './types';

/** Wait after last slider tick before scoring + map paint + loader. */
const SLIDER_COMMIT_MS = 320;

export function useWohnIndexStore(options: UseWohnIndexOptions = {}) {
  const { routeSlug = null, onCityReady } = options;
  const onCityReadyRef = useRef(onCityReady);
  onCityReadyRef.current = onCityReady;
  const routeSlugRef = useRef(routeSlug);
  routeSlugRef.current = routeSlug;

  const [loading, setLoading] = useState(true);
  const [painting, setPainting] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [features, setFeatures] = useState<Feature[]>([]);
  const [meta, setMeta] = useState<CityMeta>({});
  const [cityName, setCityName] = useState('München');
  const [citySlug, setCitySlug] = useState('muenchen');
  const [hasRent, setHasRent] = useState(true);
  const [hasExtendedMetrics, setHasExtendedMetrics] = useState(true);
  const [heatHasVariation, setHeatHasVariation] = useState(true);
  const [noiseHasVariation, setNoiseHasVariation] = useState(true);
  const [weights, setWeightsState] = useState<Record<string, number>>({});
  const [prefTargets, setPrefTargetsState] = useState({
    urban_activity: 50,
    density: 50,
    housing: 30,
  });
  const [prefInclude, setPrefIncludeState] = useState(false);
  const [dailyNeedsCategories, setDailyNeedsCategoriesState] = useState<Record<string, boolean>>(
    () => {
      const loaded = loadJson<Record<string, boolean>>(STORAGE.dailyNeeds, {});
      const out: Record<string, boolean> = {};
      DAILY_NEED_CATS.forEach((cat: string) => {
        out[cat] = loaded[cat] !== false;
      });
      return out;
    },
  );
  const [desiredAreaM2, setDesiredAreaM2State] = useState(() => {
    const v = Number(localStorage.getItem(STORAGE.area));
    return Number.isFinite(v) && v > 0 ? v : DEFAULT_SIZE_M2;
  });
  const [maxMonthlyBudget, setMaxMonthlyBudgetState] = useState<number | null>(() => {
    const v = Number(localStorage.getItem(STORAGE.budget));
    return Number.isFinite(v) && v > 0 ? v : null;
  });
  const [destinations, setDestinations] = useState<Destination[]>(() =>
    loadJson(STORAGE.dest, []),
  );
  const [customDestMatrix, setCustomDestMatrix] = useState<Record<string, Record<string, number>>>(
    {},
  );
  const [chatHex, setChatHex] = useState<ChatHex | null>(null);
  const [chatOpen, setChatOpen] = useState(true);
  const [mapView, setMapViewState] = useState(() => {
    try {
      const v = localStorage.getItem(STORAGE.mapView);
      if (v === 'objective' || v === 'personal_match' || v === 'city_percentile') return v;
      if (v && MAP_VIEW_METRICS.includes(v)) return v;
    } catch { /* */ }
    return 'objective';
  });
  const [showHiddenGems, setShowHiddenGemsState] = useState(() => {
    try {
      return localStorage.getItem(STORAGE.showHiddenGems) === '1';
    } catch {
      return false;
    }
  });
  const [activeProfile, setActiveProfile] = useState(() => {
    try {
      const v = localStorage.getItem(STORAGE.profile);
      if (v && v in PRESETS) return v;
    } catch { /* */ }
    return 'standard';
  });
  const [scoringMode] = useState<ScoringMode>('living');
  const [matchPrefs, setMatchPrefsState] = useState<MatchPrefs>(() =>
    normalizeMatchPrefs(loadJson(STORAGE.matchPrefs, DEFAULT_MATCH_PREFS)),
  );
  const [searchStatus, setSearchStatus] = useState<{ msg: string; error?: boolean } | null>(null);
  const [searching, setSearching] = useState(false);
  const [pickDestinationMode, setPickDestinationMode] = useState(false);
  const [paintVersion, setPaintVersion] = useState(0);
  const [paintStats, setPaintStats] = useState<PaintStats | null>(null);

  // Never leave the paint overlay stuck if MapLibre idle never fires.
  useEffect(() => {
    if (!painting) return;
    const t = setTimeout(() => setPainting(false), 8000);
    return () => clearTimeout(t);
  }, [painting]);
  const [debugMode] = useState(readDebugFlag);
  const rentRange = useRef({ min: 0, max: 1 });
  const commitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const uiSnapshotRef = useRef({
    weights,
    prefTargets,
    prefInclude,
    dailyNeedsCategories,
    desiredAreaM2,
    maxMonthlyBudget,
    mapView,
    scoringMode,
    matchPrefs,
  });
  uiSnapshotRef.current = {
    weights,
    prefTargets,
    prefInclude,
    dailyNeedsCategories,
    desiredAreaM2,
    maxMonthlyBudget,
    mapView,
    scoringMode,
    matchPrefs,
  };

  // UI mirrors update instantly; committed* feed the scoring engine after debounce.
  const [committedWeights, setCommittedWeights] = useState(weights);
  const [committedPrefTargets, setCommittedPrefTargets] = useState(prefTargets);
  const [committedPrefInclude, setCommittedPrefInclude] = useState(prefInclude);
  const [committedDailyNeeds, setCommittedDailyNeeds] = useState(dailyNeedsCategories);
  const [committedArea, setCommittedArea] = useState(desiredAreaM2);
  const [committedBudget, setCommittedBudget] = useState(maxMonthlyBudget);
  const [committedMapView, setCommittedMapView] = useState(mapView);
  const [committedScoringMode, setCommittedScoringMode] = useState(scoringMode);
  const [committedMatchPrefs, setCommittedMatchPrefs] = useState(matchPrefs);

  const scheduleScoringCommit = useCallback(() => {
    if (commitTimerRef.current) clearTimeout(commitTimerRef.current);
    commitTimerRef.current = setTimeout(() => {
      commitTimerRef.current = null;
      setPainting(true);
      const s = uiSnapshotRef.current;
      setCommittedWeights({ ...s.weights });
      setCommittedPrefTargets({ ...s.prefTargets });
      setCommittedPrefInclude(s.prefInclude);
      setCommittedDailyNeeds({ ...s.dailyNeedsCategories });
      setCommittedArea(s.desiredAreaM2);
      setCommittedBudget(s.maxMonthlyBudget);
      setCommittedMapView(s.mapView);
      setCommittedScoringMode(s.scoringMode);
      setCommittedMatchPrefs({ ...s.matchPrefs });
    }, SLIDER_COMMIT_MS);
  }, []);

  useEffect(() => {
    return () => {
      if (commitTimerRef.current) clearTimeout(commitTimerRef.current);
    };
  }, []);

  const setWeights = useCallback(
    (
      next:
        | Record<string, number>
        | ((prev: Record<string, number>) => Record<string, number>),
    ) => {
      setWeightsState(next);
      scheduleScoringCommit();
    },
    [scheduleScoringCommit],
  );

  /** Set one Living Score pillar as percent 0–100; redistribute the rest to sum 100%. */
  const setPillarWeightPercent = useCallback(
    (key: string, percent: number) => {
      const pillarKeys = [
        'daily_life', 'walk', 'green', 'transit', 'centrality', 'quiet', 'housing_affordability',
      ] as const;
      const resolvedKey = key === 'housing_value' ? 'housing_affordability' : key;
      if (!(pillarKeys as readonly string[]).includes(resolvedKey)) return;
      const target = Math.max(0, Math.min(100, percent)) / 100;
      setActiveProfile('custom');
      try {
        localStorage.setItem(STORAGE.profile, 'custom');
      } catch { /* */ }
      setWeightsState((prev) => {
        const cur: Record<string, number> = {};
        let sumOthers = 0;
        pillarKeys.forEach((k) => {
          const legacy = k === 'housing_affordability'
            ? Number(prev.housing_affordability ?? prev.housing_value)
            : Number(prev[k]);
          // Allow explicit 0 — only fall back when the key was never set.
          cur[k] = Number.isFinite(legacy) && legacy >= 0 ? legacy : (LIVING_WEIGHTS[k] ?? 0);
          if (k !== resolvedKey) sumOthers += cur[k];
        });
        const rest = Math.max(0, 1 - target);
        const next = { ...prev, [resolvedKey]: target };
        pillarKeys.forEach((k) => {
          if (k === resolvedKey) return;
          if (sumOthers > 1e-9) {
            next[k] = (cur[k] / sumOthers) * rest;
          } else {
            next[k] = 0;
          }
        });
        if (sumOthers <= 1e-9 && rest > 0) {
          const fallback = pillarKeys.find((k) => k !== resolvedKey) || 'daily_life';
          next[fallback] = rest;
        }
        // Raising Wohnkosten manually → lean harder on affordability for Your Match.
        if (resolvedKey === 'housing_affordability') {
          next.affordability_focus = target >= 0.2
            ? Math.min(0.85, 0.25 + (target - 0.1) * 1.5)
            : Number(prev.affordability_focus) || 0;
        }
        try {
          localStorage.setItem(STORAGE.pillarWeights, JSON.stringify(next));
        } catch { /* */ }
        return next;
      });
      scheduleScoringCommit();
    },
    [scheduleScoringCommit],
  );

  const setPrefTargets = useCallback(
    (
      next:
        | { urban_activity: number; density: number; housing: number }
        | ((prev: {
            urban_activity: number;
            density: number;
            housing: number;
          }) => { urban_activity: number; density: number; housing: number }),
    ) => {
      setPrefTargetsState(next);
      scheduleScoringCommit();
    },
    [scheduleScoringCommit],
  );

  const setPrefInclude = useCallback(
    (v: boolean) => {
      setPrefIncludeState(v);
      scheduleScoringCommit();
    },
    [scheduleScoringCommit],
  );

  const setDailyNeedsCategories = useCallback(
    (
      next:
        | Record<string, boolean>
        | ((prev: Record<string, boolean>) => Record<string, boolean>),
    ) => {
      setDailyNeedsCategoriesState(next);
      scheduleScoringCommit();
    },
    [scheduleScoringCommit],
  );

  const setDesiredAreaM2 = useCallback(
    (v: number) => {
      setDesiredAreaM2State(v);
      scheduleScoringCommit();
    },
    [scheduleScoringCommit],
  );

  const setMaxMonthlyBudget = useCallback(
    (v: number | null) => {
      setMaxMonthlyBudgetState(v);
      scheduleScoringCommit();
    },
    [scheduleScoringCommit],
  );

  const setMapView = useCallback(
    (v: string) => {
      setMapViewState(v);
      try {
        localStorage.setItem(STORAGE.mapView, v);
      } catch { /* */ }
      scheduleScoringCommit();
    },
    [scheduleScoringCommit],
  );

  const setShowHiddenGems = useCallback((on: boolean) => {
    setShowHiddenGemsState(on);
    try {
      localStorage.setItem(STORAGE.showHiddenGems, on ? '1' : '0');
    } catch { /* */ }
    setPaintVersion((v) => v + 1);
  }, []);

  const setScoringMode = useCallback((_mode: ScoringMode) => {
    /* Match Score UI deferred — Living only */
  }, []);

  const setMatchPrefs = useCallback(
    (next: MatchPrefs | ((prev: MatchPrefs) => MatchPrefs)) => {
      setMatchPrefsState((prev) => {
        const resolved = typeof next === 'function' ? next(prev) : next;
        const normalized = normalizeMatchPrefs(resolved);
        try {
          localStorage.setItem(STORAGE.matchPrefs, JSON.stringify(normalized));
        } catch { /* */ }
        return normalized;
      });
      scheduleScoringCommit();
    },
    [scheduleScoringCommit],
  );

  const setMatchPref = useCallback(
    (dim: keyof MatchPrefs, value: number) => {
      setMatchPrefs((prev) => ({ ...prev, [dim]: value }));
    },
    [setMatchPrefs],
  );

  const applyPreset = useCallback(
    (presetId: string) => {
      const preset = PRESETS[presetId as keyof typeof PRESETS];
      if (!preset) return;
      const nextWeights: Record<string, number> = {};
      IMPORTANCE_KEYS.forEach((k: string) => {
        nextWeights[k] = (preset as Record<string, number>)[k] ?? 0;
      });
      (
        ['daily_life', 'walk', 'green', 'transit', 'centrality', 'quiet', 'housing_affordability'] as const
      ).forEach((k) => {
        const src = preset as Record<string, number>;
        nextWeights[k] = src[k]
          ?? (k === 'housing_affordability' ? src.housing_value : undefined)
          ?? nextWeights[k]
          ?? 0;
      });
      (
        ['dl_food', 'dl_health', 'dl_education', 'dl_services', 'dl_restaurants_cafes', 'dl_leisure', 'dl_other'] as const
      ).forEach((k) => {
        if ((preset as Record<string, number>)[k] != null) {
          nextWeights[k] = (preset as Record<string, number>)[k];
        }
      });
      if ((preset as Record<string, number>).affordability_focus != null) {
        nextWeights.affordability_focus = (preset as Record<string, number>).affordability_focus;
      }
      const nextPrefs = {
        urban_activity: 50,
        density: 50,
        housing: 30,
      };
      const nextPrefInclude = PRESET_USES_PREFS.has(presetId);
      setActiveProfile(presetId);
      setWeightsState(nextWeights);
      setPrefTargetsState(nextPrefs);
      setPrefIncludeState(nextPrefInclude);
      // Profiles affect Your Match only — keep map on current metric mode unless diagnose.
      const keepMode = mapView === 'personal_match' || mapView === 'city_percentile'
        || mapView.startsWith('pillar:')
        || ['daily_life', 'walk', 'green', 'transit', 'centrality', 'quiet', 'housing_affordability', 'housing_value'].includes(mapView)
        || MAP_VIEW_METRICS.includes(mapView)
        ? mapView
        : 'objective';
      setMapViewState(keepMode);
      setCommittedMapView(keepMode);
      try {
        localStorage.setItem(STORAGE.profile, presetId);
        localStorage.setItem(STORAGE.mapView, keepMode);
      } catch { /* */ }
      if (commitTimerRef.current) clearTimeout(commitTimerRef.current);
      setPainting(true);
      setCommittedWeights(nextWeights);
      setCommittedPrefTargets(nextPrefs);
      setCommittedPrefInclude(nextPrefInclude);
      try {
        localStorage.setItem(STORAGE.pillarWeights, JSON.stringify(nextWeights));
      } catch { /* */ }
      // Force map repaint even if React batches weight updates.
      setPaintVersion((v) => v + 1);
    },
    [mapView],
  );

  const scoringCtx = useMemo((): ScoringContext => {
    const ctx = createContextFromFeatures(features, {
      ...meta,
      has_rent: hasRent,
      pipeline_version: hasExtendedMetrics ? 9 : 1,
    }) as ScoringContext;
    ctx.weights = { ...committedWeights };
    ctx.prefTargets = { ...committedPrefTargets };
    ctx.prefInclude = committedPrefInclude;
    ctx.pillarWeights = {
      daily_life: committedWeights.daily_life ?? 0.2,
      walk: committedWeights.walk ?? committedWeights.walking_quality ?? 0.15,
      green: committedWeights.green ?? 0.15,
      transit: committedWeights.transit ?? 0.15,
      centrality: committedWeights.centrality ?? committedWeights.center ?? 0.05,
      quiet: committedWeights.quiet ?? committedWeights.noise ?? 0.15,
      housing_affordability:
        committedWeights.housing_affordability
        ?? committedWeights.housing_value
        ?? committedWeights.price
        ?? 0.15,
    };
    const gm: Record<string, number> = {};
    ['food', 'health', 'education', 'services', 'restaurants_cafes', 'leisure', 'other'].forEach((g) => {
      const key = `dl_${g}`;
      if (committedWeights[key] != null) gm[key] = committedWeights[key];
    });
    ctx.groupMultipliers = gm;
    ctx.affordabilityFocus = Number(committedWeights.affordability_focus) || 0;
    ctx.activeProfile = activeProfile;
    ctx.scoringMode = 'living';
    ctx.mapMetricMode = (
      !committedMapView || committedMapView === 'comfort' || committedMapView === 'living'
        ? 'objective'
        : committedMapView === 'objective'
          || committedMapView === 'personal_match'
          || committedMapView === 'city_percentile'
          || committedMapView.startsWith('pillar:')
          || MAP_VIEW_METRICS.includes(committedMapView)
          ? committedMapView
          : `pillar:${committedMapView === 'housing_value' ? 'housing_affordability' : committedMapView}`
    ) as ScoringContext['mapMetricMode'];
    ctx.dailyNeedsCategories = { ...committedDailyNeeds };
    ctx.desiredAreaM2 = committedArea;
    ctx.maxMonthlyBudget = committedBudget;
    ctx.destinations = destinations;
    ctx.customDestMatrix = customDestMatrix;
    ctx.hasRent = hasRent;
    ctx.hasExtendedMetrics = hasExtendedMetrics;
    ctx.heatHasVariation = heatHasVariation;
    ctx.noiseHasVariation = noiseHasVariation;
    ctx.rentMin = rentRange.current.min;
    ctx.rentMax = rentRange.current.max;
    ctx.matchPrefs = { ...committedMatchPrefs };
    return ctx;
  }, [
    features,
    meta,
    committedWeights,
    committedPrefTargets,
    committedPrefInclude,
    committedDailyNeeds,
    committedArea,
    committedBudget,
    committedMapView,
    committedScoringMode,
    committedMatchPrefs,
    activeProfile,
    destinations,
    customDestMatrix,
    hasRent,
    hasExtendedMetrics,
    heatHasVariation,
    noiseHasVariation,
  ]);

  const engine = useMemo(
    () => createScoringEngine(scoringCtx, features) as ScoringEngine,
    [scoringCtx, features],
  );

  const bumpPaint = useCallback(() => setPaintVersion((v) => v + 1), []);

  useEffect(() => {
    bumpPaint();
  }, [engine, bumpPaint]);

  const onPaintComplete = useCallback((stats: PaintStats) => {
    setPaintStats(stats);
  }, []);

  /** Bumped on each city load request so a late München bootstrap cannot overwrite a search. */
  const cityLoadSeq = useRef(0);
  /** Synchronously tracks the last successfully loaded slug (avoids reload after navigate). */
  const loadedSlugRef = useRef<string | null>(null);
  const bootstrappedRef = useRef(false);

  const loadCity = useCallback((geojson: FeatureCollection & { meta?: CityMeta }) => {
    const m = geojson.meta || {};
    const feats = geojson.features;
    normalizeLegacyProps(feats);
    const rent = detectHasRent(geojson);
    const extended = detectExtendedMetrics(feats);
    setHasRent(rent);
    setHasExtendedMetrics(extended);
    setHeatHasVariation(factorScoreSpread(feats, 'heat') > 1);
    const noiseDbs = feats
      .map((f) => Number((f.properties as Record<string, unknown>).noise_db))
      .filter(Number.isFinite);
    const noiseSpread =
      noiseDbs.length >= 2
        ? Math.max(...noiseDbs) - Math.min(...noiseDbs)
        : factorScoreSpread(feats, 'noise');
    setNoiseHasVariation(noiseSpread > 1);
    if (rent) {
      const rents = feats
        .map((f) => Number((f.properties as Record<string, unknown>).rent_eur_m2))
        .filter(Number.isFinite);
      rentRange.current = {
        min: rents.length ? Math.min(...rents) : 0,
        max: rents.length ? Math.max(...rents) : 1,
      };
    }
    const slug = m.slug || 'stadt';
    loadedSlugRef.current = slug;
    setFeatures(feats);
    setMeta(m);
    setCityName(m.name || 'Stadt');
    setCitySlug(slug);
    setLoading(false);
    setLoadError(null);
    setPainting(true);
  }, []);

  const applyBootstrapProfile = useCallback(() => {
    if (activeProfile === 'custom') {
      const saved = loadJson<Record<string, number> | null>(STORAGE.pillarWeights, null);
      if (saved && typeof saved.daily_life === 'number') {
        const migrated = { ...saved };
        if (migrated.housing_affordability == null && migrated.housing_value != null) {
          migrated.housing_affordability = migrated.housing_value;
        }
        setWeightsState(migrated);
        setCommittedWeights(migrated);
        setPaintVersion((v) => v + 1);
      } else {
        applyPreset('standard');
      }
    } else {
      applyPreset(activeProfile in PRESETS ? activeProfile : 'standard');
    }
  }, [activeProfile, applyPreset]);

  const loadCityBySlug = useCallback(
    async (slug: string, seq: number) => {
      setSearching(true);
      setLoading(true);
      setLoadError(null);
      setSearchStatus({ msg: `Lade „${slug}“ …` });
      try {
        const { city, geojson } = await loadOrGenerateCity({ slug }, (msg) =>
          setSearchStatus({ msg }),
        );
        if (cityLoadSeq.current !== seq) return;
        loadCity(geojson);
        setSearchStatus(null);
        if (city.slug !== routeSlugRef.current) {
          onCityReadyRef.current?.(city.slug);
        }
      } catch (err) {
        if (cityLoadSeq.current !== seq || isAbortError(err)) return;
        const msg = err instanceof Error ? err.message : 'Stadt konnte nicht geladen werden';
        setSearchStatus({ msg, error: true });
        setLoadError(msg);
        setLoading(false);
      } finally {
        if (cityLoadSeq.current === seq) setSearching(false);
      }
    },
    [loadCity],
  );

  // Bootstrap from `/city/:slug`. Offline fallback: static München bundle.
  useEffect(() => {
    const seq = ++cityLoadSeq.current;
    let cancelled = false;
    (async () => {
      try {
        applyBootstrapProfile();
        if (routeSlug) {
          if (!cancelled && cityLoadSeq.current === seq) {
            await loadCityBySlug(routeSlug, seq);
          }
          return;
        }
        const resp = await fetch(CFG.dataUrl, { cache: 'no-store' });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const geojson = await resp.json();
        if (!cancelled && cityLoadSeq.current === seq) loadCity(geojson);
      } catch (err) {
        console.error(err);
        if (!cancelled && cityLoadSeq.current === seq) {
          setLoadError('Fehler beim Laden der Kartendaten.');
          setLoading(false);
        }
      } finally {
        if (!cancelled) bootstrappedRef.current = true;
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- bootstrap once on mount
  }, []);

  // Follow `/city/:slug` changes (search navigate, back/forward) without remounting.
  useEffect(() => {
    if (!bootstrappedRef.current) return;
    if (!routeSlug) return;
    if (routeSlug === loadedSlugRef.current) return;
    const seq = ++cityLoadSeq.current;
    void loadCityBySlug(routeSlug, seq);
  }, [routeSlug, loadCityBySlug]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE.dest, JSON.stringify(destinations));
    } catch {
      /* */
    }
  }, [destinations]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE.dailyNeeds, JSON.stringify(dailyNeedsCategories));
    } catch {
      /* */
    }
  }, [dailyNeedsCategories]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE.area, String(desiredAreaM2));
      if (maxMonthlyBudget) localStorage.setItem(STORAGE.budget, String(maxMonthlyBudget));
      else localStorage.removeItem(STORAGE.budget);
    } catch {
      /* */
    }
  }, [desiredAreaM2, maxMonthlyBudget]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE.mapView, mapView);
    } catch {
      /* */
    }
  }, [mapView]);

  useEffect(() => {
    if (!destinations.length || !citySlug) {
      setCustomDestMatrix({});
      return;
    }
    let cancelled = false;
    (async () => {
      await ensureApiBase();
      const matrix = await fetchDestMatrix(citySlug, destinations);
      if (!cancelled) {
        setCustomDestMatrix(matrix);
        setPainting(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [destinations, citySlug, features]);

  const runSearch = useCallback(
    async (query: string) => {
      if (!query.trim() || searching) return;
      const seq = ++cityLoadSeq.current;
      setSearching(true);
      setSearchStatus({ msg: `Suche „${query}“ …` });
      try {
        const { city, geojson } = await loadOrGenerateCity({ query }, (msg) =>
          setSearchStatus({ msg }),
        );
        if (cityLoadSeq.current !== seq) return;
        loadCity(geojson);
        setSearchStatus(null);
        onCityReadyRef.current?.(city.slug);
      } catch (err) {
        if (cityLoadSeq.current !== seq || isAbortError(err)) return;
        setSearchStatus({
          msg: err instanceof Error ? err.message : 'Suche fehlgeschlagen',
          error: true,
        });
      } finally {
        if (cityLoadSeq.current === seq) setSearching(false);
      }
    },
    [searching, loadCity],
  );

  const factorAvailable = useCallback(
    (key: string) => {
      if (key === 'price') return hasRent;
      if (key === 'custom_dest') return destinations.length > 0;
      if (key === 'heat') return hasExtendedMetrics && heatHasVariation;
      if (key === 'noise') return noiseHasVariation;
      if (['daily_needs', 'transit_service', 'traffic_safety', 'density', 'housing'].includes(key)) {
        return hasExtendedMetrics;
      }
      return true;
    },
    [hasRent, destinations.length, hasExtendedMetrics, heatHasVariation, noiseHasVariation],
  );

  const mapViewOptions = useMemo(
    () => buildMapViewOptions(FACTOR_LABELS as Record<string, string>),
    [],
  );

  useEffect(() => {
    if (!features.length) return;
    if (mapViewOptions.some((o) => o.value === mapView)) return;
    setMapView('objective');
  }, [features.length, mapView, mapViewOptions, setMapView]);

  const debugReport = useMemo(() => {
    if (!debugMode || !features.length) return null;
    const labels = FACTOR_LABELS as Record<string, string>;
    const keys = engine.activeCriterionKeys() as string[];
    const thresholds = engine.thresholdsForActiveKeys() as Record<string, number | null>;
    const factorRows = keys.map((key) => {
      let pass = 0;
      let sum = 0;
      let n = 0;
      for (const f of features) {
        const ev = engine.evaluateHex(f.properties as Record<string, unknown>);
        const fac = ev.factors[key];
        if (!fac) continue;
        n += 1;
        sum += fac.score;
        if (fac.passed) pass += 1;
      }
      const imp = PREF_KEYS.includes(key) ? (prefInclude ? 2 : 0) : (weights[key] ?? 0);
      return {
        key,
        label: labels[key] || key,
        importance: imp,
        threshold: thresholds[key],
        passRate: n ? pass / n : 0,
        meanScore: n ? sum / n : 0,
        passCount: pass,
        sampleCount: n,
      };
    });

    const distributions: ScoreDistribution[] = [];
    const livingVals: number[] = [];
    const pillarVals: Record<string, number[]> = Object.fromEntries(
      PILLAR_KEYS.map((k) => [k, [] as number[]]),
    );
    for (const f of features) {
      const p = f.properties as Record<string, unknown>;
      const living = engine.comfortScalar(p);
      if (living != null && Number.isFinite(living)) livingVals.push(living);
      for (const key of PILLAR_KEYS) {
        const v = engine.factorScalar(key, p);
        if (v != null && Number.isFinite(v)) pillarVals[key]!.push(v);
      }
    }
    const livingDist = summarizeScores('comfort', 'Infrastruktur', livingVals);
    if (livingDist) distributions.push(livingDist);
    for (const key of PILLAR_KEYS) {
      const dist = summarizeScores(key, labels[key] || key, pillarVals[key] ?? []);
      if (dist) distributions.push(dist);
    }

    return {
      cityName,
      citySlug,
      hexCount: features.length,
      passingCount: engine.getPassingCount(),
      activeKeys: keys,
      factorRows,
      distributions,
      paintStats,
      weights: { ...weights },
      prefTargets: { ...prefTargets },
      prefInclude,
      mapView,
    };
  }, [
    debugMode,
    features,
    engine,
    weights,
    prefTargets,
    prefInclude,
    cityName,
    citySlug,
    paintStats,
    mapView,
    paintVersion,
  ]);

  useEffect(() => {
    setChatHex(null);
  }, [citySlug]);

  const selectChatHex = useCallback(
    (feature: Feature) => {
      const p = feature.properties as Record<string, unknown>;
      const h3 = String(p.h3 ?? p.h3_index ?? '');
      if (!h3) return;
      const living = Number(p.s_living);
      setChatHex({
        h3,
        citySlug,
        cityName,
        livingScore: Number.isFinite(living) ? living : null,
        props: snapshotHexProps(p),
      });
      setChatOpen(true);
    },
    [citySlug, cityName],
  );

  const addDestination = useCallback((lat: number, lng: number) => {
    setDestinations((prev) => {
      if (prev.length >= 3) return prev;
      return [...prev, { lat, lng, label: `Ziel ${prev.length + 1}`, weight: 2 }];
    });
    setPickDestinationMode(false);
    setSearchStatus({ msg: '' });
    setTimeout(() => setSearchStatus(null), 0);
  }, []);

  return {
    loading,
    painting,
    setPainting,
    loadError,
    features,
    meta,
    cityName,
    citySlug,
    hasRent,
    hasExtendedMetrics,
    heatHasVariation,
    noiseHasVariation,
    weights,
    setWeights,
    setPillarWeightPercent,
    prefTargets,
    setPrefTargets,
    prefInclude,
    setPrefInclude,
    dailyNeedsCategories,
    setDailyNeedsCategories,
    desiredAreaM2,
    setDesiredAreaM2,
    maxMonthlyBudget,
    setMaxMonthlyBudget,
    destinations,
    setDestinations,
    chatHex,
    chatOpen,
    setChatHex,
    setChatOpen,
    selectChatHex,
    mapView,
    paintMapView: committedMapView,
    setMapView,
    showHiddenGems,
    setShowHiddenGems,
    activeProfile,
    scoringMode,
    setScoringMode,
    matchPrefs,
    setMatchPrefs,
    setMatchPref,
    matchAlternatives: engine.getMatchAlternatives?.() ?? [],
    mapViewOptions,
    searchStatus,
    setSearchStatus,
    searching,
    pickDestinationMode,
    setPickDestinationMode,
    paintVersion,
    paintStats,
    onPaintComplete,
    debugMode,
    debugReport,
    engine,
    factorAvailable,
    applyPreset,
    runSearch,
    addDestination,
    IMPORTANCE_KEYS,
    PREF_KEYS,
    FACTOR_LABELS: FACTOR_LABELS as Record<string, string>,
    SCORE_PROPS: SCORE_PROPS as Record<string, string>,
  };
}

export type WohnIndexStore = ReturnType<typeof useWohnIndexStore>;
