/**
 * Every tunable constant for the screen lives here so the whole definition of
 * the product is auditable from one file. Changing anything here changes the
 * snapshot's `meta.params`, which is what makes a run reproducible.
 */

export const FMP_BASE = 'https://financialmodelingprep.com/stable';

/** FMP's premium key. The screen has no fallback data source by design. */
export const API_KEY_ENV = 'API_KEY';

/** U.S. exchanges we consider listed. Excludes OTC by construction. */
export const EXCHANGES = ['NASDAQ', 'NYSE', 'AMEX'] as const;
export type Exchange = (typeof EXCHANGES)[number];

// ---------------------------------------------------------------------------
// Tradability gates
// ---------------------------------------------------------------------------

export const MIN_MARKET_CAP = 1_000_000_000;
export const MIN_PRICE = 5;
/** Median daily dollar volume over the trailing correlation window. */
export const MIN_MEDIAN_DOLLAR_VOLUME = 5_000_000;

// ---------------------------------------------------------------------------
// Momentum horizons. Every horizon ends at `skip` trading days back, which is
// what makes this a "12-1" style signal: the most recent month is excluded.
// ---------------------------------------------------------------------------

export const HORIZON_KEYS = ['h12_1', 'h9_1', 'h6_1'] as const;
export type HorizonKey = (typeof HORIZON_KEYS)[number];

export const HORIZONS: Record<HorizonKey, { lookback: number; skip: number; label: string }> = {
  h12_1: { lookback: 252, skip: 21, label: '12-1' },
  h9_1: { lookback: 189, skip: 21, label: '9-1' },
  h6_1: { lookback: 126, skip: 21, label: '6-1' },
};

/** Longest lookback across horizons; drives how much history each name needs. */
export const MAX_LOOKBACK = Math.max(...HORIZON_KEYS.map((k) => HORIZONS[k].lookback));

// ---------------------------------------------------------------------------
// Volatility adjustment
// ---------------------------------------------------------------------------

export const TRADING_DAYS_PER_YEAR = 252;
/**
 * Annualized volatility floor, applied independently per horizon. A name whose
 * realized volatility is below this gets no extra credit for being quiet.
 */
export const VOL_FLOOR_ANNUALIZED = 0.175;

// ---------------------------------------------------------------------------
// Cross-sectional normalization (only affects the Blend; see README)
// ---------------------------------------------------------------------------

export const WINSOR_LOWER_PCT = 0.01;
export const WINSOR_UPPER_PCT = 0.99;
export const BLEND_WEIGHT = 1 / 3;

// ---------------------------------------------------------------------------
// Correlation grouping
// ---------------------------------------------------------------------------

export const CORR_WINDOW = 126;
export const THRESHOLDS = [0.6, 0.65, 0.7] as const;
export const DEFAULT_THRESHOLD = 0.65;
export const TOP_N = 100;

// ---------------------------------------------------------------------------
// Data quality
// ---------------------------------------------------------------------------

/** A date joins the master calendar if this fraction of names traded on it. */
export const CALENDAR_MIN_COVERAGE = 0.6;
/**
 * Fraction of master-calendar dates in the analysis span for which a name must
 * have a real (non-forward-filled) bar. Removes recent IPOs and halted names,
 * and guarantees every eligible name supports every horizon and the
 * correlation matrix.
 */
export const MIN_ACTUAL_BAR_COVERAGE = 0.95;

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

export const CONCURRENCY = 8;
export const MAX_RETRIES = 5;
export const RETRY_BASE_MS = 500;
export const REQUEST_TIMEOUT_MS = 60_000;

/**
 * Global request budget. Measured against the live API: ~580 requests/minute
 * sustains indefinitely, while running the pool flat out (~1000/min) trips
 * HTTP 429 partway through the universe. Staying under the cap is what keeps
 * the run from losing names to rate limiting.
 */
export const RATE_LIMIT_PER_MIN = Number(process.env.FMP_RATE_LIMIT_PER_MIN ?? 550);
/** How long to hold every worker back after the API reports a 429. */
export const RATE_LIMIT_COOLDOWN_MS = 60_000;
/** Extra attempts granted to a 429, which is transient by definition. */
export const RATE_LIMIT_MAX_RETRIES = 6;
/**
 * A transient network failure that silently drops names would change the
 * ranking run to run, so by default a single unrecovered failure aborts.
 */
export const MAX_FETCH_FAILURES = 0;

/** Calendar days of history to request. Must comfortably exceed MAX_LOOKBACK trading days. */
export const HISTORY_CALENDAR_DAYS = 540;

// ---------------------------------------------------------------------------
// Views: (horizon | blend) x (raw | vol-adjusted)
// ---------------------------------------------------------------------------

export const SCORE_KEYS = ['h12_1', 'h9_1', 'h6_1', 'blend'] as const;
export type ScoreKey = (typeof SCORE_KEYS)[number];

export const MODES = ['raw', 'voladj'] as const;
export type Mode = (typeof MODES)[number];

export type ViewId = `${ScoreKey}|${Mode}`;

export function viewId(score: ScoreKey, mode: Mode): ViewId {
  return `${score}|${mode}`;
}

export const VIEW_IDS: ViewId[] = SCORE_KEYS.flatMap((s) => MODES.map((m) => viewId(s, m)));
