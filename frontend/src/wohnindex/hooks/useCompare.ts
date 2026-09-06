import { useContext } from 'react';
import { CompareContext, type CompareSlice } from '../contexts';

export type { CompareSlice };

export function useCompare(): CompareSlice {
  const value = useContext(CompareContext);
  if (value == null) throw new Error('useCompare must be used within CompareSessionProvider');
  return value;
}
