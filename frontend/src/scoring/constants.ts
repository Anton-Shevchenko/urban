export const STEP_LABELS = ['Egal', 'Gering', 'Mittel', 'Wichtig', 'Kritisch'] as const;
export const NO_CRITERIA_COLOR = '#BDBDBD';
export const SCORE_FLOOR_SOFT = 0.1;

export const DAILY_NEED_CAT_LABELS: [string, string][] = [
  ['supermarket', 'Supermarkt'],
  ['bakery', 'Bäckerei'],
  ['market', 'Markt'],
  ['pharmacy', 'Apotheke'],
  ['doctor', 'Arzt'],
  ['clinic', 'Klinik'],
  ['kita', 'Kita'],
  ['school', 'Schule'],
  ['restaurant', 'Restaurant'],
  ['cafe', 'Café'],
  ['bank', 'Bank'],
  ['post', 'Post'],
  ['administration', 'Verwaltung'],
  ['sports', 'Sport'],
  ['park', 'Park'],
  ['playground', 'Spielplatz'],
];

export const PRESET_LABELS: Record<string, string> = {
  standard: 'Standard',
  family: 'Familie',
  young_professional: 'Young Professional',
  senior: 'Senior',
  no_car: 'Ohne Auto',
  budget: 'Budget',
  custom: 'Eigene Gewichte',
  // legacy
  balanced: 'Standard',
  quiet: 'Senior',
  central: 'Ohne Auto',
  business: 'Young Professional',
};

/** Profiles shown in the control panel (excludes legacy aliases). */
export const PROFILE_IDS = [
  'standard',
  'family',
  'young_professional',
  'senior',
  'no_car',
  'budget',
] as const;

export const PRESET_USES_PREFS = new Set<string>([]);

export const METRIC_MODE_LABELS: Record<string, string> = {
  objective: 'Living Score',
  personal_match: 'Your Match',
  city_percentile: 'City percentile',
};

export const STORAGE = {
  dailyNeeds: 'wohnindex.dailyNeedsCategories',
  budget: 'wohnindex.maxMonthlyBudget',
  area: 'wohnindex.desiredAreaM2',
  mapView: 'wohnindex.mapView',
  compare: 'wohnindex.comparison',
  dest: 'wohnindex.destinations',
  profile: 'wohnindex.livingProfile',
  pillarWeights: 'wohnindex.pillarWeights',
  showHiddenGems: 'wohnindex.showHiddenGems',
  scoringMode: 'wohnindex.scoringMode',
  matchPrefs: 'wohnindex.matchPrefs',
  theme: 'wohnindex.theme',
  panelOpen: 'wohnindex.panelOpen',
} as const;

export const CFG = {
  styleUrl: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
  styleUrlDark: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
  dataUrl: '/data/hexes.geojson',
  center: [11.5755, 48.1374] as [number, number],
  zoom: 10.8,
};
