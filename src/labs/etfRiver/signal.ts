import { TRADING_DAYS_PER_YEAR } from '../../config.ts';
import { zScore } from '../../pipeline/normalize.ts';
import { sampleStdDev, simpleReturns } from '../../pipeline/stats.ts';
import { LEGS, LEG_KEYS, LEG_WEIGHTS, type LegKey } from './config.ts';

/**
 * The rolling signal.
 *
 * Per leg, as of session `t`:
 *
 *     R    = P[t − skip] / P[t − lookback] − 1
 *     vol  = stdev(daily returns over (t − lookback, t − skip]) × √252
 *     VA   = R / vol
 *
 * Two deliberate departures from the product's stock ranking, both because the
 * subjects are diversified funds rather than single names:
 *
 * **No volatility floor.** The product floors realized volatility at 17.5%
 * annualized to stop a pathologically quiet single stock — an acquisition
 * target pinned to a deal price, say — from being rewarded for standing still.
 * A sector fund cannot be pinned that way; its quiet stretches are real
 * information about the bet. Over the fetched history 10.4% of leg-volatilities
 * here fall below 17.5%, so the floor is not a formality: applying it would
 * quietly compress the whole low-volatility half of the universe (MOO, RWR,
 * KIE, XHS) toward the middle of the cross-section.
 *
 * **No annualization of the horizon return.** The two legs are z-scored
 * independently across the universe on every date, so whatever fixed scale each
 * one carries is removed before they are combined. Scaling a 12-1 return to a
 * year and a 6-1 return to a year first would add a nonlinear transform that
 * changes nothing about the ordering it feeds.
 */

export interface LegStats {
  /** Point-to-point return across the leg's window. Not annualized. */
  ret: number;
  /** Annualized sample standard deviation of daily returns inside that window. */
  annVol: number;
  /** ret / annVol. No floor. */
  volAdjusted: number;
  /** Daily returns the volatility was measured over. */
  n: number;
}

/**
 * One leg for one name as of session `L`, or null when it cannot be computed.
 *
 * Null covers every protection this signal needs and no more: too little
 * history, a missing or non-positive close anywhere in the window (a gap the
 * provider left, or a bad bar), and a volatility of zero or worse. A name with
 * a null leg is simply absent from that date's cross-section rather than being
 * carried forward or floored into it.
 */
export function legStats(
  closes: readonly (number | null)[],
  L: number,
  lookback: number,
  skip: number,
): LegStats | null {
  const startIdx = L - lookback;
  const endIdx = L - skip;
  if (startIdx < 0 || endIdx <= startIdx || endIdx >= closes.length) return null;

  // Every close in the window, not just the two endpoints: one null or zero in
  // the middle turns a daily return into -100% and inflates the volatility for
  // every date whose window covers it, which in a drawing about arrivals would
  // fabricate a collapse and a recovery.
  const window: number[] = [];
  for (let i = startIdx; i <= endIdx; i++) {
    const c = closes[i];
    if (c == null || !(c > 0)) return null;
    window.push(c);
  }

  const ret = (window[window.length - 1] as number) / (window[0] as number) - 1;
  if (!Number.isFinite(ret)) return null;

  const rets = simpleReturns(window);
  if (rets.length < 2) return null;
  const annVol = sampleStdDev(rets) * Math.sqrt(TRADING_DAYS_PER_YEAR);
  // No floor — but a zero or non-finite divisor is not a signal, it is missing
  // data, and dividing by it would put an infinity into a z-score.
  if (!(annVol > 0) || !Number.isFinite(annVol)) return null;

  const volAdjusted = ret / annVol;
  if (!Number.isFinite(volAdjusted)) return null;

  return { ret, annVol, volAdjusted, n: rets.length };
}

/** Both legs for one name as of `L`. Null if either leg is unavailable. */
export function legsAt(
  closes: readonly (number | null)[],
  L: number,
): Record<LegKey, LegStats> | null {
  const out = {} as Record<LegKey, LegStats>;
  for (const key of LEG_KEYS) {
    const { lookback, skip } = LEGS[key];
    const stats = legStats(closes, L, lookback, skip);
    if (!stats) return null;
    out[key] = stats;
  }
  return out;
}

export interface SessionScores {
  /** Names with a computable signal on this date, in the order given. */
  symbols: string[];
  /** Per leg, the cross-sectional z-score of that leg's vol-adjusted return. */
  z: Record<LegKey, number[]>;
  /** The weighted mean of the leg z-scores — the value the river draws. */
  blend: number[];
  /** The raw per-leg statistics behind those z-scores, for auditing. */
  legs: Record<LegKey, LegStats>[];
}

/**
 * One date's cross-section.
 *
 * Each leg is normalized independently, which is what makes a point on the
 * river mean "relative to the rest of this group today" rather than "up in a
 * rising market". The z-score is plain — no winsorization. The product
 * winsorizes because a 2,500-name equity cross-section is violently
 * right-skewed and one name would otherwise dominate the blend; twenty-two
 * volatility-adjusted sector funds have no such tail, and clipping at the 1st
 * and 99th percentile of twenty-two values would only shave the single extreme
 * that is often the leadership story worth seeing.
 *
 * @param symbols Names to consider, in a fixed order.
 * @param legsBySymbol Their computed legs; a null entry drops the name.
 */
export function sessionScores(
  symbols: readonly string[],
  legsBySymbol: ReadonlyMap<string, Record<LegKey, LegStats> | null>,
): SessionScores {
  const kept: string[] = [];
  const legs: Record<LegKey, LegStats>[] = [];
  for (const symbol of symbols) {
    const l = legsBySymbol.get(symbol);
    if (!l) continue;
    kept.push(symbol);
    legs.push(l);
  }

  const z = {} as Record<LegKey, number[]>;
  for (const key of LEG_KEYS) z[key] = zScore(legs.map((l) => l[key].volAdjusted));

  const blend = kept.map((_, i) => {
    let sum = 0;
    for (const key of LEG_KEYS) sum += LEG_WEIGHTS[key] * (z[key][i] as number);
    return sum;
  });

  return { symbols: kept, z, blend, legs };
}
