import type { MatchAlternative, MatchBreakdown, MatchPrefs, RankedMatch } from './match';

export type ScoringMode = 'living' | 'match';

export type ScoringContext = {
  weights: Record<string, number>;
  prefTargets: Record<string, number>;
  prefInclude: boolean;
  pillarWeights: Record<string, number>;
  groupMultipliers: Record<string, number>;
  /** 0–1: blend housing pillar toward city-relative affordability. */
  affordabilityFocus: number;
  activeProfile: string;
  _diagnoseKey: string | null;
  centerAnchors: unknown[];
  rentMin: number;
  rentMax: number;
  hasRent: boolean;
  hasExtendedMetrics: boolean;
  heatHasVariation: boolean;
  noiseHasVariation: boolean;
  destinations: { lat: number; lng: number; label?: string; weight?: number }[];
  customDestMatrix: Record<string, Record<string, number>>;
  dailyNeedsCategories: Record<string, boolean>;
  desiredAreaM2: number;
  maxMonthlyBudget: number | null;
  scoringMode: ScoringMode;
  matchPrefs: MatchPrefs;
};

export type HexEval = {
  passed: boolean;
  priorityScore: number | null;
  matchScore: number | null;
  bottleneckMatch?: number;
  factors: Record<
    string,
    { score: number; threshold: number; passed: boolean; importance: number }
  >;
  failedFactors: string[];
  activeKeys: string[];
  livingScore?: number;
  pillars?: Record<string, number>;
  matchBreakdown?: MatchBreakdown;
  dominated?: boolean;
};

export type ScoringEngine = {
  ctx: ScoringContext;
  factorAvailable: (key: string) => boolean;
  activeImportanceKeys: () => string[];
  activeCriterionKeys: () => string[];
  activeAllKeys: () => string[];
  factorScalar: (key: string, p: Record<string, unknown>) => number;
  evaluateHex: (p: Record<string, unknown>) => HexEval;
  thresholdsForActiveKeys: () => Record<string, number | null>;
  rebuildCityStats: () => unknown;
  rebuildComfortRemap: () => unknown;
  isComfortRemapActive: () => boolean;
  hasPassingHexes: () => boolean;
  getPassingCount: () => number;
  closestMatchMessage: () => string | null;
  findClosestMatch: () => unknown;
  comfortScalar: (p: Record<string, unknown>) => number | null;
  rawComfortScalar: (p: Record<string, unknown>) => number | null;
  applyPreset: (preset: Record<string, number> | string) => unknown;
  onlyFactor: (key: string, level: number) => unknown;
  absScoreForKey: (key: string, p: Record<string, unknown>) => number;
  livingScore: (p: Record<string, unknown>) => { score: number; pillars: Record<string, number> };
  pillarScores: (p: Record<string, unknown>) => Record<string, number>;
  getPillarWeights: () => Record<string, number>;
  getGroupMultipliers: () => Record<string, number>;
  getScoringMode: () => ScoringMode;
  getMatchPrefs: () => MatchPrefs;
  getMatchRanking: () => RankedMatch[];
  getMatchAlternatives: () => MatchAlternative[];
};
