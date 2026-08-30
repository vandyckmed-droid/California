import { describe, expect, it } from 'vitest';
import { crossSectionalNormalize, winsorize, zScore } from '../src/pipeline/normalize.ts';
import { buildViews } from '../src/pipeline/score.ts';
import { HORIZON_KEYS, VIEW_IDS, VOL_FLOOR_ANNUALIZED, type HorizonKey } from '../src/config.ts';
import type { StockMetrics } from '../src/pipeline/momentum.ts';
import { sampleStdDev } from '../src/pipeline/stats.ts';

function metrics(
  symbol: string,
  per: Record<HorizonKey, { mom: number; rvol: number }>,
): StockMetrics {
  const horizons = {} as StockMetrics['horizons'];
  for (const k of HORIZON_KEYS) {
    const { mom, rvol } = per[k];
    const effectiveVol = Math.max(rvol, VOL_FLOOR_ANNUALIZED);
    horizons[k] = { momentum: mom, realizedVol: rvol, effectiveVol, volAdjusted: mom / effectiveVol };
  }
  // Scoring never reads trailingVol; it is reported, not ranked on.
  return { symbol, horizons, trailingVol: 0.3, latestClose: 50, dollarVolume: 1e8 };
}

const flat = (mom: number, rvol = 0.4) => ({
  h12_1: { mom, rvol },
  h9_1: { mom, rvol },
  h6_1: { mom, rvol },
});

