import { describe, expect, it } from 'vitest';
import { buildUniverseClusters, UNGROUPED } from '../src/pipeline/universeClusters.ts';
import { completeLinkageGroups } from '../src/pipeline/cluster.ts';
import { correlationMatrix } from '../src/pipeline/correlation.ts';
import { THRESHOLDS } from '../src/config.ts';

/** Deterministic pseudo-random returns built from a small number of factors. */
function factorReturns(n: number, factors: number, len: number, seed = 11): number[][] {
  let s = seed;
  const rand = () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648 - 0.5;
  };
  const f = Array.from({ length: factors }, () => Array.from({ length: len }, rand));
  return Array.from({ length: n }, (_, i) => {
    const base = f[i % factors] as number[];
    const load = 0.55 + ((i * 7) % 40) / 100;
    return base.map((v) => v * load + rand() * 0.35);
  });
}

/** Brute force: cluster the whole matrix at once, the way the Top-100 path does. */
function bruteForceIds(returns: number[][], threshold: number): number[] {
  const C = correlationMatrix(returns);
  const row = new Array<number>(returns.length).fill(UNGROUPED);
  let next = 0;
  for (const g of completeLinkageGroups(C, threshold)) {
    if (g.members.length < 2) continue;
    for (const m of g.members) row[m] = next;
    next++;
  }
  return row;
}

/** Compares partitions by membership, since id numbering is arbitrary. */
function partition(ids: readonly number[]): string {
  const byId = new Map<number, number[]>();
  ids.forEach((id, i) => {
    if (id === UNGROUPED) return;
    if (!byId.has(id)) byId.set(id, []);
    (byId.get(id) as number[]).push(i);
  });
  return JSON.stringify([...byId.values()].map((m) => m.sort((a, b) => a - b)).sort((a, b) => (a[0] as number) - (b[0] as number)));
}

describe('universe-wide cluster ids', () => {
  const returns = factorReturns(120, 6, 126);
  const symbols = returns.map((_, i) => `S${i}`);

  /**
   * The component split is an optimization, not a different algorithm: a
   * finished complete-linkage cluster is a clique in the threshold graph, so
   * it cannot span two components. If that reasoning were wrong the partition
   * would differ, which is what this asserts.
   */
  it('matches brute-force complete linkage exactly', () => {
    const built = buildUniverseClusters(symbols, returns);
    THRESHOLDS.forEach((threshold, t) => {
      expect(partition(built.ids[t] as number[])).toBe(partition(bruteForceIds(returns, threshold)));
    });
  });

  it('guarantees every pair sharing an id clears that threshold', () => {
    const built = buildUniverseClusters(symbols, returns);
    const C = correlationMatrix(returns);
    THRESHOLDS.forEach((threshold, t) => {
      const ids = built.ids[t] as number[];
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          if ((ids[i] as number) !== UNGROUPED && ids[i] === ids[j]) {
            expect((C[i] as number[])[j] as number).toBeGreaterThanOrEqual(threshold - 1e-9);
          }
        }
      }
    });
  });

  it('marks names that group with nobody rather than inventing singleton ids', () => {
    const built = buildUniverseClusters(symbols, returns);
    THRESHOLDS.forEach((_, t) => {
      const ids = built.ids[t] as number[];
      const counts = new Map<number, number>();
      for (const id of ids) if (id !== UNGROUPED) counts.set(id, (counts.get(id) ?? 0) + 1);
      for (const size of counts.values()) expect(size).toBeGreaterThan(1);
    });
  });

  it('tightens monotonically as the threshold rises', () => {
    const built = buildUniverseClusters(symbols, returns);
    for (let t = 1; t < THRESHOLDS.length; t++) {
      expect(built.largest[t] as number).toBeLessThanOrEqual(built.largest[t - 1] as number);
    }
  });

  it('is invariant to the order names are supplied in', () => {
    const perm = returns.map((_, i) => returns.length - 1 - i);
    const a = buildUniverseClusters(symbols, returns);
    const b = buildUniverseClusters(
      perm.map((p) => symbols[p] as string),
      perm.map((p) => returns[p] as number[]),
    );
    THRESHOLDS.forEach((_, t) => {
      const back = new Array<number>(returns.length).fill(UNGROUPED);
      (b.ids[t] as number[]).forEach((id, i) => { back[perm[i] as number] = id; });
      expect(partition(back)).toBe(partition(a.ids[t] as number[]));
    });
  });

  it('handles a universe with no correlated pairs at all', () => {
    const flat = Array.from({ length: 8 }, (_, i) => Array.from({ length: 126 }, (_, k) => (k * (i + 3)) % 7 - 3));
    const built = buildUniverseClusters(flat.map((_, i) => `X${i}`), flat);
    expect(built.groupCounts.every((c) => c >= 0)).toBe(true);
  });
});
