import type { MatchAlternative, MatchBreakdown, MatchPrefs, RankedMatch } from './match';
import type { ScoreMethodVersion } from './normalization';

export type ScoringMode = 'living' | 'match';

/** Primary map paint / legend mode. */
export type MapMetricMode =
  | 'objective'
  | 'personal_match'
  | 'city_percentile'
  | `pillar:${string}`;

export type ObjectivePillarKey =
  | 'daily_life'
  | 'walk'
  | 'green'
  | 'transit'
  | 'quiet'
  | 'housing_affordability';

/** Pillars available for Personal Match (includes informational centrality). */
export type PersonalPillarKey = ObjectivePillarKey | 'centrality';

export type ScoredValue = {
  score: number | null;
  coverage: number;
  sourcesUsed: string[];
  missingInputs: string[];
};

export type ScoreDiagnostics = {
  objectiveScore: number | null;
  personalMatchScore: number | null;
  cityPercentile: number | null;
  confidence: number;
  weightedContributions: Partial<Record<ObjectivePillarKey, number>>;
  missingInputs: string[];
  proxiesUsed: string[];
  scoreMethodVersion: ScoreMethodVersion;
};

export type LocationScoreResult = {
  objectiveScore: number | null;
  personalMatchScore: number | null;
  cityPercentile: number | null;
  confidence: number;
  pillars: Record<PersonalPillarKey, number | null>;
  pillarCoverage: Record<PersonalPillarKey, number>;
  missingData: string[];
  diagnostics: ScoreDiagnostics;
  scoreMethodVersion: ScoreMethodVersion;
  /**
   * @deprecated Use objectiveScore. Kept for older clients.
   * TODO: remove after consumers migrate to objectiveScore.
   */
  score: number | null;
};

/** Loose hex property bag from GeoJSON / pipeline export. */
export type PipelinePoint = Record<string, unknown>;

export type ScoringContext = {
  weights: Record<string, number>;
  prefTargets: Record<string, number>;
  prefInclude: boolean;
  pillarWeights: Record<string, number>;
  groupMultipliers: Record<string, number>;
  /** 0–1: personal affordability emphasis (does not affect objective). */
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
  mapMetricMode: MapMetricMode;
  /** City-wide objective scores for percentile (h3 → score). */
  cityObjectiveByH3?: Map<string, number | null>;
  /** Sorted finite objectives for O(log n) percentile. */
  cityObjectiveSorted?: number[];
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
  livingScore?: number | null;
  objectiveScore?: number | null;
  personalMatchScore?: number | null;
  cityPercentile?: number | null;
  confidence?: number;
  pillars?: Record<string, number | null>;
  matchBreakdown?: MatchBreakdown;
  dominated?: boolean;
  locationScore?: LocationScoreResult;
};

export type ScoringEngine = {
  ctx: ScoringContext;
  factorAvailable: (key: string) => boolean;
  activeImportanceKeys: () => string[];
  activeCriterionKeys: () => string[];
  activeAllKeys: () => string[];
  factorScalar: (key: string, p: PipelinePoint) => number | null;
  evaluateHex: (p: PipelinePoint) => HexEval;
  thresholdsForActiveKeys: () => Record<string, number | null>;
  rebuildCityStats: () => unknown;
  rebuildComfortRemap: () => unknown;
  isComfortRemapActive: () => boolean;
  hasPassingHexes: () => boolean;
  getPassingCount: () => number;
  closestMatchMessage: () => string | null;
  findClosestMatch: () => unknown;
  comfortScalar: (p: PipelinePoint) => number | null;
  rawComfortScalar: (p: PipelinePoint) => number | null;
  applyPreset: (preset: Record<string, number> | string) => unknown;
  onlyFactor: (key: string, level: number) => unknown;
  absScoreForKey: (key: string, p: PipelinePoint) => number | null;
  livingScore: (p: PipelinePoint) => LocationScoreResult;
  locationScore: (p: PipelinePoint) => LocationScoreResult;
  pillarScores: (p: PipelinePoint) => Record<string, number | null>;
  getPillarWeights: () => Record<string, number>;
  getGroupMultipliers: () => Record<string, number>;
  getAffordabilityFocus?: () => number;
  getScoringMode: () => ScoringMode;
  getMatchPrefs: () => MatchPrefs;
  getMatchRanking: () => RankedMatch[];
  getMatchAlternatives: () => MatchAlternative[];
  getMapMetricMode: () => MapMetricMode;
  setMapMetricMode: (mode: MapMetricMode) => void;
};
