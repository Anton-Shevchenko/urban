import { useContext } from 'react';
import { CityDataContext, requireWohnIndexCtx, type CityDataSlice } from '../contexts';

export type { CityDataSlice };

export function useCityData(): CityDataSlice {
  return requireWohnIndexCtx(useContext(CityDataContext), 'useCityData');
}
