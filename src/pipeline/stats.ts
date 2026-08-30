export { mean, pearson, simpleReturns } from '../../web/lib/quant.js';

/**
 * Numeric helpers used only by the pipeline.
 *
 * The ones the browser also needs — `mean`, `pearson`, `simpleReturns` — live
 * in `web/lib/quant.js` and are re-exported above, so there is exactly one
 * implementation of each rather than two that agree until they don't.
 *
 * Everything here accumulates in a fixed index order so results do not vary
 * with floating point summation order between runs.
 */

/** Sample (n-1) standard deviation. Returns 0 for fewer than two points. */
export function sampleStdDev(xs: readonly number[]): number {
  const n = xs.length;
  if (n < 2) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += xs[i] as number;
  const m = sum / n;
  let ss = 0;
  for (let i = 0; i < n; i++) {
    const d = (xs[i] as number) - m;
    ss += d * d;
  }
  return Math.sqrt(ss / (n - 1));
}

/**
 * Linear-interpolated percentile over a *sorted ascending* array, matching the
 * common "type 7" convention. Pinned down explicitly because the winsorization
 * bounds must be reproducible.
 */
export function percentileSorted(sorted: readonly number[], p: number): number {
  const n = sorted.length;
  if (n === 0) return Number.NaN;
  if (n === 1) return sorted[0] as number;
  const idx = (n - 1) * Math.min(Math.max(p, 0), 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo] as number;
  const w = idx - lo;
  return (sorted[lo] as number) * (1 - w) + (sorted[hi] as number) * w;
}

export function median(xs: readonly number[]): number {
  if (xs.length === 0) return Number.NaN;
  const sorted = [...xs].sort((a, b) => a - b);
  return percentileSorted(sorted, 0.5);
}
