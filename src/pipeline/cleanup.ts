import {
  CLEAN_MIN_HISTORY_SESSIONS,
  CLEAN_MIN_MARKET_CAP,
  CLEAN_MIN_MEDIAN_DOLLAR_VOLUME,
  CLEAN_MISSING_SESSION_ALLOWANCE,
  CLEAN_DOLLAR_VOLUME_WINDOW,
  EXTREME_MOVE_THRESHOLD,
  EXTREME_MOVE_WINDOW,
  FLATLINE_EVENT_THRESHOLD,
  FLATLINE_EVENT_WINDOW,
  FLATLINE_VOL_CEILING,
  INDUSTRY_CAP_FRACTION,
  MIN_PRICE,
  MIN_REALIZED_VOL,
  SECTOR_CAP_FRACTION,
  SHARE_CLASS_MIN_CORR,
  SHORT_VOL_WINDOW,
  TRADING_DAYS_PER_YEAR,
} from '../config.ts';
import type { AlignedSeries } from './calendar.ts';
import { median, pearson, sampleStdDev, simpleReturns } from './stats.ts';

/** Just the fields the series rules read. Declared here rather than imported
 * from `universe.ts` so that module can import this one without a cycle. */
export interface MemberLike {
  symbol: string;
  marketCap: number;
}

/**
 * The cleanup layer: everything between "FMP says this is a listed common
 * stock" and "this belongs in a momentum ranking".
 *
 * The screener's own filters are cheap and coarse. They cannot see that a name
 * stopped moving the day its acquisition was announced, that a 900% one-day
 * print is an unapplied split rather than a return, that two tickers are the
 * same company, or that a third of the ranked list is regional banks. Each of
 * those produces a name that looks perfectly rankable and ranks on something
 * that is not momentum.
 *
 * Every rule here is deterministic and stated as a threshold on observable
 * data. None of them consults a news feed or a corporate-actions endpoint: a
 * rule the run cannot evaluate the same way twice is worse than no rule, and
 * the behaviour a pending merger produces — a price pinned to the deal terms —
 * is more reliably observed than the announcement is retrieved.
 */

export type CleanupReason =
  | 'securityType'
  | 'notActivelyTrading'
  | 'marketCapUnderFloor'
  | 'priceUnderFloor'
  | 'illiquid'
  | 'shortHistory'
  | 'missingSessions'
  | 'badSeries'
  | 'flatVolatility'
  | 'postEventFlatline'
  | 'extremeOneDayMove'
  | 'shareClassDuplicate'
  | 'industryCap'
  | 'sectorCap';

export const CLEANUP_REASONS: readonly CleanupReason[] = [
  'securityType',
  'notActivelyTrading',
  'marketCapUnderFloor',
  'priceUnderFloor',
  'illiquid',
  'shortHistory',
  'missingSessions',
  'badSeries',
  'flatVolatility',
  'postEventFlatline',
  'extremeOneDayMove',
  'shareClassDuplicate',
  'industryCap',
  'sectorCap',
];

/**
 * Security types that are not common equity and that the screener's own
 * `isEtf`/`isFund` flags miss.
 *
 * Phrase-anchored for the same reason the existing name rules are: a bare
 * `\btrust\b` would take out every REIT and half the banks. What is matched
 * here is the security's own legal form appearing in its name.
 */
const NON_COMMON_TYPE = new RegExp(
  [
    String.raw`\bETF\b`,
    String.raw`\bETN\b`,
    String.raw`\bexchange[- ]traded\b`,
    String.raw`\bindex fund\b`,
    String.raw`\bclosed[- ]end fund\b`,
    String.raw`\bcapital trust\b`,
    String.raw`\bincome trust\b`,
    String.raw`\broyalty trust\b`,
    String.raw`\bstatutory trust\b`,
    String.raw`\bunit investment trust\b`,
    String.raw`\bacquisitions? corp(?:oration)?\.?\b`,
    String.raw`\bacquisitions? co\.?$`,
    String.raw`\bblank check\b`,
    String.raw`\bspecial purpose acquisition\b`,
    String.raw`\bliquidating trust\b`,
  ].join('|'),
  'i',
);

