import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONCURRENCY,
  CORR_WINDOW,
  HISTORY_CALENDAR_DAYS,
  HORIZONS,
  HORIZON_KEYS,
  MAX_LOOKBACK,
  MAX_FETCH_FAILURES,
  THRESHOLDS,
  type HorizonKey,
  type ViewId,
} from './config.ts';
import { FmpAuthError, FmpClient, mapPool } from './fmp/client.ts';
import type { History } from './fmp/types.ts';
import { alignToCalendar, buildMasterCalendar, type AlignedSeries } from './pipeline/calendar.ts';
import { completeLinkageGroups, type Group } from './pipeline/cluster.ts';
import { correlationMatrix, windowReturns } from './pipeline/correlation.ts';
import { computeMetrics, type IneligibleReason, type StockMetrics } from './pipeline/momentum.ts';
import { buildViews } from './pipeline/score.ts';
import { buildSnapshot } from './pipeline/snapshot.ts';
import { buildUniverse } from './pipeline/universe.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const log = (msg: string) => console.log(`[screen] ${msg}`);

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function shiftDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return isoDate(d);
}

async function main(): Promise<void> {
  const asOfArg = arg('as-of');
  if (asOfArg && !/^\d{4}-\d{2}-\d{2}$/.test(asOfArg)) {
    throw new Error(`--as-of must be YYYY-MM-DD, received "${asOfArg}"`);
  }
  const to = asOfArg ?? isoDate(new Date());
  const from = shiftDays(to, -HISTORY_CALENDAR_DAYS);

  const client = new FmpClient();
  log('verifying FMP credentials');
  await client.verifyAuth();

  log('fetching screener universe');
  const universe = await buildUniverse(client);
  log(
    `screened ${universe.screenedCount} rows -> ${universe.members.length} candidate common stocks ` +
      `(${JSON.stringify(universe.exclusions)})`,
  );

  const symbols = universe.members.map((m) => m.symbol);
  log(
    `fetching ${symbols.length} dividend-adjusted histories (${from} to ${to}) ` +
      `at concurrency ${CONCURRENCY}, capped at ${client.requestsPerMinute} req/min`,
  );

  const failures: string[] = [];
  const started = Date.now();
  const fetched = await mapPool<string, History | null>(
    symbols,
    async (symbol) => {
      try {
        return await client.history(symbol, from, to);
      } catch (err) {
        // A transient network failure that silently dropped names would change
        // the ranking between runs, so failures are collected and then fatal.
        failures.push(`${symbol}: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      }
    },
    CONCURRENCY,
    (done, total) => {
      if (done % 500 === 0 || done === total) log(`  ${done}/${total} histories`);
    },
  );
  log(
    `fetched in ${((Date.now() - started) / 1000).toFixed(0)}s` +
      (client.rateLimitHits > 0
        ? ` (backed off ${client.rateLimitHits}x; now ${client.requestsPerMinute} req/min)`
        : ''),
  );

  if (failures.length > MAX_FETCH_FAILURES) {
    console.error(`\n${failures.length} symbol histories could not be fetched:`);
    for (const f of failures.slice(0, 20)) console.error(`  ${f}`);
    throw new Error(
      `Aborting: ${failures.length} unrecovered fetch failures exceeds the allowed ${MAX_FETCH_FAILURES}. ` +
        `Dropping these names silently would change the ranking, so the run fails instead.`,
    );
  }

  const memberBySymbol = new Map(universe.members.map((m) => [m.symbol, m]));
  const histories: History[] = [];
  const ineligible: Record<string, number> = {};
  const bump = (reason: string) => {
    ineligible[reason] = (ineligible[reason] ?? 0) + 1;
  };

  for (const symbol of symbols) {
    const h = fetched.get(symbol);
    if (!h || h.bars.length === 0) {
      bump('noData');
      continue;
    }
    histories.push(h);
  }

  log('building master trading calendar');
  const calendar = buildMasterCalendar(histories, histories.length);
  if (calendar.length < MAX_LOOKBACK + 1) {
    throw new Error(
      `Master calendar has only ${calendar.length} sessions; ${MAX_LOOKBACK + 1} are needed for the longest horizon.`,
    );
  }
  const L = calendar.length - 1;
  const asOf = calendar[L] as string;
  log(`calendar spans ${calendar.length} sessions, ${calendar[0]} to ${asOf}`);

  const anchors = {} as Record<HorizonKey, { start: string; end: string }>;
  for (const key of HORIZON_KEYS) {
    anchors[key] = {
      start: calendar[L - HORIZONS[key].lookback] as string,
      end: calendar[L - HORIZONS[key].skip] as string,
    };
    log(`  ${HORIZONS[key].label}: ${anchors[key].start} -> ${anchors[key].end}`);
  }

  log('aligning series and applying tradability gates');
  const aligned = new Map<string, AlignedSeries>();
  const metrics: StockMetrics[] = [];
  for (const h of histories) {
    const member = memberBySymbol.get(h.symbol);
    if (!member) continue;
    const series = alignToCalendar(h, calendar);
    const res = computeMetrics(series, member, L, CORR_WINDOW);
    if (!res.ok) {
      bump(res.reason satisfies IneligibleReason);
      continue;
    }
    aligned.set(h.symbol, series);
    metrics.push(res.metrics);
  }
  // Fixed order for every downstream normalization and sum.
  metrics.sort((a, b) => (a.symbol < b.symbol ? -1 : 1));
  log(`${metrics.length} names eligible (${JSON.stringify(ineligible)})`);

  log('scoring all eight views');
  const views = buildViews(metrics);

  log('computing correlations and grouping each view');
  const groupsByView = new Map<ViewId, Map<number, Group[]>>();
  const ungroupedByView = new Map<ViewId, string[]>();

  for (const [id, view] of views) {
    const rows = view.ranked;
    const returns: number[][] = [];
    const keptIdx: number[] = [];
    const ungrouped: string[] = [];

    for (let i = 0; i < rows.length; i++) {
      const symbol = (rows[i] as { symbol: string }).symbol;
      const rs = windowReturns(aligned.get(symbol) as AlignedSeries, L, CORR_WINDOW);
      // A name that cannot be correlated keeps its rank and is shown on its
      // own; grouping never removes a ranked name.
      if (!rs) {
        ungrouped.push(symbol);
        continue;
      }
      returns.push(rs);
      keptIdx.push(i);
    }

    const C = correlationMatrix(returns);
    const ungroupedIdx = ungrouped.map((symbol) => rows.findIndex((r) => r.symbol === symbol));
    const perThreshold = new Map<number, Group[]>();
    for (const t of THRESHOLDS) {
      // Cluster indices refer to the reduced list, so map them back onto
      // positions in the full ranked list before anything else uses them.
      const groups: Group[] = completeLinkageGroups(C, t).map((g) => {
        const reduced = [...g.members].sort(
          (a, b) => (keptIdx[a] as number) - (keptIdx[b] as number),
        );
        const members = reduced.map((m) => keptIdx[m] as number);
        // Keep the group's own correlations so the detail screen can show how
        // tightly each peer tracks the name being viewed.
        const corr = reduced.map((a) => reduced.map((b) => (C[a] as number[])[b] as number));
        return { members, minCorr: g.minCorr, bestRank: members[0] as number, corr };
      });
      // A name with no usable correlation window still occupies its rank.
      for (const idx of ungroupedIdx) groups.push({ members: [idx], minCorr: 1, bestRank: idx });
      groups.sort((a, b) => a.bestRank - b.bestRank);
      perThreshold.set(t, groups);
    }
    groupsByView.set(id, perThreshold);
    ungroupedByView.set(id, ungrouped);
  }

  assertInvariants(views, groupsByView);

  const snapshot = buildSnapshot({
    asOf,
    calendarLength: calendar.length,
    anchors,
    members: memberBySymbol,
    metrics,
    views,
    groupsByView,
    ungroupedByView,
    screenedCount: universe.screenedCount,
    afterStaticExclusions: universe.members.length,
    exclusions: { ...universe.exclusions, ...ineligible },
    excludedSamples: universe.excludedSamples as Record<string, string[]>,
  });

  const out = resolve(ROOT, 'web/data/snapshot.json');
  const archive = resolve(ROOT, `web/data/archive/${asOf}.json`);
  const json = JSON.stringify(snapshot);
  mkdirSync(dirname(out), { recursive: true });
  mkdirSync(dirname(archive), { recursive: true });
  writeFileSync(out, json);
  writeFileSync(archive, json);

  const meta = snapshot.meta as { dataHash: string };
  log(`wrote ${out} (${(json.length / 1024).toFixed(0)} KB)`);
  log(`dataHash ${meta.dataHash}`);
}

/**
 * Guards the properties the product depends on. These are cheap and catch a
 * whole class of regressions that would otherwise be invisible in the UI.
 */
function assertInvariants(
  views: Map<ViewId, { ranked: { rank: number; symbol: string }[] }>,
  groupsByView: Map<ViewId, Map<number, Group[]>>,
): void {
  for (const [id, view] of views) {
    const n = view.ranked.length;
    const ranks = view.ranked.map((r) => r.rank);
    if (ranks.some((r, i) => r !== i + 1)) throw new Error(`${id}: ranks are not 1..${n}`);

    for (const [t, groups] of groupsByView.get(id) ?? []) {
      const seen = groups.flatMap((g) => g.members).sort((a, b) => a - b);
      if (seen.length !== n || seen.some((v, i) => v !== i)) {
        throw new Error(`${id} @ ${t}: grouping did not partition the ranked list exactly once`);
      }
      for (const g of groups) {
        const sorted = [...g.members].sort((a, b) => a - b);
        if (JSON.stringify(sorted) !== JSON.stringify(g.members)) {
          throw new Error(`${id} @ ${t}: group members are not in rank order`);
        }
        if (g.members.length > 1 && g.minCorr < t - 1e-9) {
          throw new Error(`${id} @ ${t}: group contains a pair below the threshold (${g.minCorr})`);
        }
      }
    }
  }
}

try {
  await main();
} catch (err) {
  if (err instanceof FmpAuthError) {
    console.error(`\n[screen] FMP credentials unavailable — stopping.\n${err.message}\n`);
  } else {
    console.error(`\n[screen] ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  }
  process.exitCode = 1;
}
