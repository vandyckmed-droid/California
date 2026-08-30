import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CORRELATION_CHARS,
  DISPLAY_CHARS,
  decodeCorrelationSeries,
  decodeDisplaySeries,
  encodeCorrelationSeries,
  encodeDisplaySeries,
} from '../src/pipeline/series.ts';
import { completeLinkageGroups } from '../src/pipeline/cluster.ts';
import { correlationMatrix } from '../src/pipeline/correlation.ts';
import { pearson, simpleReturns } from '../src/pipeline/stats.ts';
import { THRESHOLDS } from '../src/config.ts';

/**
 * Ground truth for the shipped encodings.
 *
 * The point of this file is that it is NOT self-referential. Computing
 * correlations from shipped data and then checking the resulting groups
 * against those same correlations is internally consistent however wrong the
 * input is — it tests the clustering algorithm, which was never in doubt, and
 * is structurally blind to a degraded series. This compares against
 * full-precision closes instead, which is the only way the precision of the
 * encoding is actually under test.
 *
 * It is also what keeps the encoding honest later: pressure to shave bytes off
 * the series will come from the size budget in `series.test.ts`, and this is
 * what stops that pressure from silently degrading the risk numbers.
 */
const fixture = JSON.parse(
  readFileSync('tests/fixtures/precision-groundtruth.json', 'utf8'),
) as { window: { sessions: number }; closes: Record<string, number[]> };

const SYMBOLS = Object.keys(fixture.closes).sort();
const TRUE_CLOSES = SYMBOLS.map((s) => fixture.closes[s] as number[]);
/** Tolerance the plan commits to: correlation from shipped data within this of full precision. */
const TOLERANCE = 0.005;

const roundTrip = (values: readonly number[], correlationGrade: boolean): number[] =>
  correlationGrade
    ? decodeCorrelationSeries(encodeCorrelationSeries(values))
    : decodeDisplaySeries(encodeDisplaySeries(values));

const returnsFor = (closes: readonly number[][]) => closes.map((c) => simpleReturns(c));

function pairErrors(correlationGrade: boolean): { errors: number[]; crossings: number } {
  const shipped = returnsFor(TRUE_CLOSES.map((c) => roundTrip(c, correlationGrade)));
  const truth = returnsFor(TRUE_CLOSES);
  const errors: number[] = [];
  let crossings = 0;
  for (let i = 0; i < SYMBOLS.length; i++) {
    for (let j = i + 1; j < SYMBOLS.length; j++) {
      const t = pearson(truth[i] as number[], truth[j] as number[]);
      const q = pearson(shipped[i] as number[], shipped[j] as number[]);
      errors.push(Math.abs(t - q));
      for (const threshold of THRESHOLDS) {
        if (t >= threshold !== (q >= threshold)) crossings++;
      }
    }
  }
  return { errors, crossings };
}

describe('ground truth: correlation from shipped data', () => {
  it('has a fixture spanning both tight and loose pairs', () => {
    expect(SYMBOLS.length).toBeGreaterThanOrEqual(10);
    expect(fixture.window.sessions).toBeGreaterThan(120);
    const truth = returnsFor(TRUE_CLOSES);
    const rhos = [];
    for (let i = 0; i < SYMBOLS.length; i++)
      for (let j = i + 1; j < SYMBOLS.length; j++)
        rhos.push(pearson(truth[i] as number[], truth[j] as number[]));
    // A fixture of only tight pairs could not detect a threshold crossing.
    expect(Math.max(...rhos)).toBeGreaterThan(0.65);
    expect(Math.min(...rhos)).toBeLessThan(0.4);
  });

  it('matches full precision within tolerance at correlation grade', () => {
    const { errors, crossings } = pairErrors(true);
    expect(Math.max(...errors)).toBeLessThan(TOLERANCE);
    expect(crossings).toBe(0);
  });

  it('produces the same groups as full precision at every threshold', () => {
    const shipped = correlationMatrix(returnsFor(TRUE_CLOSES.map((c) => roundTrip(c, true))));
    const truth = correlationMatrix(returnsFor(TRUE_CLOSES));
    for (const threshold of THRESHOLDS) {
      const a = completeLinkageGroups(truth, threshold).map((g) => g.members);
      const b = completeLinkageGroups(shipped, threshold).map((g) => g.members);
      expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    }
  });

  /**
   * The discriminating case. If this ever passes, the test above has stopped
   * measuring anything: it would mean display grade is good enough for
   * correlation, which measurement says it is not.
   */
  it('would NOT match at display grade — the reason two grades exist', () => {
    const { errors, crossings } = pairErrors(false);
    expect(Math.max(...errors)).toBeGreaterThan(TOLERANCE);
    expect(crossings).toBeGreaterThan(0);
  });

  it('costs about 2x display grade per name, which the selection can afford', () => {
    const one = TRUE_CLOSES[0] as number[];
    const display = JSON.stringify(encodeDisplaySeries(one)).length;
    const corr = JSON.stringify(encodeCorrelationSeries(one)).length;
    expect(corr / display).toBeGreaterThan(1.5);
    expect(corr / display).toBeLessThan(2.5);
    // A 30-name watchlist, against the 351 KB bundle this replaces.
    expect(corr * 30).toBeLessThan(20_000);
  });

  it('keeps the two grades at their stated widths', () => {
    const one = TRUE_CLOSES[0] as number[];
    expect(encodeDisplaySeries(one).points.length).toBe(one.length * DISPLAY_CHARS);
    expect(encodeCorrelationSeries(one).points.length).toBe(one.length * CORRELATION_CHARS);
  });
});
