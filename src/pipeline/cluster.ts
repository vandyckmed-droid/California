/**
 * Correlation grouping by hierarchical agglomerative clustering with COMPLETE
 * linkage.
 *
 * Complete linkage is the defensible choice here because it guarantees that
 * *every* pair inside a group clears the threshold — which is the honest
 * reading of "these names may be the same trade", and an invariant the
 * pipeline asserts. Average linkage would admit members only weakly related to
 * the rest of their group, and single linkage would chain the whole Top 100
 * into one blob, since nearly every equity is somewhat market-correlated.
 *
 * Grouping is strictly downstream of ranking: it never reorders or removes a
 * ranked name.
 */

export interface Group {
  /** Indices into the ranked list, ascending — i.e. in momentum-rank order. */
  members: number[];
  /** Lowest pairwise correlation inside the group; 1 for a solo name. */
  minCorr: number;
  /** Best (lowest) rank index in the group, used to order groups. */
  bestRank: number;
  /**
   * Pairwise correlations between members, aligned with `members`. Populated
   * downstream for the detail screen; the clustering itself does not use it.
   */
  corr?: number[][];
}

/** Ties are compared on a rounded similarity so equal merges are detected consistently. */
const round12 = (x: number): number => Math.round(x * 1e12) / 1e12;

export function completeLinkageGroups(C: readonly (readonly number[])[], threshold: number): Group[] {
  const n = C.length;
  if (n === 0) return [];

  // Each cluster starts as one name. `members` stays sorted ascending, so a
  // cluster's first element is its best rank.
  const clusters: number[][] = Array.from({ length: n }, (_, i) => [i]);
  // sim[a][b] is the complete-linkage similarity: the *minimum* correlation
  // between any member of a and any member of b.
  const sim: number[][] = C.map((row) => [...row]);
  const alive: boolean[] = new Array(n).fill(true);

  while (true) {
    let bestSim = Number.NEGATIVE_INFINITY;
    let bestA = -1;
    let bestB = -1;
    let bestKeyLo = Number.POSITIVE_INFINITY;
    let bestKeyHi = Number.POSITIVE_INFINITY;

    for (let a = 0; a < n; a++) {
      if (!alive[a]) continue;
      for (let b = a + 1; b < n; b++) {
        if (!alive[b]) continue;
        const s = round12(sim[a]![b] as number);
        if (s < threshold) continue;

        // Deterministic tie-break: among equally similar merges, take the one
        // touching the best-ranked names. Ranks are unique, so this is a total
        // order and the result cannot depend on input ordering.
        const ra = clusters[a]![0] as number;
        const rb = clusters[b]![0] as number;
        const keyLo = Math.min(ra, rb);
        const keyHi = Math.max(ra, rb);

        const better =
          s > bestSim ||
          (s === bestSim && (keyLo < bestKeyLo || (keyLo === bestKeyLo && keyHi < bestKeyHi)));
        if (better) {
          bestSim = s;
          bestA = a;
          bestB = b;
          bestKeyLo = keyLo;
          bestKeyHi = keyHi;
        }
      }
    }

    if (bestA < 0) break;

    // Merge B into A, then update linkages by taking the worse of the two.
    clusters[bestA] = [...(clusters[bestA] as number[]), ...(clusters[bestB] as number[])].sort(
      (x, y) => x - y,
    );
    alive[bestB] = false;
    for (let k = 0; k < n; k++) {
      if (!alive[k] || k === bestA) continue;
      const merged = Math.min(sim[bestA]![k] as number, sim[bestB]![k] as number);
      sim[bestA]![k] = merged;
      sim[k]![bestA] = merged;
    }
  }

  const groups: Group[] = [];
  for (let a = 0; a < n; a++) {
    if (!alive[a]) continue;
    const members = clusters[a] as number[];
    let minCorr = 1;
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        const r = C[members[i] as number]![members[j] as number] as number;
        if (r < minCorr) minCorr = r;
      }
    }
    groups.push({ members, minCorr, bestRank: members[0] as number });
  }

  // Groups are presented in best-rank order, so the page reads top to bottom in
  // ascending rank whether a card holds one name or nine.
  groups.sort((x, y) => x.bestRank - y.bestRank);
  return groups;
}
