import { describe, expect, it } from 'vitest';
import { clamp100, finiteScore, num } from './num';

describe('num()', () => {
  it('returns fallback for null', () => {
    expect(num(null)).toBeNull();
    expect(num(null, 7)).toBe(7);
  });

  it('returns fallback for undefined', () => {
    expect(num(undefined)).toBeNull();
    expect(num(undefined, 3)).toBe(3);
  });

  it('returns fallback for empty string', () => {
    expect(num('')).toBeNull();
    expect(num('', 1)).toBe(1);
  });

  it('parses numeric strings', () => {
    expect(num('42')).toBe(42);
  });

  it('preserves real zero', () => {
    expect(num(0)).toBe(0);
    expect(num('0')).toBe(0);
  });

  it('returns fallback for NaN', () => {
    expect(num(Number.NaN)).toBeNull();
    expect(num(Number.NaN, 9)).toBe(9);
  });

  it('returns fallback for Infinity', () => {
    expect(num(Number.POSITIVE_INFINITY)).toBeNull();
    expect(num(Number.NEGATIVE_INFINITY)).toBeNull();
  });

  it('returns fallback for non-numeric text', () => {
    expect(num('nope')).toBeNull();
    expect(num('nope', -1)).toBe(-1);
  });
});

describe('clamp100 / finiteScore', () => {
  it('clamps to 0–100', () => {
    expect(clamp100(-5)).toBe(0);
    expect(clamp100(150)).toBe(100);
    expect(clamp100(42)).toBe(42);
  });

  it('finiteScore rejects non-finite', () => {
    expect(finiteScore(null)).toBeNull();
    expect(finiteScore(Number.NaN)).toBeNull();
    expect(finiteScore(Number.POSITIVE_INFINITY)).toBeNull();
    expect(finiteScore(12)).toBe(12);
  });
});
