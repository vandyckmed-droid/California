/**
 * Small numeric helpers shared by the scoring stages. Every one of these
 * accumulates in a fixed index order so results do not vary with floating
 * point summation order between runs.
 */

/** Sample (n-1) standard deviation. Returns 0 for fewer than two points. */
export function sampleStdDev(xs: readonly number[]): number {
  const n = xs.length;
  if (n < 2) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += xs[i] as number;
  const mean = sum / n;
  let ss = 0;
  for (let i = 0; i < n; i++) {
    const d = (xs[i] as number) - mean;
    ss += d * d;
  }
  return Math.sqrt(ss / (n - 1));
}

export function mean(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < xs.length; i++) sum += xs[i] as number;
  return sum / xs.length;
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

/** Pearson correlation. Returns 0 when either series has no variance. */
export function pearson(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;
  const ma = mean(a.slice(0, n));
  const mb = mean(b.slice(0, n));
  let cov = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < n; i++) {
    const da = (a[i] as number) - ma;
    const db = (b[i] as number) - mb;
    cov += da * db;
    va += da * da;
    vb += db * db;
  }
  if (va <= 0 || vb <= 0) return 0;
  return cov / Math.sqrt(va * vb);
}

/** Simple daily returns from a close series. */
export function simpleReturns(closes: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const prev = closes[i - 1] as number;
    if (prev > 0) out.push((closes[i] as number) / prev - 1);
  }
  return out;
}
