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
// Cleanup layer
//
// The gates above decide what FMP will return. These decide what survives
// contact with the actual price series, and they are deliberately stricter:
// a name that clears a screener and then turns out to have been pinned to a
// merger price for four months ranks on the acquirer's offer, not on momentum.
// ---------------------------------------------------------------------------

/**
 * Cap floor for the cleaned universe.
 *
 * Higher than MIN_MARKET_CAP above, which stays where it is because it governs
 * what is *fetched*: the run needs the wider set in hand to measure what the
 * cleanup removes, and a screener floor cannot be revisited without re-running
 * the whole fetch.
 */
export const CLEAN_MIN_MARKET_CAP = 500_000_000;

/**
 * History a name must have before it is rankable: three years, not one.
 *
 * The longest momentum horizon needs 252 sessions, so this is not a horizon
 * requirement — it is a quality one. A name with three years of continuous
 * prints has demonstrated that it trades; a name with exactly enough history
 * for the 12-1 window has demonstrated only that it listed a year ago.
 */
export const CLEAN_MIN_HISTORY_SESSIONS = 756;

/**
 * Master-calendar sessions a name may miss inside that span. Zero, as specified.
 *
 * Kept at zero because the data says an allowance buys nothing. Measured over
 * the live universe, 3,304 of 3,335 names miss no session at all and the
 * distribution is zero at the 99th percentile; the names that miss any tend to
 * miss a great many (121, 78, 40). There is no population of otherwise-fine
 * names losing a single halt day for an allowance to rescue — it would have
 * spared 13 names and blurred a rule that is currently exact.
 */
export const CLEAN_MISSING_SESSION_ALLOWANCE = 0;

/** Liquidity, measured over a year rather than the correlation window. */
export const CLEAN_DOLLAR_VOLUME_WINDOW = 252;
export const CLEAN_MIN_MEDIAN_DOLLAR_VOLUME = 5_000_000;

/**
 * The window every "has this name stopped moving" test is measured over.
 *
 * One month. Short enough that a deal announced last quarter shows up now,
 * long enough that a quiet fortnight does not.
 */
export const SHORT_VOL_WINDOW = 21;

/** Below this annualized realized volatility a listed equity is not trading. */
export const MIN_REALIZED_VOL = 0.05;

/**
 * The post-event flatline: a large shock, and then nothing.
 *
 * This is what an agreed acquisition looks like from the outside — a jump to
 * the deal price on announcement, then a pinned quote until it closes. The
 * event window ends where the volatility window begins so the shock cannot
 * inflate the calm it is being compared against.
 */
export const FLATLINE_EVENT_WINDOW = 126;
export const FLATLINE_EVENT_THRESHOLD = 0.20;
export const FLATLINE_VOL_CEILING = 0.10;

/**
 * A one-day move this large in a split- and dividend-adjusted series.
 *
 * Far more often an unapplied corporate action than a return. Either way the
 * momentum computed across it is arithmetic on two incomparable prices.
 */
export const EXTREME_MOVE_WINDOW = 63;
export const EXTREME_MOVE_THRESHOLD = 0.50;

/**
 * How alike two listings must trade before a name match is allowed to merge
 * them. Share classes of one company are near-identical; two companies that
 * merely share a word in their names are not.
 */
export const SHARE_CLASS_MIN_CORR = 0.95;

/**
 * Concentration ceilings, as a share of the universe at the point each runs.
 *
 * Both are currently inert, and that is the finding rather than a bug: the
 * largest industry in the cleaned universe is Banks - Regional at 6.2% and the
 * largest sector is Financial Services at 16.0%, so neither cap binds. They are
 * kept as armed guardrails — they cost one pass and catch drift — but nothing
 * in this layer is trimming for concentration today.
 *
 * The reason is worth stating: FMP's industry taxonomy is fine-grained enough
 * ("Banks - Regional", "Software - Application", "Semiconductors") that no
 * single label reaches 7.5% of 2,283 names. The redundancy a momentum ranking
 * actually suffers from — fifteen semiconductor names expressing one bet — is
 * not visible at the label level at all. It lives in the correlation structure,
 * which is what the existing grouping addresses.
 */
export const INDUSTRY_CAP_FRACTION = 0.075;
export const SECTOR_CAP_FRACTION = 0.20;

/**
 * Whether the cleanup treats an ADR as outside a U.S. common-stock universe.
 *
 * Off, and this is the one place the implementation departs from its starting
 * specification. The rule is well-posed — an ADR is a receipt for a listing
 * whose primary market is elsewhere — but nothing in the data identifies one:
 *
 *  - Matching the name catches 9 listings out of 3,655. It would remove ARM,
 *    whose name happens to carry "American Depositary Shares", while keeping
 *    TSM, BABA, MUFG, NVS and AZN, whose names do not. That is not the rule
 *    partially applied, it is an arbitrary sample of it.
 *  - `country != US` catches 625, but conflates a genuine ADR with a
 *    foreign-domiciled company whose primary listing *is* American: it would
 *    delete Linde plc, Royal Bank of Canada and Arm Holdings alongside the
 *    receipts, and FMP already places PDD in Ireland and Trip.com in Singapore.
 *  - The `stable` endpoints this client uses expose no ADR flag.
 *
 * An inconsistently applied rule is worse than an absent one: it removes real
 * names and leaves the class it was aimed at largely intact, while reading in
 * the exclusion counts as though the job were done. The flag stays so the
 * decision is one edit away if a reliable classification appears.
 */
export const CLEAN_EXCLUDE_ADR = false;

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
// Correlation grouping
// ---------------------------------------------------------------------------

export const CORR_WINDOW = 126;
export const THRESHOLDS = [0.6, 0.65, 0.7] as const;
export const TOP_N = 100;

// ---------------------------------------------------------------------------
// Volatility
// ---------------------------------------------------------------------------

export const TRADING_DAYS_PER_YEAR = 252;
/**
 * Annualized volatility floor, applied independently per horizon. A name whose
 * realized volatility is below this gets no extra credit for being quiet.
 *
 * This floor belongs to the *ranking*: it is the divisor the vol-adjusted
 * views use. It is deliberately not applied to the trailing volatility below,
 * which nothing divides by and which is therefore reported honestly.
 */
export const VOL_FLOOR_ANNUALIZED = 0.175;

/**
 * Sessions in the trailing volatility the list displays.
 *
 * Every momentum horizon stops `skip` sessions short of today, because a
 * momentum signal must not be contaminated by the short-term reversal window
 * it excludes. "How volatile is this name right now" is the opposite question:
 * leaving the last month out makes the answer stale exactly when it matters,
 * so this window runs right up to the latest session.
 *
 * Defined as the correlation window so the figure on the list is the same
 * quantity the watchlist reports per name. Two constants that happened to both
 * read 126 could drift apart and the two screens would quietly disagree about
 * one name's volatility.
 */
export const TRAILING_VOL_WINDOW = CORR_WINDOW;

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

/**
 * Calendar days of history to request.
 *
 * Sized by the cleanup layer, not by the horizons: CLEAN_MIN_HISTORY_SESSIONS
 * is 756 trading days, which is about 1,096 calendar days, and the master
 * calendar has to reach past that with room for the run to sit on a holiday.
 * The request count is unchanged — this is one call per name either way — so
 * the cost is response size rather than rate limit.
 */
export const HISTORY_CALENDAR_DAYS = 1_150;

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
