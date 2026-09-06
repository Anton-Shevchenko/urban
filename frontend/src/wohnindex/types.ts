import type { Feature } from 'geojson';
import type { ScoringEngine } from '../scoring/types';
import type { ScoreDistribution } from '../scoring/histogram';

export type UseWohnIndexOptions = {
  /** City slug from `/city/:slug`, or null on `/`. */
  routeSlug?: string | null;
  /** Called after a successful search so the app can update the URL. */
  onCityReady?: (slug: string) => void;
};

export type Destination = { lat: number; lng: number; label: string; weight: number };

export type CompareItem = {
  id: string;
  citySlug: string;
  cityName: string;
  h3: string;
  props: Record<string, unknown>;
  sizeM2: number;
  pricePerM2: number | null;
  lng: number | null;
  lat: number | null;
  /** Percentile in the city where the hex was pinned, not the city currently on the map. */
  cityPercentile: number | null;
};

export type CompareFocus = {
  citySlug: string;
  h3: string;
  lng: number | null;
  lat: number | null;
};

export type ChatHex = {
  h3: string;
  citySlug: string;
  cityName: string;
  livingScore: number | null;
  props?: Record<string, unknown>;
};

export type CityMeta = {
  name?: string;
  slug?: string;
  count?: number;
  h3_res?: number;
  bbox?: number[];
  center?: [number, number];
  centers?: { lat: number; lng: number; primary?: boolean }[];
  center_anchors?: { id?: string; label?: string; lat: number; lng: number; weight?: number }[];
  has_rent?: boolean;
  has_value_opportunity?: boolean;
  rent_estimated?: boolean;
  rent_source?: string;
  metric_quality?: Record<string, { source?: string; confidence?: number | string }>;
  pipeline_version?: number;
};

export type PaintStats = {
  ms: number;
  lo: number;
  hi: number;
  passingCount: number;
  hexCount: number;
};

export type DebugFactorRow = {
  key: string;
  label: string;
  importance: number;
  threshold: number | null | undefined;
  passRate: number;
  meanScore: number;
  passCount: number;
  sampleCount: number;
};

export type DebugReport = {
  cityName: string;
  citySlug: string;
  hexCount: number;
  passingCount: number;
  activeKeys: string[];
  factorRows: DebugFactorRow[];
  distributions: ScoreDistribution[];
  paintStats: PaintStats | null;
  weights: Record<string, number>;
  prefTargets: Record<string, number>;
  prefInclude: boolean;
  mapView: string;
};

/** Fields the map paint worker needs — not the full WohnIndex bag. */
export type HexPaintSnapshot = {
  features: Feature[];
  engine: ScoringEngine;
  paintMapView: string;
  mapView: string;
  paintVersion: number;
  comparison: CompareItem[];
  chatHex: ChatHex | null;
  cityName: string;
  citySlug: string;
  showHiddenGems: boolean;
  setPainting: (v: boolean) => void;
  onPaintComplete: (stats: PaintStats) => void;
};
