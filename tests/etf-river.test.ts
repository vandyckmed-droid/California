import { describe, expect, it } from 'vitest';
import { TRADING_DAYS_PER_YEAR, VOL_FLOOR_ANNUALIZED } from '../src/config.ts';
import { buildEtfRiver } from '../src/labs/etfRiver/build.ts';
import { LEGS, LEG_KEYS } from '../src/labs/etfRiver/config.ts';
import { pairStats } from '../src/labs/etfRiver/redundancy.ts';
import { legStats, legsAt, sessionScores } from '../src/labs/etfRiver/signal.ts';
import { ETF_UNIVERSE, FAMILY_KEYS, REMOVED } from '../src/labs/etfRiver/universe.ts';
import { sampleStdDev } from '../src/pipeline/stats.ts';

/**
 * The gate on the ETF River experiment.
 *
 * The signal here is deliberately *not* the product's stock signal — no
 * volatility floor, no annualized horizon return, no winsorization — and every
 * one of those is a difference a later change could quietly undo by
 * "harmonising" the two. So each is asserted as a property with a value that
 * would visibly move if it were reinstated, not merely as a comment.
 *
 * Prices are constructed from a chosen list of daily returns, so the expected
 * return and volatility are known without reimplementing the function under
 * test inside the test.
 */

/** Prices whose successive simple returns are exactly `rets`. */
function pricesFrom(rets: readonly number[], start = 100): number[] {
  const out = [start];
  for (const r of rets) out.push((out[out.length - 1] as number) * (1 + r));
  return out;
}

/** A repeating pattern, so a window of any length has a known composition. */
const pattern = (n: number, cycle: readonly number[]) =>
  Array.from({ length: n }, (_, i) => cycle[i % cycle.length] as number);

describe('the momentum legs', () => {
  const { lookback, skip } = LEGS.l12_1;
  const rets = pattern(400, [0.01, -0.008, 0.004, -0.002, 0.006]);
  const closes = pricesFrom(rets);
  const L = closes.length - 1;

  it('measures the window the specification names: P[t−21] / P[t−252]', () => {
    const s = legStats(closes, L, lookback, skip);
    expect(s).not.toBeNull();
    const expected = (closes[L - skip] as number) / (closes[L - lookback] as number) - 1;
    expect((s as { ret: number }).ret).toBeCloseTo(expected, 12);
  });

  it('annualizes the volatility of that same window with √252', () => {
    const s = legStats(closes, L, lookback, skip) as { annVol: number; n: number };
    // The daily returns strictly inside (t−252, t−21]: 231 of them, matching
    // the number of closes in the window minus one.
    const window = rets.slice(L - lookback, L - skip);
    expect(s.n).toBe(lookback - skip);
    expect(window.length).toBe(lookback - skip);
    expect(s.annVol).toBeCloseTo(sampleStdDev(window) * Math.sqrt(TRADING_DAYS_PER_YEAR), 12);
  });

  it('divides by realized volatility with no floor', () => {
    // A deliberately quiet series: annualized volatility well under the 17.5%
    // the product floors single stocks at.
    const quiet = pricesFrom(pattern(400, [0.002, -0.001]));
    const s = legStats(quiet, quiet.length - 1, lookback, skip) as {
      ret: number; annVol: number; volAdjusted: number;
    };
    expect(s.annVol).toBeLessThan(VOL_FLOOR_ANNUALIZED);
    expect(s.volAdjusted).toBeCloseTo(s.ret / s.annVol, 12);
    // And the floor would have made a materially different number, so this is
    // a real difference rather than a distinction without one.
    expect(s.volAdjusted).toBeGreaterThan((s.ret / VOL_FLOOR_ANNUALIZED) * 1.2);
  });

  it('does not annualize the horizon return', () => {
    const s = legStats(closes, L, lookback, skip) as { ret: number };
    const annualized = (1 + s.ret) ** (TRADING_DAYS_PER_YEAR / (lookback - skip)) - 1;
    // The 6−1 leg spans under half a year, so annualizing it is not a no-op.
    const short = legStats(closes, L, LEGS.l6_1.lookback, LEGS.l6_1.skip) as { ret: number };
    const shortAnnualized = (1 + short.ret) ** (TRADING_DAYS_PER_YEAR / (LEGS.l6_1.lookback - LEGS.l6_1.skip)) - 1;
    expect(Math.abs(shortAnnualized - short.ret)).toBeGreaterThan(1e-3);
    expect(s.ret).not.toBeCloseTo(annualized, 6);
  });

  it('refuses a window it cannot compute rather than inventing one', () => {
    expect(legStats(closes, 100, lookback, skip)).toBeNull();          // not enough history
    expect(legStats(closes.slice(0, 200), 199, lookback, skip)).toBeNull();

    const holed = closes.slice();
    holed[L - 100] = null as unknown as number;                         // a gap mid-window
    expect(legStats(holed, L, lookback, skip)).toBeNull();

    const zeroed = closes.slice();
    zeroed[L - 100] = 0;                                                // a bad bar
    expect(legStats(zeroed, L, lookback, skip)).toBeNull();

    const negative = closes.slice();
    negative[L - lookback] = -1;
    expect(legStats(negative, L, lookback, skip)).toBeNull();

    // Zero volatility is missing information, not a free infinity.
    expect(legStats(pricesFrom(pattern(400, [0])), 400, lookback, skip)).toBeNull();
  });

  it('scans the whole window, not just its endpoints', () => {
    // A single bad bar in the middle leaves both anchors intact; a check that
    // only looked at them would return a plausible number built on a -100%
    // daily return.
    const holed = closes.slice();
    holed[L - skip - 1] = null as unknown as number;
    expect(holed[L - lookback]).toBeGreaterThan(0);
    expect(holed[L - skip]).toBeGreaterThan(0);
    expect(legStats(holed, L, lookback, skip)).toBeNull();
  });
});

