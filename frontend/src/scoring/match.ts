/**
 * Personalized Match Score engine.
 *
 * Utility − soft-constraint penalties, then Pareto filter on active dimensions.
 * Does not replace Living Score — this is the personalization overlay.
 */

export const MATCH_DIMS = [
  'centrality',
  'infrastructure',
  'walk',
  'green',
  'transit',
  'quiet',
  'price',
] as const;

export type MatchDim = (typeof MATCH_DIMS)[number];

export type MatchPrefs = Record<MatchDim, number>;

export const MATCH_PROP: Record<MatchDim, string> = {
  centrality: 's_match_centrality',
  infrastructure: 's_match_infrastructure',
  walk: 's_match_walk',
  green: 's_match_green',
  transit: 's_match_transit',
  quiet: 's_match_quiet',
  price: 's_match_price',
};

/** Fallback props when s_match_* is missing. */
const MATCH_FALLBACK: Record<MatchDim, string[]> = {
  centrality: ['s_center'],
  infrastructure: ['s_daily_life'],
  walk: ['s_walk'],
  green: ['s_green'],
  transit: ['s_transit'],
  quiet: ['s_quiet'],
  price: ['s_rent_relative_city'],
};

export const MATCH_LABELS: Record<MatchDim, string> = {
  centrality: 'Zentralität',
  infrastructure: 'Infrastruktur',
  walk: 'Gehqualität',
  green: 'Grün',
  transit: 'ÖPNV',
  quiet: 'Ruhe',
  price: 'Preis',
};

export const MATCH_QUESTIONS: Record<MatchDim, string> = {
  centrality: 'Wie wichtig ist Nähe zum Stadtzentrum?',
  infrastructure: 'Wie wichtig sind Alltagsangebote in der Nähe?',
  walk: 'Wie wichtig ist angenehmes Gehen?',
  green: 'Wie wichtig sind Natur und Grün?',
  transit: 'Wie wichtig ist der ÖPNV?',
  quiet: 'Wie wichtig ist Ruhe / wenig Lärm?',
  price: 'Wie wichtig ist günstiger Wohnraum?',
};

export const DEFAULT_MATCH_PREFS: MatchPrefs = {
  centrality: 50,
  infrastructure: 50,
  walk: 40,
  green: 40,
  transit: 40,
  quiet: 30,
  price: 20,
};

/** Soft-penalty strength (gap 20 → 20 score points before weight). */
export const MATCH_PENALTY_LAMBDA = 5;

export type MatchBreakdown = {
  attributes: MatchPrefs;
  weights: MatchPrefs;
  thresholds: MatchPrefs;
  penalties: MatchPrefs;
  utility: number;
  totalPenalty: number;
  finalScore: number;
  activeDims: MatchDim[];
};

export type MatchHexResult = MatchBreakdown & {
  h3: string;
  dominated: boolean;
  props: Record<string, unknown>;
};

export type MatchAlternative = {
  key: 'budget' | 'commute' | 'green';
  label: string;
  h3: string;
  score: number;
  props: Record<string, unknown>;
};

function clamp100(v: number): number {
  return Math.max(0, Math.min(100, v));
}

export function normalizeMatchPrefs(raw: Partial<MatchPrefs> | null | undefined): MatchPrefs {
  const out = { ...DEFAULT_MATCH_PREFS };
  MATCH_DIMS.forEach((d) => {
    if (raw && raw[d] != null) out[d] = clamp100(Number(raw[d]));
  });
  return out;
}

export function matchAttributeVector(p: Record<string, unknown>): MatchPrefs {
  const out = {} as MatchPrefs;
  MATCH_DIMS.forEach((dim) => {
    const primary = p[MATCH_PROP[dim]];
    if (primary != null && Number.isFinite(Number(primary))) {
      out[dim] = clamp100(Number(primary));
      return;
    }
    for (const key of MATCH_FALLBACK[dim]) {
      if (p[key] != null && Number.isFinite(Number(p[key]))) {
        out[dim] = clamp100(Number(p[key]));
        return;
      }
    }
    out[dim] = 50;
  });
  return out;
}

export function preferenceWeights(prefs: MatchPrefs): { weights: MatchPrefs; activeDims: MatchDim[] } {
  const activeDims = MATCH_DIMS.filter((d) => prefs[d] > 0);
  const sum = activeDims.reduce((s, d) => s + prefs[d], 0);
  const weights = {} as MatchPrefs;
  MATCH_DIMS.forEach((d) => {
    weights[d] = sum > 0 && prefs[d] > 0 ? prefs[d] / sum : 0;
  });
  return { weights, activeDims };
}

/** High preference → minimum acceptable quality (P=90 → threshold 70). */
export function softThreshold(preference: number): number {
  if (preference <= 0) return 0;
  return Math.max(0, preference - 20);
}

