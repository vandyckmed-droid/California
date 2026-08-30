import { describe, expect, it } from 'vitest';
import { horizonStats } from '../src/pipeline/momentum.ts';
import { alignToCalendar, asOfIndex, buildMasterCalendar } from '../src/pipeline/calendar.ts';
import { sampleStdDev, percentileSorted, simpleReturns } from '../src/pipeline/stats.ts';
import { TRADING_DAYS_PER_YEAR, VOL_FLOOR_ANNUALIZED } from '../src/config.ts';
import type { AdjustedBar, History } from '../src/fmp/types.ts';

/** Closes that grow at a constant daily rate: zero volatility, known return. */
function geometric(n: number, start: number, dailyRate: number): number[] {
  const out = [start];
  for (let i = 1; i < n; i++) out.push((out[i - 1] as number) * (1 + dailyRate));
  return out;
}

describe('horizon momentum', () => {
  it('measures return from t-lookback to t-skip, excluding the skip window', () => {
    // 300 closes. Flat until index 279, then a sharp move in the last 20 days.
    const closes = new Array(300).fill(100) as number[];
    for (let i = 280; i < 300; i++) closes[i] = 500;
    const L = 299;

    // 12-1 ends at index 278, entirely before the spike, so it must not see it.
    const s = horizonStats(closes, L, 252, 21)!;
    expect(s.momentum).toBeCloseTo(0, 12);
  });

  it('computes the point-to-point return exactly', () => {
    const closes = new Array(300).fill(0).map((_, i) => (i === 47 ? 50 : i === 278 ? 125 : 100));
    const L = 299;
    const s = horizonStats(closes, L, 252, 21)!; // start idx 47, end idx 278
    expect(s.momentum).toBeCloseTo(125 / 50 - 1, 12);
  });

  it('annualizes volatility from daily returns inside the horizon window', () => {
    const closes = geometric(300, 100, 0.001);
    const L = 299;
    const s = horizonStats(closes, L, 252, 21)!;
    // Constant growth rate => zero dispersion => realized vol is 0.
    expect(s.realizedVol).toBeCloseTo(0, 12);
    // ...and the floor takes over.
    expect(s.effectiveVol).toBe(VOL_FLOOR_ANNUALIZED);
  });

  it('matches a hand-computed annualized volatility', () => {
    const closes: number[] = [100];
    for (let i = 1; i < 300; i++) closes.push((closes[i - 1] as number) * (i % 2 === 0 ? 1.02 : 0.99));
    const L = 299;
    const s = horizonStats(closes, L, 252, 21)!;
    const window = closes.slice(L - 252, L - 21 + 1);
    const expected = sampleStdDev(simpleReturns(window)) * Math.sqrt(TRADING_DAYS_PER_YEAR);
    expect(s.realizedVol).toBeCloseTo(expected, 12);
  });

  it('uses lookback-minus-skip daily returns for the volatility window', () => {
    const closes = geometric(300, 100, 0.001);
    expect(simpleReturns(closes.slice(299 - 252, 299 - 21 + 1)).length).toBe(231);
    expect(simpleReturns(closes.slice(299 - 189, 299 - 21 + 1)).length).toBe(168);
    expect(simpleReturns(closes.slice(299 - 126, 299 - 21 + 1)).length).toBe(105);
  });

  it('returns null when history is too short for the horizon', () => {
    expect(horizonStats(geometric(100, 100, 0.001), 99, 252, 21)).toBeNull();
  });
});

