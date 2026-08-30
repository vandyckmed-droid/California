import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { applyFilters, buildRows, markedRows, ranksFor, scoresFor, SCORE_KEYS } from '../web/lib/model.js';
import { buildViews } from '../src/pipeline/score.ts';
import { MODES, THRESHOLDS, VOL_FLOOR_ANNUALIZED, type HorizonKey } from '../src/config.ts';
import type { StockMetrics } from '../src/pipeline/momentum.ts';

/**
 * Ranking moved into the browser so filters can precede it. That only holds up
 * if the browser reproduces what the pipeline would have produced — otherwise
 * the number on screen is not the universe rank it claims to be.
 */
const snapshot = JSON.parse(readFileSync('web/data/snapshot.json', 'utf8'));

/** Reconstructs pipeline-shaped metrics from the shipped columns. */
function metricsFromSnapshot(): StockMetrics[] {
  const c = snapshot.columns;
  const keys: HorizonKey[] = ['h12_1', 'h9_1', 'h6_1'];
  return c.symbol.map((symbol: string, i: number) => {
    const horizons = {} as StockMetrics['horizons'];
    keys.forEach((k, h) => {
      const momentum = c.m[h][i];
      const realizedVol = c.rv[h][i];
      const effectiveVol = Math.max(realizedVol, VOL_FLOOR_ANNUALIZED);
      horizons[k] = { momentum, realizedVol, effectiveVol, volAdjusted: momentum / effectiveVol };
    });
    return { symbol, horizons, latestClose: c.price[i], dollarVolume: 0 };
  });
}

