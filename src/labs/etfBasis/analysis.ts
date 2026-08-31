import { mean, pearson } from '../../pipeline/stats.ts';

/**
 * The statistics the study rests on. Pure, small, and separated from the
 * program that fetches so each one can be checked against a closed-form answer.
 */

export interface Fit {
  alpha: number;
  beta: number;
  /** Share of the dependent series' variance the regressor explains. */
  r2: number;
  residuals: number[];
}

/**
 * One-regressor OLS.
 *
 * The market model, and nothing more elaborate, because the question this
 * study asks is whether *industry* structure compresses. Adding size and value
 * factors would strip out variation that an industry ETF is entitled to
 * explain, and would answer a different question.
 */
export function regress(y: readonly number[], x: readonly number[]): Fit | null {
  const n = Math.min(y.length, x.length);
  if (n < 30) return null;
  const my = mean(y.slice(0, n));
  const mx = mean(x.slice(0, n));
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    const dx = (x[i] as number) - mx;
    sxy += dx * ((y[i] as number) - my);
    sxx += dx * dx;
  }
  if (!(sxx > 0)) return null;
  const beta = sxy / sxx;
  const alpha = my - beta * mx;
  const residuals: number[] = new Array(n);
  let ssTot = 0;
  let ssRes = 0;
  for (let i = 0; i < n; i++) {
    const fitted = alpha + beta * (x[i] as number);
    const e = (y[i] as number) - fitted;
    residuals[i] = e;
    ssRes += e * e;
    ssTot += ((y[i] as number) - my) ** 2;
  }
  if (!(ssTot > 0)) return null;
  return { alpha, beta, r2: 1 - ssRes / ssTot, residuals };
}

/**
 * What one series explains of another *after* both have had the market removed.
 *
 * This is the partial R², and it is the whole reason the study residualizes
 * first. Raw correlation between any two U.S. equity series is dominated by
 * the fact that both are U.S. equities: on this data the median raw pair
 * correlation between two unrelated industry ETFs is high enough that
 * everything looks like everything. Removing the market is what makes
 * "these two are the same bet" a statement about industry rather than about
 * beta.
 */
export function partialR2(residA: readonly number[], residB: readonly number[]): number {
  const rho = pearson(residA, residB);
  return Number.isFinite(rho) ? rho * rho : 0;
}

/** Complete-linkage clustering on a distance = 1 - |residual correlation|. */
export function completeLinkage(
  labels: readonly string[],
  corr: readonly (readonly number[])[],
  minCorr: number,
): string[][] {
  let clusters = labels.map((_, i) => [i]);
  const linkage = (a: readonly number[], b: readonly number[]): number => {
    // Complete linkage: a cluster is only joined if *every* cross pair clears
    // the bar. Single linkage would chain semis to software to cloud to
    // fintech through a run of merely-adjacent pairs and call it one bet.
    let worst = 1;
    for (const i of a) for (const j of b) {
      const c = (corr[i] as readonly number[])[j] as number;
      if (c < worst) worst = c;
    }
    return worst;
  };
  for (;;) {
    let best = -Infinity;
    let pick: [number, number] | null = null;
    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        const l = linkage(clusters[i] as number[], clusters[j] as number[]);
        if (l > best) { best = l; pick = [i, j]; }
      }
    }
    if (!pick || best < minCorr) break;
    const [i, j] = pick;
    clusters[i] = [...(clusters[i] as number[]), ...(clusters[j] as number[])];
    clusters = clusters.filter((_, k) => k !== j);
  }
  return clusters.map((c) => c.map((i) => labels[i] as string).sort());
}

export interface StockFit {
  symbol: string;
  /** Best partial R² against any basis member, and which member. */
  best: number;
  bestEtf: string;
  /** What an arbitrary basis member explains — the null the best is read against. */
  median: number;
}

/**
 * Maps one stock onto the basis by best partial R².
 *
 * Deliberately reports the median alongside the maximum. A best-of-75 maximum
 * is an order statistic and will look impressive even on noise; the median is
 * what the same search returns when there is nothing to find, so the pair is
 * readable as signal against its own null rather than against an assumed one.
 */
export function fitStock(
  symbol: string,
  stockResid: readonly number[],
  basisResid: ReadonlyMap<string, readonly number[]>,
): StockFit | null {
  const scores: { etf: string; r2: number }[] = [];
  for (const [etf, resid] of basisResid) {
    const n = Math.min(stockResid.length, resid.length);
    if (n < 30) continue;
    scores.push({ etf, r2: partialR2(stockResid.slice(0, n), resid.slice(0, n)) });
  }
  if (scores.length === 0) return null;
  scores.sort((a, b) => b.r2 - a.r2 || (a.etf < b.etf ? -1 : 1));
  const top = scores[0] as { etf: string; r2: number };
  const mid = scores[Math.floor(scores.length / 2)] as { r2: number };
  return { symbol, best: top.r2, bestEtf: top.etf, median: mid.r2 };
}

/**
 * The compression curve, by greedy forward selection.
 *
 * At each step the ETF added is the one that newly represents the most
 * still-unrepresented stocks. Greedy rather than exhaustive because the
 * exhaustive problem is set cover and intractable at 75 choose k; greedy is
 * the standard approximation and, more usefully here, it produces the curve in
 * the order a person would actually add bets — most valuable first — so the
 * elbow is where it looks like it is.
 */
export function compressionCurve(
  stocks: readonly { symbol: string; byEtf: ReadonlyMap<string, number> }[],
  etfs: readonly string[],
  threshold: number,
): { size: number; added: string; covered: number; share: number }[] {
  const remaining = new Set(etfs);
  const uncovered = new Set(stocks.map((s) => s.symbol));
  const byName = new Map(stocks.map((s) => [s.symbol, s]));
  const curve: { size: number; added: string; covered: number; share: number }[] = [];
  let covered = 0;
  while (remaining.size > 0) {
    let bestEtf = '';
    let bestGain = -1;
    for (const etf of [...remaining].sort()) {
      let gain = 0;
      for (const sym of uncovered) {
        if (((byName.get(sym) as { byEtf: ReadonlyMap<string, number> }).byEtf.get(etf) ?? 0) >= threshold) gain++;
      }
      if (gain > bestGain) { bestGain = gain; bestEtf = etf; }
    }
    if (bestGain <= 0) break;
    for (const sym of [...uncovered]) {
      if (((byName.get(sym) as { byEtf: ReadonlyMap<string, number> }).byEtf.get(bestEtf) ?? 0) >= threshold) {
        uncovered.delete(sym);
      }
    }
    remaining.delete(bestEtf);
    covered += bestGain;
    curve.push({
      size: curve.length + 1,
      added: bestEtf,
      covered,
      share: covered / stocks.length,
    });
  }
  return curve;
}

/** Spearman rank correlation, for comparing two orderings. */
export function spearman(a: readonly number[], b: readonly number[]): number {
  const rank = (xs: readonly number[]): number[] => {
    const idx = xs.map((v, i) => ({ v, i })).sort((p, q) => p.v - q.v);
    const r = new Array<number>(xs.length);
    for (let k = 0; k < idx.length; ) {
      let j = k;
      while (j + 1 < idx.length && (idx[j + 1] as { v: number }).v === (idx[k] as { v: number }).v) j++;
      // Ties share the average rank, or a run of equal momentum scores would
      // manufacture an ordering the data does not contain.
      const avg = (k + j) / 2 + 1;
      for (let m = k; m <= j; m++) r[(idx[m] as { i: number }).i] = avg;
      k = j + 1;
    }
    return r;
  };
  return pearson(rank(a), rank(b));
}
