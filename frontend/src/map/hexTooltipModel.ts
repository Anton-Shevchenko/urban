import type { MapLayerMouseEvent } from 'maplibre-gl';
import { FACTOR_LABELS } from '../scoring/engine';
import { explainLivingScore, pillarBreakdownRows } from '../scoring/explain';
import { voiTooltipModel, type VoiTooltipModel } from '../scoring/valueOpportunity';
import type { ScoringEngine } from '../scoring/types';
import { formatPriceLine } from './hexInfoModel';

export type HexTooltipPillar = { label: string; score: number };

export type HexTooltipModel = {
  x: number;
  y: number;
  insufficient: boolean;
  missingData: string[];
  modeLabel: string;
  headlineScore: string;
  headlineLabel: string;
  objective: string;
  match: string;
  percentile: string;
  confidence: number;
  explainText: string;
  caption: string;
  insufficientTitle: string;
  insufficientDetail: string;
  pillars: HexTooltipPillar[];
  voi: VoiTooltipModel | null;
};

export function buildHexTooltipModel(
  e: MapLayerMouseEvent,
  engine: ScoringEngine,
  paintMapView: string,
  showHiddenGems: boolean,
): HexTooltipModel | null {
  const f = e.features?.[0];
  if (!f) return null;
  const p = f.properties as Record<string, unknown>;
  const weights = engine.getPillarWeights?.();
  const focus = engine.getAffordabilityFocus?.() ?? 0;
  const loc = engine.locationScore ? engine.locationScore(p) : engine.livingScore(p);
  const explained = explainLivingScore(p, weights, focus);
  const engineMode = String(engine.getMapMetricMode?.() ?? '');
  const modeRaw = engineMode && engineMode !== 'objective'
    ? engineMode
    : String(paintMapView || engineMode || 'objective');
  const modeLabel =
    modeRaw === 'objective' || modeRaw === 'comfort' || modeRaw === 'living'
      ? 'Infrastruktur'
      : modeRaw === 'personal_match'
        ? 'Your Match'
        : modeRaw === 'city_percentile'
          ? 'City percentile'
          : (FACTOR_LABELS[modeRaw.replace(/^pillar:/, '')] || modeRaw);

  const overlayKey = modeRaw.replace(/^pillar:/, '');
  const overlayScore = overlayKey !== 'objective'
    && overlayKey !== 'personal_match'
    && overlayKey !== 'city_percentile'
    && overlayKey !== 'comfort'
    && overlayKey !== 'living'
    ? engine.factorScalar(overlayKey, p)
    : null;
  const rentKnown = overlayScore != null && Number.isFinite(overlayScore);
  const headlineScore = rentKnown
    ? String(Math.round(overlayScore))
    : (loc.objectiveScore != null ? String(Math.round(loc.objectiveScore)) : '—');
  const headlineLabel = rentKnown ? modeLabel : 'Infrastruktur';
  const x = e.point.x + 14;
  const y = e.point.y + 14;
  const confidence = Math.round((loc.confidence ?? 0) * 100);
  const priceCaption = modeRaw === 'price'
    ? (formatPriceLine('Kaltmiete', p.rent_eur_m2, p.rent_source, p.rent_as_of) ?? '')
    : '';

  if (modeRaw === 'price' && !rentKnown) {
    return {
      x,
      y,
      insufficient: true,
      missingData: [],
      modeLabel,
      headlineScore: '—',
      headlineLabel: modeLabel,
      objective: loc.objectiveScore != null ? String(Math.round(loc.objectiveScore)) : '—',
      match: loc.personalMatchScore != null ? String(Math.round(loc.personalMatchScore)) : '—',
      percentile: loc.cityPercentile != null ? String(Math.round(loc.cityPercentile)) : '—',
      confidence,
      explainText: '',
      caption: '',
      insufficientTitle: 'Keine Beobachtung',
      insufficientDetail: 'Für dieses Hexagon liegt keine Kaltmiete vor.',
      pillars: [],
      voi: null,
    };
  }

  if (loc.objectiveScore == null && (modeRaw === 'objective' || modeRaw === 'comfort' || modeRaw === 'living')) {
    return {
      x,
      y,
      insufficient: true,
      missingData: loc.missingData?.slice(0, 4) ?? [],
      modeLabel,
      headlineScore: '—',
      headlineLabel: modeLabel,
      objective: '—',
      match: '—',
      percentile: '—',
      confidence,
      explainText: '',
      caption: '',
      insufficientTitle: 'Insufficient data',
      insufficientDetail: '',
      pillars: [],
      voi: null,
    };
  }

  return {
    x,
    y,
    insufficient: false,
    missingData: [],
    modeLabel,
    headlineScore,
    headlineLabel,
    objective: loc.objectiveScore != null ? String(Math.round(loc.objectiveScore)) : '—',
    match: loc.personalMatchScore != null ? String(Math.round(loc.personalMatchScore)) : '—',
    percentile: loc.cityPercentile != null ? String(Math.round(loc.cityPercentile)) : '—',
    confidence,
    explainText: explained.text,
    caption: priceCaption,
    insufficientTitle: '',
    insufficientDetail: '',
    pillars: pillarBreakdownRows(explained.pillars),
    voi: showHiddenGems ? voiTooltipModel(p) : null,
  };
}
