import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CORR_WINDOW, HORIZONS, TRADING_DAYS_PER_YEAR } from '../../config.ts';
import { FmpClient, mapPool } from '../../fmp/client.ts';
import type { History } from '../../fmp/types.ts';
import { alignToCalendar, buildMasterCalendar } from '../../pipeline/calendar.ts';
import { simpleReturns } from '../../pipeline/stats.ts';
import {
  ALL_SYMBOLS,
  CANDIDATES,
  CANDIDATE_SYMBOLS,
  CONTROL_PAIRS,
  CONTROL_SYMBOLS,
  MARKET_PROXY,
} from './candidates.ts';
import {
  compressionCurve,
  completeLinkage,
  fitStock,
  partialR2,
  regress,
  spearman,
} from './analysis.ts';

/**
 * Can a small set of industry ETFs stand in for 2,280 stocks?
 *
 * A research program, not a product change. It writes a report and a sidecar
 * and touches nothing the screen reads. Nothing in `src/` outside this
 * directory imports it.
 *
 * The one methodological departure from the brief worth stating up front: the
 * baseline is not "no grouping". Cali already clusters its whole universe by
 * correlation into 293-386 groups, and 58% of names sit in some multi-name
 * group. Any ETF basis has to beat *that*, not beat nothing, or it is
 * replacing a finer instrument with a coarser one and calling it progress.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const CACHE = resolve(ROOT, '.cache/etf-basis');
const REPORT = resolve(ROOT, 'web/data/labs/etf-basis.json');

/** Three years of daily returns: long enough for a stable beta, short enough to still describe today. */
const STUDY_SESSIONS = 756;
/** Residual correlation above which two ETFs are treated as one bet. */
const REDUNDANT_AT = 0.7;

const log = (m: string) => console.log(`[etf-basis] ${m}`);
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

function isoDate(d: Date): string { return d.toISOString().slice(0, 10); }
function shiftDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return isoDate(d);
}

/**
 * Histories, cached on disk.
 *
 * The study is meant to be re-run while its thresholds are argued about, and
 * refetching 2,300 histories to change a number from 0.5 to 0.4 would make
 * that argument expensive enough not to have.
 */
async function fetchAll(client: FmpClient, symbols: string[], from: string, to: string): Promise<Map<string, History>> {
  mkdirSync(CACHE, { recursive: true });
  const out = new Map<string, History>();
  const missing: string[] = [];
  for (const s of symbols) {
    const path = resolve(CACHE, `${encodeURIComponent(s)}.json`);
    if (existsSync(path)) {
      try {
        out.set(s, JSON.parse(readFileSync(path, 'utf8')) as History);
        continue;
      } catch { /* corrupt cache entry; refetch it */ }
    }
    missing.push(s);
  }
  if (missing.length === 0) return out;
  log(`fetching ${missing.length} histories (${out.size} already cached)`);
  const fetched = await mapPool<string, History | null>(
    missing,
    async (s) => { try { return await client.history(s, from, to); } catch { return null; } },
    8,
    (done, total) => { if (done % 500 === 0 || done === total) log(`  ${done}/${total}`); },
  );
  for (const s of missing) {
    const h = fetched.get(s);
    if (!h || h.bars.length === 0) continue;
    writeFileSync(resolve(CACHE, `${encodeURIComponent(s)}.json`), JSON.stringify(h));
    out.set(s, h);
  }
  return out;
}

