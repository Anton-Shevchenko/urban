import { describe, expect, it } from 'vitest';
import type { Feature } from 'geojson';
import {
  buildHexInfoModel,
  countOrNull,
  formatAmenityPresence,
  mergeCityHexProps,
  minutesOrNull,
} from './hexInfoModel';

const props = {
  h3: 'hex-m',
  s_living: 71,
  s_daily_life: 71,
  s_walk: 64,
  s_green: 40,
  s_transit: 70,
  s_quiet: 38,
  s_housing_affordability: 46,
  s_center: 62,
  dn_supermarket_min: 6,
  dn_pharmacy_min: 8,
  dn_school_min: 99,
  dn_kita_min: 0,
  dn_kita_n: 2,
  dn_supermarket_n: 0,
  dn_doctor_min: 4,
  dn_playground_min: 0,
  rent_eur_m2: 18.5,
};

describe('minutesOrNull', () => {
  it('drops missing and 90+ minute walks', () => {
    expect(minutesOrNull(6)).toBe(6);
    expect(minutesOrNull(99)).toBeNull();
    expect(minutesOrNull(undefined)).toBeNull();
  });
});

describe('formatAmenityPresence', () => {
  it('says hier instead of 0 minutes when the POI is in the hex', () => {
    expect(
      formatAmenityPresence({
        key: 'dn_kita_min',
        label: 'Kita',
        minutes: 0,
        inHex: 2,
        isCenter: false,
      }),
    ).toBe('2 hier');
    expect(
      formatAmenityPresence({
        key: 'dn_kita_min',
        label: 'Kita',
        minutes: 0,
        inHex: null,
        isCenter: false,
      }),
    ).toBe('hier');
  });

  it('says keine plus walk time when nothing is in the hex', () => {
    expect(
      formatAmenityPresence({
        key: 'dn_supermarket_min',
        label: 'Supermarkt',
        minutes: 6,
        inHex: 0,
        isCenter: false,
      }),
    ).toBe('keine · 6 Min.');
  });
});

describe('mergeCityHexProps', () => {
  it('fills pillar scores from the loaded city feature', () => {
    const features: Feature[] = [
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [0, 0] },
        properties: { h3: 'hex-m', s_green: 40, s_transit: 70, s_quiet: 38 },
      },
    ];
    const merged = mergeCityHexProps({ h3: 'hex-m', s_daily_life: 90 }, features);
    expect(merged.s_green).toBe(40);
    expect(merged.s_transit).toBe(70);
    expect(merged.s_daily_life).toBe(90);
  });
});

describe('buildHexInfoModel', () => {
  it('lists fact-sheet walk minutes, in-hex counts, and rent', () => {
    const info = buildHexInfoModel(props, 'München');
    expect(info.h3).toBe('hex-m');
    expect(info.walks.find((w) => w.key === 'dn_supermarket_min')?.inHex).toBe(0);
    expect(info.walks.find((w) => w.key === 'dn_kita_min')?.inHex).toBe(2);
    expect(info.walks.find((w) => w.key === 'dn_school_min')?.minutes).toBeNull();
    expect(info.priceLines.some((line) => line.startsWith('Kaltmiete:'))).toBe(true);
    expect(countOrNull(2.4)).toBe(2);
  });

  it('hides a price that was not published', () => {
    const info = buildHexInfoModel({ ...props, rent_eur_m2: null }, 'München');
    expect(info.priceLines).toEqual([]);
  });

  it('prints source, date, and resolution without mixing sale into rent', () => {
    const info = buildHexInfoModel(
      {
        ...props,
        rent_eur_m2: 11.4,
        rent_source: 'Zensus 2022, 100 m, fortgeschrieben bis 2026-08',
        rent_as_of: '2026-08',
        asking_rent_eur_m2: null,
        sale_eur_m2: 5251,
        sale_source: 'Gutachterausschuss Berlin, Stadt',
        sale_as_of: '2024',
      },
      'Berlin',
    );
    expect(info.priceLines).toEqual([
      'Kaltmiete: 11,4 €/m² · Zensus 2022, 100 m, fortgeschrieben bis 2026-08',
      'Kaufpreis: 5.251 €/m² · Gutachterausschuss Berlin, Stadt, 2024',
    ]);
  });

  it('lists ÖPNV, Grün and Ruhe from hex_fact_sheet pillars', () => {
    const info = buildHexInfoModel(props, 'München');
    const byKey = Object.fromEntries(info.pillars.map((p) => [p.key, p]));
    expect(byKey.green?.label).toBe('Grün');
    expect(byKey.green?.score).toBe(40);
    expect(byKey.transit?.label).toBe('ÖPNV');
    expect(byKey.transit?.score).toBe(70);
    expect(byKey.quiet?.label).toBe('Ruhe');
    expect(byKey.quiet?.score).toBe(38);
  });
});
