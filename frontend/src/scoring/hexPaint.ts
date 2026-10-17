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

/** Hex fill of observed city-relative Kaltmiete. Not a street overlay. */
export function isRentFillView(paintMapView: string | null | undefined): boolean {
  return paintMapView === 'price';
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
  const paintMapView = input.paintMapView;
  const rentFill = isRentFillView(paintMapView);
  const engine = createScoringEngine(
    rentFill
      ? { ...input.ctx, mapMetricMode: 'price', scoringMode: 'living', _diagnoseKey: null }
      : input.ctx,
    hexes.map((properties) => ({ properties })),
  );
  const primary = isPrimaryPaintView(paintMapView);
  const pillarKey = paintMapView;
  const scores = new Float32Array(hexes.length);
  const passed = new Uint8Array(hexes.length);

  for (let i = 0; i < hexes.length; i++) {
    const src = hexes[i];
    // Rent fill goes through comfortScalar so a budget still dims the
    // city-relative score instead of hiding the hex grid.
    const c = primary || rentFill ? engine.comfortScalar(src) : engine.factorScalar(pillarKey, src);
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
