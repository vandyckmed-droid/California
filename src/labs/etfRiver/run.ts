import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CALENDAR_MIN_COVERAGE, TRADING_DAYS_PER_YEAR } from '../../config.ts';
import { FmpAuthError, FmpClient, mapPool } from '../../fmp/client.ts';
import type { History } from '../../fmp/types.ts';
import { alignToCalendar, buildMasterCalendar } from '../../pipeline/calendar.ts';
import { sampleStdDev, simpleReturns } from '../../pipeline/stats.ts';
import { buildEtfRiver } from './build.ts';
import {
  HISTORY_CALENDAR_DAYS,
  LEGS,
  LEG_KEYS,
  LEG_WEIGHTS,
  MAX_LOOKBACK,
  REDUNDANCY_REPORT_PAIRS,
  RIVER_SESSIONS,
} from './config.ts';
import { pairStats } from './redundancy.ts';
import { ETF_UNIVERSE, REMOVED, SYMBOLS } from './universe.ts';

/**
 * ETF River — a Labs experiment, and its own program.
 *
 * It does not run inside `npm run screen` and shares no state with it. It
 * fetches its own twenty-odd symbols, writes its own sidecar, and can be
 * deleted by removing `src/labs/etfRiver/`, `web/views/labs/etfRiver.js`, the
 * sidecar and two lines elsewhere. The product cannot notice either way — the
 * strongest form of the rule the Labs boundary test enforces.
 *
 * Unlike the rank-history sidecar, which is emitted at the tail of the product
 * run and must never be able to cost a day's snapshot, a failure here is
 * simply a failure: nothing else is riding on this process, so a gate that
 * does not pass exits non-zero and writes nothing.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const log = (msg: string) => console.log(`[etf-river] ${msg}`);

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const isoDate = (d: Date) => d.toISOString().slice(0, 10);

function shiftDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return isoDate(d);
}

/**
 * A second implementation of the signal, kept deliberately naive and separate.
 *
 * It reads a fund's own bars rather than the master-calendar arrays the build
 * uses, indexes by date rather than by calendar position, and recomputes the
 * mean and standard deviation in the most obvious way. That is the point: the
 * failure this guards against is not arithmetic but *indexing* — an off-by-one
 * in which session a window starts at produces entirely plausible numbers that
 * are silently a day out, and a second copy of the same indexing would agree
 * with it perfectly.
 */
function naiveLeg(
  bars: readonly { date: string; adjClose: number }[],
  date: string,
  lookback: number,
  skip: number,
): { ret: number; annVol: number; volAdjusted: number } | null {
  const at = bars.findIndex((b) => b.date === date);
  if (at < 0 || at - lookback < 0) return null;
  const start = bars[at - lookback] as { adjClose: number };
  const end = bars[at - skip] as { adjClose: number };
  const ret = end.adjClose / start.adjClose - 1;

  const rets: number[] = [];
  for (let i = at - lookback + 1; i <= at - skip; i++) {
    rets.push((bars[i] as { adjClose: number }).adjClose / (bars[i - 1] as { adjClose: number }).adjClose - 1);
  }
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1);
  const annVol = Math.sqrt(variance) * Math.sqrt(TRADING_DAYS_PER_YEAR);
  if (!(annVol > 0)) return null;
  return { ret, annVol, volAdjusted: ret / annVol };
}

