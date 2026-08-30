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

/**
 * Market cap is a weak proxy for tradability and the liquidity gate below is
 * the one doing the work: measured, moving this floor from $1B to $200M adds
 * ~380 names and every one of them still clears $5M/day. Set low deliberately
 * so the universe is "everything you could actually trade" rather than
 * "everything large".
 */
export const MIN_MARKET_CAP = 200_000_000;
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
/**
 * Decimal places z-scores are rounded to.
 *
 * The rounding happens inside the normalization, not on the way out, so the
 * pipeline ranks from exactly the numbers the browser receives. Rounding only
 * at serialization time would let the two disagree: measured on real data,
 * even five decimal places reorders one of the eight views relative to full
 * precision, because names separated by less than half a unit in the last
 * place fall back on the symbol tie-break. Four decimals is far below any
 * meaningful difference in a unit-variance score, and being the single source
 * of truth is worth more than the discarded digits.
 */
export const Z_DECIMALS = 4;

// ---------------------------------------------------------------------------
// Correlation grouping
// ---------------------------------------------------------------------------

export const CORR_WINDOW = 126;
export const THRESHOLDS = [0.6, 0.65, 0.7] as const;
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
export const RATE_LIMIT_DEFAULT_PER_MIN = 550;

/**
 * Parsed strictly: `??` only catches undefined/null, so an empty or malformed
 * value would otherwise yield NaN, and a NaN interval makes every wait
 * comparison false — silently disabling rate limiting entirely and running the
 * pool flat out at the rate that trips 429s.
 */
function positiveNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(`[config] Ignoring invalid $${name}=${JSON.stringify(raw)}; using ${fallback}.`);
    return fallback;
  }
  return parsed;
}

export const RATE_LIMIT_PER_MIN = positiveNumberEnv(
  'FMP_RATE_LIMIT_PER_MIN',
  RATE_LIMIT_DEFAULT_PER_MIN,
);

/** How long to hold every worker back after the API reports a 429. */
export const RATE_LIMIT_COOLDOWN_MS = 60_000;
/** Extra attempts granted to a 429, which is transient by definition. */
export const RATE_LIMIT_MAX_RETRIES = 6;
/** How much one rate-limit episode eases the request rate. */
export const RATE_LIMIT_BACKOFF_FACTOR = 1.25;
/** Hard ceiling on that easing, as a multiple of the configured interval. */
export const RATE_LIMIT_MAX_BACKOFF = 8;
/** Clean responses required before the rate decays back toward the budget. */
export const RATE_LIMIT_DECAY_AFTER_CLEAN = 50;
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
