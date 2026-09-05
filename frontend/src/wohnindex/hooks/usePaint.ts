import { useContext } from 'react';
import { PaintContext, requireWohnIndexCtx, type PaintSlice } from '../contexts';

export type { PaintSlice };

export function usePaint(): PaintSlice {
  return requireWohnIndexCtx(useContext(PaintContext), 'usePaint');
}
