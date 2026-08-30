import {
  HORIZONS,
  HORIZON_KEYS,
  MODES,
  SCORE_KEYS,
  VOL_FLOOR_ANNUALIZED,
  viewId,
  type HorizonKey,
  type Mode,
  type ScoreKey,
  type ViewId,
} from '../config.ts';
import type { AlignedSeries } from './calendar.ts';
import { horizonStats } from './momentum.ts';
import { crossSectionalNormalize } from './normalize.ts';
import { roundTo } from './snapshot.ts';
// The browser's own scorer and ranker, imported rather than reimplemented.
import { ranksFor, scoresFor } from '../../web/lib/model.js';

/**
 * Rank history for the Labs Rank River experiment.
 *
 * **Nothing in the core product reads this.** It is emitted to its own sidecar
 * file, and a failure here is caught by the caller so the snapshot is written
 * regardless.
 *
 * ## Derived, not accumulated
 *
 * The product keeps no rank history and deliberately dropped its dated
 * archive. It does not need one: a run already holds 371 aligned sessions per
 * name and a 30-session backfill reaches back 281, so the history is recomputed
 * from prices already fetched. That means no growing state in the repo, no
 * waiting for history to build up, and a wrong number is fixed by the next run
 * rather than being permanent.
 *
 * ## Why it cannot disagree with the product
 *
 * There is no second implementation of the ranking here. This module assembles
 * snapshot-shaped columns as of an earlier session using the same
 * `horizonStats` and `crossSectionalNormalize` the pipeline uses, then hands
 * them to the same `scoresFor` and `ranksFor` the browser uses. What is new is
 * only the *indexing* — which session each column is built from — and that is
 * exactly what the k=0 identity test pins down.
 *
 * ## What a backfilled rank means
 *
 * A rank against **today's eligible universe**, measured the same way, from
 * prices as of that session. Not what the screen showed that morning: market
 * cap comes from the live screener and only today's is available, and the
 * eligible set is today's. The Labs panel states this; it is a different claim
 * and must not be presented as an observed history.
 */

/** Sessions of history to backfill, including today. */
export const HISTORY_SESSIONS = 30;
/** Names per view whose history is emitted. Rank River is a top-20 object. */
export const HISTORY_TOP_N = 20;

export interface RankHistory {
  /** Session dates, oldest first, newest last. */
  sessions: string[];
  /** Eligible names ranked in the newest session. */
  universe: number;
  /** Per view, the current top N and each one's rank per session. */
  views: Record<string, { symbols: string[]; ranks: (number | null)[][] }>;
}

/** Snapshot-shaped columns for one session, as `scoresFor` expects them. */
interface SessionColumns {
  symbol: string[];
  m: number[][];
  rv: number[][];
  zr: number[][];
  zv: number[][];
}

/**
 * Builds the columns for one session over the names that have usable history
 * for it.
 *
 * The cross-section is per session by necessity: a name that had not listed
 * yet cannot be ranked, and including it would mean inventing a price. At k=0
 * every eligible name is computable — eligibility already required it — so the
 * cross-section there is the full universe and the identity check is exact.
 *
 * Rounding mirrors `buildSnapshot` because the browser ranks from the rounded
 * columns it is shipped, not from full precision. Skipping that here would
 * make the backfill disagree with the product in the last decimal place, which
 * is precisely where the symbol tie-break lives.
 */
function columnsAt(
  symbols: readonly string[],
  closes: ReadonlyMap<string, readonly (number | null)[]>,
  L: number,
): SessionColumns | null {
  const usable: string[] = [];
  const momentum: number[][] = HORIZON_KEYS.map(() => []);
  const realized: number[][] = HORIZON_KEYS.map(() => []);
  const volAdj: number[][] = HORIZON_KEYS.map(() => []);

  for (const symbol of symbols) {
    const series = closes.get(symbol);
    if (!series) continue;
    const stats = HORIZON_KEYS.map((key) => {
      const { lookback, skip } = HORIZONS[key];
      // `horizonStats` reads closes[L - lookback] and closes[L - skip]; a null
      // there means the name had not listed yet and it is simply absent from
      // this session rather than carried forward from nothing.
      return horizonStats(series as readonly number[], L, lookback, skip);
    });
    if (stats.some((s) => s === null || !Number.isFinite(s.momentum))) continue;

    usable.push(symbol);
    stats.forEach((s, h) => {
      (momentum[h] as number[]).push((s as NonNullable<typeof s>).momentum);
      (realized[h] as number[]).push((s as NonNullable<typeof s>).realizedVol);
      (volAdj[h] as number[]).push((s as NonNullable<typeof s>).volAdjusted);
    });
  }

  if (usable.length === 0) return null;

  return {
    symbol: usable,
    m: momentum.map((xs) => xs.map((v) => roundTo(v, 5))),
    rv: realized.map((xs) => xs.map((v) => roundTo(v, 4))),
    // z-scores come from the unrounded figures, as in `buildSnapshot`;
    // `crossSectionalNormalize` does its own rounding on the way out.
    zr: momentum.map((xs) => crossSectionalNormalize(xs)),
    zv: volAdj.map((xs) => crossSectionalNormalize(xs)),
  };
}

