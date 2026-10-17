import { describe, expect, it } from 'vitest';
import type { Feature } from 'geojson';
import { locationScore } from '../scoring/locationScore';
import {
  MAX_COMPARE,
  compareItemId,
  compareListHas,
  itemBelongsToCity,
  migrateCompareItems,
  snapshotHexProps,
  addCompareList,
  chatHexFromItem,
  toggleCompareList,
} from './compareSnapshot';

function hexFeature(
  h3: string,
  props: Record<string, unknown> = {},
  ring: number[][] = [
    [11, 48],
    [11.2, 48],
    [11.2, 48.2],
    [11, 48.2],
    [11, 48],
  ],
): Feature {
  return {
    type: 'Feature',
    properties: { h3, ...props },
    geometry: { type: 'Polygon', coordinates: [ring] },
  };
}

const dailyLifeProps = {
  dn_supermarket_min: 6,
  dn_supermarket_avail: 90,
  dn_bakery_min: 4,
  dn_bakery_avail: 100,
  dn_market_min: 20,
  dn_market_avail: 20,
  dn_pharmacy_min: 8,
  dn_pharmacy_avail: 80,
  dn_doctor_min: 10,
  dn_doctor_avail: 70,
  dn_clinic_min: 25,
  dn_clinic_avail: 30,
  dn_kita_min: 5,
  dn_kita_avail: 100,
  dn_school_min: 10,
  dn_school_avail: 70,
  dn_administration_min: 12,
  dn_administration_avail: 50,
  dn_bank_min: 8,
  dn_bank_avail: 90,
  dn_post_min: 6,
  dn_post_avail: 90,
  dn_restaurant_min: 5,
  dn_restaurant_avail: 100,
  dn_cafe_min: 8,
  dn_cafe_avail: 90,
  dn_sports_min: 10,
  dn_sports_avail: 80,
  dn_playground_min: 5,
  dn_playground_avail: 100,
  s_daily_life: 72,
  rent_eur_m2: 18.5,
};

describe('toggleCompareList', () => {
  it('keeps hexes from different cities side by side', () => {
    const munich = hexFeature('hex-m', dailyLifeProps);
    const berlin = hexFeature('hex-b', { ...dailyLifeProps, rent_eur_m2: 12 });
    let list = toggleCompareList([], munich, { citySlug: 'muenchen', cityName: 'München' });
    list = toggleCompareList(list, berlin, { citySlug: 'berlin', cityName: 'Berlin' });
    expect(list).toHaveLength(2);
    expect(list.map((i) => i.id)).toEqual([
      compareItemId('muenchen', 'hex-m'),
      compareItemId('berlin', 'hex-b'),
    ]);
    expect(compareListHas(list, 'muenchen', 'hex-m')).toBe(true);
    expect(compareListHas(list, 'berlin', 'hex-b')).toBe(true);
  });

  it('toggles the same city hex off without dropping the other city', () => {
    const munich = hexFeature('hex-m', dailyLifeProps);
    const berlin = hexFeature('hex-b', dailyLifeProps);
    let list = toggleCompareList([], munich, { citySlug: 'muenchen', cityName: 'München' });
    list = toggleCompareList(list, berlin, { citySlug: 'berlin', cityName: 'Berlin' });
    list = toggleCompareList(list, munich, { citySlug: 'muenchen', cityName: 'München' });
    expect(list).toHaveLength(1);
    expect(list[0].citySlug).toBe('berlin');
  });

  it('snapshots the canonical pillar so the hex still scores after the city unloads', () => {
    const feature = hexFeature('hex-m', dailyLifeProps);
    const [item] = toggleCompareList([], feature, { citySlug: 'muenchen', cityName: 'München' });
    expect(item.props.dn_supermarket_min).toBe(6);
    expect(item.props.s_daily_life).toBe(72);
    expect(item.pricePerM2).toBe(18.5);
    expect(item.lng).toBeCloseTo(11.1);
    expect(item.lat).toBeCloseTo(48.1);
    const score = locationScore(item.props);
    expect(score.objectiveScore).toBe(72);
  });

  it('does not invent an objective score from walk minutes alone', () => {
    const minutesOnly: Record<string, unknown> = { ...dailyLifeProps };
    delete minutesOnly.s_daily_life;
    const score = locationScore(snapshotHexProps(minutesOnly));
    expect(score.objectiveScore).toBeNull();
  });

  it('caps the list instead of dropping older cities', () => {
    let list = toggleCompareList([], hexFeature('keep'), {
      citySlug: 'muenchen',
      cityName: 'München',
    });
    for (let i = 0; i < MAX_COMPARE; i += 1) {
      list = toggleCompareList(list, hexFeature(`n${i}`), {
        citySlug: 'berlin',
        cityName: 'Berlin',
      });
    }
    expect(list).toHaveLength(MAX_COMPARE);
    expect(list[0].citySlug).toBe('muenchen');
  });
});

describe('chatHexFromItem', () => {
  it('copies living score from snapshot props', () => {
    const [item] = addCompareList([], hexFeature('hex-m', dailyLifeProps), {
      citySlug: 'muenchen',
      cityName: 'München',
    });
    const chat = chatHexFromItem(item);
    expect(chat).toMatchObject({
      h3: 'hex-m',
      citySlug: 'muenchen',
      cityName: 'München',
      livingScore: null,
    });
    expect(chat?.props?.dn_supermarket_min).toBe(6);
  });
});

describe('addCompareList', () => {
  it('keeps a second click on the same hex instead of removing it', () => {
    const munich = hexFeature('hex-m', dailyLifeProps);
    let list = addCompareList([], munich, { citySlug: 'muenchen', cityName: 'München' });
    list = addCompareList(list, munich, { citySlug: 'muenchen', cityName: 'München' });
    expect(list).toHaveLength(1);
  });

  it('adds hexes from another city without dropping the first', () => {
    const munich = hexFeature('hex-m', dailyLifeProps);
    const cologne = hexFeature('hex-k', dailyLifeProps);
    let list = addCompareList([], munich, { citySlug: 'muenchen', cityName: 'München' });
    list = addCompareList(list, cologne, { citySlug: 'koeln', cityName: 'Köln' });
    expect(list.map((i) => i.citySlug)).toEqual(['muenchen', 'koeln']);
  });
});

describe('snapshotHexProps', () => {
  it('keeps scalars and drops nested objects', () => {
    expect(
      snapshotHexProps({
        s_daily_life: 71,
        nested: { no: true },
        ok: 'yes',
        flag: false,
      }),
    ).toEqual({ s_daily_life: 71, ok: 'yes', flag: false });
  });
});

describe('migrateCompareItems', () => {
  it('accepts legacy rows that only stored cityName', () => {
    const items = migrateCompareItems([
      { id: 'München:abc', cityName: 'München', h3: 'abc', props: { s_daily_life: 40 } },
    ]);
    expect(items).toHaveLength(1);
    expect(items[0].cityName).toBe('München');
    expect(items[0].h3).toBe('abc');
    expect(itemBelongsToCity(items[0], 'muenchen', 'München')).toBe(true);
  });
});
