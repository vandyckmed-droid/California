/**
 * Compact encoding for the per-symbol price series carried in the snapshot.
 *
 * The detail screen draws its own chart rather than embedding a third-party
 * one, so the snapshot has to ship the prices. Stored raw that would add
 * hundreds of kilobytes; instead each series is normalized to its own range
 * and quantized to one character per day.
 *
 * 64 levels sounds coarse but the normalization is per series, so the error is
 * always 1/63 of that name's own visible range — about two pixels on a phone
 * chart, whether the stock moved 5% or 2500%.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
export const SERIES_LEVELS = ALPHABET.length; // 64

export interface EncodedSeries {
  /** One character per point, oldest first. */
  points: string;
  /** Value of level 0. */
  lo: number;
  /** Value of the top level. */
  hi: number;
}

export function encodeSeries(values: readonly number[]): EncodedSeries {
  if (values.length === 0) return { points: '', lo: 0, hi: 0 };
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of values) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const span = hi - lo;
  let points = '';
  for (const v of values) {
    // A flat series collapses to the bottom level rather than dividing by zero.
    const level = span > 0 ? Math.round(((v - lo) / span) * (SERIES_LEVELS - 1)) : 0;
    points += ALPHABET[level];
  }
  return { points, lo: round(lo), hi: round(hi) };
}

export function decodeSeries(encoded: EncodedSeries): number[] {
  const span = encoded.hi - encoded.lo;
  const out: number[] = [];
  for (const ch of encoded.points) {
    const level = ALPHABET.indexOf(ch);
    out.push(encoded.lo + (span * level) / (SERIES_LEVELS - 1));
  }
  return out;
}

/** Four significant figures is ample for an axis label and keeps the JSON small. */
function round(v: number): number {
  if (v === 0) return 0;
  const digits = Math.max(0, 4 - Math.ceil(Math.log10(Math.abs(v))));
  const f = 10 ** Math.min(digits, 6);
  return Math.round(v * f) / f;
}
