import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  decodeDisplaySeries,
  encodeDisplaySeries,
  levelsFor,
  DISPLAY_CHARS,
} from '../src/pipeline/series.ts';

describe('display series encoding', () => {
  it('uses exactly one character per point', () => {
    const values = Array.from({ length: 253 }, (_, i) => 100 + i);
    expect(encodeDisplaySeries(values).points.length).toBe(253);
  });

  it('round-trips within one quantization step of the series range', () => {
    // A realistic shape: a strong trend with noise on top.
    const values = Array.from({ length: 253 }, (_, i) => 50 * Math.exp(i / 90) + Math.sin(i) * 3);
    const encoded = encodeDisplaySeries(values);
    const decoded = decodeDisplaySeries(encoded);
    const span = Math.max(...values) - Math.min(...values);
    const step = span / (levelsFor(DISPLAY_CHARS) - 1);
    expect(decoded.length).toBe(values.length);
    for (let i = 0; i < values.length; i++) {
      expect(Math.abs((decoded[i] as number) - (values[i] as number))).toBeLessThanOrEqual(step);
    }
  });

  it('keeps error proportional to the series own range, not its price level', () => {
    // A quiet name and a violent one must both quantize to the same relative
    // precision, because each series is normalized to itself.
    const quiet = Array.from({ length: 100 }, (_, i) => 100 + Math.sin(i / 5) * 2);
    const wild = Array.from({ length: 100 }, (_, i) => 10 + Math.sin(i / 5) * 200);
    for (const values of [quiet, wild]) {
      const decoded = decodeDisplaySeries(encodeDisplaySeries(values));
      const span = Math.max(...values) - Math.min(...values);
      const worst = Math.max(...values.map((v, i) => Math.abs((decoded[i] as number) - v)));
      expect(worst / span).toBeLessThanOrEqual(1 / (levelsFor(DISPLAY_CHARS) - 1));
    }
  });

  it('pins the extremes to the ends of the range', () => {
    const values = [10, 20, 30, 40, 50];
    const e = encodeDisplaySeries(values);
    expect(e.lo).toBe(10);
    expect(e.hi).toBe(50);
    const d = decodeDisplaySeries(e);
    expect(d[0]).toBeCloseTo(10, 6);
    expect(d[4]).toBeCloseTo(50, 6);
  });

  it('preserves the shape monotonically', () => {
    const rising = Array.from({ length: 50 }, (_, i) => i * 3 + 7);
    const d = decodeDisplaySeries(encodeDisplaySeries(rising));
    for (let i = 1; i < d.length; i++) expect(d[i] as number).toBeGreaterThanOrEqual(d[i - 1] as number);
  });

  it('handles a flat series without dividing by zero', () => {
    const e = encodeDisplaySeries([42, 42, 42]);
    expect(e.points).toBe('AAA');
    expect(decodeDisplaySeries(e).every((v) => Number.isFinite(v))).toBe(true);
  });

  it('handles the empty case', () => {
    expect(encodeDisplaySeries([]).points).toBe('');
    expect(decodeDisplaySeries({ points: '', lo: 0, hi: 0 })).toEqual([]);
  });

});

/**
 * Payload budgets, measured against the committed artefacts rather than
 * extrapolated. These are the assertions that stop the product quietly
 * becoming heavy again: the whole design rests on the ranked list being cheap
 * and prices being fetched only for names the user actually opens.
 *
 * Each cap is measurement plus a stated margin, so a failure reads as
 * "something regressed" rather than "the estimate was optimistic".
 */
describe('shipped payload budgets', () => {
  const gzippedBytes = (path: string): number =>
    gzipSync(readFileSync(path), { level: 9 }).length;

  it('keeps snapshot.json within budget for the whole eligible universe', () => {
    const snapshot = JSON.parse(readFileSync('web/data/snapshot.json', 'utf8')) as {
      columns: { symbol: string[] };
    };
    // The point of the budget: it covers every eligible name, not a Top 100.
    expect(snapshot.columns.symbol.length).toBeGreaterThan(1500);
    // ~122 KB measured. Cap at 140 KB.
    expect(gzippedBytes('web/data/snapshot.json')).toBeLessThan(140 * 1024);
  });

  it('carries no price series in the snapshot at all', () => {
    // Prices belong in per-symbol files. If they leak back into the snapshot
    // the home screen silently pays for data it never draws.
    const raw = readFileSync('web/data/snapshot.json', 'utf8');
    expect(raw).not.toContain('"series"');
    expect(raw).not.toContain('"display"');
    expect(raw).not.toContain('"correlation"');
  });

  it('keeps every per-symbol series file small enough to fetch on tap', () => {
    const dir = 'web/data/series';
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    expect(files.length).toBeGreaterThan(1500);
    let largest = 0;
    let largestName = '';
    for (const f of files) {
      const size = statSync(join(dir, f)).size;
      if (size > largest) {
        largest = size;
        largestName = f;
      }
    }
    // ~637 B measured. Cap at 2 KB.
    expect(largest, `largest is ${largestName} at ${largest} B`).toBeLessThan(2048);
  });

  it('gives every symbol in the snapshot exactly one series file', () => {
    const snapshot = JSON.parse(readFileSync('web/data/snapshot.json', 'utf8')) as {
      columns: { symbol: string[] };
    };
    const onDisk = new Set(
      readdirSync('web/data/series').filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)),
    );
    const missing = snapshot.columns.symbol.filter((s) => !onDisk.has(s));
    const orphaned = [...onDisk].filter((s) => !snapshot.columns.symbol.includes(s));
    expect(missing, `no series file for ${missing.slice(0, 5).join(', ')}`).toEqual([]);
    // A name leaving the universe must not leave a stale file for the site to serve.
    expect(orphaned, `orphaned ${orphaned.slice(0, 5).join(', ')}`).toEqual([]);
  });

  it('costs a 30-name watchlist well under the bundle it replaces', () => {
    const dir = 'web/data/series';
    const files = readdirSync(dir).filter((f) => f.endsWith('.json')).slice(0, 30);
    const total = files.reduce((n, f) => n + statSync(join(dir, f)).size, 0);
    expect(total).toBeLessThan(30 * 1024);
  });
});
