/**
 * German narrative explanations for the 15-Minute Living Score (7 metrics).
 */

import { LIVING_WEIGHTS, PILLAR_LABELS, livingScore } from './engine';

const PILLAR_WEAKNESS: Record<string, string> = {
  daily_life: 'Alltagsversorgung (Läden, Ärzte, Schulen)',
  walk: 'Gehqualität (Straßen, Sicherheit, Komfort)',
  green: 'Grün- und Parkzugang',
  transit: 'ÖPNV-Anbindung',
  centrality: 'Lage zu Aktivitätszentren',
  quiet: 'Lärmbelastung',
  housing_value: 'Mietpreis / Preis-Leistung',
};

const PILLAR_STRENGTH: Record<string, string> = {
  daily_life: 'Alltagsziele sind gut zu Fuß erreichbar',
  walk: 'angenehme und sichere Gehwege',
  green: 'gutes Grünangebot in der Nähe',
  transit: 'starke ÖPNV-Anbindung',
  centrality: 'zentrale Lage zu Aktivitätszentren',
  quiet: 'ruhige Umgebung',
  housing_value: 'gutes Preis-Leistungs-Verhältnis',
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

function headline(score: number): string {
  if (score >= 90) return 'Hervorragend ohne Auto.';
  if (score >= 80) return 'Sehr gut ohne Auto.';
  if (score >= 70) return 'Gut geeignet für ein Leben ohne Auto.';
  if (score >= 55) return 'Eingeschränkt autoarm machbar.';
  if (score >= 40) return 'Eher autoabhängig.';
  return 'Stark autoabhängig.';
}

export function explainLivingScore(
  p: Record<string, unknown>,
  pillarWeights?: Record<string, number>,
  affordabilityFocus = 0,
): { score: number; text: string; pillars: Record<string, number> } {
  const { score, pillars } = livingScore(
    p,
    pillarWeights as typeof LIVING_WEIGHTS | undefined,
    null,
    affordabilityFocus,
  );
  const rounded = Math.round(score);

  const amenityBits: string[] = [];
  const supermarket = minutesLabel(p.dn_supermarket_min as number);
  const pharmacy = minutesLabel(p.dn_pharmacy_min as number);
  if (supermarket) amenityBits.push(`Supermarkt in ${supermarket} Gehminuten`);
  if (pharmacy) amenityBits.push(`Apotheke in ${pharmacy}`);
  if (pillars.transit >= 75) amenityBits.push('guter ÖPNV');
  else if (pillars.transit >= 55) amenityBits.push('ÖPNV in der Nähe');

  const rent = Number(p.rent_eur_m2);
  const rel = Number(p.s_rent_relative_city);
  if (Number.isFinite(rent) && Number.isFinite(rel) && rel < 20 && affordabilityFocus >= 0.45) {
    amenityBits.push(`teuer (~${rent.toFixed(0)} €/m²)`);
  }

  const sorted = Object.entries(pillars).sort((a, b) => a[1] - b[1]);
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

  return {
    score: rounded,
    text: parts.join(' '),
    pillars,
  };
}

export function pillarBreakdownRows(pillars: Record<string, number>) {
  return Object.entries(pillars).map(([key, score]) => ({
    key,
    label: PILLAR_LABELS[key as keyof typeof PILLAR_LABELS] || key,
    score: Math.round(score),
  }));
}
