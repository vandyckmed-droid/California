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
 * Symmetric Pearson correlation matrix. Implementation shared with the
 * browser via `web/lib/quant.js`, so the watchlist and the pipeline compute
 * correlations the same way by construction rather than by agreement.
 */
export { correlationMatrix } from '../../web/lib/quant.js';
