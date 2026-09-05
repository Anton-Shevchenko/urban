import { createContext, type Dispatch, type SetStateAction } from 'react';
import type { Feature } from 'geojson';
import type { ScoringEngine } from '../scoring/types';
import type {
  ChatHex,
  CityMeta,
  CompareItem,
  DebugReport,
  Destination,
  PaintStats,
} from './types';

export type CityDataSlice = {
  loading: boolean;
  loadError: string | null;
  features: Feature[];
  meta: CityMeta;
  cityName: string;
  citySlug: string;
  hasRent: boolean;
  searchStatus: { msg: string; error?: boolean } | null;
  searching: boolean;
  runSearch: (query: string) => Promise<void>;
};

export type WeightsSlice = {
  weights: Record<string, number>;
  setPillarWeightPercent: (key: string, percent: number) => void;
  desiredAreaM2: number;
  setDesiredAreaM2: (v: number) => void;
  maxMonthlyBudget: number | null;
  setMaxMonthlyBudget: (v: number | null) => void;
  activeProfile: string;
  applyPreset: (presetId: string) => void;
};

export type DestinationsSlice = {
  destinations: Destination[];
  pickDestinationMode: boolean;
  addDestination: (lat: number, lng: number) => void;
};

export type CompareSlice = {
  comparison: CompareItem[];
  setComparison: Dispatch<SetStateAction<CompareItem[]>>;
  toggleCompare: (feature: Feature) => void;
};

export type MapViewSlice = {
  mapView: string;
  paintMapView: string;
  setMapView: (v: string) => void;
  mapViewOptions: { value: string; label: string }[];
  showHiddenGems: boolean;
  setShowHiddenGems: (on: boolean) => void;
};

export type ChatSlice = {
  chatHex: ChatHex | null;
  chatOpen: boolean;
  setChatOpen: (open: boolean) => void;
  selectChatHex: (feature: Feature) => void;
};

export type PaintSlice = {
  painting: boolean;
  setPainting: (v: boolean) => void;
  paintVersion: number;
  onPaintComplete: (stats: PaintStats) => void;
  engine: ScoringEngine;
  debugMode: boolean;
  debugReport: DebugReport | null;
};

export const CityDataContext = createContext<CityDataSlice | null>(null);
export const WeightsContext = createContext<WeightsSlice | null>(null);
export const DestinationsContext = createContext<DestinationsSlice | null>(null);
export const CompareContext = createContext<CompareSlice | null>(null);
export const MapViewContext = createContext<MapViewSlice | null>(null);
export const ChatContext = createContext<ChatSlice | null>(null);
export const PaintContext = createContext<PaintSlice | null>(null);

export function requireWohnIndexCtx<T>(value: T | null, hook: string): T {
  if (value == null) throw new Error(`${hook} must be used within WohnIndexProvider`);
  return value;
}
