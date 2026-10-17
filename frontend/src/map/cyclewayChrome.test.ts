import { describe, expect, it } from 'vitest';
import { cityNameFromQuery } from './useCyclewaySearch';
import { displayCityChrome, hexGridSummary } from './cyclewayChrome';

describe('hexGridSummary', () => {
  it('formats a real grid', () => {
    expect(hexGridSummary({ count: 420, h3_res: 9 }, 0)).toBe('420 Hexagone · H3 res 9');
  });

  it('hides a missing resolution instead of a broken count', () => {
    expect(hexGridSummary({ count: 1 }, 1)).toBeNull();
    expect(hexGridSummary({ h3_res: 9, count: 0 }, 0)).toBeNull();
  });

  it('falls back to the loaded feature count', () => {
    expect(hexGridSummary({ h3_res: 8 }, 12)).toBe('12 Hexagone · H3 res 8');
  });
});

describe('displayCityChrome', () => {
  const muenchen = { count: 1, h3_res: 9 as number | undefined, city_type: 'METROPOLIS' };

  it('names the selected cycleway city and hides another city’s hex grid and type', () => {
    const chrome = displayCityChrome({
      mapView: 'cycleways',
      wohnindexName: 'München',
      wohnindexSlug: 'muenchen',
      cyclewayName: 'Freising',
      cyclewaySlug: 'freising',
      meta: muenchen,
      featureCount: 1,
    });
    expect(chrome).toEqual({ cityName: 'Freising', hexSummary: null, cityType: null });
  });

  it('keeps the hex line when the cycleway city is the loaded grid', () => {
    const chrome = displayCityChrome({
      mapView: 'cycleways',
      wohnindexName: 'München',
      wohnindexSlug: 'muenchen',
      cyclewayName: 'München',
      cyclewaySlug: 'muenchen',
      meta: muenchen,
      featureCount: 1,
    });
    expect(chrome.hexSummary).toBe('1 Hexagone · H3 res 9');
    expect(chrome.cityType).toBe('METROPOLIS');
  });

  it('returns to the Wohnindex city outside the cycleway view', () => {
    const chrome = displayCityChrome({
      mapView: 'objective',
      wohnindexName: 'München',
      wohnindexSlug: 'muenchen',
      cyclewayName: 'Freising',
      cyclewaySlug: 'freising',
      meta: muenchen,
      featureCount: 1,
    });
    expect(chrome.cityName).toBe('München');
    expect(chrome.hexSummary).toBe('1 Hexagone · H3 res 9');
    expect(chrome.cityType).toBe('METROPOLIS');
  });
});

describe('cityNameFromQuery', () => {
  it('uses the place name ahead of the state', () => {
    expect(cityNameFromQuery('Freising, Bayern')).toBe('Freising');
  });
});