describe('17.5% volatility floor', () => {
  function volOf(dailyAmplitude: number): ReturnType<typeof horizonStats> {
    const closes: number[] = [100];
    for (let i = 1; i < 300; i++) {
      closes.push((closes[i - 1] as number) * (i % 2 === 0 ? 1 + dailyAmplitude : 1 - dailyAmplitude));
    }
    return horizonStats(closes, 299, 252, 21);
  }

  it('binds for quiet names, so two sub-floor names share one divisor', () => {
    // ~0.3%/day => roughly 5% annualized; ~0.6%/day => roughly 10%. Both < 17.5%.
    const quiet = volOf(0.003)!;
    const quieter = volOf(0.0015)!;
    expect(quiet.realizedVol).toBeLessThan(VOL_FLOOR_ANNUALIZED);
    expect(quieter.realizedVol).toBeLessThan(VOL_FLOOR_ANNUALIZED);
    expect(quiet.effectiveVol).toBe(VOL_FLOOR_ANNUALIZED);
    expect(quieter.effectiveVol).toBe(VOL_FLOOR_ANNUALIZED);
  });

  it('does not bind for volatile names', () => {
    const loud = volOf(0.03)!;
    expect(loud.realizedVol).toBeGreaterThan(VOL_FLOOR_ANNUALIZED);
    expect(loud.effectiveVol).toBe(loud.realizedVol);
  });

  it('divides raw momentum by the effective, not the realized, volatility', () => {
    const quiet = volOf(0.003)!;
    expect(quiet.volAdjusted).toBeCloseTo(quiet.momentum / VOL_FLOOR_ANNUALIZED, 12);
    const loud = volOf(0.03)!;
    expect(loud.volAdjusted).toBeCloseTo(loud.momentum / loud.realizedVol, 12);
  });
});

function bar(symbol: string, date: string, close: number): AdjustedBar {
  return { symbol, date, adjOpen: close, adjHigh: close, adjLow: close, adjClose: close, volume: 1000 };
}

describe('master calendar and as-of alignment', () => {
  const mk = (symbol: string, dates: string[]): History => ({
    symbol,
    bars: dates.map((d, i) => bar(symbol, d, 100 + i)),
  });

  it('keeps dates traded by enough names and drops thin ones', () => {
    const hs = [
      mk('A', ['2026-01-02', '2026-01-05', '2026-01-06']),
      mk('B', ['2026-01-02', '2026-01-05', '2026-01-06']),
      mk('C', ['2026-01-02', '2026-01-05', '2026-01-06', '2026-01-07']),
    ];
    // 2026-01-07 appears for 1 of 3 names (33%) and is below the 60% floor.
    expect(buildMasterCalendar(hs, 3)).toEqual(['2026-01-02', '2026-01-05', '2026-01-06']);
  });

  it('is independent of the order histories are supplied in', () => {
    const hs = [mk('A', ['2026-01-02', '2026-01-05']), mk('B', ['2026-01-02', '2026-01-05'])];
    expect(buildMasterCalendar(hs, 2)).toEqual(buildMasterCalendar([...hs].reverse(), 2));
  });

  it('finds the last bar on or before a target date', () => {
    const bars = [bar('A', '2026-01-02', 1), bar('A', '2026-01-06', 2), bar('A', '2026-01-08', 3)];
    expect(asOfIndex(bars, '2026-01-07')).toBe(1);
    expect(asOfIndex(bars, '2026-01-08')).toBe(2);
    expect(asOfIndex(bars, '2026-01-01')).toBe(-1);
  });

  it('carries the prior close across a halt and flags it as not actual', () => {
    const cal = ['2026-01-02', '2026-01-05', '2026-01-06', '2026-01-07'];
    // The name did not trade on 2026-01-06.
    const h: History = {
      symbol: 'A',
      bars: [bar('A', '2026-01-02', 10), bar('A', '2026-01-05', 11), bar('A', '2026-01-07', 13)],
    };
    const s = alignToCalendar(h, cal);
    expect(s.closes).toEqual([10, 11, 11, 13]);
    expect(s.actual).toEqual([true, true, false, true]);
  });

  it('leaves nulls before a name first traded', () => {
    const cal = ['2026-01-02', '2026-01-05', '2026-01-06'];
    const h: History = { symbol: 'IPO', bars: [bar('IPO', '2026-01-06', 20)] };
    const s = alignToCalendar(h, cal);
    expect(s.closes).toEqual([null, null, 20]);
  });
});

describe('percentile convention', () => {
  it('interpolates linearly between order statistics (type 7)', () => {
    const xs = [1, 2, 3, 4, 5];
    expect(percentileSorted(xs, 0)).toBe(1);
    expect(percentileSorted(xs, 1)).toBe(5);
    expect(percentileSorted(xs, 0.5)).toBe(3);
    expect(percentileSorted(xs, 0.25)).toBe(2);
    expect(percentileSorted([1, 2], 0.5)).toBeCloseTo(1.5, 12);
  });
});
