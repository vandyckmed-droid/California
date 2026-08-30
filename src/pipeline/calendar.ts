import { CALENDAR_MIN_COVERAGE } from '../config.ts';
import type { History } from '../fmp/types.ts';

/**
 * The master trading calendar: every date on which at least `minCoverage` of
 * the fetched names traded. Deriving it from the data rather than a hardcoded
 * exchange calendar keeps the pipeline reproducible from the FMP payload
 * alone, and the coverage floor keeps one name's halt from adding a phantom
 * session or one name's bad tick from removing a real one.
 *
 * `histories` must be keyed by symbol; iteration order does not affect output.
 */
export function buildMasterCalendar(
  histories: Iterable<History>,
  symbolCount: number,
  minCoverage: number = CALENDAR_MIN_COVERAGE,
): string[] {
  const counts = new Map<string, number>();
  for (const h of histories) {
    for (const bar of h.bars) counts.set(bar.date, (counts.get(bar.date) ?? 0) + 1);
  }
  const needed = minCoverage * symbolCount;
  const dates: string[] = [];
  for (const [date, n] of counts) if (n >= needed) dates.push(date);
  return dates.sort();
}

export interface AlignedSeries {
  symbol: string;
  /** Close for each master-calendar date; null before the name's first bar. */
  closes: (number | null)[];
  /** Raw share volume for each date; null where closes is null. */
  volumes: (number | null)[];
  /** True where a real bar exists on that exact date (false = carried forward). */
  actual: boolean[];
}

/**
 * Projects a name's bars onto the master calendar using as-of lookup, so an
 * isolated halt carries the prior close forward instead of dropping the name.
 */
export function alignToCalendar(history: History, calendar: string[]): AlignedSeries {
  const closes: (number | null)[] = new Array(calendar.length).fill(null);
  const volumes: (number | null)[] = new Array(calendar.length).fill(null);
  const actual: boolean[] = new Array(calendar.length).fill(false);

  // Bars are oldest-first, so a single forward walk resolves every as-of lookup.
  let cursor = -1;
  for (let i = 0; i < calendar.length; i++) {
    const date = calendar[i] as string;
    while (cursor + 1 < history.bars.length && (history.bars[cursor + 1] as { date: string }).date <= date) {
      cursor++;
    }
    if (cursor < 0) continue;
    const bar = history.bars[cursor]!;
    closes[i] = bar.adjClose;
    volumes[i] = bar.volume;
    actual[i] = bar.date === date;
  }
  return { symbol: history.symbol, closes, volumes, actual };
}

/** Fraction of `[from, to]` calendar slots backed by a real bar. */
export function actualCoverage(series: AlignedSeries, from: number, to: number): number {
  const span = to - from + 1;
  if (span <= 0) return 0;
  let n = 0;
  for (let i = from; i <= to; i++) if (series.actual[i]) n++;
  return n / span;
}
