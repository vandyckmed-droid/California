import { describe, expect, it } from 'vitest';
import { decodeSeries, encodeSeries, SERIES_LEVELS } from '../src/pipeline/series.ts';

describe('price series encoding', () => {
  it('uses exactly one character per point', () => {
    const values = Array.from({ length: 253 }, (_, i) => 100 + i);
    expect(encodeSeries(values).points.length).toBe(253);
  });

  it('round-trips within one quantization step of the series range', () => {
    // A realistic shape: a strong trend with noise on top.
    const values = Array.from({ length: 253 }, (_, i) => 50 * Math.exp(i / 90) + Math.sin(i) * 3);
    const encoded = encodeSeries(values);
    const decoded = decodeSeries(encoded);
    const span = Math.max(...values) - Math.min(...values);
    const step = span / (SERIES_LEVELS - 1);
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
      const decoded = decodeSeries(encodeSeries(values));
      const span = Math.max(...values) - Math.min(...values);
      const worst = Math.max(...values.map((v, i) => Math.abs((decoded[i] as number) - v)));
      expect(worst / span).toBeLessThanOrEqual(1 / (SERIES_LEVELS - 1));
    }
  });

  it('pins the extremes to the ends of the range', () => {
    const values = [10, 20, 30, 40, 50];
    const e = encodeSeries(values);
    expect(e.lo).toBe(10);
    expect(e.hi).toBe(50);
    const d = decodeSeries(e);
    expect(d[0]).toBeCloseTo(10, 6);
    expect(d[4]).toBeCloseTo(50, 6);
  });

  it('preserves the shape monotonically', () => {
    const rising = Array.from({ length: 50 }, (_, i) => i * 3 + 7);
    const d = decodeSeries(encodeSeries(rising));
    for (let i = 1; i < d.length; i++) expect(d[i] as number).toBeGreaterThanOrEqual(d[i - 1] as number);
  });

  it('handles a flat series without dividing by zero', () => {
    const e = encodeSeries([42, 42, 42]);
    expect(e.points).toBe('AAA');
    expect(decodeSeries(e).every((v) => Number.isFinite(v))).toBe(true);
  });

  it('handles the empty case', () => {
    expect(encodeSeries([]).points).toBe('');
    expect(decodeSeries({ points: '', lo: 0, hi: 0 })).toEqual([]);
  });

  it('stays compact enough to ship for the whole displayed universe', () => {
    const one = encodeSeries(Array.from({ length: 253 }, (_, i) => 100 + Math.sin(i) * 10));
    const bytes = JSON.stringify(one).length * 278;
    // Raw daily closes for 278 names would be several hundred KB.
    expect(bytes).toBeLessThan(90_000);
  });
});
