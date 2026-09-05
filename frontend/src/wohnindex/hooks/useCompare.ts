import { useContext } from 'react';
import { CompareContext, requireWohnIndexCtx, type CompareSlice } from '../contexts';

export type { CompareSlice };

export function useCompare(): CompareSlice {
  return requireWohnIndexCtx(useContext(CompareContext), 'useCompare');
}
