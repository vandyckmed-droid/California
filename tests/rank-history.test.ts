import { describe, expect, it } from 'vitest';
import { buildRankHistory } from '../src/pipeline/rankHistory.ts';
import { buildSnapshot } from '../src/pipeline/snapshot.ts';
import { horizonStats } from '../src/pipeline/momentum.ts';
import { ranksFor, scoresFor } from '../web/lib/model.js';
import {
  HORIZONS, HORIZON_KEYS, MAX_LOOKBACK, MODES, SCORE_KEYS, VOL_FLOOR_ANNUALIZED, viewId,
  type HorizonKey,
} from '../src/config.ts';
import type { AlignedSeries } from '../src/pipeline/calendar.ts';
import type { StockMetrics } from '../src/pipeline/momentum.ts';
import type { UniverseMember } from '../src/pipeline/universe.ts';

/**
 * The gate on the Rank River experiment.
 *
 * The backfill is a second path to a number the product already computes, and
 * the failure mode that matters is not a wrong price but a wrong *session* —
 * an off-by-one in the indexing would produce ranks that look entirely
 * plausible and are silently a day out. So the test is an identity: backfilled
 * at k=0, over the session it shares with the snapshot, it must reproduce the
 * shipped ranking exactly, for every name in all eight views, with no
 * tolerance.
 *
 * Deterministic synthetic prices, because the point is the indexing and the
 * rounding, both of which are independent of what the prices are.
 */

const SESSIONS = 320;
const NAMES = 60;

/** A cheap deterministic PRNG, so a failure is always reproducible. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const calendar = Array.from({ length: SESSIONS }, (_, i) => {
  const d = new Date(Date.UTC(2025, 0, 5 + i));
  return d.toISOString().slice(0, 10);
});
const L = SESSIONS - 1;

const symbols = Array.from({ length: NAMES }, (_, i) => `S${String(i).padStart(3, '0')}`);

/** Random walks with per-name drift and volatility, so ranks actually differ. */
const aligned = new Map<string, AlignedSeries>();
for (const [i, symbol] of symbols.entries()) {
  const rand = rng(1000 + i * 7);
  const drift = (rand() - 0.45) * 0.004;
  const vol = 0.008 + rand() * 0.03;
  const closes: (number | null)[] = [];
  let price = 20 + rand() * 200;
  for (let t = 0; t < SESSIONS; t++) {
    price *= 1 + drift + (rand() - 0.5) * vol;
    closes.push(price);
  }
  aligned.set(symbol, {
    symbol,
    closes,
    volumes: closes.map(() => 1e6),
    actual: closes.map(() => true),
  });
}

/** Today's metrics, exactly as `computeMetrics` would produce them. */
function metricsToday(): StockMetrics[] {
  return symbols.map((symbol) => {
    const closes = aligned.get(symbol)!.closes as number[];
    const horizons = {} as StockMetrics['horizons'];
    for (const key of HORIZON_KEYS as readonly HorizonKey[]) {
      const { lookback, skip } = HORIZONS[key];
      horizons[key] = horizonStats(closes, L, lookback, skip)!;
    }
    return {
      symbol,
      horizons,
      trailingVol: 0.3,
      latestClose: closes[L] as number,
      dollarVolume: 1e8,
    };
  });
}

const metrics = metricsToday();
const members = new Map<string, UniverseMember>(
  symbols.map((symbol) => [symbol, {
    symbol, name: symbol, sector: 'Technology', exchange: 'NASDAQ',
    country: 'US', marketCap: 5e9,
  } as UniverseMember]),
);

const snapshot = buildSnapshot({
  asOf: calendar[L] as string,
  calendarLength: SESSIONS,
  chartDates: calendar.slice(L - 252, L + 1),
  anchors: {
    h12_1: { start: calendar[L - 252] as string, end: calendar[L - 21] as string },
    h9_1: { start: calendar[L - 189] as string, end: calendar[L - 21] as string },
    h6_1: { start: calendar[L - 126] as string, end: calendar[L - 21] as string },
  },
  members,
  metrics,
  clusters: { ids: [[], [], []], groupCounts: [0, 0, 0], largest: [0, 0, 0] },
  screenedCount: NAMES,
  afterStaticExclusions: NAMES,
  exclusions: {},
  excludedSamples: {},
}) as any;

