import { describe, expect, it } from 'vitest';
import {
  completeLinkage,
  compressionCurve,
  fitStock,
  partialR2,
  regress,
  spearman,
} from '../src/labs/etfBasis/analysis.ts';
import { CANDIDATES, CONTROL_PAIRS, CANDIDATE_SYMBOLS } from '../src/labs/etfBasis/candidates.ts';

const seq = (n: number, f: (i: number) => number) => Array.from({ length: n }, (_, i) => f(i));

describe('the regression', () => {
  it('recovers a known line exactly', () => {
    const x = seq(100, (i) => Math.sin(i / 3));
    const y = x.map((v) => 2.5 * v + 0.4);
    const f = regress(y, x);
    expect(f?.beta).toBeCloseTo(2.5, 10);
    expect(f?.alpha).toBeCloseTo(0.4, 10);
    expect(f?.r2).toBeCloseTo(1, 10);
  });

  it('reports no explanatory power for an unrelated series', () => {
    const x = seq(200, (i) => Math.sin(i / 3));
    const y = seq(200, (i) => Math.cos(i / 7.11));
    const f = regress(y, x);
    expect(f?.r2).toBeLessThan(0.1);
  });

  it('refuses a constant regressor and a short sample', () => {
    expect(regress(seq(100, (i) => i), seq(100, () => 3))).toBeNull();
    expect(regress(seq(10, (i) => i), seq(10, (i) => i * 2))).toBeNull();
  });
});

describe('partial R²', () => {
  it('is the squared correlation of the residuals', () => {
    const a = seq(200, (i) => Math.sin(i / 5));
    const b = a.map((v, i) => 0.6 * v + 0.4 * Math.cos(i / 9));
    expect(partialR2(a, b)).toBeGreaterThan(0.4);
    expect(partialR2(a, b)).toBeLessThanOrEqual(1);
  });

  it('is zero for orthogonal series and one for identical ones', () => {
    const a = seq(400, (i) => Math.sin((2 * Math.PI * i) / 40));
    const b = seq(400, (i) => Math.cos((2 * Math.PI * i) / 40));
    expect(partialR2(a, b)).toBeLessThan(0.02);
    expect(partialR2(a, a)).toBeCloseTo(1, 10);
  });
});

describe('complete linkage', () => {
  const labels = ['A', 'B', 'C', 'D'];
  //   A-B are 0.9; C is 0.8 to A but only 0.4 to B; D is alone.
  const corr = [
    [1.0, 0.9, 0.8, 0.1],
    [0.9, 1.0, 0.4, 0.1],
    [0.8, 0.4, 1.0, 0.1],
    [0.1, 0.1, 0.1, 1.0],
  ];

  it('only merges when every cross pair clears the bar', () => {
    // Single linkage would chain C onto A-B through the 0.8 and call all three
    // one bet, even though B and C barely move together.
    const groups = completeLinkage(labels, corr, 0.7);
    expect(groups.map((g) => g.join('')).sort()).toEqual(['AB', 'C', 'D']);
  });

  it('merges nothing when the bar is above every pair', () => {
    expect(completeLinkage(labels, corr, 0.95).map((g) => g.join(''))).toHaveLength(4);
  });

  it('merges the chain once the bar allows it', () => {
    expect(completeLinkage(labels, corr, 0.4).map((g) => g.join('')).sort()).toEqual(['ABC', 'D']);
  });
});

describe('mapping a stock to the basis', () => {
  const etfA = seq(200, (i) => Math.sin(i / 5));
  const etfB = seq(200, (i) => Math.cos(i / 11));
  const basis = new Map([['A', etfA], ['B', etfB]]);

  it('picks the closest member and reports the median as its own null', () => {
    const stock = etfA.map((v, i) => v + 0.05 * Math.sin(i / 2.3));
    const f = fitStock('X', stock, basis);
    expect(f?.bestEtf).toBe('A');
    expect(f?.best).toBeGreaterThan(0.9);
    // The median across a two-member basis is the weaker of the two, which is
    // what "an arbitrary basis member" would have explained.
    expect(f?.median).toBeLessThan(f?.best as number);
  });

  it('still returns a best match for a stock nothing explains', () => {
    // The point of reporting the null: a best-of-N maximum always exists and
    // always looks like something. Only the gap to the median says whether it is.
    const noise = seq(200, (i) => Math.sin(i * 1.7) * Math.cos(i * 0.31));
    const f = fitStock('X', noise, basis);
    expect(f).not.toBeNull();
    expect(f?.best).toBeLessThan(0.3);
  });
});

describe('the compression curve', () => {
  const stocks = [
    { symbol: 's1', byEtf: new Map([['A', 0.9], ['B', 0.1]]) },
    { symbol: 's2', byEtf: new Map([['A', 0.8], ['B', 0.1]]) },
    { symbol: 's3', byEtf: new Map([['A', 0.1], ['B', 0.7]]) },
    { symbol: 's4', byEtf: new Map([['A', 0.1], ['B', 0.1]]) },
  ];

  it('adds the most valuable bet first and never double-counts', () => {
    const curve = compressionCurve(stocks, ['A', 'B'], 0.5);
    expect(curve.map((c) => c.added)).toEqual(['A', 'B']);
    expect(curve.map((c) => c.covered)).toEqual([2, 3]);
    // s4 is explained by nothing, so the curve stops short of the universe.
    expect(curve[curve.length - 1]?.share).toBeCloseTo(0.75, 10);
  });

  it('stops once no remaining ETF represents anything new', () => {
    const curve = compressionCurve(stocks, ['A', 'B'], 0.95);
    expect(curve).toHaveLength(0);
  });

  it('is not sensitive to the order ETFs are offered in', () => {
    const a = compressionCurve(stocks, ['A', 'B'], 0.5).map((c) => c.added);
    const b = compressionCurve(stocks, ['B', 'A'], 0.5).map((c) => c.added);
    expect(a).toEqual(b);
  });
});

describe('spearman', () => {
  it('is 1 for a monotone relationship regardless of shape', () => {
    const x = seq(50, (i) => i);
    expect(spearman(x, x.map((v) => Math.exp(v / 10)))).toBeCloseTo(1, 10);
  });

  it('is -1 when reversed, and averages tied ranks', () => {
    const x = seq(50, (i) => i);
    expect(spearman(x, x.map((v) => -v))).toBeCloseTo(-1, 10);
    // A run of equal values must not manufacture an ordering.
    expect(spearman([1, 1, 1, 2], [5, 5, 5, 9])).toBeCloseTo(1, 10);
  });
});

describe('the candidate library', () => {
  it('has no duplicate symbols', () => {
    expect(new Set(CANDIDATE_SYMBOLS).size).toBe(CANDIDATE_SYMBOLS.length);
  });

  it('states a redundancy prediction the study can be scored against', () => {
    // The controls are the study's own falsifier: a method that fails to merge
    // two semiconductor ETFs is broken, and without a known answer in the data
    // there is no way to tell a working method from a plausible one.
    expect(CONTROL_PAIRS.length).toBeGreaterThanOrEqual(10);
    for (const [a, b] of CONTROL_PAIRS) {
      expect(CANDIDATE_SYMBOLS).toContain(a);
      expect(CANDIDATE_SYMBOLS).toContain(b);
      expect(a).not.toBe(b);
    }
  });

  it('carries a label and a reporting group for every candidate', () => {
    for (const c of CANDIDATES) {
      expect(c.label.length, c.symbol).toBeGreaterThan(2);
      expect(c.group.length, c.symbol).toBeGreaterThan(2);
    }
  });
});
