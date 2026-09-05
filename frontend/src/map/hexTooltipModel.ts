import type { MapLayerMouseEvent } from 'maplibre-gl';
import { FACTOR_LABELS } from '../scoring/engine';
import { explainLivingScore, pillarBreakdownRows } from '../scoring/explain';
import { voiTooltipModel, type VoiTooltipModel } from '../scoring/valueOpportunity';
import type { ScoringEngine } from '../scoring/types';

export type HexTooltipPillar = { label: string; score: number };

export type HexTooltipModel = {
  x: number;
  y: number;
  insufficient: boolean;
  missingData: string[];
  modeLabel: string;
  objective: string;
  match: string;
  percentile: string;
  confidence: number;
  explainText: string;
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
  const modeRaw = String(engine.getMapMetricMode?.() ?? paintMapView ?? 'objective');
  const modeLabel =
    modeRaw === 'objective' || modeRaw === 'comfort' || modeRaw === 'living'
      ? 'Infrastruktur'
      : modeRaw === 'personal_match'
        ? 'Your Match'
        : modeRaw === 'city_percentile'
          ? 'City percentile'
          : (FACTOR_LABELS[modeRaw.replace(/^pillar:/, '')] || modeRaw);

  const x = e.point.x + 14;
  const y = e.point.y + 14;
  const confidence = Math.round((loc.confidence ?? 0) * 100);

  if (loc.objectiveScore == null && (modeRaw === 'objective' || modeRaw === 'comfort' || modeRaw === 'living')) {
    return {
      x,
      y,
      insufficient: true,
      missingData: loc.missingData?.slice(0, 4) ?? [],
      modeLabel,
      objective: '—',
      match: '—',
      percentile: '—',
      confidence,
      explainText: '',
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
    objective: loc.objectiveScore != null ? String(Math.round(loc.objectiveScore)) : '—',
    match: loc.personalMatchScore != null ? String(Math.round(loc.personalMatchScore)) : '—',
    percentile: loc.cityPercentile != null ? String(Math.round(loc.cityPercentile)) : '—',
    confidence,
    explainText: explained.text,
    pillars: pillarBreakdownRows(explained.pillars),
    voi: showHiddenGems ? voiTooltipModel(p) : null,
  };
}