const history = buildRankHistory(symbols, aligned, calendar, L, 30, 20);

describe('the rank-history backfill', () => {
  it('reproduces the shipped ranking exactly at k=0', () => {
    // The gate. Every name, every view, no tolerance.
    const lastIndex = history.sessions.length - 1;
    for (const score of SCORE_KEYS) {
      for (const mode of MODES) {
        const id = viewId(score, mode);
        const live = ranksFor(scoresFor(snapshot, score, mode), snapshot.columns.symbol) as number[];
        const liveBySymbol = new Map<string, number>();
        snapshot.columns.symbol.forEach((s: string, i: number) => liveBySymbol.set(s, live[i] as number));

        const view = history.views[id]!;
        expect(view.symbols.length).toBe(20);
        view.symbols.forEach((symbol, n) => {
          expect(
            view.ranks[n]![lastIndex],
            `${id} ${symbol}: backfilled today's rank disagrees with the product`,
          ).toBe(liveBySymbol.get(symbol));
        });
      }
    }
  });

  it('lists exactly the current top 20, in rank order', () => {
    for (const score of SCORE_KEYS) {
      for (const mode of MODES) {
        const id = viewId(score, mode);
        const live = ranksFor(scoresFor(snapshot, score, mode), snapshot.columns.symbol) as number[];
        const expected = (snapshot.columns.symbol as string[])
          .map((s: string, i: number): [string, number] => [s, live[i] as number])
          .filter(([, r]: [string, number]) => r <= 20)
          .sort((a: [string, number], b: [string, number]) => a[1] - b[1])
          .map(([s]: [string, number]) => s);
        expect(history.views[id]!.symbols).toEqual(expected);
      }
    }
  });

  it('runs oldest first, ending on the latest session', () => {
    expect(history.sessions).toHaveLength(30);
    expect(history.sessions[history.sessions.length - 1]).toBe(calendar[L]);
    expect(history.sessions[0]).toBe(calendar[L - 29]);
    const sorted = [...history.sessions].sort();
    expect(history.sessions).toEqual(sorted);
  });

  it('gives every name one rank per session', () => {
    for (const view of Object.values(history.views)) {
      for (const trail of view.ranks) {
        expect(trail).toHaveLength(30);
        // Synthetic names all have full history, so none should be null here.
        expect(trail.every((r) => typeof r === 'number' && r >= 1)).toBe(true);
      }
    }
  });

  it('ranks move between sessions rather than being copied forward', () => {
    // Guards the indexing from the other side: if every session read the same
    // `L`, the identity test above would still pass and every trail would be
    // flat. Real ranks churn.
    const trails = Object.values(history.views).flatMap((v) => v.ranks);
    const moved = trails.filter((t) => new Set(t).size > 1);
    expect(moved.length).toBeGreaterThan(trails.length * 0.5);
  });

  it('never ranks a name outside the session cross-section', () => {
    for (const view of Object.values(history.views)) {
      for (const trail of view.ranks) {
        for (const rank of trail) {
          if (rank !== null) expect(rank).toBeLessThanOrEqual(NAMES);
        }
      }
    }
  });

  it('carries all eight views', () => {
    expect(Object.keys(history.views).sort()).toEqual(
      SCORE_KEYS.flatMap((s) => MODES.map((m) => viewId(s, m))).sort(),
    );
  });

  it('uses the shipped volatility floor', () => {
    // The backfill builds its own snapshot-shaped object for `scoresFor`; if it
    // invented a floor, the vol-adjusted views would silently diverge.
    expect(VOL_FLOOR_ANNUALIZED).toBe(0.175);
  });
});

