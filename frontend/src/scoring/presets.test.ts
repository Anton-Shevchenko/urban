/**
 * Infra-only: every preset is 100% daily_life. Personal match must still
 * renormalise, and must not drift from LIVING_WEIGHTS.
 */
import { describe, expect, it } from 'vitest';

import { PRESETS, extractPillarWeights } from './formulas';
import { LIVING_WEIGHTS, PERSONAL_PILLAR_KEYS } from './objective';

describe('personal match presets', () => {
  it('renormalise to 1 over the personal pillars', () => {
    for (const [name, preset] of Object.entries(PRESETS)) {
      const weights = extractPillarWeights(preset);
      const sum = PERSONAL_PILLAR_KEYS.reduce((acc, key) => acc + weights[key], 0);
      expect(sum, name).toBeCloseTo(1, 9);
    }
  });

  it('standard is the neutral default weight set', () => {
    for (const key of PERSONAL_PILLAR_KEYS) {
      expect(PRESETS.standard[key], key).toBe(LIVING_WEIGHTS[key]);
    }
  });

  it('all personal-match presets are infrastructure-only', () => {
    for (const [name, preset] of Object.entries(PRESETS)) {
      expect(preset.daily_life, name).toBe(1);
      expect(preset.walk, name).toBe(0);
      expect(preset.housing_affordability, name).toBe(0);
    }
  });
});
