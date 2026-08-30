import { WINSOR_LOWER_PCT, WINSOR_UPPER_PCT } from '../config.ts';
import { percentileSorted, sampleStdDev } from './stats.ts';

/**
 * Clips values to the given percentile bounds of their own cross-section.
 *
 * This matters because the momentum cross-section is heavily right-skewed — in
 * a live run the strongest 12-1 name was +2542% against a far lower median.
 * Without clipping, one name's z-score would dominate the blended average and
 * the other two horizons would stop mattering.
 */
export function winsorize(
  values: readonly number[],
  lowerPct: number = WINSOR_LOWER_PCT,
  upperPct: number = WINSOR_UPPER_PCT,
): number[] {
  if (values.length === 0) return [];
  const sorted = [...values].sort((a, b) => a - b);
  const lo = percentileSorted(sorted, lowerPct);
  const hi = percentileSorted(sorted, upperPct);
  return values.map((v) => (v < lo ? lo : v > hi ? hi : v));
}

/** Z-scores a vector. A zero-variance cross-section maps to all zeros. */
export function zScore(values: readonly number[]): number[] {
  const n = values.length;
  if (n === 0) return [];
  let sum = 0;
  for (let i = 0; i < n; i++) sum += values[i] as number;
  const mu = sum / n;
  const sd = sampleStdDev(values);
  if (!(sd > 0)) return values.map(() => 0);
  return values.map((v) => (v - mu) / sd);
}

/**
 * The cross-sectional normalization used before blending: winsorize, then
 * z-score. Placing each horizon on a mean-0/sd-1 scale is what stops the
 * longest horizon from dominating the blend simply because it spans more time
 * and therefore has larger raw returns.
 *
 * Note this is a monotonic transform, so it does not reorder a single horizon —
 * it only affects how horizons combine.
 */
export function crossSectionalNormalize(values: readonly number[]): number[] {
  return zScore(winsorize(values));
}
