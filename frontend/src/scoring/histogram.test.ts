import { describe, expect, it } from 'vitest';
import { buildHistogram, summarizeScores } from './histogram';

describe('histogram', () => {
  it('bins scores into 10 equal bands', () => {
    const vals = [0, 5, 15, 25, 35, 45, 55, 65, 75, 85, 95, 100];
    const bins = buildHistogram(vals);
    expect(bins).toHaveLength(10);
    expect(bins.every((b) => b.count === 1 || b.count === 2)).toBe(true);
    expect(bins[0]!.count).toBe(2); // 0, 5
    expect(bins[9]!.count).toBe(2); // 95, 100
  });

  it('summarizes mean and percentiles', () => {
    const dist = summarizeScores('green', 'Grün', [10, 20, 30, 40, 50]);
    expect(dist).not.toBeNull();
    expect(dist!.mean).toBe(30);
    expect(dist!.p50).toBe(30);
    expect(dist!.n).toBe(5);
    expect(dist!.ge70).toBe(0);
    expect(dist!.lt30).toBe(40);
  });

  it('returns null for empty input', () => {
    expect(summarizeScores('x', 'X', [])).toBeNull();
  });
});