/** Ranks every name in one session's cross-section, per view. */
function ranksForSession(cols: SessionColumns): Map<ViewId, Map<string, number>> {
  const fakeSnapshot = {
    meta: { params: { volFloorAnnualized: VOL_FLOOR_ANNUALIZED } },
    columns: cols,
  };
  const out = new Map<ViewId, Map<string, number>>();
  for (const score of SCORE_KEYS) {
    for (const mode of MODES) {
      const ranks = ranksFor(scoresFor(fakeSnapshot, score, mode), cols.symbol) as number[];
      const bySymbol = new Map<string, number>();
      cols.symbol.forEach((s, i) => bySymbol.set(s, ranks[i] as number));
      out.set(viewId(score, mode), bySymbol);
    }
  }
  return out;
}

/**
 * Every name's rank in one session, per view.
 *
 * Exported so the pipeline's identity gate can check the *whole* cross-section
 * rather than only the twenty names per view the sidecar keeps. An indexing
 * error would move every name at once, so twenty would catch it — but a gate
 * that covers 2,572 costs one extra session and leaves nothing to argue about.
 */
export function sessionRanks(
  symbols: readonly string[],
  aligned: ReadonlyMap<string, AlignedSeries>,
  L: number,
): Map<ViewId, Map<string, number>> {
  const closes = new Map<string, readonly (number | null)[]>();
  for (const [symbol, series] of aligned) closes.set(symbol, series.closes);
  const cols = columnsAt(symbols, closes, L);
  return cols ? ranksForSession(cols) : new Map();
}

/**
 * Backfills `sessions` sessions of ranks and keeps the current top `topN` per
 * view.
 *
 * @param symbols  Eligible names, in snapshot column order.
 * @param aligned  Calendar-aligned series for those names.
 * @param calendar Master trading calendar.
 * @param L        Index of the latest session.
 */
export function buildRankHistory(
  symbols: readonly string[],
  aligned: ReadonlyMap<string, AlignedSeries>,
  calendar: readonly string[],
  L: number,
  sessions: number = HISTORY_SESSIONS,
  topN: number = HISTORY_TOP_N,
): RankHistory {
  const closes = new Map<string, readonly (number | null)[]>();
  for (const [symbol, series] of aligned) closes.set(symbol, series.closes);

  // Newest last, so the right edge of the drawing is today.
  const offsets: number[] = [];
  for (let k = sessions - 1; k >= 0; k--) {
    if (L - k >= 0) offsets.push(k);
  }

  const perSession = offsets.map((k) => {
    const cols = columnsAt(symbols, closes, L - k);
    return cols ? ranksForSession(cols) : new Map<ViewId, Map<string, number>>();
  });

  const latest = perSession[perSession.length - 1] as Map<ViewId, Map<string, number>>;
  const views: RankHistory['views'] = {};
  for (const score of SCORE_KEYS as readonly ScoreKey[]) {
    for (const mode of MODES as readonly Mode[]) {
      const id = viewId(score, mode);
      const today = latest.get(id) ?? new Map<string, number>();
      const top = [...today.entries()]
        .filter(([, rank]) => rank <= topN)
        .sort((a, b) => a[1] - b[1])
        .map(([symbol]) => symbol);
      views[id] = {
        symbols: top,
        // A null is a session the name could not be ranked in — it had not
        // listed yet. The trail starts there rather than being invented.
        ranks: top.map((symbol) => perSession.map((s) => s.get(id)?.get(symbol) ?? null)),
      };
    }
  }

  return {
    sessions: offsets.map((k) => calendar[L - k] as string),
    universe: (latest.get(viewId('h12_1', 'raw')) ?? new Map()).size,
    views,
  };
}

/** The horizon keys, re-exported so tests can assert the column order. */
export const HISTORY_HORIZONS: readonly HorizonKey[] = HORIZON_KEYS;
