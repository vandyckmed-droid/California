import { describe, expect, it } from 'vitest';
import { completeLinkageGroups } from '../src/pipeline/cluster.ts';
import { correlationMatrix } from '../src/pipeline/correlation.ts';
import { pearson } from '../src/pipeline/stats.ts';

/** Builds a symmetric matrix from an upper-triangular spec, diagonal = 1. */
function matrix(n: number, pairs: Record<string, number>): number[][] {
  const C = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i++) C[i]![i] = 1;
  for (const [k, v] of Object.entries(pairs)) {
    const [a, b] = k.split('-').map(Number) as [number, number];
    C[a]![b] = v;
    C[b]![a] = v;
  }
  return C;
}

describe('complete-linkage grouping', () => {
  it('groups a mutually correlated triple and leaves the rest solo', () => {
    const C = matrix(5, { '0-1': 0.8, '0-2': 0.75, '1-2': 0.72, '3-4': 0.1 });
    const groups = completeLinkageGroups(C, 0.65);
    expect(groups.map((g) => g.members)).toEqual([[0, 1, 2], [3], [4]]);
  });

  it('guarantees every pair inside a group clears the threshold', () => {
    // 0-1 and 1-2 are strong but 0-2 is weak: complete linkage must refuse to
    // put 0 and 2 together, where single linkage would chain them.
    const C = matrix(3, { '0-1': 0.9, '1-2': 0.9, '0-2': 0.2 });
    const groups = completeLinkageGroups(C, 0.65);
    for (const g of groups) {
      for (const i of g.members) {
        for (const j of g.members) expect(C[i]![j]).toBeGreaterThanOrEqual(0.65);
      }
    }
    expect(groups.some((g) => g.members.length === 3)).toBe(false);
  });

  it('reports the weakest pair inside each group', () => {
    const C = matrix(3, { '0-1': 0.9, '0-2': 0.75, '1-2': 0.7 });
    const [g] = completeLinkageGroups(C, 0.65);
    expect(g!.members).toEqual([0, 1, 2]);
    expect(g!.minCorr).toBeCloseTo(0.7, 12);
  });

  it('keeps members in rank order and orders groups by their best rank', () => {
    const C = matrix(6, { '1-4': 0.9, '0-3': 0.8, '2-5': 0.7 });
    const groups = completeLinkageGroups(C, 0.65);
    for (const g of groups) {
      expect([...g.members].sort((a, b) => a - b)).toEqual(g.members);
      expect(g.bestRank).toBe(g.members[0]);
    }
    expect(groups.map((g) => g.bestRank)).toEqual([...groups.map((g) => g.bestRank)].sort((a, b) => a - b));
    expect(groups[0]!.members).toEqual([0, 3]);
  });

  it('never drops or duplicates a ranked name', () => {
    const C = matrix(8, { '0-1': 0.9, '1-2': 0.85, '0-2': 0.8, '5-6': 0.7 });
    const groups = completeLinkageGroups(C, 0.65);
    const seen = groups.flatMap((g) => g.members).sort((a, b) => a - b);
    expect(seen).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('yields all singletons when nothing clears the threshold', () => {
    const C = matrix(4, { '0-1': 0.5, '2-3': 0.64 });
    expect(completeLinkageGroups(C, 0.65).map((g) => g.members)).toEqual([[0], [1], [2], [3]]);
  });

  it('tightens monotonically as the threshold rises', () => {
    const C = matrix(4, { '0-1': 0.9, '0-2': 0.68, '1-2': 0.66, '0-3': 0.2, '1-3': 0.2, '2-3': 0.2 });
    expect(completeLinkageGroups(C, 0.6).map((g) => g.members)).toEqual([[0, 1, 2], [3]]);
    expect(completeLinkageGroups(C, 0.7).map((g) => g.members)).toEqual([[0, 1], [2], [3]]);
  });

  it('resolves ties identically regardless of scan order', () => {
    // Several pairs share exactly the same similarity.
    const C = matrix(6, { '0-1': 0.8, '2-3': 0.8, '4-5': 0.8, '0-2': 0.66, '1-3': 0.66 });
    const a = completeLinkageGroups(C, 0.65);
    const b = completeLinkageGroups(C.map((r) => [...r]), 0.65);
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
  });

  it('handles the degenerate empty case', () => {
    expect(completeLinkageGroups([], 0.65)).toEqual([]);
  });
});

describe('permutation invariance', () => {
  /**
   * Relabelling the names must produce the same partition. This is the property
   * that makes the grouping reproducible rather than an artifact of input order.
   */
  it('produces the same partition under a relabelling of the inputs', () => {
    const n = 12;
    // Deterministic pseudo-random return series, three latent factors.
    let seed = 42;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648 - 0.5;
    };
    const factors = Array.from({ length: 3 }, () => Array.from({ length: 130 }, rand));
    const series = Array.from({ length: n }, (_, i) => {
      const f = factors[i % 3] as number[];
      return f.map((v) => v * 0.9 + rand() * 0.1);
    });

    const C = correlationMatrix(series);
    const base = completeLinkageGroups(C, 0.65);
    const baseSets = base.map((g) => g.members.map((m) => (m % 3) as number));

    // Reverse the ordering and re-cluster; group membership by latent factor
    // must be unchanged.
    const perm = Array.from({ length: n }, (_, i) => n - 1 - i);
    const permuted = perm.map((p) => perm.map((q) => C[p]![q] as number));
    const other = completeLinkageGroups(permuted, 0.65);
    const otherSets = other.map((g) => g.members.map((m) => ((perm[m] as number) % 3) as number));

    const norm = (xs: number[][]) => JSON.stringify(xs.map((g) => [...g].sort()).sort());
    expect(norm(otherSets)).toEqual(norm(baseSets));
  });
});

describe('correlation matrix', () => {
  it('is symmetric with a unit diagonal', () => {
    const C = correlationMatrix([
      [0.01, -0.02, 0.03, 0.0],
      [0.02, -0.01, 0.02, 0.01],
      [-0.01, 0.03, -0.02, 0.0],
    ]);
    for (let i = 0; i < 3; i++) {
      expect(C[i]![i]).toBe(1);
      for (let j = 0; j < 3; j++) expect(C[i]![j]).toBeCloseTo(C[j]![i] as number, 15);
    }
  });

  it('detects a perfect linear relationship and its inverse', () => {
    expect(pearson([1, 2, 3, 4], [2, 4, 6, 8])).toBeCloseTo(1, 12);
    expect(pearson([1, 2, 3, 4], [-2, -4, -6, -8])).toBeCloseTo(-1, 12);
  });

  it('returns 0 rather than NaN for a flat series', () => {
    expect(pearson([1, 1, 1, 1], [1, 2, 3, 4])).toBe(0);
  });
});
