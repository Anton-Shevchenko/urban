import type { PipelinePoint, ScoringContext } from '../scoring/types';

export type HexPaintRequest = {
  requestId: number;
  ctx: ScoringContext;
  hexes: PipelinePoint[];
  paintMapView: string;
};

export type HexPaintResult = {
  requestId: number;
  scores: Float32Array;
  passed: Uint8Array;
};