describe('winsorize', () => {
  it('clips the tails to the interpolated percentile bounds', () => {
    const xs = [-100, 1, 2, 3, 4, 5, 6, 7, 8, 900];
    // n=10, type-7: p10 sits at index 0.9 and p90 at index 8.1.
    const lo = -100 * 0.1 + 1 * 0.9;
    const hi = 8 * 0.9 + 900 * 0.1;
    const w = winsorize(xs, 0.1, 0.9);
    expect(w[0]).toBeCloseTo(lo, 12);
    expect(w.at(-1)).toBeCloseTo(hi, 12);
    // Everything between the bounds is untouched.
    expect(w.slice(1, 9)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('stops a single outlier from swallowing the cross-section', () => {
    // A realistic cross-section: 199 ordinary names plus one extreme winner,
    // which is the shape the live 12-1 distribution actually has.
    const xs = [...Array.from({ length: 199 }, (_, i) => i / 100), 1000];
    const naive = zScore(xs);
    const clipped = crossSectionalNormalize(xs);
    expect(naive.at(-1)).toBeGreaterThan(13); // one name is 13+ sigma on its own
    expect(clipped.at(-1) as number).toBeLessThan(2.5);
    // Clipping pins everything past the bound to the same value, so the
    // extreme winner is no longer distinguishable from the next name up there.
    expect(clipped.at(-1) as number).toBeCloseTo(clipped.at(-2) as number, 12);
    // The transform stays monotonic, so it never reorders the cross-section.
    for (let i = 1; i < clipped.length; i++) {
      expect(clipped[i] as number).toBeGreaterThanOrEqual(clipped[i - 1] as number);
    }
  });
});

describe('zScore', () => {
  it('produces mean 0 and sample sd 1', () => {
    const z = zScore([2, 4, 4, 4, 5, 5, 7, 9]);
    expect(z.reduce((a, b) => a + b, 0) / z.length).toBeCloseTo(0, 12);
    expect(sampleStdDev(z)).toBeCloseTo(1, 12);
  });

  it('matches a hand-computed vector', () => {
    // mean 3, sample sd 2 for [1,3,5]
    expect(zScore([1, 3, 5])).toEqual([-1, 0, 1]);
  });

  it('maps a zero-variance cross-section to zeros rather than NaN', () => {
    expect(zScore([7, 7, 7])).toEqual([0, 0, 0]);
  });
});

describe('views', () => {
  const universe: StockMetrics[] = [
    metrics('AAA', flat(2.0)),
    metrics('BBB', flat(1.0)),
    metrics('CCC', flat(0.5)),
    metrics('DDD', flat(0.1)),
    metrics('EEE', flat(-0.2)),
  ];

  it('builds all eight views', () => {
    const views = buildViews(universe);
    expect([...views.keys()].sort()).toEqual([...VIEW_IDS].sort());
  });

  it('ranks single horizons by the raw figure, unaffected by normalization', () => {
    const v = buildViews(universe).get('h12_1|raw')!;
    expect(v.ranked.map((r) => r.symbol)).toEqual(['AAA', 'BBB', 'CCC', 'DDD', 'EEE']);
    expect(v.ranked[0]!.score).toBeCloseTo(2.0, 12);
    expect(v.ranked.map((r) => r.rank)).toEqual([1, 2, 3, 4, 5]);
  });

  it('breaks score ties on symbol so the order is total', () => {
    const tied = [metrics('ZZZ', flat(1.0)), metrics('AAA', flat(1.0)), metrics('MMM', flat(1.0))];
    expect(buildViews(tied).get('h9_1|raw')!.ranked.map((r) => r.symbol)).toEqual(['AAA', 'MMM', 'ZZZ']);
  });

  it('is invariant to the order the universe is supplied in', () => {
    const a = buildViews(universe).get('blend|voladj')!.ranked;
    const b = buildViews([...universe].reverse()).get('blend|voladj')!.ranked;
    expect(JSON.stringify(b)).toEqual(JSON.stringify(a));
  });

  it('blends three equally weighted normalized components', () => {
    const v = buildViews(universe).get('blend|raw')!;
    for (const entry of v.ranked) {
      const c = entry.components!;
      const expected = (c.h12_1 + c.h9_1 + c.h6_1) / 3;
      expect(entry.score).toBeCloseTo(expected, 12);
    }
  });

  it('lets a consistent mid-horizon name outrank a name strong only at 12-1', () => {
    // Normalization is what makes this possible: without it, the 12-1 spike
    // would carry the blend on raw magnitude alone.
    const mixed: StockMetrics[] = [
      metrics('SPIKE', { h12_1: { mom: 5.0, rvol: 0.4 }, h9_1: { mom: -0.3, rvol: 0.4 }, h6_1: { mom: -0.4, rvol: 0.4 } }),
      metrics('STEADY', { h12_1: { mom: 0.9, rvol: 0.4 }, h9_1: { mom: 0.9, rvol: 0.4 }, h6_1: { mom: 0.9, rvol: 0.4 } }),
      metrics('FILL1', flat(0.0)),
      metrics('FILL2', flat(0.1)),
      metrics('FILL3', flat(-0.1)),
    ];
    const blend = buildViews(mixed).get('blend|raw')!.ranked;
    expect(blend[0]!.symbol).toBe('STEADY');
    // The pure 12-1 view still shows the spike on top; the blend has not
    // altered any single-horizon ranking.
    expect(buildViews(mixed).get('h12_1|raw')!.ranked[0]!.symbol).toBe('SPIKE');
  });

  it('applies the volatility floor so quiet names get no extra credit', () => {
    const quiet = metrics('QUIET', flat(1.0, 0.05)); // realized 5% -> floored to 17.5%
    const atFloor = metrics('FLOOR', flat(1.0, 0.175));
    const views = buildViews([quiet, atFloor, metrics('X', flat(0.2))]);
    const ranked = views.get('h12_1|voladj')!.ranked;
    const q = ranked.find((r) => r.symbol === 'QUIET')!;
    const f = ranked.find((r) => r.symbol === 'FLOOR')!;
    expect(q.score).toBeCloseTo(f.score, 12);
    expect(q.score).toBeCloseTo(1.0 / VOL_FLOOR_ANNUALIZED, 12);
  });

  it('caps each view at topN', () => {
    const many = Array.from({ length: 250 }, (_, i) => metrics(`S${String(i).padStart(3, '0')}`, flat(i / 100)));
    expect(buildViews(many).get('h6_1|raw')!.ranked.length).toBe(100);
    expect(buildViews(many).get('h6_1|raw')!.universeSize).toBe(250);
  });
});
