import { createHash } from 'node:crypto';
import {
  BLEND_WEIGHT,
  CORR_WINDOW,
  HORIZONS,
  HORIZON_KEYS,
  MIN_ACTUAL_BAR_COVERAGE,
  MIN_MARKET_CAP,
  MIN_MEDIAN_DOLLAR_VOLUME,
  MIN_PRICE,
  MODES,
  THRESHOLDS,
  TOP_N,
  VOL_FLOOR_ANNUALIZED,
  WINSOR_LOWER_PCT,
  WINSOR_UPPER_PCT,
  type HorizonKey,
  type Mode,
} from '../config.ts';
import type { StockMetrics } from './momentum.ts';
import { crossSectionalNormalize } from './normalize.ts';
import type { UniverseMember } from './universe.ts';
import type { UniverseClusters } from './universeClusters.ts';

const r = (x: number, dp: number): number => {
  const f = 10 ** dp;
  return Math.round(x * f) / f;
};

export interface SnapshotInput {
  asOf: string;
  calendarLength: number;
  chartDates: string[];
  anchors: Record<HorizonKey, { start: string; end: string }>;
  members: Map<string, UniverseMember>;
  /** Every eligible name, already sorted by symbol. */
  metrics: readonly StockMetrics[];
  clusters: UniverseClusters;
  screenedCount: number;
  afterStaticExclusions: number;
  exclusions: Record<string, number>;
  excludedSamples: Record<string, string[]>;
}

/**
 * Assembles the snapshot the ranked list reads.
 *
 * It carries the **whole eligible universe** but no prices: filtering has to
 * precede ranking, so the browser needs every row, and prices are fetched per
 * symbol only when a chart or a watchlist actually needs one.
 *
 * Ranking itself is not materialized here. Eight pre-computed Top-100 lists
 * cannot support filter-then-rank, and would be a second source of truth for
 * an ordering the browser can derive in under a millisecond. What the pipeline
 * must supply is the part the browser *cannot* derive: winsorized
 * cross-sectional z-scores, which depend on the full cross-section and must
 * not shift when a filter changes.
 */
export function buildSnapshot(input: SnapshotInput): Record<string, unknown> {
  const symbols = input.metrics.map((m) => m.symbol);

  // Normalize each horizon over the whole eligible universe, per mode. These
  // are what make the blend meaningful and what filtering must not disturb.
  const z = {} as Record<Mode, Record<HorizonKey, number[]>>;
  for (const mode of MODES) {
    z[mode] = {} as Record<HorizonKey, number[]>;
    for (const horizon of HORIZON_KEYS) {
      z[mode][horizon] = crossSectionalNormalize(
        input.metrics.map((m) =>
          mode === 'raw' ? m.horizons[horizon].momentum : m.horizons[horizon].volAdjusted,
        ),
      );
    }
  }

  // Columnar, not one object per name. Repeating nine key names across 2,320
  // rows costs ~140 KB of pure punctuation, and grouping like values together
  // compresses far better than interleaving them: measured, this is 216 KB
  // gzipped as row objects against 112 KB as columns, for identical data.
  const sectors = [...new Set(input.metrics.map((m) => member(m).sector))].sort();
  const exchanges = [...new Set(input.metrics.map((m) => member(m).exchange))].sort();
  const countries = [...new Set(input.metrics.map((m) => member(m).country))].sort();
  const sectorIndex = new Map(sectors.map((v, i) => [v, i]));
  const exchangeIndex = new Map(exchanges.map((v, i) => [v, i]));
  const countryIndex = new Map(countries.map((v, i) => [v, i]));

  function member(m: StockMetrics): UniverseMember {
    return input.members.get(m.symbol) as UniverseMember;
  }

  const columns = {
    symbol: input.metrics.map((m) => m.symbol),
    name: input.metrics.map((m) => member(m).name),
    sectors,
    exchanges,
    sector: input.metrics.map((m) => sectorIndex.get(member(m).sector) ?? 0),
    exchange: input.metrics.map((m) => exchangeIndex.get(member(m).exchange) ?? 0),
    /**
     * Domicile, carried but not filtered on. It is here so a domicile filter
     * is a UI change rather than a pipeline re-run — and deliberately not used
     * as an exclusion rule, because the field cannot support one honestly:
     * FMP places PDD in Ireland and Trip.com in Singapore, so a "China" rule
     * would drop Alibaba and keep PDD.
     */
    countries,
    country: input.metrics.map((m) => countryIndex.get(member(m).country) ?? 0),
    price: input.metrics.map((m) => r(m.latestClose, 2)),
    /** Millions, so a $1.2T cap is 1200000 rather than 1200000000000. */
    marketCapM: input.metrics.map((m) => Math.round(member(m).marketCap / 1e6)),
    /** Per horizon, in HORIZON_KEYS order: raw momentum and realized volatility. */
    m: HORIZON_KEYS.map((h) => input.metrics.map((x) => r(x.horizons[h].momentum, 5))),
    rv: HORIZON_KEYS.map((h) => input.metrics.map((x) => r(x.horizons[h].realizedVol, 4))),
    /**
     * Cross-sectional z-scores, already rounded by the normalization itself,
     * so these are the exact values the pipeline ranked from. The browser
     * cannot derive them: winsorized z-scores depend on the full cross-section
     * and must not shift when a filter changes.
     */
    zr: HORIZON_KEYS.map((h) => (z.raw[h] as number[]).slice()),
    zv: HORIZON_KEYS.map((h) => (z.voladj[h] as number[]).slice()),
  };

  const payload = {
    asOf: input.asOf,
    chartDates: input.chartDates,
    calendarLength: input.calendarLength,
    anchors: input.anchors,
    params: {
      horizons: Object.fromEntries(
        HORIZON_KEYS.map((k) => [
          k,
          { lookback: HORIZONS[k].lookback, skip: HORIZONS[k].skip, label: HORIZONS[k].label },
        ]),
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
    },
    exclusions: input.exclusions,
    excludedSamples: input.excludedSamples,
    // Three parallel arrays in column order, NOT an object keyed by ticker:
    // keying by symbol re-lists 2,320 ticker strings the rows already carry,
    // which costs 19.3 KB gzipped against a few KB for the same information.
    clusters: {
      thresholds: [...THRESHOLDS],
      ids: input.clusters.ids,
      groupCounts: input.clusters.groupCounts,
      largest: input.clusters.largest,
    },
    columns,
  };

  // Certifies the scores, cluster ids and the parameters behind them.
  // Descriptive metadata from the live screener is in the columns too, so
  // market-cap drift moves this — accepted, because the eligible set is what
  // that drift would actually change.
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
    clusters: payload.clusters,
    columns: payload.columns,
  };
}