/** A cheap deterministic PRNG, so the sampled gate is reproducible. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

async function main(): Promise<void> {
  const asOfArg = arg('as-of');
  if (asOfArg && !/^\d{4}-\d{2}-\d{2}$/.test(asOfArg)) {
    throw new Error(`--as-of must be YYYY-MM-DD, received "${asOfArg}"`);
  }
  const to = asOfArg ?? isoDate(new Date());
  const from = shiftDays(to, -HISTORY_CALENDAR_DAYS);

  const client = new FmpClient();
  await client.verifyAuth();
  log(`fetching ${SYMBOLS.length} ETF histories (${from} to ${to})`);
  if (REMOVED.length > 0) {
    log(`  not fetched, removed from the starting list: ${REMOVED.map((x) => x.symbol).join(', ')}`);
  }

  const fetched = await mapPool<string, History>(SYMBOLS, (s) => client.history(s, from, to), 4);
  const histories: History[] = [];
  for (const symbol of SYMBOLS) {
    const h = fetched.get(symbol);
    // Every member is a named, deliberate choice, so a missing one is a broken
    // universe rather than a name to quietly drop.
    if (!h || h.bars.length === 0) throw new Error(`no price history returned for ${symbol}`);
    histories.push(h);
  }

  const calendar = buildMasterCalendar(histories, histories.length, CALENDAR_MIN_COVERAGE);
  const needed = RIVER_SESSIONS + MAX_LOOKBACK;
  if (calendar.length < needed) {
    throw new Error(
      `calendar has ${calendar.length} sessions; ${needed} are needed to draw ` +
        `${RIVER_SESSIONS} sessions of a ${MAX_LOOKBACK}-session signal`,
    );
  }
  const L = calendar.length - 1;
  log(`calendar spans ${calendar.length} sessions, ${calendar[0]} to ${calendar[L]}`);

  const closes = new Map<string, readonly (number | null)[]>();
  const barsBySymbol = new Map<string, { date: string; adjClose: number }[]>();
  for (const h of histories) {
    closes.set(h.symbol, alignToCalendar(h, calendar as string[]).closes);
    barsBySymbol.set(h.symbol, h.bars.map((b) => ({ date: b.date, adjClose: b.adjClose })));
  }

  const { river, perSession, offsets } = buildEtfRiver(ETF_UNIVERSE, closes, calendar, L);
  log(
    `built ${river.sessions.length} sessions, ${river.members.length} funds, ` +
      `${river.sessions[0]} → ${river.asOf}`,
  );

  gateAnchors(calendar, offsets);
  gateRecomputation(river, perSession, offsets, calendar, barsBySymbol);
  gateCrossSection(perSession);
  gateCoverage(river, perSession);
  const flagged = screenRedundancy(river, closes, calendar, L);
  river.diagnostics.flagged = flagged;
  reportRotation(river);

  const dir = resolve(ROOT, 'web/data/labs');
  mkdirSync(dir, { recursive: true });
  const file = JSON.stringify(river);
  writeFileSync(resolve(dir, 'etf-river.json'), file);
  log(`wrote labs/etf-river.json (${(file.length / 1024).toFixed(0)} KB)`);
  log(`dataHash ${river.dataHash}`);
}

/**
 * Gate 1 — the windows are anchored where the specification says.
 *
 * Reported as dates rather than only asserted, because "P[t−21] / P[t−252]" is
 * a claim about two specific trading days and the cheapest way to be wrong
 * about it is to be a day out with no symptom.
 */
function gateAnchors(calendar: readonly string[], offsets: readonly number[]): void {
  const t = offsets[offsets.length - 1] as number;
  for (const key of LEG_KEYS) {
    const { lookback, skip } = LEGS[key];
    const start = calendar[t - lookback];
    const end = calendar[t - skip];
    if (!start || !end) throw new Error(`gate 1: ${key} anchors fall outside the calendar`);
    log(`  gate 1 ${LEGS[key].label}: ${start} → ${end} (as of ${calendar[t]})`);
  }
}

