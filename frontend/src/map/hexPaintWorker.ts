import { scoreHexPaint } from '../scoring/hexPaint';
import type { HexPaintRequest, HexPaintResult } from './hexPaintWorker.types';

type PaintWorker = {
  onmessage: ((event: MessageEvent<HexPaintRequest>) => void) | null;
  postMessage: (message: HexPaintResult, transfer: Transferable[]) => void;
};

const worker = self as unknown as PaintWorker;

worker.onmessage = (event: MessageEvent<HexPaintRequest>) => {
  const { requestId, ctx, hexes, paintMapView } = event.data;
  const { scores, passed } = scoreHexPaint({ ctx, hexes, paintMapView });
  const result: HexPaintResult = { requestId, scores, passed };
  worker.postMessage(result, [scores.buffer, passed.buffer]);
};