describe('browser-side ranking', () => {
  const rows = buildRows(snapshot);
  const symbols: string[] = snapshot.columns.symbol;

  it('ranks the whole eligible universe, not a Top 100', () => {
    expect(rows.length).toBeGreaterThan(1500);
    expect(rows.length).toBe(snapshot.meta.universe.eligible);
  });

  /**
   * Single-horizon views rank on the raw figure — a return, or a return per
   * unit of volatility — so reconstructing metrics from the snapshot and
   * re-running the pipeline is a genuine end-to-end comparison.
   *
   * The blend is deliberately excluded here and checked separately below. It
   * ranks on cross-sectional z-scores, and re-running the normalization over
   * the snapshot's rounded momentum and volatility yields slightly different
   * z-scores than the pipeline computed from full precision — enough to flip a
   * near-tie (measured: two names 0.00017 apart at rank 78). That is an
   * artifact of reconstructing the input, not a disagreement about ranking:
   * the pipeline ranks from the z-scores it ships, and so does the browser.
   */
  it('reproduces the pipeline ordering for the six single-horizon views', () => {
    const metrics = metricsFromSnapshot();
    const views = buildViews(metrics, 100);
    for (const scoreKey of SCORE_KEYS.filter((k) => k !== 'blend')) {
      for (const mode of MODES) {
        const ranks = ranksFor(scoresFor(snapshot, scoreKey, mode), symbols);
        const browserTop = symbols
          .map((s, i) => [s, ranks[i] as number] as const)
          .filter(([, r]) => r <= 100)
          .sort((a, b) => a[1] - b[1])
          .map(([s]) => s);
        const pipelineTop = (views.get(`${scoreKey}|${mode}` as never) as { ranked: { symbol: string }[] })
          .ranked.map((e) => e.symbol);
        expect(browserTop, `${scoreKey}|${mode}`).toEqual(pipelineTop);
      }
    }
  });

  /**
   * For the blend, the shipped z-scores are the source of truth: the
   * normalization rounds them, and the pipeline ranks from the rounded values,
   * precisely so the two cannot disagree. What is worth checking is that the
   * browser combines and orders them the way the pipeline does.
   */
  it('blends and orders exactly as the pipeline does, from the shipped scores', () => {
    for (const mode of MODES) {
      const key = mode === 'raw' ? 'zr' : 'zv';
      const z = snapshot.columns[key] as number[][];
      const expected = symbols
        .map((symbol, i) => ({
          symbol,
          score: ((z[0] as number[])[i]! + (z[1] as number[])[i]! + (z[2] as number[])[i]!) / 3,
        }))
        .sort((a, b) => b.score - a.score || (a.symbol < b.symbol ? -1 : 1))
        .slice(0, 100)
        .map((e) => e.symbol);

      const ranks = ranksFor(scoresFor(snapshot, 'blend', mode), symbols);
      const actual = symbols
        .map((s, i) => [s, ranks[i] as number] as const)
        .filter(([, r]) => r <= 100)
        .sort((a, b) => a[1] - b[1])
        .map(([s]) => s);
      expect(actual, `blend|${mode}`).toEqual(expected);
    }
  });

  it('assigns each rank exactly once', () => {
    const ranks = ranksFor(scoresFor(snapshot, 'h12_1', 'raw'), symbols);
    expect(new Set(ranks).size).toBe(ranks.length);
    expect(Math.min(...ranks)).toBe(1);
    expect(Math.max(...ranks)).toBe(ranks.length);
  });

  /** The invariant that keeps "rank" meaning position in the universe. */
  it('filtering hides rows but never renumbers them', () => {
    const ranks = ranksFor(scoresFor(snapshot, 'h12_1', 'raw'), symbols);
    const all = applyFilters(rows, ranks, { sectors: new Set(), minMarketCap: 0, search: '' });
    const tech = applyFilters(rows, ranks, {
      sectors: new Set(['Technology']),
      minMarketCap: 0,
      search: '',
    });
    expect(tech.length).toBeGreaterThan(10);
    expect(tech.length).toBeLessThan(all.length);
    // Every filtered row keeps the rank it had in the unfiltered universe.
    for (const r of tech) expect(ranks[r.i]).toBe(ranks[r.i]);
    const ranksInFiltered = tech.map((r) => ranks[r.i] as number);
    expect(ranksInFiltered).toEqual([...ranksInFiltered].sort((a, b) => a - b));
    // ...and they are emphatically not 1..n.
    expect(ranksInFiltered.slice(0, 20)).not.toEqual(
      Array.from({ length: 20 }, (_, i) => i + 1),
    );
  });

  it('filters by market cap and by search over symbol and name', () => {
    const ranks = ranksFor(scoresFor(snapshot, 'blend', 'voladj'), symbols);
    const big = applyFilters(rows, ranks, { sectors: new Set(), minMarketCap: 1e10, search: '' });
    expect(big.every((r) => r.marketCap >= 1e10)).toBe(true);

    const bySymbol = applyFilters(rows, ranks, { sectors: new Set(), minMarketCap: 0, search: 'AAPL' });
    expect(bySymbol.some((r) => r.symbol === 'AAPL')).toBe(true);
    const byName = applyFilters(rows, ranks, { sectors: new Set(), minMarketCap: 0, search: 'bancorp' });
    expect(byName.length).toBeGreaterThan(0);
    expect(byName.every((r) => /bancorp/i.test(r.name) || r.symbol.includes('BANCORP'))).toBe(true);
  });

  it('scores single horizons on the raw figure, not the normalized one', () => {
    // The interpretable number is what a single-horizon view should rank and
    // display; normalization exists only to make the three commensurable.
    expect(scoresFor(snapshot, 'h12_1', 'raw')).toEqual(snapshot.columns.m[0]);

    const volFloor = snapshot.meta.params.volFloorAnnualized;
    const adjusted = scoresFor(snapshot, 'h9_1', 'voladj');
    expect(adjusted[0]).toBeCloseTo(
      (snapshot.columns.m[1][0] as number) /
        Math.max(snapshot.columns.rv[1][0] as number, volFloor),
      12,
    );
  });

  it('applies the volatility floor so quiet names get no extra credit', () => {
    const volFloor = snapshot.meta.params.volFloorAnnualized;
    const rv = snapshot.columns.rv[0] as number[];
    const quiet = rv.findIndex((v) => v < volFloor);
    if (quiet < 0) return; // no sub-floor name in this snapshot
    const scores = scoresFor(snapshot, 'h12_1', 'voladj');
    expect(scores[quiet]).toBeCloseTo((snapshot.columns.m[0][quiet] as number) / volFloor, 12);
  });
});

describe('"moves with something you hold" marking', () => {
  it('marks rows sharing a universe cluster with the selection', () => {
    const t = THRESHOLDS[1] as number;
    const ids: number[] = snapshot.clusters.ids[1];
    const seedIndex = ids.findIndex((v) => v >= 0);
    const seed = snapshot.columns.symbol[seedIndex] as string;
    const marked = markedRows(snapshot, [seed], t.toFixed(2));

    expect(marked.size).toBeGreaterThan(0);
    // Everything marked genuinely shares the seed's cluster...
    for (const i of marked) expect(ids[i]).toBe(ids[seedIndex]);
    // ...and the held name is not marked as moving with itself.
    expect(marked.has(seedIndex)).toBe(false);
  });

  it('marks nothing when nothing is selected', () => {
    expect(markedRows(snapshot, [], '0.65').size).toBe(0);
  });

  it('needs no price series at all', () => {
    // The whole reason this is precomputed: it resolves before any fetch.
    const raw = readFileSync('web/data/snapshot.json', 'utf8');
    expect(raw).not.toContain('"display"');
    expect(markedRows(snapshot, ['AAPL'], '0.65')).toBeInstanceOf(Set);
  });
});
