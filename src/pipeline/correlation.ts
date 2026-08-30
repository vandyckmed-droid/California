import type { AlignedSeries } from './calendar.ts';
import { pearson } from './stats.ts';

/**
 * Daily simple returns over the trailing correlation window, for one name.
 * Returns null when the window is not fully covered, which the caller treats
 * as "cannot be grouped" rather than as a reason to alter the ranking.
 */
export function windowReturns(series: AlignedSeries, L: number, window: number): number[] | null {
  const from = L - window;
  if (from < 0) return null;
  const out: number[] = [];
  for (let i = from + 1; i <= L; i++) {
    const prev = series.closes[i - 1];
    const cur = series.closes[i];
    if (prev == null || cur == null || !(prev > 0)) return null;
    out.push(cur / prev - 1);
  }
  return out;
}

/**
 * Symmetric Pearson correlation matrix over `returns`, indexed the same way as
 * the caller's symbol list. Accumulated in fixed index order so the matrix is
 * bit-identical between runs.
 */
export function correlationMatrix(returns: readonly (readonly number[])[]): number[][] {
  const n = returns.length;
  const C: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(1));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const r = pearson(returns[i] as number[], returns[j] as number[]);
      C[i]![j] = r;
      C[j]![i] = r;
    }
  }
  return C;
}
