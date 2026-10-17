import type { Feature } from 'geojson';
import { DAILY_NEED_CAT_LABELS } from '../scoring/constants';
import { PILLAR_LABELS } from '../scoring/engine';
import { explainLivingScore } from '../scoring/explain';
import { locationScore } from '../scoring/locationScore';
import { num } from '../scoring/num';
import type { PersonalPillarKey, PipelinePoint, ScoringEngine } from '../scoring/types';

/** Pillars from contracts/metrics.json `hex_fact_sheet.pillars`. */
export const HEX_PILLAR_FACTS: { key: string; prop: string; labelKey: string; scoreKey: PersonalPillarKey }[] = [
  { key: 'daily_life', prop: 's_daily_life', labelKey: 'daily_life', scoreKey: 'daily_life' },
  { key: 'walk', prop: 's_walk', labelKey: 'walk', scoreKey: 'walk' },
  { key: 'green', prop: 's_green', labelKey: 'green', scoreKey: 'green' },
  { key: 'transit', prop: 's_transit', labelKey: 'transit', scoreKey: 'transit' },
  { key: 'quiet', prop: 's_quiet', labelKey: 'quiet', scoreKey: 'quiet' },
  { key: 'housing_affordability', prop: 's_housing_affordability', labelKey: 'housing_affordability', scoreKey: 'housing_affordability' },
  { key: 'centrality', prop: 's_center', labelKey: 'centrality', scoreKey: 'centrality' },
];

/** Walk-minute fields from contracts/metrics.json `hex_fact_sheet.walk_minutes`. */
export const HEX_WALK_FACTS: { key: string; countKey: string | null; label: string }[] = [
  { key: 'dn_supermarket_min', countKey: 'dn_supermarket_n', label: catLabel('supermarket') },
  { key: 'dn_pharmacy_min', countKey: 'dn_pharmacy_n', label: catLabel('pharmacy') },
  { key: 'dn_school_min', countKey: 'dn_school_n', label: catLabel('school') },
  { key: 'dn_kita_min', countKey: 'dn_kita_n', label: catLabel('kita') },
  { key: 'dn_doctor_min', countKey: 'dn_doctor_n', label: catLabel('doctor') },
  { key: 'dn_playground_min', countKey: 'dn_playground_n', label: catLabel('playground') },
  { key: 'center_min', countKey: null, label: 'Zentrum' },
];

function catLabel(id: string): string {
  return DAILY_NEED_CAT_LABELS.find(([key]) => key === id)?.[1] ?? id;
}

export type HexInfoWalkRow = {
  key: string;
  label: string;
  minutes: number | null;
  inHex: number | null;
  isCenter: boolean;
};
export type HexInfoPillarRow = { key: string; label: string; score: number | null };

export type HexInfoModel = {
  h3: string;
  cityName: string;
  insufficient: boolean;
  comfort: number | null;
  match: number | null;
  percentile: number | null;
  confidence: number | null;
  explainText: string;
  rentEurM2: number | null;
  priceLines: string[];
  pillars: HexInfoPillarRow[];
  walks: HexInfoWalkRow[];
};

export function minutesOrNull(raw: unknown): number | null {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n >= 90) return null;
  return n;
}

export function formatPriceLine(label: string, amount: unknown, source: unknown, asOf: unknown): string | null {
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) return null;
  const digits = value >= 100 ? 0 : 1;
  const euros = value.toLocaleString('de-DE', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  const published = typeof source === 'string' ? source.trim() : '';
  const date = typeof asOf === 'string' ? asOf.trim() : '';
  let line = `${label}: ${euros} €/m²`;
  if (published) {
    line += ` · ${published}`;
    if (date && !published.includes(date)) line += `, ${date}`;
  } else if (date) {
    line += ` · ${date}`;
  }
  return line;
}

export function countOrNull(raw: unknown): number | null {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n);
}

