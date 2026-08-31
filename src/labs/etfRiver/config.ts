/**
 * Every tunable for the ETF River experiment, in one file, exactly as the
 * product keeps its own in `src/config.ts`.
 *
 * Nothing here is imported by the product. The experiment reads a few of the
 * product's constants (`TRADING_DAYS_PER_YEAR`, the FMP client's budget) rather
 * than restating them, which is the allowed direction of dependence.
 */

/**
 * The two momentum legs.
 *
 * Both end `skip` sessions back, so the most recent month is excluded — the
 * same "12-1" convention the product uses. `lookback` is where the window
 * starts.
 */
export const LEG_KEYS = ['l12_1', 'l6_1'] as const;
export type LegKey = (typeof LEG_KEYS)[number];

export const LEGS: Record<LegKey, { lookback: number; skip: number; label: string }> = {
  l12_1: { lookback: 252, skip: 21, label: '12–1' },
  l6_1: { lookback: 126, skip: 21, label: '6–1' },
};

/** Equal weight on the two legs. They are z-scores, so this is a plain mean. */
export const LEG_WEIGHTS: Record<LegKey, number> = { l12_1: 0.5, l6_1: 0.5 };

export const MAX_LOOKBACK = Math.max(...LEG_KEYS.map((k) => LEGS[k].lookback));

/** Sessions of rolling signal drawn: roughly one year, including today. */
export const RIVER_SESSIONS = 252;

/**
 * Calendar days of prices to request.
 *
 * The oldest drawn session needs `MAX_LOOKBACK` sessions of history behind it,
 * so the run needs `RIVER_SESSIONS + MAX_LOOKBACK` ≈ 504 sessions ≈ two years.
 * Three years is asked for so a run still has headroom after holidays, a late
 * listing, or a provider gap.
 */
export const HISTORY_CALENDAR_DAYS = 1150;

/** Decimals the drawn score is serialized to. The axis spans about ±3. */
export const SCORE_DECIMALS = 3;

// ---------------------------------------------------------------------------
// Redundancy screen
// ---------------------------------------------------------------------------

/**
 * The universe is meant to be distinct industry bets, so every run re-measures
 * whether any two members have collapsed into the same one.
 *
 * A pair is flagged only when it is redundant on **both** axes: its daily
 * returns move together *and* the thing actually drawn — the blended
 * cross-sectional score — traces the same path. One axis alone is not enough.
 * Two industries can share a beta and still take turns leading (which is the
 * information this screen exists to show), and two unrelated industries can
 * happen to drift together for a year without being the same bet.
 */
export const REDUNDANT_RETURN_CORR = 0.75;
export const REDUNDANT_PATH_CORR = 0.85;
/** Root-mean-square gap between two paths, in z units, below which they coincide. */
export const REDUNDANT_PATH_RMS = 0.5;

/** Pairs listed in the run log and the sidecar's diagnostics. */
export const REDUNDANCY_REPORT_PAIRS = 6;
