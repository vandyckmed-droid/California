import {
  HORIZONS,
  HORIZON_KEYS,
  MAX_LOOKBACK,
  MIN_MARKET_CAP,
  MIN_MEDIAN_DOLLAR_VOLUME,
  MIN_PRICE,
  MIN_ACTUAL_BAR_COVERAGE,
  TRADING_DAYS_PER_YEAR,
  TRAILING_VOL_WINDOW,
  VOL_FLOOR_ANNUALIZED,
  type HorizonKey,
} from '../config.ts';
import { actualCoverage, type AlignedSeries } from './calendar.ts';
import { median, sampleStdDev, simpleReturns } from './stats.ts';
import type { UniverseMember } from './universe.ts';

export interface HorizonStats {
  /** Raw point-to-point return from t-lookback to t-skip. */
  momentum: number;
  /** Annualized sample stdev of daily returns inside that same window. */
  realizedVol: number;
  /** max(realizedVol, VOL_FLOOR_ANNUALIZED) — the floor applied per horizon. */
  effectiveVol: number;
  /** momentum / effectiveVol. */
  volAdjusted: number;
}

export interface StockMetrics {
  symbol: string;
  horizons: Record<HorizonKey, HorizonStats>;
  /**
   * Annualized volatility over the trailing `TRAILING_VOL_WINDOW` sessions,
   * up to and including the latest one. Reported, never ranked on.
   */
  trailingVol: number;
  latestClose: number;
  dollarVolume: number;
}

export type IneligibleReason =
  | 'noData'
  | 'sparseHistory'
  | 'badPrices'
  | 'priceUnderFloor'
  | 'illiquid'
  | 'marketCapUnderFloor';

/**
 * Momentum and volatility for one horizon.
 *
 * The window runs from `L - lookback` to `L - skip`, so the most recent `skip`
 * sessions are excluded from both the return and the volatility. Volatility is
 * measured on the daily returns of that same window, per the spec, rather than
 * on a separate trailing window.
 */
export function horizonStats(
  closes: readonly number[],
  L: number,
  lookback: number,
  skip: number,
): HorizonStats | null {
  const startIdx = L - lookback;
  const endIdx = L - skip;
  if (startIdx < 0 || endIdx <= startIdx) return null;

  const start = closes[startIdx] ?? Number.NaN;
  const end = closes[endIdx] ?? Number.NaN;
  if (!(start > 0) || !(end > 0)) return null;

  const momentum = end / start - 1;

  const window = closes.slice(startIdx, endIdx + 1);
  const rets = simpleReturns(window);
  const realizedVol = sampleStdDev(rets) * Math.sqrt(TRADING_DAYS_PER_YEAR);
  const effectiveVol = Math.max(realizedVol, VOL_FLOOR_ANNUALIZED);

  return { momentum, realizedVol, effectiveVol, volAdjusted: momentum / effectiveVol };
}

/**
 * Annualized volatility over the most recent `window` sessions.
 *
 * Distinct from every `HorizonStats.realizedVol` in one way that matters: it
 * includes the skipped month. The horizons stop 21 sessions short so a
 * momentum signal is not contaminated by the reversal window it excludes;
 * a "how volatile is this name" figure that stopped 21 sessions short would
 * simply be a month out of date.
 *
 * `window` returns come from `window + 1` closes, matching `windowReturns` in
 * the correlation module so the list and the watchlist measure the same thing.
 */
export function trailingVol(
  closes: readonly number[],
  L: number,
  window: number,
): number | null {
  const from = L - window;
  if (from < 0) return null;
  const rets = simpleReturns(closes.slice(from, L + 1));
  if (rets.length < 2) return null;
  return sampleStdDev(rets) * Math.sqrt(TRADING_DAYS_PER_YEAR);
}

/**
 * Applies the data-driven tradability gates and computes every horizon for one
 * name. Returns a reason instead of metrics when the name is not eligible; the
 * caller tallies those reasons for the snapshot's audit trail.
 *
 * Eligibility is evaluated once, over the union of every horizon window and the
 * correlation window, so all eight views share a single eligible universe.
 */
export function computeMetrics(
  series: AlignedSeries,
  member: UniverseMember,
  L: number,
  corrWindow: number,
): { ok: true; metrics: StockMetrics } | { ok: false; reason: IneligibleReason } {
  const spanStart = L - MAX_LOOKBACK;
  if (spanStart < 0) return { ok: false, reason: 'noData' };

  // The name must have traded for the whole analysis span, not just recently.
  if (series.closes[spanStart] == null) return { ok: false, reason: 'sparseHistory' };
  if (actualCoverage(series, spanStart, L) < MIN_ACTUAL_BAR_COVERAGE) {
    return { ok: false, reason: 'sparseHistory' };
  }

  const closes: number[] = new Array(L + 1);
  for (let i = spanStart; i <= L; i++) {
    const c = series.closes[i];
    if (c == null || !(c > 0)) return { ok: false, reason: 'badPrices' };
    closes[i] = c;
  }

  const latestClose = closes[L] as number;
  // The penny-stock gate is applied to the current price. Applying it to
  // adjusted historical prices would wrongly reject exactly the names momentum
  // is looking for: a $12 stock that traded at $3 six months ago.
  if (latestClose < MIN_PRICE) return { ok: false, reason: 'priceUnderFloor' };
  if (member.marketCap < MIN_MARKET_CAP) return { ok: false, reason: 'marketCapUnderFloor' };

  const dollarVolume = recentDollarVolume(series, L, corrWindow);
  if (!(dollarVolume >= MIN_MEDIAN_DOLLAR_VOLUME)) return { ok: false, reason: 'illiquid' };

  const horizons = {} as Record<HorizonKey, HorizonStats>;
  for (const key of HORIZON_KEYS) {
    const { lookback, skip } = HORIZONS[key];
    const stats = horizonStats(closes, L, lookback, skip);
    if (!stats || !Number.isFinite(stats.momentum)) return { ok: false, reason: 'badPrices' };
    horizons[key] = stats;
  }

  // The eligibility span covers MAX_LOOKBACK sessions and the trailing window
  // is far shorter, so every close it needs is present and already validated.
  const tv = trailingVol(closes, L, TRAILING_VOL_WINDOW);
  if (tv === null || !Number.isFinite(tv)) return { ok: false, reason: 'badPrices' };

  return {
    ok: true,
    metrics: { symbol: member.symbol, horizons, trailingVol: tv, latestClose, dollarVolume },
  };
}

/**
 * Typical daily dollar volume: the median of close x volume over the trailing
 * correlation window.
 *
 * Derived from end-of-day bars rather than the screener's live `avgVolume` and
 * `price`, because those tick during the session and would make an otherwise
 * identical run produce a different universe — a liquidity gate that moves
 * intraday can flip a borderline name in or out of the ranking. Checked
 * against the screener figure across large caps, this measure tracks it
 * closely (median ratio ~0.84, no name off by anywhere near the factor a
 * split-adjustment mismatch would cause), and being a median it is robust to
 * one-off volume spikes.
 */
function recentDollarVolume(series: AlignedSeries, L: number, corrWindow: number): number {
  const from = Math.max(0, L - corrWindow + 1);
  const dv: number[] = [];
  for (let i = from; i <= L; i++) {
    const c = series.closes[i];
    const v = series.volumes[i];
    if (c != null && v != null) dv.push(c * v);
  }
  return dv.length === 0 ? 0 : median(dv);
}
