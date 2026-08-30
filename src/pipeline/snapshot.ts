import { createHash } from 'node:crypto';
import {
  BLEND_WEIGHT,
  CORR_WINDOW,
  HORIZONS,
  HORIZON_KEYS,
  MIN_MARKET_CAP,
  MIN_MEDIAN_DOLLAR_VOLUME,
  MIN_PRICE,
  MIN_ACTUAL_BAR_COVERAGE,
  THRESHOLDS,
  TOP_N,
  VOL_FLOOR_ANNUALIZED,
  WINSOR_LOWER_PCT,
  WINSOR_UPPER_PCT,
  type HorizonKey,
  type ViewId,
} from '../config.ts';
import type { Group } from './cluster.ts';
import type { StockMetrics } from './momentum.ts';
import type { ViewResult } from './score.ts';
import { encodeSeries, type EncodedSeries } from './series.ts';
import type { UniverseMember } from './universe.ts';

const r = (x: number, dp: number): number => {
  const f = 10 ** dp;
  return Math.round(x * f) / f;
};

export interface SnapshotGroup {
  members: string[];
  minCorr: number;
  bestRank: number;
  corr?: number[][];
}

export interface SnapshotInput {
  asOf: string;
  calendarLength: number;
  anchors: Record<HorizonKey, { start: string; end: string }>;
  members: Map<string, UniverseMember>;
  metrics: readonly StockMetrics[];
  /** Closes over the charted span, keyed by symbol, oldest first. */
  chartSeries: Map<string, number[]>;
  /** Master-calendar dates for that span, shared by every series. */
  chartDates: string[];
  views: Map<ViewId, ViewResult>;
  groupsByView: Map<ViewId, Map<number, Group[]>>;
  ungroupedByView: Map<ViewId, string[]>;
  screenedCount: number;
  afterStaticExclusions: number;
  exclusions: Record<string, number>;
  excludedSamples: Record<string, string[]>;
}

/**
 * Assembles the snapshot with deliberate key ordering, then stamps a hash over
 * everything except `generatedAt`. Two runs against the same as-of date must
 * produce the same `dataHash`; that is the reproducibility check.
 */
export function buildSnapshot(input: SnapshotInput): Record<string, unknown> {
  // Only names that actually surface in a view are carried into the snapshot.
  // The eligible universe is an order of magnitude larger, and shipping all of
  // it would make the phone download megabytes it never reads.
  const referenced = new Set<string>();
  for (const view of input.views.values()) for (const e of view.ranked) referenced.add(e.symbol);

  const symbols: Record<string, unknown> = {};
  const bySymbol = new Map(input.metrics.map((m) => [m.symbol, m]));
  for (const symbol of [...referenced].sort()) {
    const m = bySymbol.get(symbol) as StockMetrics;
    const member = input.members.get(symbol) as UniverseMember;
    const horizons: Record<string, unknown> = {};
    for (const key of HORIZON_KEYS) {
      const h = m.horizons[key];
      horizons[key] = {
        momentum: r(h.momentum, 6),
        realizedVol: r(h.realizedVol, 6),
        effectiveVol: r(h.effectiveVol, 6),
        volAdjusted: r(h.volAdjusted, 6),
        floored: h.realizedVol < VOL_FLOOR_ANNUALIZED,
      };
    }
    const series = input.chartSeries.get(symbol);
    symbols[symbol] = {
      name: member.name,
      sector: member.sector,
      industry: member.industry,
      exchange: member.exchange,
      price: r(m.latestClose, 2),
      marketCap: Math.round(member.marketCap),
      dollarVolume: Math.round(m.dollarVolume),
      horizons,
      ...(series ? { series: encodeSeries(series) satisfies EncodedSeries } : {}),
    };
  }

  const views: Record<string, unknown> = {};
  for (const id of [...input.views.keys()].sort()) {
    const view = input.views.get(id) as ViewResult;
    const groupsByThreshold = input.groupsByView.get(id) ?? new Map<number, Group[]>();
    const groups: Record<string, SnapshotGroup[]> = {};
    for (const t of THRESHOLDS) {
      const gs = groupsByThreshold.get(t) ?? [];
      groups[t.toFixed(2)] = gs.map((g) => {
        const row: SnapshotGroup = {
          members: g.members.map((i) => (view.ranked[i] as { symbol: string }).symbol),
          minCorr: r(g.minCorr, 4),
          bestRank: g.bestRank + 1,
        };
        if (g.corr && g.members.length > 1) row.corr = g.corr.map((c) => c.map((x) => r(x, 3)));
        return row;
      });
    }
    views[id] = {
      scoreKey: view.scoreKey,
      mode: view.mode,
      universeSize: view.universeSize,
      ranked: view.ranked.map((e) => {
        const row: Record<string, unknown> = { rank: e.rank, symbol: e.symbol, score: r(e.score, 6) };
        if (e.components) {
          const c: Record<string, number> = {};
          for (const k of HORIZON_KEYS) c[k] = r(e.components[k], 6);
          row.components = c;
        }
        return row;
      }),
      groups,
      ungrouped: input.ungroupedByView.get(id) ?? [],
    };
  }

  const payload = {
    asOf: input.asOf,
    chartDates: input.chartDates,
    calendarLength: input.calendarLength,
    anchors: input.anchors,
    params: {
      horizons: Object.fromEntries(
        HORIZON_KEYS.map((k) => [k, { lookback: HORIZONS[k].lookback, skip: HORIZONS[k].skip, label: HORIZONS[k].label }]),
      ),
      volFloorAnnualized: VOL_FLOOR_ANNUALIZED,
      winsorPct: [WINSOR_LOWER_PCT, WINSOR_UPPER_PCT],
      blendWeight: r(BLEND_WEIGHT, 6),
      corrWindow: CORR_WINDOW,
      thresholds: [...THRESHOLDS],
      topN: TOP_N,
      minMarketCap: MIN_MARKET_CAP,
      minPrice: MIN_PRICE,
      minMedianDollarVolume: MIN_MEDIAN_DOLLAR_VOLUME,
      minActualBarCoverage: MIN_ACTUAL_BAR_COVERAGE,
    },
    universe: {
      screened: input.screenedCount,
      afterStaticExclusions: input.afterStaticExclusions,
      eligible: input.metrics.length,
      displayed: referenced.size,
    },
    exclusions: input.exclusions,
    excludedSamples: input.excludedSamples,
    views,
  };

  // What the hash certifies: the rankings, the groupings, and the parameters
  // and anchors that produced them. Descriptive per-symbol metadata sits
  // outside it, because market cap comes from the screener and ticks during
  // the session — folding it in would make two identical rankings hash
  // differently. If that drift ever flips a name across the eligibility floor,
  // the universe counts and the views themselves change, so the hash moves.
  const dataHash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');

  return {
    meta: {
      generatedAt: new Date().toISOString(),
      dataHash,
      asOf: payload.asOf,
      chartDates: payload.chartDates,
      calendarLength: payload.calendarLength,
      anchors: payload.anchors,
      params: payload.params,
      universe: payload.universe,
      exclusions: payload.exclusions,
      excludedSamples: payload.excludedSamples,
    },
    symbols,
    views: payload.views,
  };
}
