import { useContext } from 'react';
import { WeightsContext, requireWohnIndexCtx, type WeightsSlice } from '../contexts';

export type { WeightsSlice };

export function useWeights(): WeightsSlice {
  return requireWohnIndexCtx(useContext(WeightsContext), 'useWeights');
}