export function scoreMatchHex(p: Record<string, unknown>, prefs: MatchPrefs): MatchBreakdown {
  const attributes = matchAttributeVector(p);
  const { weights, activeDims } = preferenceWeights(prefs);
  const thresholds = {} as MatchPrefs;
  const penalties = {} as MatchPrefs;
  let utility = 0;
  let totalPenalty = 0;

  MATCH_DIMS.forEach((d) => {
    const w = weights[d];
    const x = attributes[d];
    const t = softThreshold(prefs[d]);
    thresholds[d] = t;
    utility += w * x;
    const gap = Math.max(0, t - x);
    const pen = w * MATCH_PENALTY_LAMBDA * (gap * gap) / 100;
    penalties[d] = pen;
    totalPenalty += pen;
  });

  return {
    attributes,
    weights,
    thresholds,
    penalties,
    utility,
    totalPenalty,
    finalScore: clamp100(utility - totalPenalty),
    activeDims,
  };
}

/** A dominates B on active dims if ≥ everywhere and > somewhere. */
export function dominates(
  a: MatchPrefs,
  b: MatchPrefs,
  activeDims: MatchDim[],
): boolean {
  if (!activeDims.length) return false;
  let strictlyBetter = false;
  for (const d of activeDims) {
    if (a[d] < b[d]) return false;
    if (a[d] > b[d]) strictlyBetter = true;
  }
  return strictlyBetter;
}

export function filterParetoFront(
  hexes: { h3: string; attributes: MatchPrefs; props: Record<string, unknown> }[],
  activeDims: MatchDim[],
): Set<string> {
  const nonDominated = new Set<string>();
  for (let i = 0; i < hexes.length; i++) {
    let dominated = false;
    for (let j = 0; j < hexes.length; j++) {
      if (i === j) continue;
      if (dominates(hexes[j].attributes, hexes[i].attributes, activeDims)) {
        dominated = true;
        break;
      }
    }
    if (!dominated) nonDominated.add(hexes[i].h3);
  }
  return nonDominated;
}

export type RankedMatch = {
  h3: string;
  props: Record<string, unknown>;
  breakdown: MatchBreakdown;
  dominated: boolean;
};

export function rankMatchHexes(
  features: { properties?: Record<string, unknown> | null }[],
  prefs: MatchPrefs,
): RankedMatch[] {
  const normalized = normalizeMatchPrefs(prefs);
  const { activeDims } = preferenceWeights(normalized);

  const scored = features.map((f) => {
    const props = (f.properties || {}) as Record<string, unknown>;
    const h3 = String(props.h3 ?? props.h3_index ?? '');
    const breakdown = scoreMatchHex(props, normalized);
    return { h3, props, breakdown, attributes: breakdown.attributes };
  });

  const pareto = filterParetoFront(
    scored.map((s) => ({ h3: s.h3, attributes: s.attributes, props: s.props })),
    activeDims,
  );

  const ranked: RankedMatch[] = scored.map((s) => ({
    h3: s.h3,
    props: s.props,
    breakdown: s.breakdown,
    dominated: !pareto.has(s.h3),
  }));

  ranked.sort((a, b) => {
    // Non-dominated first, then by final score.
    if (a.dominated !== b.dominated) return a.dominated ? 1 : -1;
    return b.breakdown.finalScore - a.breakdown.finalScore;
  });

  return ranked;
}

function bestUnderPrefs(
  rankedPool: RankedMatch[],
  prefs: MatchPrefs,
  excludeH3: string,
): RankedMatch | null {
  let best: RankedMatch | null = null;
  let bestScore = -1;
  for (const item of rankedPool) {
    if (item.h3 === excludeH3) continue;
    if (item.dominated) continue;
    const bd = scoreMatchHex(item.props, prefs);
    if (bd.finalScore > bestScore) {
      bestScore = bd.finalScore;
      best = { ...item, breakdown: bd };
    }
  }
  return best;
}

export function computeMatchAlternatives(
  ranked: RankedMatch[],
  prefs: MatchPrefs,
): MatchAlternative[] {
  const top = ranked.find((r) => !r.dominated) ?? ranked[0];
  if (!top) return [];

  const base = normalizeMatchPrefs(prefs);
  const variants: { key: MatchAlternative['key']; label: string; prefs: MatchPrefs }[] = [
    {
      key: 'budget',
      label: 'Beste Alternative bei höherem Budget',
      prefs: { ...base, price: Math.max(0, base.price - 40) },
    },
    {
      key: 'commute',
      label: 'Beste Alternative bei längerem Arbeitsweg',
      prefs: { ...base, centrality: Math.max(0, base.centrality - 40) },
    },
    {
      key: 'green',
      label: 'Beste Alternative mit mehr Grün',
      prefs: { ...base, green: Math.min(100, base.green + 30) },
    },
  ];

  const out: MatchAlternative[] = [];
  for (const v of variants) {
    const alt = bestUnderPrefs(ranked, v.prefs, top.h3);
    if (!alt) continue;
    out.push({
      key: v.key,
      label: v.label,
      h3: alt.h3,
      score: Math.round(alt.breakdown.finalScore),
      props: alt.props,
    });
  }
  return out;
}

export function matchDisplayScore(
  p: Record<string, unknown>,
  prefs: MatchPrefs,
  dominated = false,
): number {
  const score = scoreMatchHex(p, prefs).finalScore;
  // Dim dominated hexes on the map without hiding them.
  return dominated ? clamp100(score * 0.55) : score;
}
