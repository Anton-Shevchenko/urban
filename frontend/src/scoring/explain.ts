/**
 * German narrative explanations for the Objective Living Score.
 */

import { LIVING_WEIGHTS, PILLAR_KEYS, PILLAR_LABELS, livingScore } from './engine';
import { num } from './num';

const PILLAR_WEAKNESS: Record<string, string> = {
  daily_life: 'Infrastruktur (Läden, Cafés, Ärzte, Schulen)',
  walk: 'Gehqualität (Straßen, Sicherheit, Komfort)',
  green: 'Grün- und Parkzugang',
  transit: 'ÖPNV-Anbindung',
  centrality: 'Lage zu Aktivitätszentren',
  quiet: 'Lärmbelastung',
  housing_affordability: 'Wohnkosten (absolut)',
  housing_value: 'Wohnkosten (absolut)',
};

const PILLAR_STRENGTH: Record<string, string> = {
  daily_life: 'gute Infrastruktur zu Fuß erreichbar',
  walk: 'angenehme und sichere Gehwege',
  green: 'gutes Grünangebot in der Nähe',
  transit: 'starke ÖPNV-Anbindung',
  centrality: 'zentrale Lage zu Aktivitätszentren',
  quiet: 'ruhige Umgebung',
  housing_affordability: 'günstigere absolute Wohnkosten',
  housing_value: 'günstigere absolute Wohnkosten',
};

function minutesLabel(m: number | null | undefined): string | null {
  if (m == null || !Number.isFinite(Number(m))) return null;
  const v = Number(m);
  if (v >= 90) return null;
  if (v <= 3) return 'unter 3';
  if (v <= 5) return 'unter 5';
  if (v <= 10) return 'unter 10';
  if (v <= 15) return 'unter 15';
  return `${Math.round(v)}`;
}

function headline(score: number | null): string {
  if (score == null) return 'Unzureichende Daten für die Infrastruktur.';
  if (score >= 90) return 'Hervorragende Infrastruktur.';
  if (score >= 80) return 'Sehr gute Infrastruktur.';
  if (score >= 70) return 'Gute Infrastruktur in der Nähe.';
  if (score >= 55) return 'Durchschnittliche Infrastruktur.';
  if (score >= 40) return 'Eingeschränkte Infrastruktur.';
  return 'Schwache Infrastruktur.';
}

export function explainLivingScore(
  p: Record<string, unknown>,
  pillarWeights?: Record<string, number>,
  affordabilityFocus = 0,
  groupMultipliers: Record<string, number> | null = null,
): {
  score: number | null;
  text: string;
  pillars: Record<string, number>;
  personalMatchScore: number | null;
  cityPercentile: number | null;
  confidence: number;
} {
  const loc = livingScore(
    p,
    pillarWeights as typeof LIVING_WEIGHTS | undefined,
    groupMultipliers,
    affordabilityFocus,
  );
  const score = loc.objectiveScore;
  const rounded = score != null ? Math.round(score) : null;

  // Infra-only: narrative from active pillars (daily_life).
  const pillarsKnown: Record<string, number> = {};
  for (const k of PILLAR_KEYS) {
    const v = loc.pillars[k];
    if (v != null && Number.isFinite(v)) pillarsKnown[k] = v;
  }

  const amenityBits: string[] = [];
  const supermarket = minutesLabel(num(p.dn_supermarket_min) ?? undefined);
  const pharmacy = minutesLabel(num(p.dn_pharmacy_min) ?? undefined);
  if (supermarket) amenityBits.push(`Supermarkt in ${supermarket} Gehminuten`);
  if (pharmacy) amenityBits.push(`Apotheke in ${pharmacy}`);

  const sorted = Object.entries(pillarsKnown).sort((a, b) => a[1] - b[1]);
  const weakest = sorted[0];
  const strongest = sorted[sorted.length - 1];

  let weakness = '';
  if (weakest && weakest[1] < 55) {
    weakness = `Schwäche: ${PILLAR_WEAKNESS[weakest[0]] || weakest[0]}.`;
  }

  const strength =
    strongest && strongest[1] >= 80
      ? PILLAR_STRENGTH[strongest[0]]
      : null;

  const parts = [headline(rounded)];
  if (amenityBits.length) {
    parts.push(`${amenityBits.join(', ')}.`);
  } else if (strength) {
    parts.push(`${strength.charAt(0).toUpperCase()}${strength.slice(1)}.`);
  }
  if (weakness) parts.push(weakness);
  if (loc.confidence < 0.6) {
    parts.push(`Datenvertrauen: ${Math.round(loc.confidence * 100)}%.`);
  }

  return {
    score: rounded,
    text: parts.join(' '),
    pillars: pillarsKnown,
    personalMatchScore: loc.personalMatchScore,
    cityPercentile: loc.cityPercentile,
    confidence: loc.confidence,
  };
}

export function pillarBreakdownRows(pillars: Record<string, number | null | undefined>) {
  return PILLAR_KEYS
    .filter((key) => {
      const score = pillars[key];
      return score != null && Number.isFinite(score);
    })
    .map((key) => ({
      key,
      label: PILLAR_LABELS[key] || key,
      score: Math.round(pillars[key] as number),
    }));
}