/**
 * A note on what this deliberately does *not* match.
 *
 * Many SPACs are named "<Something> Capital Corp", which is also what a great
 * many ordinary lenders and BDCs are called. There is no phrase that separates
 * them, so no rule here tries: a pattern that took "Capital Corp" would delete
 * real businesses to catch shells. Shells are removed by FMP's own
 * `Shell Companies` industry and, failing that, by the volatility rules — a
 * pre-deal SPAC sits pinned near its trust value, which is exactly the
 * behaviour `MIN_REALIZED_VOL` exists to find.
 */

/**
 * American depositary receipts.
 *
 * The starting specification asks for primary U.S. common stock, and an ADR is
 * by construction a receipt for a listing whose primary market is elsewhere.
 * This is the single most consequential rule in the layer and is reported
 * separately for that reason — see the run's cleanup report for what it costs.
 */
const ADR_NAME = /\bamerican depositary (?:shares?|receipts?)\b|\bADR\b|\bADS\b/i;

/** Share-class markers, stripped before two listings are compared as one company. */
const CLASS_MARKER =
  /\b(?:class|cl\.?|series)\s+[A-Z]\b|\bclass\s+[A-Z]\b|\b[A-Z]\s+shares\b|\bordinary shares\b|\bcommon (?:stock|shares?)\b|\bnew\b/gi;

/** Legal-form suffixes, likewise stripped: they carry no identity. */
const CORPORATE_SUFFIX =
  /\b(?:inc|incorporated|corp|corporation|co|company|plc|ltd|limited|holdings?|group|the|sa|nv|ag)\b\.?/gi;

/**
 * Two listings of one company reduce to the same key.
 *
 * Deliberately only a *candidate* generator: matching names is evidence, not
 * proof, and the caller confirms with a correlation before merging anything.
 */
