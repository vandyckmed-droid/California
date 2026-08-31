import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
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
  MODES,
  SCORE_KEYS,
  THRESHOLDS,
  viewId,
  type HorizonKey,
  type ViewId,
} from './config.ts';
import { FmpAuthError, FmpClient, mapPool } from './fmp/client.ts';
import type { History } from './fmp/types.ts';
import { alignToCalendar, buildMasterCalendar, type AlignedSeries } from './pipeline/calendar.ts';
import { completeLinkageGroups, type Group } from './pipeline/cluster.ts';
import { correlationMatrix, windowReturns } from './pipeline/correlation.ts';
import { buildRankHistory, sessionRanks } from './pipeline/rankHistory.ts';
import { ranksFor, scoresFor } from '../web/lib/model.js';
import { computeMetrics, type IneligibleReason, type StockMetrics } from './pipeline/momentum.ts';
import { simpleReturns } from './pipeline/stats.ts';
import { buildViews } from './pipeline/score.ts';
import { buildSnapshot } from './pipeline/snapshot.ts';
import { buildUniverseClusters } from './pipeline/universeClusters.ts';
import { encodeCorrelationSeries, encodeDisplaySeries } from './pipeline/series.ts';
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
        // A revoked or downgraded key is neither transient nor per-symbol.
        // Collecting it would burn the rest of the universe and then report
        // thousands of "fetch failures" with the real cause buried, so it goes
        // straight to the top-level handler that explains it.
        if (err instanceof FmpAuthError) throw err;
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
        ? ` (${client.rateLimitHits} rate-limit responses across ${client.rateLimitEpisodes} ` +
          `episode(s); now ${client.requestsPerMinute} req/min)`
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

  // The charted span covers the longest horizon through the latest session, so
  // the detail screen can draw every horizon window on one line.
  const chartFrom = L - MAX_LOOKBACK;
  const chartDates = calendar.slice(chartFrom, L + 1);
  const corrFrom = L - CORR_WINDOW;

  const closesFor = (symbol: string, from: number): number[] => {
    const series = aligned.get(symbol) as AlignedSeries;
    const out: number[] = [];
    for (let i = from; i <= L; i++) out.push(series.closes[i] as number);
    return out;
  };

  log('correlating the full universe for cluster ids');
  const corrStarted = Date.now();
  const universeReturns = metrics.map((m) => simpleReturns(closesFor(m.symbol, corrFrom)));
  const clusters = buildUniverseClusters(metrics.map((m) => m.symbol), universeReturns);
  log(
    `  ${((Date.now() - corrStarted) / 1000).toFixed(1)}s; groups per threshold ` +
      `${JSON.stringify(clusters.groupCounts)}, largest ${JSON.stringify(clusters.largest)}`,
  );

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

  // The per-view grouping above is no longer shipped — the browser derives it
  // from the selection. It is still computed because it is what the invariant
  // check runs against, and those invariants are cheap insurance on the
  // scoring and clustering the whole product rests on.
  assertInvariants(views, groupsByView);

  const snapshot = buildSnapshot({
    asOf,
    chartDates,
    calendarLength: calendar.length,
    anchors,
    members: memberBySymbol,
    metrics,
    clusters,
    screenedCount: universe.screenedCount,
    afterStaticExclusions: universe.members.length,
    exclusions: { ...universe.exclusions, ...ineligible },
    excludedSamples: universe.excludedSamples as Record<string, string[]>,
  });

  const dataDir = resolve(ROOT, 'web/data');
  const seriesDir = resolve(dataDir, 'series');
  mkdirSync(dataDir, { recursive: true });
  // Rebuilt from scratch so a name leaving the universe does not leave a stale
  // file behind for the site to serve.
  rmSync(seriesDir, { recursive: true, force: true });
  mkdirSync(seriesDir, { recursive: true });

  log(`writing ${metrics.length} per-symbol series files`);
  let seriesBytes = 0;
  let largestSeries = 0;
  for (const m of metrics) {
    // Two grades, because a chart and a correlation are not the same problem.
    // The display series is never an input to a calculation; the correlation
    // block is the only series a correlation may be derived from.
    const file = JSON.stringify({
      symbol: m.symbol,
      display: encodeDisplaySeries(closesFor(m.symbol, chartFrom)),
      correlation: encodeCorrelationSeries(closesFor(m.symbol, corrFrom)),
    });
    seriesBytes += file.length;
    if (file.length > largestSeries) largestSeries = file.length;
    writeFileSync(resolve(seriesDir, `${m.symbol}.json`), file);
  }

  const out = resolve(dataDir, 'snapshot.json');
  const json = JSON.stringify(snapshot);
  writeFileSync(out, json);

  // ---- Labs sidecar --------------------------------------------------------
  // Everything above is the product. This is the Rank River experiment, and it
  // is deliberately the last thing that happens: the snapshot is already on
  // disk, so a failure here cannot cost a day's refresh. Core reads none of it.
  writeRankHistory(dataDir, metrics.map((m) => m.symbol), aligned, calendar, L, snapshot);

  const meta = snapshot.meta as { dataHash: string };
  log(`wrote snapshot.json (${(json.length / 1024).toFixed(0)} KB)`);
  log(
    `wrote series/ (${metrics.length} files, ${(seriesBytes / 1024).toFixed(0)} KB total, ` +
      `largest ${largestSeries} B)`,
  );
  log(`dataHash ${meta.dataHash}`);
}

