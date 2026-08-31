import { pearson } from '../../pipeline/stats.ts';
import {
  REDUNDANT_PATH_CORR,
  REDUNDANT_PATH_RMS,
  REDUNDANT_RETURN_CORR,
} from './config.ts';

/**
 * The standing check on the universe.
 *
 * The point of this ETF set is that each member is a different economic bet, so
 * the run re-measures that claim every time rather than trusting the list. Two
 * funds are redundant here only if they are redundant on both axes at once:
 *
 *  - **Returns.** Their daily moves are the same move.
 *  - **Path.** The blended cross-sectional score — the line actually drawn —
 *    traces the same shape, closely enough that the second line adds no
 *    picture.
 *
 * Either axis alone is a false positive with a known cause. XOP and XES have
 * the most correlated daily returns in this universe (0.81) and still swap
 * leadership by more than a full z at times, because oil producers and the
 * companies that drill for them are on different parts of the same cycle —
 * exactly the rotation this screen exists to show. In the other direction XAR
 * and URA drifted along nearly identical paths for the drawn year (path
 * correlation 0.95) on daily returns correlated only 0.63; aerospace and
 * uranium are not one bet, they had one similar year.
 */

export interface PairStat {
  a: string;
  b: string;
  /** Pearson correlation of daily returns over the whole fetched history. */
  returnCorr: number;
  /** Pearson correlation of the two drawn blended-score paths. */
  pathCorr: number;
  /** Root-mean-square gap between those paths, in z units. */
  pathRms: number;
  /** True when the pair clears both bars and is proposed for removal. */
  redundant: boolean;
}

/**
 * Pair statistics for every combination, most redundant first.
 *
 * Ordering is by `pathRms` ascending — how far apart the two drawn lines
 * actually sit — with the symbol pair as a tie-break so the report is stable
 * between runs.
 *
 * @param symbols     Names, in a fixed order.
 * @param returns     Daily returns per name, aligned to a common calendar.
 * @param paths       Drawn blended score per name per session; nulls are skipped.
 */
export function pairStats(
  symbols: readonly string[],
  returns: ReadonlyMap<string, readonly number[]>,
  paths: ReadonlyMap<string, readonly (number | null)[]>,
): PairStat[] {
  const out: PairStat[] = [];
  for (let i = 0; i < symbols.length; i++) {
    for (let j = i + 1; j < symbols.length; j++) {
      const a = symbols[i] as string;
      const b = symbols[j] as string;
      const ra = returns.get(a) ?? [];
      const rb = returns.get(b) ?? [];
      const returnCorr = ra.length > 1 && ra.length === rb.length ? pearson(ra, rb) : Number.NaN;

      // Only sessions where both paths exist, so a name with a late start is
      // compared over the stretch the two actually share.
      const pa: number[] = [];
      const pb: number[] = [];
      const va = paths.get(a) ?? [];
      const vb = paths.get(b) ?? [];
      for (let k = 0; k < Math.min(va.length, vb.length); k++) {
        const x = va[k];
        const y = vb[k];
        if (x == null || y == null) continue;
        pa.push(x);
        pb.push(y);
      }
      const pathCorr = pa.length > 1 ? pearson(pa, pb) : Number.NaN;
      let ss = 0;
      for (let k = 0; k < pa.length; k++) ss += ((pa[k] as number) - (pb[k] as number)) ** 2;
      const pathRms = pa.length > 0 ? Math.sqrt(ss / pa.length) : Number.NaN;

      out.push({
        a,
        b,
        returnCorr,
        pathCorr,
        pathRms,
        redundant:
          returnCorr >= REDUNDANT_RETURN_CORR &&
          pathCorr >= REDUNDANT_PATH_CORR &&
          pathRms <= REDUNDANT_PATH_RMS,
      });
    }
  }
  out.sort((x, y) => x.pathRms - y.pathRms || (x.a < y.a ? -1 : x.a > y.a ? 1 : x.b < y.b ? -1 : 1));
  return out;
}