/** Gate 2 — an independent recomputation of a deterministic sample. */
function gateRecomputation(
  river: ReturnType<typeof buildEtfRiver>['river'],
  perSession: ReturnType<typeof buildEtfRiver>['perSession'],
  offsets: readonly number[],
  calendar: readonly string[],
  bars: ReadonlyMap<string, { date: string; adjClose: number }[]>,
  samples = 400,
): void {
  const rand = rng(20260831);
  const symbols = river.members.map((m) => m.symbol);
  let checked = 0;
  let worst = 0;

  for (let n = 0; n < samples; n++) {
    const si = Math.floor(rand() * offsets.length);
    const yi = Math.floor(rand() * symbols.length);
    const session = perSession[si];
    const symbol = symbols[yi] as string;
    if (!session) continue;
    const i = session.symbols.indexOf(symbol);
    if (i < 0) continue;
    const date = calendar[offsets[si] as number] as string;
    const b = bars.get(symbol);
    if (!b) continue;

    for (const key of LEG_KEYS) {
      const { lookback, skip } = LEGS[key];
      const want = (session.legs[i] as Record<string, { ret: number; annVol: number; volAdjusted: number }>)[key];
      const got = naiveLeg(b, date, lookback, skip);
      if (!want || !got) throw new Error(`gate 2: ${symbol} ${date} ${key} could not be recomputed`);
      for (const field of ['ret', 'annVol', 'volAdjusted'] as const) {
        const d = Math.abs(got[field] - want[field]);
        if (d > worst) worst = d;
        if (d > 1e-9) {
          throw new Error(
            `gate 2: ${symbol} ${date} ${key}.${field} — built ${want[field]}, recomputed ${got[field]}`,
          );
        }
      }
      checked++;
    }
  }
  if (checked === 0) throw new Error('gate 2: nothing was checked');
  log(`  gate 2 ok: ${checked} legs recomputed independently, worst difference ${worst.toExponential(1)}`);
}

/**
 * Gate 3 — every date is a cross-section.
 *
 * The whole claim of this screen is that a point means "relative to the group
 * on that day", which is true only if each leg really is standardized within
 * the date and the blend really is the stated weighted mean of the two.
 */
function gateCrossSection(perSession: ReturnType<typeof buildEtfRiver>['perSession']): void {
  let worstMean = 0;
  let worstSd = 0;
  let worstBlend = 0;
  for (const session of perSession) {
    for (const key of LEG_KEYS) {
      const z = session.z[key];
      const mean = z.reduce((a, b) => a + b, 0) / z.length;
      const sd = sampleStdDev(z);
      worstMean = Math.max(worstMean, Math.abs(mean));
      worstSd = Math.max(worstSd, Math.abs(sd - 1));
    }
    session.blend.forEach((v, i) => {
      let want = 0;
      for (const key of LEG_KEYS) want += LEG_WEIGHTS[key] * (session.z[key][i] as number);
      worstBlend = Math.max(worstBlend, Math.abs(v - want));
    });
  }
  if (worstMean > 1e-9 || worstSd > 1e-9 || worstBlend > 1e-12) {
    throw new Error(
      `gate 3: cross-sections are off — |mean| ${worstMean}, |sd−1| ${worstSd}, |blend−mix| ${worstBlend}`,
    );
  }
  log(
    `  gate 3 ok: every leg is mean 0 / sd 1 within its date ` +
      `(worst |mean| ${worstMean.toExponential(1)}, |sd−1| ${worstSd.toExponential(1)})`,
  );
}

/** Gate 4 — the drawing has something to draw. */
function gateCoverage(
  river: ReturnType<typeof buildEtfRiver>['river'],
  perSession: ReturnType<typeof buildEtfRiver>['perSession'],
): void {
  const { nameSessions, of } = river.diagnostics.rejected;
  log(
    `  gate 4: ${of - nameSessions}/${of} name-sessions computable, ` +
      `${river.diagnostics.partialSessions} session(s) short of the full universe`,
  );
  const gaps = river.blend.filter((path) => path.some((v) => v === null)).length;
  if (gaps > river.members.length / 4) {
    throw new Error(`gate 4: ${gaps} of ${river.members.length} trails have holes in them`);
  }
  const last = perSession[perSession.length - 1];
  if (!last || last.symbols.length < 2) throw new Error('gate 4: the latest session has no cross-section');
}

/**
 * The standing redundancy screen. Reported every run; it does not stop one.
 *
 * Whether two industries have become one bet is a judgement about what the
 * universe is for, and this program is not the right place to make it — but it
 * is the right place to notice, which is why the numbers are printed and
 * carried in the sidecar rather than measured once and forgotten.
 */
