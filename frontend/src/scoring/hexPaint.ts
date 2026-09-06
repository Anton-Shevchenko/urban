/**
 * Off-thread hex paint scoring. Rebuilds the existing engine and returns
 * typed arrays so the map can mutate live GeoJSON without scoring on the
 * main-thread paint path.
 */

import { createScoringEngine } from './engine';
import type { PipelinePoint, ScoringContext } from './types';

const PRIMARY_PAINT_VIEWS = new Set([
  'comfort',
  'living',
  'objective',
  'personal_match',
  'city_percentile',
]);

export type HexPaintInput = {
  ctx: ScoringContext;
  hexes: PipelinePoint[];
  paintMapView: string;
};

export type HexPaintOutput = {
  scores: Float32Array;
  passed: Uint8Array;
};

export function isPrimaryPaintView(paintMapView: string | null | undefined): boolean {
  return !paintMapView || PRIMARY_PAINT_VIEWS.has(paintMapView);
}

export function isStreetOverlayView(paintMapView: string | null | undefined): boolean {
  return paintMapView === 'cycleways';
}

/** Drop non-cloneable Maps so the context can be posted to a worker. */
export function serializeScoringContext(ctx: ScoringContext): ScoringContext {
  return {
    weights: { ...ctx.weights },
    prefTargets: { ...ctx.prefTargets },
    prefInclude: ctx.prefInclude,
    pillarWeights: { ...ctx.pillarWeights },
    groupMultipliers: { ...ctx.groupMultipliers },
    affordabilityFocus: ctx.affordabilityFocus,
    activeProfile: ctx.activeProfile,
    _diagnoseKey: ctx._diagnoseKey,
    centerAnchors: [...ctx.centerAnchors],
    rentMin: ctx.rentMin,
    rentMax: ctx.rentMax,
    hasRent: ctx.hasRent,
    hasExtendedMetrics: ctx.hasExtendedMetrics,
    heatHasVariation: ctx.heatHasVariation,
    noiseHasVariation: ctx.noiseHasVariation,
    destinations: ctx.destinations.map((d) => ({ ...d })),
    customDestMatrix: { ...ctx.customDestMatrix },
    dailyNeedsCategories: { ...ctx.dailyNeedsCategories },
    desiredAreaM2: ctx.desiredAreaM2,
    maxMonthlyBudget: ctx.maxMonthlyBudget,
    scoringMode: ctx.scoringMode,
    matchPrefs: { ...ctx.matchPrefs },
    mapMetricMode: ctx.mapMetricMode,
  };
}

export function scoreHexPaint(input: HexPaintInput): HexPaintOutput {
  const hexes = input.hexes;
  const engine = createScoringEngine(
    input.ctx,
    hexes.map((properties) => ({ properties })),
  );
  const paintMapView = input.paintMapView;
  const primary = isPrimaryPaintView(paintMapView);
  const pillarKey = paintMapView === 'housing_value' ? 'housing_affordability' : paintMapView;
  const scores = new Float32Array(hexes.length);
  const passed = new Uint8Array(hexes.length);

  for (let i = 0; i < hexes.length; i++) {
    const src = hexes[i];
    const c = primary ? engine.comfortScalar(src) : engine.factorScalar(pillarKey, src);
    if (c != null && Number.isFinite(c)) {
      scores[i] = c;
      passed[i] = 1;
    } else {
      scores[i] = Number.NaN;
      passed[i] = 0;
    }
  }

  return { scores, passed };
}
