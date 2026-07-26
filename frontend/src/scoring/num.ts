/**
 * Safe numeric coercion — never treat null/'' as 0.
 */
export function num(
  value: unknown,
  fallback: number | null = null,
): number | null {
  if (value === null || value === undefined || value === '') {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function clamp100(v: number): number {
  return Math.max(0, Math.min(100, v));
}

/** Clamp finite numbers to 0–100; return null for non-finite. */
export function finiteScore(v: number | null | undefined): number | null {
  if (v == null || !Number.isFinite(v)) return null;
  return clamp100(v);
}