describe('the daily cross-section', () => {
  const symbols = ['A', 'B', 'C', 'D', 'E'];
  const seriesFor = (drift: number) => pricesFrom(pattern(400, [drift, -drift / 2, drift / 3]));
  const closes = new Map(symbols.map((s, i) => [s, seriesFor(0.002 + i * 0.001)]));
  const L = 400;
  const legs = new Map(symbols.map((s) => [s, legsAt(closes.get(s) as number[], L)]));

  it('standardizes each leg independently within the date', () => {
    const scores = sessionScores(symbols, legs);
    for (const key of LEG_KEYS) {
      const z = scores.z[key];
      expect(z.reduce((a, b) => a + b, 0) / z.length).toBeCloseTo(0, 12);
      expect(sampleStdDev(z)).toBeCloseTo(1, 12);
    }
  });

  it('blends the two legs at equal weight', () => {
    const scores = sessionScores(symbols, legs);
    scores.blend.forEach((v, i) => {
      expect(v).toBeCloseTo(0.5 * (scores.z.l12_1[i] as number) + 0.5 * (scores.z.l6_1[i] as number), 12);
    });
  });

  it('is a relative measure: only a fund\'s position within the group survives', () => {
    // The property the whole screen rests on. If every fund\'s signal is
    // shifted and stretched by the same amounts — a good year for the whole
    // group, or a loud one — the picture must not move, because the picture is
    // about who is ahead of whom.
    const raw = [0.4, -0.9, 1.7, 0.05, -0.3];
    const make = (f: (v: number) => number) =>
      new Map(symbols.map((s, i) => [s, Object.fromEntries(
        LEG_KEYS.map((k, n) => [k, {
          ret: 0, annVol: 1, n: 10,
          volAdjusted: f((raw[(i + n) % raw.length] as number)),
        }]),
      ) as Record<(typeof LEG_KEYS)[number], { ret: number; annVol: number; volAdjusted: number; n: number }>]));

    const base = sessionScores(symbols, make((v) => v));
    const shifted = sessionScores(symbols, make((v) => 3 * v + 7));
    base.blend.forEach((v, i) => expect(shifted.blend[i]).toBeCloseTo(v, 12));
  });

  it('drops a fund it cannot score rather than carrying it forward', () => {
    const partial = new Map(legs);
    partial.set('C', null);
    const scores = sessionScores(symbols, partial);
    expect(scores.symbols).toEqual(['A', 'B', 'D', 'E']);
    expect(scores.blend).toHaveLength(4);
  });
});