export function companyKey(name: string): string {
  return (name ?? '')
    .replace(CLASS_MARKER, ' ')
    .replace(/[.,&'’-]/g, ' ')
    .replace(CORPORATE_SUFFIX, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export interface ScreenerLike {
  symbol: string;
  companyName: string | null;
  isEtf?: boolean;
  isFund?: boolean;
  isActivelyTrading?: boolean;
}

/**
 * Security-type rules, applied to the screener row before anything is fetched.
 *
 * `isEtf`/`isFund` are asked of the API *and* re-checked here. The request
 * parameters are a hint the vendor may or may not honour on every row; the
 * flags on the row are the vendor's own answer for that row, and disagreeing
 * with a filter you asked for is exactly the sort of thing that shows up as
 * three ETFs in a stock ranking.
 */
export function securityTypeReason(
  row: ScreenerLike,
  excludeAdr: boolean,
): CleanupReason | null {
  const name = row.companyName ?? '';
  if (row.isEtf === true || row.isFund === true) return 'securityType';
  if (NON_COMMON_TYPE.test(name)) return 'securityType';
  if (excludeAdr && ADR_NAME.test(name)) return 'securityType';
  if (row.isActivelyTrading === false) return 'notActivelyTrading';
  return null;
}

/** Annualized realized volatility of the last `window` sessions ending at `L`. */
export function annualizedVol(closes: readonly number[], L: number, window: number): number | null {
  const from = L - window;
  if (from < 0) return null;
  const rets = simpleReturns(closes.slice(from, L + 1));
  if (rets.length < 2) return null;
  const sd = sampleStdDev(rets);
  if (!Number.isFinite(sd)) return null;
  return sd * Math.sqrt(TRADING_DAYS_PER_YEAR);
}

/** The largest absolute one-day return over the `window` sessions ending at `L`. */
export function largestAbsMove(closes: readonly number[], L: number, window: number): number | null {
  const from = Math.max(1, L - window + 1);
  if (from > L) return null;
  let worst = 0;
  for (let i = from; i <= L; i++) {
    const a = closes[i - 1];
    const b = closes[i];
    if (a === undefined || b === undefined || !(a > 0) || !(b > 0)) continue;
    const r = Math.abs(b / a - 1);
    if (r > worst) worst = r;
  }
  return worst;
}

export interface SeriesVerdict {
  reason: CleanupReason | null;
  /** Reported whether or not the name is kept, so the report can show the distribution. */
  shortVol: number | null;
  eventMove: number | null;
  recentMove: number | null;
  missing: number;
  dollarVolume: number;
}

/**
 * Every rule that needs the price series. One pass, one verdict, all the
 * measured quantities returned whether or not they rejected the name — the
 * report needs the distribution, not just the tail it cut off.
 */
export function seriesVerdict(
  series: AlignedSeries,
  member: MemberLike,
  L: number,
): SeriesVerdict {
  const out: SeriesVerdict = {
    reason: null,
    shortVol: null,
    eventMove: null,
    recentMove: null,
    missing: 0,
    dollarVolume: 0,
  };
  const start = L - CLEAN_MIN_HISTORY_SESSIONS + 1;
  if (start < 0 || series.closes[start] == null) {
    out.reason = 'shortHistory';
    return out;
  }

  // A "missing session" is a master-calendar date on which this name did not
  // print a bar. `alignToCalendar` carries the previous close forward so an
  // isolated halt does not destroy the series, which means the hole is only
  // visible in `actual` — the close itself looks perfectly valid.
  let missing = 0;
  for (let i = start; i <= L; i++) if (!series.actual[i]) missing++;
  out.missing = missing;

  const closes: number[] = [];
  for (let i = start; i <= L; i++) {
    const c = series.closes[i];
    if (c == null || !Number.isFinite(c) || !(c > 0)) {
      out.reason = 'badSeries';
      return out;
    }
    closes.push(c);
  }
  // Indices within `closes`, which starts at the first required session.
  const l = closes.length - 1;

  if (missing > CLEAN_MISSING_SESSION_ALLOWANCE) {
    out.reason = 'missingSessions';
    return out;
  }

  const latest = closes[l] as number;
  if (latest < MIN_PRICE) {
    out.reason = 'priceUnderFloor';
    return out;
  }
  if (member.marketCap < CLEAN_MIN_MARKET_CAP) {
    out.reason = 'marketCapUnderFloor';
    return out;
  }

  // Median rather than mean: one index-rebalance print is worth more than a
  // quiet month, and a mean lets that single day carry an illiquid name.
  const dollars: number[] = [];
  for (let i = Math.max(0, L - CLEAN_DOLLAR_VOLUME_WINDOW + 1); i <= L; i++) {
    const c = series.closes[i];
    const v = series.volumes[i];
    if (c != null && v != null && c > 0 && v >= 0) dollars.push(c * v);
  }
  out.dollarVolume = dollars.length > 0 ? median(dollars) : 0;
  if (!(out.dollarVolume >= CLEAN_MIN_MEDIAN_DOLLAR_VOLUME)) {
    out.reason = 'illiquid';
    return out;
  }

  out.shortVol = annualizedVol(closes, l, SHORT_VOL_WINDOW);
  out.recentMove = largestAbsMove(closes, l, EXTREME_MOVE_WINDOW);
  // The event window ends where the short volatility window begins, so "the
  // shock" and "what happened after it" never overlap. Measuring both over the
  // same span would let the shock's own day inflate the volatility that is
  // supposed to show the name has gone quiet.
  out.eventMove = largestAbsMove(closes, l - SHORT_VOL_WINDOW, FLATLINE_EVENT_WINDOW);

  // A price that has stopped moving is the observable half of a deal that has
  // been agreed: the stock is pinned to the terms and its "momentum" is the
  // acquirer's offer, not the market's opinion.
  if (out.shortVol !== null && out.shortVol < MIN_REALIZED_VOL) {
    out.reason = 'flatVolatility';
    return out;
  }
  if (
    out.eventMove !== null && out.eventMove >= FLATLINE_EVENT_THRESHOLD &&
    out.shortVol !== null && out.shortVol < FLATLINE_VOL_CEILING
  ) {
    out.reason = 'postEventFlatline';
    return out;
  }
  // A move this size in an adjusted series is far more often an unapplied
  // corporate action than a real return, and either way it is not momentum.
  if (out.recentMove !== null && out.recentMove >= EXTREME_MOVE_THRESHOLD) {
    out.reason = 'extremeOneDayMove';
    return out;
  }
  return out;
}

export interface Candidate {
  symbol: string;
  name: string;
  sector: string;
  industry: string;
  dollarVolume: number;
}

export interface Removal {
  symbol: string;
  reason: CleanupReason;
  /** Free-text detail for the report: what the rule actually measured. */
  detail?: string;
}

/**
 * Collapses economically equivalent share classes to the most liquid listing.
 *
 * Two gates, because either alone is wrong. A name match alone would merge
 * unrelated companies that share a word; a correlation alone would merge two
 * regional banks that happen to move together, which are genuinely two bets.
 * Requiring both means the pair has to look like one company *and* trade like
 * one.
 */
export function dedupeShareClasses(
  candidates: readonly Candidate[],
  returns: ReadonlyMap<string, readonly number[]>,
): { kept: Candidate[]; removed: Removal[] } {
  const groups = new Map<string, Candidate[]>();
  for (const c of candidates) {
    const key = companyKey(c.name);
    if (!key) continue;
    (groups.get(key) ?? groups.set(key, []).get(key) as Candidate[]).push(c);
  }
  const drop = new Map<string, Removal>();
  for (const [, group] of groups) {
    if (group.length < 2) continue;
    // Most liquid first; symbol breaks a tie so the choice never depends on
    // the order the universe happened to arrive in.
    const ordered = [...group].sort(
      (a, b) => b.dollarVolume - a.dollarVolume || (a.symbol < b.symbol ? -1 : 1),
    );
    const primary = ordered[0] as Candidate;
    const pr = returns.get(primary.symbol);
    for (const other of ordered.slice(1)) {
      const or = returns.get(other.symbol);
      if (!pr || !or || pr.length !== or.length || pr.length < 2) continue;
      const rho = pearson(pr, or);
      if (!Number.isFinite(rho) || rho < SHARE_CLASS_MIN_CORR) continue;
      drop.set(other.symbol, {
        symbol: other.symbol,
        reason: 'shareClassDuplicate',
        detail: `${primary.symbol} ρ=${rho.toFixed(3)}, $${(other.dollarVolume / 1e6).toFixed(1)}M vs $${(primary.dollarVolume / 1e6).toFixed(1)}M`,
      });
    }
  }
  return {
    kept: candidates.filter((c) => !drop.has(c.symbol)),
    removed: [...drop.values()].sort((a, b) => (a.symbol < b.symbol ? -1 : 1)),
  };
}

/**
 * Trims any one industry, then any one sector, back to a share of the universe.
 *
 * Industry first, as specified, and it matters: the sector cap applied first
 * would thin banks and biotech evenly across their sector, leaving the *single*
 * over-represented industry inside it still over-represented. Trimming the
 * industry first removes the concentration where it actually is, and often
 * leaves the sector under its own cap with nothing further to do.
 *
 * Each cap is measured against the universe as it stands when that cap runs,
 * not against the original size: a cap computed on a number that no longer
 * exists is not a cap on anything.
 */
export function applyConcentrationCaps(
  candidates: readonly Candidate[],
  industryFraction: number = INDUSTRY_CAP_FRACTION,
  sectorFraction: number = SECTOR_CAP_FRACTION,
): { kept: Candidate[]; removed: Removal[] } {
  const removed: Removal[] = [];

  const trim = (
    input: readonly Candidate[],
    keyOf: (c: Candidate) => string,
    fraction: number,
    reason: CleanupReason,
  ): Candidate[] => {
    const cap = Math.max(1, Math.floor(input.length * fraction));
    const byKey = new Map<string, Candidate[]>();
    for (const c of input) {
      const k = keyOf(c) || '(unclassified)';
      (byKey.get(k) ?? byKey.set(k, []).get(k) as Candidate[]).push(c);
    }
    const cut = new Set<string>();
    for (const [key, group] of byKey) {
      if (group.length <= cap) continue;
      const ordered = [...group].sort(
        (a, b) => b.dollarVolume - a.dollarVolume || (a.symbol < b.symbol ? -1 : 1),
      );
      for (const c of ordered.slice(cap)) {
        cut.add(c.symbol);
        removed.push({
          symbol: c.symbol,
          reason,
          detail: `${key}: ${group.length} names over a cap of ${cap}, $${(c.dollarVolume / 1e6).toFixed(1)}M/day`,
        });
      }
    }
    return input.filter((c) => !cut.has(c.symbol));
  };

  const afterIndustry = trim(candidates, (c) => c.industry, industryFraction, 'industryCap');
  const afterSector = trim(afterIndustry, (c) => c.sector, sectorFraction, 'sectorCap');
  return { kept: afterSector, removed };
}