async function main(): Promise<void> {
  const to = isoDate(new Date());
  const from = shiftDays(to, -1150);

  const snapshot = JSON.parse(readFileSync(resolve(ROOT, 'web/data/snapshot.json'), 'utf8')) as {
    columns: { symbol: string[]; name: string[]; sectors: string[]; sector: number[]; m: number[][] };
  };
  const stockSymbols = snapshot.columns.symbol;
  log(`universe: ${stockSymbols.length} cleaned stocks; ${CANDIDATE_SYMBOLS.length} candidate ETFs`);

  const client = new FmpClient();
  await client.verifyAuth();
  const histories = await fetchAll(client, [...ALL_SYMBOLS, ...stockSymbols], from, to);

  // One calendar for everything, so every return series is the same dates.
  const all = [...histories.values()];
  const calendar = buildMasterCalendar(all, all.length);
  const L = calendar.length - 1;
  const start = Math.max(0, L - STUDY_SESSIONS);
  log(`calendar ${calendar.length} sessions, studying ${calendar[start]} -> ${calendar[L]}`);

  const returnsOf = (symbol: string): number[] | null => {
    const h = histories.get(symbol);
    if (!h) return null;
    const s = alignToCalendar(h, calendar);
    const closes: number[] = [];
    for (let i = start; i <= L; i++) {
      const c = s.closes[i];
      if (c == null || !(c > 0)) return null;
      closes.push(c);
    }
    if (closes.length < 100) return null;
    return simpleReturns(closes);
  };

  const market = returnsOf(MARKET_PROXY);
  if (!market) throw new Error(`no usable history for the market proxy ${MARKET_PROXY}`);

  /** Market-model residuals, the unit every comparison below is made in. */
  const residualize = (r: readonly number[]): number[] | null => {
    const n = Math.min(r.length, market.length);
    const f = regress(r.slice(0, n), market.slice(0, n));
    return f ? f.residuals : null;
  };

  // ---- Stage 1/2: the candidate library, and what is redundant in it -------
  const etfResid = new Map<string, number[]>();
  const etfBeta = new Map<string, number>();
  const dropped: string[] = [];
  for (const sym of CANDIDATE_SYMBOLS) {
    const r = returnsOf(sym);
    if (!r) { dropped.push(sym); continue; }
    const n = Math.min(r.length, market.length);
    const f = regress(r.slice(0, n), market.slice(0, n));
    if (!f) { dropped.push(sym); continue; }
    etfResid.set(sym, f.residuals);
    etfBeta.set(sym, f.beta);
  }
  if (dropped.length) log(`  no usable history: ${dropped.join(', ')}`);
  const live = [...etfResid.keys()].sort();
  log(`${live.length} candidate ETFs with usable history`);

  // Raw vs residual correlation, which is the case for residualizing at all.
  const rawSeries = new Map(live.map((s) => [s, returnsOf(s) as number[]]));
  const pairStats = (get: (s: string) => readonly number[]) => {
    const vals: number[] = [];
    for (let i = 0; i < live.length; i++) {
      for (let j = i + 1; j < live.length; j++) {
        const a = get(live[i] as string);
        const b = get(live[j] as string);
        const n = Math.min(a.length, b.length);
        vals.push(Math.sqrt(partialR2(a.slice(0, n), b.slice(0, n))));
      }
    }
    vals.sort((x, y) => x - y);
    return vals;
  };
  const rawCorr = pairStats((s) => rawSeries.get(s) as number[]);
  const resCorr = pairStats((s) => etfResid.get(s) as number[]);
  const q = (v: number[], p: number) => v[Math.floor(p * (v.length - 1))] as number;
  log(
    `pairwise |ρ| across ${rawCorr.length} ETF pairs — raw: p50 ${q(rawCorr, 0.5).toFixed(2)}, ` +
      `p90 ${q(rawCorr, 0.9).toFixed(2)}; market-residual: p50 ${q(resCorr, 0.5).toFixed(2)}, p90 ${q(resCorr, 0.9).toFixed(2)}`,
  );

  const corr: number[][] = live.map((a) => live.map((b) => {
    const ra = etfResid.get(a) as number[];
    const rb = etfResid.get(b) as number[];
    const n = Math.min(ra.length, rb.length);
    return Math.sqrt(partialR2(ra.slice(0, n), rb.slice(0, n)));
  }));
  const clusters = completeLinkage(live, corr, REDUNDANT_AT);

  // Representative = the member with the highest median dollar volume proxy;
  // absent volume here, the widest-history / lowest-beta-error member is a
  // weaker choice than simply the one the library named first, so use the
  // candidate order, which is editorial and stable.
  const order = new Map(CANDIDATE_SYMBOLS.map((s, i) => [s, i]));
  const basis = clusters
    .map((c) => [...c].sort((a, b) => (order.get(a) as number) - (order.get(b) as number)))
    .map((c) => ({ keep: c[0] as string, merged: c.slice(1) }))
    .sort((a, b) => (order.get(a.keep) as number) - (order.get(b.keep) as number));
  const basisSymbols = basis.map((b) => b.keep);
  log(`redundancy pruning at residual ρ >= ${REDUNDANT_AT}: ${live.length} -> ${basisSymbols.length} distinct bets`);
  for (const b of basis.filter((x) => x.merged.length > 0)) {
    log(`  ${b.keep} absorbs ${b.merged.join(', ')}`);
  }

  // Positive controls: did the method find the pairs we said it must?
  const merged = new Map<string, string>();
  for (const b of basis) for (const m of b.merged) merged.set(m, b.keep);
  const sameCluster = (a: string, b: string) =>
    (merged.get(a) ?? a) === (merged.get(b) ?? b);
  const controlHits = CONTROL_PAIRS.filter(([a, b]) => etfResid.has(a) && etfResid.has(b));
  const caught = controlHits.filter(([a, b]) => sameCluster(a, b));
  log(
    `positive controls: ${caught.length}/${controlHits.length} known-duplicate pairs merged` +
      (caught.length < controlHits.length
        ? ` — missed ${controlHits.filter(([a, b]) => !sameCluster(a, b)).map(([a, b]) => `${a}/${b}`).join(', ')}`
        : ''),
  );

  // ---- Stage 3: map every stock onto the basis ----------------------------
  const basisResid = new Map(basisSymbols.map((s) => [s, etfResid.get(s) as number[]]));
  const fits: { symbol: string; best: number; bestEtf: string; median: number; byEtf: Map<string, number> }[] = [];
  let unusable = 0;
  for (const sym of stockSymbols) {
    const r = returnsOf(sym);
    if (!r) { unusable++; continue; }
    const resid = residualize(r);
    if (!resid) { unusable++; continue; }
    const f = fitStock(sym, resid, basisResid);
    if (!f) { unusable++; continue; }
    const byEtf = new Map<string, number>();
    for (const [etf, er] of basisResid) {
      const n = Math.min(resid.length, er.length);
      byEtf.set(etf, partialR2(resid.slice(0, n), er.slice(0, n)));
    }
    fits.push({ ...f, byEtf });
  }
  log(`mapped ${fits.length} stocks (${unusable} lacked usable history)`);

  const bests = fits.map((f) => f.best).sort((a, b) => a - b);
  const medians = fits.map((f) => f.median).sort((a, b) => a - b);
  log(
    `best-match partial R²: p10 ${q(bests, 0.1).toFixed(2)}, p25 ${q(bests, 0.25).toFixed(2)}, ` +
      `p50 ${q(bests, 0.5).toFixed(2)}, p75 ${q(bests, 0.75).toFixed(2)}, p90 ${q(bests, 0.9).toFixed(2)}`,
  );
  log(
    `  the same search's null (median ETF): p50 ${q(medians, 0.5).toFixed(3)}, p90 ${q(medians, 0.9).toFixed(3)}`,
  );
  for (const t of [0.2, 0.3, 0.4, 0.5, 0.6]) {
    log(`  stocks with best partial R² >= ${t.toFixed(1)}: ${fits.filter((f) => f.best >= t).length} (${pct(fits.filter((f) => f.best >= t).length / fits.length)})`);
  }

  // ---- Stage 4: the compression curve -------------------------------------
  const curves: Record<string, { size: number; added: string; covered: number; share: number }[]> = {};
  for (const t of [0.3, 0.4, 0.5]) {
    const curve = compressionCurve(fits, basisSymbols, t);
    curves[t.toFixed(1)] = curve;
    const at = (k: number) => curve.find((c) => c.size === k)?.share ?? curve[curve.length - 1]?.share ?? 0;
    log(
      `compression at R² >= ${t.toFixed(1)}: 10 ETFs ${pct(at(10))}, 20 ${pct(at(20))}, ` +
        `30 ${pct(at(30))}, 40 ${pct(at(40))}, all ${basisSymbols.length} ${pct(at(basisSymbols.length))}`,
    );
  }

  // ---- Stage 6: does the compression preserve momentum information? -------
  const momentumOf = (symbol: string): number | null => {
    const h = histories.get(symbol);
    if (!h) return null;
    const s = alignToCalendar(h, calendar);
    const { lookback, skip } = HORIZONS.h12_1;
    const a = s.closes[L - lookback];
    const b = s.closes[L - skip];
    if (a == null || b == null || !(a > 0) || !(b > 0)) return null;
    return b / a - 1;
  };
  const etfMom = new Map<string, number>();
  for (const s of basisSymbols) {
    const m = momentumOf(s);
    if (m !== null) etfMom.set(s, m);
  }
  const rankedEtfs = [...etfMom.entries()].sort((a, b) => b[1] - a[1]).map(([s]) => s);
  const etfRank = new Map(rankedEtfs.map((s, i) => [s, i + 1]));
  log(`ETF 12-1 leaders: ${rankedEtfs.slice(0, 6).map((s) => `${s} ${pct(etfMom.get(s) as number)}`).join(', ')}`);

  // Stocks that are at least partially represented, so the question is asked
  // where an ETF-first screen would actually be making the claim.
  const represented = fits.filter((f) => f.best >= 0.3);
  const stockMom = new Map(stockSymbols.map((s, i) => [s, snapshot.columns.m[0]?.[i] as number]));
  const withBoth = represented
    .map((f) => ({ f, sm: stockMom.get(f.symbol) as number, er: etfRank.get(f.bestEtf) }))
    .filter((x) => Number.isFinite(x.sm) && x.er !== undefined);
  const topStocks = [...withBoth].sort((a, b) => b.sm - a.sm).slice(0, 100);
  const etfQuintile = Math.ceil(rankedEtfs.length / 5);
  const fromTopQuintile = topStocks.filter((x) => (x.er as number) <= etfQuintile).length;
  log(
    `of the top 100 represented stocks by 12-1, ${fromTopQuintile} sit in a top-quintile ETF ` +
      `(chance would be ~${Math.round(100 / 5)})`,
  );
  const rho = spearman(withBoth.map((x) => x.sm), withBoth.map((x) => -(x.er as number)));
  log(`Spearman(stock 12-1, its ETF's 12-1 rank) = ${rho.toFixed(3)} over ${withBoth.length} stocks`);

  // How much of a stock's momentum its group already accounts for.
  const groupMom = withBoth.map((x) => etfMom.get(x.f.bestEtf) as number);
  const fit = regress(withBoth.map((x) => x.sm), groupMom);
  log(`stock 12-1 regressed on its ETF's 12-1: R² ${fit ? fit.r2.toFixed(3) : 'n/a'}, beta ${fit ? fit.beta.toFixed(2) : 'n/a'}`);
  const strongInWeak = topStocks.filter((x) => (x.er as number) > rankedEtfs.length / 2).length;
  log(`  of those top 100, ${strongInWeak} come from a below-median ETF group`);

  // ---- Stage 5 material: the mappings a person should look at -------------
  const bySector = new Map<string, string>(stockSymbols.map((s, i) => [s, snapshot.columns.sectors[snapshot.columns.sector[i] as number] as string]));
  const strongest = [...fits].sort((a, b) => b.best - a.best).slice(0, 12);
  const weakest = [...fits].sort((a, b) => a.best - b.best).slice(0, 12);
  log('strongest mappings:');
  for (const f of strongest) log(`  ${f.symbol.padEnd(6)} -> ${f.bestEtf.padEnd(5)} R² ${f.best.toFixed(2)}  ${bySector.get(f.symbol)}`);
  log('weakest mappings:');
  for (const f of weakest) log(`  ${f.symbol.padEnd(6)} -> ${f.bestEtf.padEnd(5)} R² ${f.best.toFixed(2)}  ${bySector.get(f.symbol)}`);
  const absorbed = new Map<string, number>();
  for (const f of fits) if (f.best >= 0.3) absorbed.set(f.bestEtf, (absorbed.get(f.bestEtf) ?? 0) + 1);
  log('ETFs absorbing the most stocks (at R² >= 0.3):');
  for (const [etf, n] of [...absorbed.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    log(`  ${etf.padEnd(5)} ${String(n).padStart(4)}  ${CANDIDATES.find((c) => c.symbol === etf)?.label ?? ''}`);
  }

  mkdirSync(dirname(REPORT), { recursive: true });
  writeFileSync(REPORT, JSON.stringify({
    asOf: calendar[L],
    sessions: STUDY_SESSIONS,
    market: MARKET_PROXY,
    redundantAt: REDUNDANT_AT,
    candidates: live.length,
    basis: basis.map((b) => ({ keep: b.keep, merged: b.merged, label: CANDIDATES.find((c) => c.symbol === b.keep)?.label ?? '' })),
    controls: { total: controlHits.length, caught: caught.length },
    pairCorr: { rawP50: q(rawCorr, 0.5), rawP90: q(rawCorr, 0.9), resP50: q(resCorr, 0.5), resP90: q(resCorr, 0.9) },
    fitQuantiles: { p10: q(bests, 0.1), p25: q(bests, 0.25), p50: q(bests, 0.5), p75: q(bests, 0.75), p90: q(bests, 0.9) },
    nullQuantiles: { p50: q(medians, 0.5), p90: q(medians, 0.9) },
    curves,
    absorbed: [...absorbed.entries()].sort((a, b) => b[1] - a[1]),
    momentum: {
      topQuintileShare: fromTopQuintile / 100,
      spearman: rho,
      groupR2: fit?.r2 ?? null,
      strongInWeakGroup: strongInWeak,
    },
    fits: fits.map((f) => ({ s: f.symbol, e: f.bestEtf, r: Number(f.best.toFixed(4)), m: Number(f.median.toFixed(4)) })),
  }));
  log(`wrote ${REPORT}`);
}

await main();
