import { useContext } from 'react';
import { MapViewContext, requireWohnIndexCtx, type MapViewSlice } from '../contexts';

export type { MapViewSlice };

export function useMapViewState(): MapViewSlice {
  return requireWohnIndexCtx(useContext(MapViewContext), 'useMapViewState');
}
