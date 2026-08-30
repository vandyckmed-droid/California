/**
 * Correlation grouping. The implementation now lives in `web/lib/quant.js`,
 * which the browser also imports — the watchlist groups the user's selection
 * client-side, and two copies of this would drift.
 *
 * Re-exported here so the pipeline's imports stay where readers expect them.
 */
export { completeLinkageGroups } from '../../web/lib/quant.js';

export interface Group {
  /** Indices into the ranked list, ascending — i.e. in momentum-rank order. */
  members: number[];
  /** Lowest pairwise correlation inside the group; 1 for a solo name. */
  minCorr: number;
  /** Best (lowest) rank index in the group, used to order groups. */
  bestRank: number;
  /**
   * Pairwise correlations between members, aligned with `members`. Populated
   * downstream for the detail screen; the clustering itself does not use it.
   */
  corr?: number[][];
}