/**
 * Emits the Labs rank-history sidecar, and refuses to emit a wrong one.
 *
 * Two gates run here rather than in a test, because they are assertions about
 * *this run's* data and only this run has it:
 *
 *  1. **Identity.** Backfilled at k=0 the ranking must equal the one the
 *     snapshot ships, for every name in all eight views. The backfill reuses
 *     the product's own scorer, so what this actually pins is the indexing —
 *     an off-by-one would give plausible ranks that are silently a day out.
 *  2. **Legibility.** How far outside the top 100 the current top 20 roam over
 *     the window. If nearly all of them sit beyond it the drawing is a row of
 *     trails pinned to the floor, and the feature is not worth building.
 *
 * A failure writes no sidecar and logs why. It never throws: the snapshot is
 * the product, and an experiment must not be able to break the daily refresh.
 */
function writeRankHistory(
  dataDir: string,
  symbols: readonly string[],
  aligned: ReadonlyMap<string, AlignedSeries>,
  calendar: readonly string[],
  L: number,
  snapshot: Record<string, unknown>,
): void {
  const labsDir = resolve(dataDir, 'labs');
  try {
    // Inside the try, not before it: `force` only swallows ENOENT, so an
    // EACCES or EBUSY here would propagate out of `main()` and fail the run —
    // the one path by which this experiment could still cost a day's refresh,
    // which is precisely what the rest of this function exists to prevent.
    //
    // This experiment's own file, not the directory: web/data/labs/ is shared
    // by every Labs sidecar, and other experiments have their own programs
    // writing into it. Clearing the directory here would delete their output on
    // every product run, which is the opposite of experiments being isolated.
    rmSync(resolve(labsDir, 'rank-history.json'), { force: true });
    const started = Date.now();
    const history = buildRankHistory(symbols, aligned, calendar, L);
    const cols = (snapshot as { columns: { symbol: string[] } }).columns;

    // Gate 1 — identity at k=0, over the whole cross-section rather than only
    // the twenty per view the sidecar keeps.
    const latest = sessionRanks(symbols, aligned, L);
    let checked = 0;
    for (const score of SCORE_KEYS) {
      for (const mode of MODES) {
        const id = viewId(score, mode);
        const live = ranksFor(scoresFor(snapshot, score, mode), cols.symbol) as number[];
        const backfilled = latest.get(id);
        if (!backfilled) throw new Error(`rank history is missing the ${id} view`);
        cols.symbol.forEach((sym, i) => {
          const got = backfilled.get(sym);
          const want = live[i];
          if (got !== want) {
            throw new Error(`${id} ${sym}: backfilled #${got} but the snapshot ranks it #${want}`);
          }
          checked++;
        });
      }
    }
    log(`  gate 1 ok: ${checked} backfilled ranks match the snapshot exactly`);
    const { symbolSessions, of } = history.rejected;
    log(
      `  price rule rejected ${symbolSessions} of ${of} symbol-sessions ` +
        `(${((symbolSessions / Math.max(of, 1)) * 100).toFixed(2)}%)`,
    );

    // Gate 2 — legibility of the default view.
    const def = history.views[viewId('h12_1', 'raw')];
    if (!def) throw new Error('rank history is missing the default view');
    const span = history.sessions.length;
    const outside = def.ranks.map((t) => t.filter((r) => r === null || r > 100).length);
    const mostlyOutside = outside.filter((n) => n > span / 2).length;
    const alwaysOutside = outside.filter((n) => n === span).length;
    log(
      `  gate 2: of the top ${def.symbols.length} on 12-1 raw over ${span} sessions, ` +
        `${mostlyOutside} spend most of the window beyond #100, ${alwaysOutside} never enter it`,
    );
    if (alwaysOutside > def.symbols.length / 2) {
      throw new Error(
        `legibility gate: ${alwaysOutside} of ${def.symbols.length} trails never enter the top 100`,
      );
    }

    mkdirSync(labsDir, { recursive: true });
    const file = JSON.stringify(history);
    writeFileSync(resolve(labsDir, 'rank-history.json'), file);
    log(
      `wrote labs/rank-history.json (${(file.length / 1024).toFixed(0)} KB, ` +
        `${span} sessions, ${((Date.now() - started) / 1000).toFixed(1)}s)`,
    );
  } catch (err) {
    // No sidecar, and Labs will say so. The snapshot is already written.
    log(`  labs: rank history not written — ${err instanceof Error ? err.message : String(err)}`);
  }
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
