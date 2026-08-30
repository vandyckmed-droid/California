import { readFileSync } from 'node:fs';
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

  /**
   * A payload budget, measured against the committed snapshot rather than
   * extrapolated from one series times today's symbol count.
   *
   * The number of names carrying a series is the size of the union of the
   * eight Top 100s — an emergent property of the data, not a constant. It grows
   * whenever the eight rankings overlap less, so a guard that multiplies by a
   * hardcoded count cannot notice the growth it exists to catch.
   *
   * Denominated in gzipped bytes because that is what a phone downloads:
   * shipping the series doubled the snapshot over the wire, 48 KB -> 96 KB,
   * of which the series are ~42 KB.
   */
  it('keeps the shipped series payload within budget', () => {
    const raw = readFileSync('web/data/snapshot.json', 'utf8');
    const snapshot = JSON.parse(raw) as {
      symbols: Record<string, { series?: unknown }>;
    };
    const withSeries = Object.values(snapshot.symbols).filter((s) => s.series);
    expect(withSeries.length).toBeGreaterThan(0);

    const seriesOnly = JSON.stringify(withSeries.map((s) => s.series));
    const gzipped = gzipSync(Buffer.from(seriesOnly), { level: 9 }).length;

    // ~42 KB today. Fails on real growth in how many names carry a series,
    // rather than on a number frozen at the count that happened to be current.
    expect(gzipped).toBeLessThan(90_000);
  });
});