function screenRedundancy(
  river: ReturnType<typeof buildEtfRiver>['river'],
  closes: ReadonlyMap<string, readonly (number | null)[]>,
  calendar: readonly string[],
  L: number,
): ReturnType<typeof pairStats> {
  const symbols = river.members.map((m) => m.symbol);
  const returns = new Map<string, number[]>();
  for (const symbol of symbols) {
    const series = (closes.get(symbol) ?? []).slice(0, L + 1).filter((c): c is number => c != null && c > 0);
    returns.set(symbol, simpleReturns(series));
  }
  const paths = new Map(symbols.map((s, i) => [s, river.blend[i] as (number | null)[]]));
  const stats = pairStats(symbols, returns, paths);

  log(`  redundancy screen over ${calendar.length} sessions of returns and the drawn year:`);
  for (const p of stats.slice(0, REDUNDANCY_REPORT_PAIRS)) {
    log(
      `    ${p.a}-${p.b}\treturns ${p.returnCorr.toFixed(2)}\tpath ${p.pathCorr.toFixed(2)}` +
        `\trms ${p.pathRms.toFixed(2)}z${p.redundant ? '   ← REDUNDANT' : ''}`,
    );
  }
  const flagged = stats.filter((p) => p.redundant);
  river.diagnostics.closestPairs = stats.slice(0, REDUNDANCY_REPORT_PAIRS);
  if (flagged.length > 0) {
    log(
      `  ${flagged.length} pair(s) are redundant on both axes — consider dropping one of each: ` +
        flagged.map((p) => `${p.a}/${p.b}`).join(', '),
    );
  } else {
    log('  no pair is redundant on both axes; the universe still holds distinct bets');
  }
  return flagged;
}

/** What the year actually showed, printed so a run is readable without the page. */
function reportRotation(river: ReturnType<typeof buildEtfRiver>['river']): void {
  const symbols = river.members.map((m) => m.symbol);
  const at = (k: number) =>
    symbols
      .map((s, i) => ({ s, v: (river.blend[i] as (number | null)[])[k] }))
      .filter((x): x is { s: string; v: number } => x.v != null)
      .sort((a, b) => b.v - a.v);

  const first = at(0);
  const last = at(river.sessions.length - 1);
  const leaders = new Set<string>();
  for (let k = 0; k < river.sessions.length; k++) leaders.add((at(k)[0] as { s: string }).s);

  log(`  a year ago (${river.sessions[0]}): ${first.slice(0, 4).map((x) => `${x.s} ${x.v.toFixed(2)}`).join(', ')}`);
  log(`  today (${river.asOf}):        ${last.slice(0, 4).map((x) => `${x.s} ${x.v.toFixed(2)}`).join(', ')}`);
  log(`  ${leaders.size} different funds held the top spot over the year: ${[...leaders].sort().join(', ')}`);

  const moves = symbols
    .map((s, i) => {
      const path = river.blend[i] as (number | null)[];
      const a = path[0];
      const b = path[path.length - 1];
      return a == null || b == null ? null : { s, from: a, to: b, move: b - a };
    })
    .filter((x): x is { s: string; from: number; to: number; move: number } => x !== null)
    .sort((a, b) => b.move - a.move);
  const show = (x: { s: string; from: number; to: number; move: number }) =>
    `${x.s} ${x.from.toFixed(2)}→${x.to.toFixed(2)}`;
  log(`  biggest rise: ${moves.slice(0, 3).map(show).join(', ')}`);
  log(`  biggest fade: ${moves.slice(-3).reverse().map(show).join(', ')}`);
}

try {
  await main();
} catch (err) {
  if (err instanceof FmpAuthError) {
    console.error(`\n[etf-river] FMP credentials unavailable — stopping.\n${err.message}\n`);
  } else {
    console.error(`\n[etf-river] ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  }
  process.exitCode = 1;
}
