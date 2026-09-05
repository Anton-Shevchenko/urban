import { useContext } from 'react';
import { DestinationsContext, requireWohnIndexCtx, type DestinationsSlice } from '../contexts';

export type { DestinationsSlice };

export function useDestinations(): DestinationsSlice {
  return requireWohnIndexCtx(useContext(DestinationsContext), 'useDestinations');
}