describe('the drawn object', () => {
  const symbols = ETF_UNIVERSE.map((m) => m.symbol);
  const calendar = Array.from({ length: 600 }, (_, i) =>
    new Date(Date.UTC(2024, 0, 2 + i)).toISOString().slice(0, 10));
  const L = calendar.length - 1;
  const closes = new Map<string, (number | null)[]>(
    symbols.map((s, i) => [s, pricesFrom(pattern(600, [0.001 + i * 0.0004, -0.002, 0.0015, -0.0005]))]),
  );

  it('draws one value per fund per session, newest last', () => {
    const { river } = buildEtfRiver(ETF_UNIVERSE, closes, calendar, L, 60);
    expect(river.sessions).toHaveLength(60);
    expect(river.sessions[river.sessions.length - 1]).toBe(calendar[L]);
    expect(river.asOf).toBe(calendar[L]);
    expect(river.blend).toHaveLength(symbols.length);
    for (const path of river.blend) expect(path).toHaveLength(60);
  });

  it('reports today the same way it draws it', () => {
    const { river } = buildEtfRiver(ETF_UNIVERSE, closes, calendar, L, 60);
    river.members.forEach((m, i) => {
      const path = river.blend[i] as (number | null)[];
      expect(river.today[i]?.blend).toBe(path[path.length - 1]);
      expect(river.today[i]?.z).toHaveLength(LEG_KEYS.length);
    });
    expect(river.legs.map((l) => l.key)).toEqual([...LEG_KEYS]);
  });

  it('leaves a hole where a fund has no signal instead of bridging it', () => {
    const gapped = new Map(closes);
    const broken = (closes.get('XSD') as number[]).slice();
    broken[L - 300] = null as unknown as number;
    gapped.set('XSD', broken);
    const { river } = buildEtfRiver(ETF_UNIVERSE, gapped, calendar, L, 60);
    const i = river.members.findIndex((m) => m.symbol === 'XSD');
    const path = river.blend[i] as (number | null)[];
    expect(path.some((v) => v === null)).toBe(true);
    // Every other fund is unaffected: one absent name does not blank the date.
    expect(river.blend.filter((p) => p.some((v) => v === null))).toHaveLength(1);
  });

  it('is reproducible: the same prices produce the same file', () => {
    const a = buildEtfRiver(ETF_UNIVERSE, closes, calendar, L, 60).river;
    const b = buildEtfRiver(ETF_UNIVERSE, closes, calendar, L, 60).river;
    expect(a.dataHash).toBe(b.dataHash);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('states the two departures from the stock signal in the file itself', () => {
    const { river } = buildEtfRiver(ETF_UNIVERSE, closes, calendar, L, 60);
    expect(river.params.volFloor).toBeNull();
    expect(river.params.annualizeHorizonReturn).toBe(false);
    expect(river.params.normalization).toContain('unwinsorized');
  });
});

describe('the universe', () => {
  it('holds each fund once, in a fixed order that today cannot change', () => {
    const symbols = ETF_UNIVERSE.map((m) => m.symbol);
    expect(new Set(symbols).size).toBe(symbols.length);
    const byFamily = [...ETF_UNIVERSE].sort(
      (a, b) =>
        FAMILY_KEYS.indexOf(a.family) - FAMILY_KEYS.indexOf(b.family) ||
        (a.symbol < b.symbol ? -1 : 1),
    );
    expect(byFamily.map((m) => m.symbol)).toEqual(symbols);
  });

  it('does not contain anything it says it removed, and says why it removed it', () => {
    const symbols = new Set(ETF_UNIVERSE.map((m) => m.symbol));
    for (const r of REMOVED) {
      expect(symbols.has(r.symbol)).toBe(false);
      // A removal without a measured reason is the kind that gets undone.
      expect(r.because.length).toBeGreaterThan(80);
    }
  });

  it('assigns every fund to a known family', () => {
    for (const m of ETF_UNIVERSE) expect(FAMILY_KEYS).toContain(m.family);
  });
});

describe('the redundancy screen', () => {
  const rets = pattern(300, [0.01, -0.006, 0.003]);
  const other = pattern(300, [-0.004, 0.009, -0.001]);
  const path = (f: (i: number) => number) => Array.from({ length: 100 }, (_, i) => f(i));

  it('flags a pair only when the returns and the drawn paths both coincide', () => {
    const returns = new Map([['A', rets], ['B', rets.slice()], ['C', other]]);
    const paths = new Map<string, (number | null)[]>([
      ['A', path((i) => Math.sin(i / 9))],
      ['B', path((i) => Math.sin(i / 9) + 0.02)],
      ['C', path((i) => Math.cos(i / 5))],
    ]);
    const stats = pairStats(['A', 'B', 'C'], returns, paths);
    const ab = stats.find((p) => p.a === 'A' && p.b === 'B');
    expect(ab?.redundant).toBe(true);
    expect(stats.filter((p) => p.redundant)).toHaveLength(1);
  });

  it('does not flag a pair that shares a beta but takes turns leading', () => {
    // Correlated day to day, opposite in relative strength — the XOP/XES case,
    // and precisely what this screen is built to show rather than remove.
    const returns = new Map([['A', rets], ['B', rets.slice()]]);
    const paths = new Map<string, (number | null)[]>([
      ['A', path((i) => Math.sin(i / 9))],
      ['B', path((i) => -Math.sin(i / 9))],
    ]);
    expect(pairStats(['A', 'B'], returns, paths)[0]?.redundant).toBe(false);
  });

  it('does not flag a pair that merely drifted together for one year', () => {
    const returns = new Map([['A', rets], ['B', other]]);
    const paths = new Map<string, (number | null)[]>([
      ['A', path((i) => Math.sin(i / 9))],
      ['B', path((i) => Math.sin(i / 9) + 0.02)],
    ]);
    expect(pairStats(['A', 'B'], returns, paths)[0]?.redundant).toBe(false);
  });
});
