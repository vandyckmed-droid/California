import { createHash } from 'node:crypto';
import { roundTo } from '../../pipeline/snapshot.ts';
import {
  LEGS,
  LEG_KEYS,
  LEG_WEIGHTS,
  RIVER_SESSIONS,
  SCORE_DECIMALS,
  type LegKey,
} from './config.ts';
import { FAMILIES, FAMILY_KEYS, REMOVED, type EtfMember } from './universe.ts';
import { legsAt, sessionScores, type LegStats, type SessionScores } from './signal.ts';
import type { PairStat } from './redundancy.ts';

/**
 * Assembles the drawn object: one blended cross-sectional score per fund per
 * session, over roughly the last year, newest last.
 *
 * The file is columnar and rounded for the same reason the product's snapshot
 * is — it is downloaded by a phone — but it carries no ranking, no ordering by
 * score and no derived commentary. The order of `members` is the universe's own
 * fixed order, so nothing about the file changes when leadership does.
 */

export interface TodayStats {
  blend: number;
  /** Per leg, in `legs` order: the cross-sectional z-score. */
  z: number[];
  /** Per leg: the raw horizon return, and the annualized volatility it was divided by. */
  ret: number[];
  vol: number[];
}

export interface EtfRiver {
  /** Latest session drawn — the right edge. */
  asOf: string;
  /**
   * SHA-256 over the drawn payload and the parameters that produced it.
   *
   * Two runs over the same prices must produce the same file, and this is what
   * says so out loud. Diagnostics sit outside it: the redundancy screen
   * compares every pair and is reported for a human, not consumed by the page.
   */
  dataHash: string;
  /** Session dates, oldest first. */
  sessions: string[];
  families: { key: string; label: string }[];
  /**
   * The momentum legs, in the order every per-leg array uses.
   *
   * Shipped rather than assumed, so the page never has to hardcode a key or a
   * label that lives in the pipeline's config.
   */
  legs: { key: string; label: string; lookback: number; skip: number; weight: number }[];
  /** Universe order, fixed; `family` indexes `families`. */
  members: { symbol: string; label: string; family: number }[];
  /** Per member, the blended score per session. Null where it is uncomputable. */
  blend: (number | null)[][];
  /**
   * Per member, the latest session's figures.
   *
   * Only the latest: the two legs behind the blend are worth showing for the
   * name someone taps, and shipping their whole history would triple the file
   * to answer a question the drawing already answers.
   */
  today: (TodayStats | null)[];
  params: {
    sessions: number;
    volFloor: null;
    annualizeHorizonReturn: false;
    normalization: string;
  };
  diagnostics: {
    /** Name-sessions the data rules rejected, and how many were considered. */
    rejected: { nameSessions: number; of: number };
    /** Sessions whose cross-section was not the full universe. */
    partialSessions: number;
    /** The redundancy screen's closest pairs, and anything it flags. */
    closestPairs: PairStat[];
    flagged: PairStat[];
    /** Members removed from the starting list, carried for the record. */
    removed: readonly { symbol: string; label: string; because: string }[];
  };
}

const r = (x: number) => roundTo(x, SCORE_DECIMALS);

export interface BuiltRiver {
  river: EtfRiver;
  /** Per session, the full cross-section. Kept in memory for the run's gates. */
  perSession: SessionScores[];
  /** The session indices drawn, oldest first. */
  offsets: number[];
}

export function buildEtfRiver(
  universe: readonly EtfMember[],
  closes: ReadonlyMap<string, readonly (number | null)[]>,
  calendar: readonly string[],
  L: number,
  span: number = RIVER_SESSIONS,
): BuiltRiver {
  const symbols = universe.map((m) => m.symbol);

  // Oldest first, so the right edge of the drawing is the latest session.
  const offsets: number[] = [];
  for (let k = span - 1; k >= 0; k--) if (L - k >= 0) offsets.push(L - k);

  let rejected = 0;
  let considered = 0;
  const perSession = offsets.map((t) => {
    const legs = new Map<string, Record<LegKey, LegStats> | null>();
    for (const symbol of symbols) {
      const series = closes.get(symbol);
      considered++;
      const l = series ? legsAt(series, t) : null;
      if (!l) rejected++;
      legs.set(symbol, l);
    }
    return sessionScores(symbols, legs);
  });

  const blend: (number | null)[][] = symbols.map(() => []);
  const bySymbol = new Map(symbols.map((s, i) => [s, i]));
  for (const session of perSession) {
    const seen = new Set<number>();
    session.symbols.forEach((symbol, i) => {
      const idx = bySymbol.get(symbol) as number;
      seen.add(idx);
      (blend[idx] as (number | null)[]).push(r(session.blend[i] as number));
    });
    // A name absent from this date's cross-section gets a hole, not a value
    // carried over from the day before.
    for (let i = 0; i < symbols.length; i++) if (!seen.has(i)) (blend[i] as (number | null)[]).push(null);
  }

  const latest = perSession[perSession.length - 1] as SessionScores;
  const today: (TodayStats | null)[] = symbols.map((symbol) => {
    const i = latest.symbols.indexOf(symbol);
    if (i < 0) return null;
    const stats = latest.legs[i] as Record<LegKey, LegStats>;
    return {
      blend: r(latest.blend[i] as number),
      z: LEG_KEYS.map((key) => r(latest.z[key][i] as number)),
      ret: LEG_KEYS.map((key) => roundTo(stats[key].ret, 4)),
      vol: LEG_KEYS.map((key) => roundTo(stats[key].annVol, 4)),
    };
  });

  const legs = LEG_KEYS.map((k) => ({
    key: k,
    label: LEGS[k].label,
    lookback: LEGS[k].lookback,
    skip: LEGS[k].skip,
    weight: LEG_WEIGHTS[k],
  }));

  const params = {
    sessions: offsets.length,
    // Stated rather than omitted: the two departures from the product's stock
    // ranking are the whole reason this signal is not that one.
    volFloor: null as null,
    annualizeHorizonReturn: false as const,
    normalization: 'per-leg cross-sectional z-score, unwinsorized',
  };

  const sessions = offsets.map((t) => calendar[t] as string);
  const members = universe.map((m) => ({
    symbol: m.symbol,
    label: m.label,
    family: FAMILY_KEYS.indexOf(m.family),
  }));
  const dataHash = createHash('sha256')
    .update(JSON.stringify({ sessions, members, legs, blend, today, params }))
    .digest('hex');

  return {
    river: {
      asOf: calendar[L] as string,
      dataHash,
      sessions,
      families: FAMILY_KEYS.map((key) => ({ key, label: FAMILIES[key] })),
      legs,
      members,
      blend,
      today,
      params,
      diagnostics: {
        rejected: { nameSessions: rejected, of: considered },
        partialSessions: perSession.filter((s) => s.symbols.length < symbols.length).length,
        closestPairs: [],
        flagged: [],
        removed: REMOVED,
      },
    },
    perSession,
    offsets,
  };
}