/** Fill in city-file props so Info is not stuck on a MapLibre/localStorage stub. */
export function mergeCityHexProps(
  snapshot: Record<string, unknown>,
  features: Feature[] | undefined,
): Record<string, unknown> {
  const h3 = String(snapshot.h3 ?? snapshot.h3_index ?? '');
  if (!h3 || !features?.length) return snapshot;
  const full = features.find((f) => {
    const p = f.properties as Record<string, unknown> | null | undefined;
    return String(p?.h3 ?? p?.h3_index ?? '') === h3;
  });
  if (!full?.properties) return snapshot;
  return { ...(full.properties as Record<string, unknown>), ...snapshot };
}

/** 0 minutes means the amenity sits in the hex, not “none here”. */
export function formatAmenityPresence(row: HexInfoWalkRow): string {
  if (row.isCenter) {
    if (row.minutes == null) return '—';
    if (row.minutes < 1) return 'hier';
    return `${Math.round(row.minutes)} Min.`;
  }
  if (row.inHex != null) {
    if (row.inHex > 0) return row.inHex === 1 ? '1 hier' : `${row.inHex} hier`;
    if (row.minutes == null) return 'keine';
    if (row.minutes < 1) return 'hier';
    return `keine · ${Math.round(row.minutes)} Min.`;
  }
  if (row.minutes == null) return '—';
  if (row.minutes < 1) return 'hier';
  return `${Math.round(row.minutes)} Min.`;
}

export function buildHexInfoModel(
  props: Record<string, unknown>,
  cityName: string,
  opts?: {
    engine?: ScoringEngine | null;
    cityPercentile?: number | null;
  },
): HexInfoModel {
  const engine = opts?.engine ?? null;
  const result = locationScore(
    props as PipelinePoint,
    engine
      ? {
          pillarWeights: engine.getPillarWeights(),
          groupMultipliers: engine.getGroupMultipliers(),
          affordabilityFocus: engine.getAffordabilityFocus?.() ?? 0,
          cityPercentile: opts?.cityPercentile ?? null,
        }
      : { cityPercentile: opts?.cityPercentile ?? null },
  );
  const explained = explainLivingScore(
    props,
    engine?.getPillarWeights(),
    engine?.getAffordabilityFocus?.() ?? 0,
    engine?.getGroupMultipliers?.() ?? null,
  );
  const h3 = String(props.h3 ?? props.h3_index ?? '');
  const rent = Number(props.rent_eur_m2);
  const comfort = result.objectiveScore ?? result.score;
  return {
    h3,
    cityName,
    insufficient: comfort == null,
    comfort: comfort != null && Number.isFinite(comfort) ? comfort : null,
    match: result.personalMatchScore ?? explained.personalMatchScore,
    percentile: result.cityPercentile ?? explained.cityPercentile,
    confidence: result.confidence ?? explained.confidence,
    explainText: explained.text,
    rentEurM2: Number.isFinite(rent) && rent > 0 ? rent : null,
    priceLines: [
      formatPriceLine('Kaltmiete', props.rent_eur_m2, props.rent_source, props.rent_as_of),
      formatPriceLine('Angebotsmiete', props.asking_rent_eur_m2, props.asking_rent_source, props.asking_rent_as_of),
      formatPriceLine('Kaufpreis', props.sale_eur_m2, props.sale_source, props.sale_as_of),
    ].filter((line): line is string => line != null),
    pillars: HEX_PILLAR_FACTS.map((row) => {
      const fromProps = num(props[row.prop]);
      const fromScore = result.pillars?.[row.scoreKey];
      const val = fromProps ?? (fromScore == null || !Number.isFinite(Number(fromScore)) ? null : Number(fromScore));
      return {
        key: row.key,
        label: PILLAR_LABELS[row.labelKey] || row.labelKey,
        score: val,
      };
    }),
    walks: HEX_WALK_FACTS.map((row) => ({
      key: row.key,
      label: row.label,
      minutes: minutesOrNull(props[row.key]),
      inHex: row.countKey ? countOrNull(props[row.countKey]) : null,
      isCenter: row.key === 'center_min',
    })),
  };
}
