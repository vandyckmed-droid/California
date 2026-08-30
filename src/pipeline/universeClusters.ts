import { THRESHOLDS } from '../config.ts';
import { completeLinkageGroups } from './cluster.ts';

/**
 * Complete-linkage groups over the *whole* eligible universe, one id per name
 * per threshold.
 *
 * This is what lets the ranked list mark rows that move with something the
 * user holds, without the browser needing correlation data for 2,320 names —
 * marking becomes set membership against ids that are already on screen.
 *
 * Two properties matter and both come from doing it here rather than in the
 * browser. It is computed from full-precision closes, so it is more accurate
 * than anything the shipped series could support. And it cannot truncate: a
 * top-N neighbour list silently loses members of a large group, and the
 * largest group in real data has ten names.
 *
 * Note this is deliberately a *coarser* notion than the watchlist's grouping
 * over a selection: complete linkage over a subset is not a restriction of
 * complete linkage over the whole, so a row marked here may land in a
 * different group once starred. That is why the marker says "moves with
 * something you hold" rather than "will group with it".
 */
export interface UniverseClusters {
  /** One entry per threshold, each an array of group ids in `symbols` order. */
  ids: number[][];
  /** Group count per threshold, excluding singletons. */
  groupCounts: number[];
  /** Largest group size per threshold. */
  largest: number[];
}

/** -1 marks a name that shares a group with nobody at that threshold. */
export const UNGROUPED = -1;

export function buildUniverseClusters(
  symbols: readonly string[],
  returns: readonly (readonly number[])[],
): UniverseClusters {
  const n = symbols.length;
  // Pre-standardize once so each correlation is a dot product rather than a
  // fresh two-pass mean/variance. At ~2,300 names that is 2.7M pairs.
  const z = returns.map((r) => standardize(r));

  const ids: number[][] = [];
  const groupCounts: number[] = [];
  const largest: number[] = [];

  for (const threshold of THRESHOLDS) {
    // Complete linkage only ever merges when *every* cross pair clears the
    // threshold, so a finished cluster is a clique in the "rho >= threshold"
    // graph and therefore lies wholly inside one connected component of it.
    // Clustering each component separately is exact, and turns an O(n^3) scan
    // over 2,320 names — 12.5 billion operations — into the same work over a
    // handful of small components.
    const adjacency: number[][] = Array.from({ length: n }, () => []);
    for (let i = 0; i < n; i++) {
      const zi = z[i] as Float64Array;
      for (let j = i + 1; j < n; j++) {
        if (dot(zi, z[j] as Float64Array) >= threshold) {
          (adjacency[i] as number[]).push(j);
          (adjacency[j] as number[]).push(i);
        }
      }
    }

    const row = new Array<number>(n).fill(UNGROUPED);
    let next = 0;
    let biggest = 0;

    for (const component of connectedComponents(adjacency, n)) {
      if (component.length < 2) continue;
      // Rebuild the small dense matrix this component needs.
      const C = component.map((a) =>
        component.map((b) => (a === b ? 1 : dot(z[a] as Float64Array, z[b] as Float64Array))),
      );
      for (const group of completeLinkageGroups(C, threshold)) {
        if (group.members.length < 2) continue;
        for (const member of group.members) row[component[member] as number] = next;
        next++;
        if (group.members.length > biggest) biggest = group.members.length;
      }
    }
    ids.push(row);
    groupCounts.push(next);
    largest.push(biggest);
  }
  return { ids, groupCounts, largest };
}

/** Mean-centred and scaled to unit norm, so correlation is a dot product. */
function standardize(values: readonly number[]): Float64Array {
  const n = values.length;
  const out = new Float64Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += values[i] as number;
  const mean = sum / n;
  let ss = 0;
  for (let i = 0; i < n; i++) {
    const d = (values[i] as number) - mean;
    out[i] = d;
    ss += d * d;
  }
  const norm = Math.sqrt(ss);
  if (norm > 0) for (let i = 0; i < n; i++) out[i] = (out[i] as number) / norm;
  return out;
}

function dot(a: Float64Array, b: Float64Array): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += (a[i] as number) * (b[i] as number);
  return s;
}

/** Iterative so a large component cannot blow the stack. */
function connectedComponents(adjacency: readonly number[][], n: number): number[][] {
  const seen = new Uint8Array(n);
  const out: number[][] = [];
  for (let start = 0; start < n; start++) {
    if (seen[start]) continue;
    const stack = [start];
    seen[start] = 1;
    const component: number[] = [];
    while (stack.length > 0) {
      const v = stack.pop() as number;
      component.push(v);
      for (const w of adjacency[v] as number[]) {
        if (!seen[w]) {
          seen[w] = 1;
          stack.push(w);
        }
      }
    }
    // Ascending, so cluster ids come out in a deterministic order.
    out.push(component.sort((a, b) => a - b));
  }
  return out;
}
