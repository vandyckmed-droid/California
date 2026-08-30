/**
 * The numerical core, shared by the pipeline and the browser.
 *
 * This is the **only** copy. The watchlist groups whatever names the user
 * picked, client-side, which is the same maths the pipeline runs over the
 * universe — two implementations of that would drift, and drift here is
 * invisible until the numbers disagree.
 *
 * It lives under `web/` because only `web/` is deployed; the pipeline imports
 * it back through `src/pipeline/`. Type-checked under `checkJs`, so moving it
 * out of TypeScript does not move it out of the checked surface.
 *
 * Deliberately absent: any price-series decoder. Putting one next to `pearson`
 * is what made feeding display-grade prices into a correlation feel like the
 * natural thing to do, and that produced risk numbers that were plausible,
 * self-consistent and wrong. The display decoder lives with the chart, named
 * `decodeDisplaySeries`; correlations are computed only from correlation-grade
 * data.
 */

/**
 * Reads an element the caller has already bounded by `.length`.
 *
 * `noUncheckedIndexedAccess` types every index read as possibly-undefined,
 * which is right in general and pure noise inside a numeric kernel whose loops
 * are bounded by the array itself. One documented helper is better than a cast
 * on every line, and far better than turning the check off — it is what
 * catches the mistakes that matter here.
 *
 * @param {readonly number[]} a
 * @param {number} i
 * @returns {number}
 */
const at = (a, i) => /** @type {number} */ (a[i]);

/**
 * @param {readonly (readonly number[])[]} m
 * @param {number} i
 * @returns {readonly number[]}
 */
const row = (m, i) => /** @type {readonly number[]} */ (m[i]);

/**
 * Simple daily returns from a close series.
 * @param {readonly number[]} closes
 * @returns {number[]}
 */
export function simpleReturns(closes) {
  const out = [];
  for (let i = 1; i < closes.length; i++) {
    const prev = at(closes, i - 1);
    if (prev > 0) out.push(at(closes, i) / prev - 1);
  }
  return out;
}

/**
 * Arithmetic mean. Accumulated in index order so repeated runs agree bit for bit.
 * @param {readonly number[]} xs
 * @returns {number}
 */
export function mean(xs) {
  if (xs.length === 0) return 0;
  let sum = 0;
  for (const v of xs) sum += v;
  return sum / xs.length;
}

/**
 * Pearson correlation. Returns 0 when either series has no variance.
 * @param {readonly number[]} a
 * @param {readonly number[]} b
 * @returns {number}
 */
export function pearson(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;
  const ma = mean(a.slice(0, n));
  const mb = mean(b.slice(0, n));
  let cov = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < n; i++) {
    const da = at(a, i) - ma;
    const db = at(b, i) - mb;
    cov += da * db;
    va += da * da;
    vb += db * db;
  }
  if (va <= 0 || vb <= 0) return 0;
  return cov / Math.sqrt(va * vb);
}

/**
 * Symmetric correlation matrix, accumulated in fixed index order.
 * @param {readonly (readonly number[])[]} returns
 * @returns {number[][]}
 */
export function correlationMatrix(returns) {
  const n = returns.length;
  /** @type {number[][]} */
  const C = Array.from({ length: n }, () => new Array(n).fill(1));
  for (let i = 0; i < n; i++) {
    const ri = row(returns, i);
    for (let j = i + 1; j < n; j++) {
      const r = pearson(ri, row(returns, j));
      /** @type {number[]} */ (C[i])[j] = r;
      /** @type {number[]} */ (C[j])[i] = r;
    }
  }
  return C;
}

/**
 * @typedef {object} Group
 * @property {number[]} members Indices into the input, ascending.
 * @property {number} minCorr Lowest pairwise correlation inside the group; 1 for a solo name.
 * @property {number} bestRank Lowest member index, used to order groups.
 * @property {number[][]} [corr] Pairwise correlations between members, for display.
 */

/** Ties are compared on a rounded similarity so equal merges are detected consistently. */
const round12 = (/** @type {number} */ x) => Math.round(x * 1e12) / 1e12;

/**
 * Correlation grouping by hierarchical agglomerative clustering with COMPLETE
 * linkage.
 *
 * Complete linkage guarantees that *every* pair inside a group clears the
 * threshold, which is the honest reading of "these names are the same trade"
 * and an invariant callers assert. Average linkage would admit members only
 * weakly related to the rest of their group; single linkage would chain
 * everything into one blob, since nearly every equity is somewhat
 * market-correlated.
 *
 * Deterministic: among equally similar merges it takes the one touching the
 * lowest-indexed names, so the result cannot depend on input ordering.
 *
 * @param {readonly (readonly number[])[]} C
 * @param {number} threshold
 * @returns {Group[]}
 */
export function completeLinkageGroups(C, threshold) {
  const n = C.length;
  if (n === 0) return [];

  /** @type {number[][]} */
  const clusters = Array.from({ length: n }, (_, i) => [i]);
  // sim[a][b] is the complete-linkage similarity: the *minimum* correlation
  // between any member of a and any member of b.
  const sim = C.map((row) => [...row]);
  const alive = new Array(n).fill(true);

  for (;;) {
    let bestSim = Number.NEGATIVE_INFINITY;
    let bestA = -1;
    let bestB = -1;
    let bestKeyLo = Number.POSITIVE_INFINITY;
    let bestKeyHi = Number.POSITIVE_INFINITY;

    for (let a = 0; a < n; a++) {
      if (!alive[a]) continue;
      const simA = /** @type {number[]} */ (sim[a]);
      for (let b = a + 1; b < n; b++) {
        if (!alive[b]) continue;
        const s = round12(at(simA, b));
        if (s < threshold) continue;
        const ra = at(/** @type {number[]} */ (clusters[a]), 0);
        const rb = at(/** @type {number[]} */ (clusters[b]), 0);
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

    clusters[bestA] = [
      .../** @type {number[]} */ (clusters[bestA]),
      .../** @type {number[]} */ (clusters[bestB]),
    ].sort((x, y) => x - y);
    alive[bestB] = false;
    const simBestA = /** @type {number[]} */ (sim[bestA]);
    const simBestB = /** @type {number[]} */ (sim[bestB]);
    for (let k = 0; k < n; k++) {
      if (!alive[k] || k === bestA) continue;
      const merged = Math.min(at(simBestA, k), at(simBestB, k));
      simBestA[k] = merged;
      /** @type {number[]} */ (sim[k])[bestA] = merged;
    }
  }

  /** @type {Group[]} */
  const groups = [];
  for (let a = 0; a < n; a++) {
    if (!alive[a]) continue;
    const members = /** @type {number[]} */ (clusters[a]);
    let minCorr = 1;
    for (let i = 0; i < members.length; i++) {
      const ri = row(C, at(members, i));
      for (let j = i + 1; j < members.length; j++) {
        const r = at(ri, at(members, j));
        if (r < minCorr) minCorr = r;
      }
    }
    groups.push({ members, minCorr, bestRank: at(members, 0) });
  }
  groups.sort((x, y) => x.bestRank - y.bestRank);
  return groups;
}