/**
 * A bad bar outside the validated span must not reach the maths.
 *
 * `computeMetrics` guarantees `closes[i] > 0` only over `[L - MAX_LOOKBACK, L]`
 * for the *latest* session. This backfill reads up to 29 sessions further back,
 * so the oldest stretch of an old 12-1 window is territory nothing validated —
 * and `horizonStats` checks the two window endpoints, never the interior.
 *
 * The damage is specific and would look like a real finding: `simpleReturns`
 * skips the return whose previous close is bad, but the return *into* it
 * evaluates to `null / prev - 1`, which is exactly -100%. One such return
 * inflates that name's realized volatility in every session whose window covers
 * it, so its vol-adjusted trail collapses and then "recovers" — a fabricated
 * arrival in a drawing built to show arrivals. The k=0 gate cannot catch it,
 * because k=0 is inside the validated span.
 */
describe('prices outside the validated span', () => {
  const BAD_AT = L - 260; // inside [L-281, L-253]: unvalidated by computeMetrics

  // A name that is actually drawn, so the gap assertion below is not vacuous.
  const victim = history.views[viewId('h12_1', 'raw')]!.symbols[5] as string;

  const withGap = new Map<string, AlignedSeries>();
  for (const [symbol, series] of aligned) {
    withGap.set(symbol, { ...series, closes: [...series.closes] });
  }
  (withGap.get(victim)!.closes)[BAD_AT] = null;

  const gapped = buildRankHistory(symbols, withGap, calendar, L, 30, 20);

  it('the bad bar sits outside what the product validated', () => {
    expect(BAD_AT).toBeLessThan(L - MAX_LOOKBACK);
    expect(BAD_AT).toBeGreaterThanOrEqual(L - 29 - MAX_LOOKBACK);
  });

  it('still ranks the name today, whose window excludes the bad bar', () => {
    // k=0 spans [L-252, L] and never reads index L-260, so the newest session
    // is untouched and the top-20 sets match the clean run exactly.
    for (const score of SCORE_KEYS) {
      for (const mode of MODES) {
        const id = viewId(score, mode);
        expect(gapped.views[id]!.symbols).toEqual(history.views[id]!.symbols);
      }
    }
  });

  it('drops the name from the sessions whose window covers it', () => {
    const id = viewId('h12_1', 'raw');
    const view = gapped.views[id]!;
    const trail = view.ranks[view.symbols.indexOf(victim)]!;
    // A gap, not a rank computed from a -100% return. The drawing renders it
    // as a break in the trail.
    expect(trail.some((r) => r === null)).toBe(true);
    expect(trail[trail.length - 1]).not.toBeNull();
    // The clean run has no gap at all, so the nulls are caused by the bad bar.
    const cleanTrail = history.views[id]!.ranks[history.views[id]!.symbols.indexOf(victim)]!;
    expect(cleanTrail.every((r) => r !== null)).toBe(true);
  });

  it('removes the name cleanly rather than corrupting the session', () => {
    // Dropping a name shrinks that session's cross-section, so ranks move —
    // legitimately, and by a bounded amount. The two bounds have different
    // standing and are set differently:
    //
    // Single horizons rank on a raw figure, so removing one name moves the
    // names below it up by exactly one and nobody else at all. That is
    // structural, so {0,+1} is asserted exactly, with no margin.
    //
    // The blend ranks on winsorised z-scores, which are recomputed over the
    // changed cross-section, so a name can move either way and the bound is
    // not structural. Measured on this fixture it is -1..+2; asserted at
    // -2..+3 for margin, since the point is to catch corruption rather than to
    // pin an exact number that a fixture change would break.
    //
    // A -100% return leaking into a volatility moves a name far further than
    // either bound, which is what this actually guards.
    for (const score of SCORE_KEYS) {
      for (const mode of MODES) {
        const id = viewId(score, mode);
        const lo = score === 'blend' ? -2 : 0;
        const hi = score === 'blend' ? 3 : 1;
        const clean = history.views[id]!;
        const dirty = gapped.views[id]!;
        dirty.symbols.forEach((symbol, n) => {
          if (symbol === victim) return;
          const c = clean.ranks[clean.symbols.indexOf(symbol)]!;
          dirty.ranks[n]!.forEach((r, i) => {
            if (r === null) return;
            const shift = (c[i] as number) - r;
            expect(shift, `${id} ${symbol} moved ${shift} places`).toBeGreaterThanOrEqual(lo);
            expect(shift, `${id} ${symbol} moved ${shift} places`).toBeLessThanOrEqual(hi);
          });
        });
      }
    }
  });
});
