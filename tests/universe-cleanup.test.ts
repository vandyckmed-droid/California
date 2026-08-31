import { describe, expect, it } from 'vitest';
import {
  CLEAN_MIN_HISTORY_SESSIONS,
  CLEAN_MISSING_SESSION_ALLOWANCE,
  EXTREME_MOVE_THRESHOLD,
  FLATLINE_EVENT_THRESHOLD,
  MIN_REALIZED_VOL,
  SHORT_VOL_WINDOW,
} from '../src/config.ts';
import {
  annualizedVol,
  applyConcentrationCaps,
  companyKey,
  dedupeShareClasses,
  largestAbsMove,
  securityTypeReason,
  seriesVerdict,
  type Candidate,
} from '../src/pipeline/cleanup.ts';
import type { AlignedSeries } from '../src/pipeline/calendar.ts';
import { readFileSync } from 'node:fs';

const N = CLEAN_MIN_HISTORY_SESSIONS + 40;

/**
 * A clean, liquid, ordinary series.
 *
 * Built from a repeating return pattern rather than random walk so every
 * expectation below is a consequence of a stated input, not of a seed.
 */
function series(opts: {
  returns?: (i: number) => number;
  n?: number;
  firstBarAt?: number;
  missingAt?: number[];
  volume?: number;
  zeroAt?: number;
} = {}): AlignedSeries {
  const n = opts.n ?? N;
  const first = opts.firstBarAt ?? 0;
  const closes: (number | null)[] = new Array(n).fill(null);
  const volumes: (number | null)[] = new Array(n).fill(null);
  const actual: boolean[] = new Array(n).fill(false);
  let price = 100;
  for (let i = first; i < n; i++) {
    if (i > first) price *= 1 + (opts.returns ? opts.returns(i) : (i % 2 === 0 ? 0.012 : -0.010));
    closes[i] = i === opts.zeroAt ? 0 : price;
    volumes[i] = opts.volume ?? 1_000_000;
    actual[i] = true;
  }
  for (const i of opts.missingAt ?? []) actual[i] = false;
  return { symbol: 'TEST', closes, volumes, actual };
}

const member = { symbol: 'TEST', marketCap: 5_000_000_000 };
const L = N - 1;
const verdict = (s: AlignedSeries, m = member) => seriesVerdict(s, m, L);

describe('security-type rules', () => {
  it('trusts the row\'s own flags, not just the query that asked for them', () => {
    // The screener is asked for isEtf=false; this is the vendor's answer for
    // this row, and the two are not the same promise.
    expect(securityTypeReason({ symbol: 'X', companyName: 'Something', isEtf: true }, true)).toBe('securityType');
    expect(securityTypeReason({ symbol: 'X', companyName: 'Something', isFund: true }, true)).toBe('securityType');
    expect(securityTypeReason({ symbol: 'X', companyName: 'Something', isActivelyTrading: false }, true))
      .toBe('notActivelyTrading');
  });

  it('catches wrappers the flags miss', () => {
    for (const name of [
      'iPath Series B Bloomberg Cocoa Subindex Total Return ETN',
      'Ajax Capital Acquisitions Corp',
      'Permian Basin Royalty Trust',
      'Some Liquidating Trust',
      'Big Blank Check Co',
    ]) {
      expect(securityTypeReason({ symbol: 'X', companyName: name }, true), name).toBe('securityType');
    }
  });

  it('leaves ordinary companies alone', () => {
    // Each of these has previously been killed by a rule that looked right:
    // "Preferred Bank" by a bare \bpreferred\b, "Construction Partners" by a
    // bare \bpartners\b, and any REIT by a bare \btrust\b.
    for (const name of [
      'Preferred Bank',
      'Construction Partners, Inc.',
      'Berkshire Hathaway Inc. Class B',
      'Realty Income Corporation',
      'Northern Trust Corporation',
      'Apple Inc.',
    ]) {
      expect(securityTypeReason({ symbol: 'X', companyName: name }, true), name).toBeNull();
    }
  });

  it('does not guess at SPACs from a name that real lenders also use', () => {
    // "Churchill Capital Corp" is a SPAC and "Capitala Finance Corp" is a
    // lender, and no phrase separates them. Shells are caught by FMP's own
    // industry and by the volatility rules — a pre-deal SPAC sits pinned near
    // its trust value — rather than by deleting every "Capital Corp".
    expect(securityTypeReason({ symbol: 'CCIX', companyName: 'Churchill Capital Corp X' }, true)).toBeNull();
    expect(securityTypeReason({ symbol: 'X', companyName: 'Hercules Capital, Inc.' }, true)).toBeNull();
  });

  it('treats ADRs as out of scope only when asked to', () => {
    const row = { symbol: 'X', companyName: 'Arm Holdings plc American Depositary Shares' };
    expect(securityTypeReason(row, true)).toBe('securityType');
    expect(securityTypeReason(row, false)).toBeNull();
  });
});

describe('the measured quantities', () => {
  it('annualizes the standard deviation of daily returns', () => {
    // Alternating ±1% has a known sample sd, so this is a closed-form check
    // rather than a comparison against another implementation.
    const closes = [100];
    for (let i = 1; i <= 22; i++) closes.push(closes[i - 1]! * (i % 2 ? 1.01 : 1 / 1.01));
    const v = annualizedVol(closes, closes.length - 1, 21) as number;
    expect(v).toBeGreaterThan(0.14);
    expect(v).toBeLessThan(0.17);
  });

  it('finds the largest one-day move inside its window and ignores older ones', () => {
    const closes = new Array(100).fill(0).map(() => 100);
    closes[10] = 200; // a 100% move at index 10, then back
    expect(largestAbsMove(closes, 99, 20)).toBe(0);
    expect(largestAbsMove(closes, 15, 20)).toBeCloseTo(1, 6);
  });
});

describe('the series rules', () => {
  it('keeps an ordinary liquid name', () => {
    expect(verdict(series()).reason).toBeNull();
  });

  it('requires three years of history', () => {
    const short = series({ firstBarAt: N - 400 });
    expect(verdict(short).reason).toBe('shortHistory');
  });

  it('requires a real bar on every expected session', () => {
    // Written against the constant rather than a hardcoded count, so tightening
    // or loosening the allowance moves the test with the rule instead of
    // breaking it. At the shipped value of zero, one absent session is enough.
    const within = Array.from({ length: CLEAN_MISSING_SESSION_ALLOWANCE }, (_, i) => 100 + i * 10);
    expect(verdict(series({ missingAt: within })).reason).toBeNull();
    const over = Array.from({ length: CLEAN_MISSING_SESSION_ALLOWANCE + 1 }, (_, i) => 100 + i * 10);
    const v = verdict(series({ missingAt: over }));
    expect(v.reason).toBe('missingSessions');
    expect(v.missing).toBe(CLEAN_MISSING_SESSION_ALLOWANCE + 1);
  });

  it('sees an absent session even though the close beside it looks valid', () => {
    // alignToCalendar carries the previous close forward across a halt, so the
    // hole exists only in `actual`. A rule that read the closes would find a
    // complete, plausible, entirely fabricated series.
    const s = series({ missingAt: [400] });
    expect(s.closes[400]).toBeGreaterThan(0);
    expect(verdict(s).missing).toBe(1);
  });

  it('rejects zero, negative and non-finite closes', () => {
    expect(verdict(series({ zeroAt: 500 })).reason).toBe('badSeries');
  });

  it('rejects a name below the market-cap floor', () => {
    expect(verdict(series(), { symbol: 'TEST', marketCap: 100_000_000 }).reason).toBe('marketCapUnderFloor');
  });

  it('rejects a name below the dollar-volume floor', () => {
    expect(verdict(series({ volume: 100 })).reason).toBe('illiquid');
  });

  it('rejects a name that has stopped moving', () => {
    // Flat for the last month: what a stock pinned to agreed deal terms does.
    const flat = series({ returns: (i) => (i > L - 40 ? 0 : i % 2 === 0 ? 0.012 : -0.01) });
    const v = verdict(flat);
    expect(v.reason).toBe('flatVolatility');
    expect(v.shortVol as number).toBeLessThan(MIN_REALIZED_VOL);
  });

  it('rejects a shock followed by a flatline, and reports both halves', () => {
    // A 30% jump 60 sessions back, then a quiet — but not dead — month, so it
    // clears the bare volatility floor and only the paired rule catches it.
    const jumpAt = L - 60;
    const quiet = series({
      returns: (i) => {
        if (i === jumpAt) return 0.30;
        if (i > L - SHORT_VOL_WINDOW - 1) return i % 2 === 0 ? 0.0044 : -0.0044;
        return i % 2 === 0 ? 0.012 : -0.01;
      },
    });
    const v = verdict(quiet);
    expect(v.reason).toBe('postEventFlatline');
    expect(v.eventMove as number).toBeGreaterThanOrEqual(FLATLINE_EVENT_THRESHOLD);
    expect(v.shortVol as number).toBeGreaterThanOrEqual(MIN_REALIZED_VOL);
  });

  it('does not let the shock inflate the calm it is compared against', () => {
    // The same jump placed *inside* the volatility window. If the two windows
    // overlapped, this name's 21-day vol would be enormous and the flatline
    // rule would never fire — which is the bug this separation prevents.
    const inside = series({
      returns: (i) => (i === L - 5 ? 0.30 : i % 2 === 0 ? 0.012 : -0.01),
    });
    const v = verdict(inside);
    expect(v.reason).not.toBe('postEventFlatline');
    expect(v.shortVol as number).toBeGreaterThan(0.5);
  });

  it('rejects an implausible one-day move in an adjusted series', () => {
    const split = series({ returns: (i) => (i === L - 10 ? -0.6 : i % 2 === 0 ? 0.012 : -0.01) });
    const v = verdict(split);
    expect(v.reason).toBe('extremeOneDayMove');
    expect(v.recentMove as number).toBeGreaterThanOrEqual(EXTREME_MOVE_THRESHOLD);
  });

  it('ignores an old extreme move outside the recent window', () => {
    expect(verdict(series({ returns: (i) => (i === 300 ? -0.6 : i % 2 === 0 ? 0.012 : -0.01) })).reason)
      .toBeNull();
  });

  it('reports what it measured even when it keeps the name', () => {
    const v = verdict(series());
    expect(v.reason).toBeNull();
    expect(v.shortVol).toBeGreaterThan(0);
    expect(v.dollarVolume).toBeGreaterThan(0);
  });
});

describe('share classes', () => {
  it('reduces two classes of one company to the same key', () => {
    expect(companyKey('Alphabet Inc. Class A')).toBe(companyKey('Alphabet Inc. Class C'));
    expect(companyKey('Berkshire Hathaway Inc. Class A')).toBe(companyKey('Berkshire Hathaway Inc. Class B'));
    expect(companyKey('Fox Corporation Class A')).toBe(companyKey('Fox Corporation Class B'));
  });

  it('does not collapse different companies', () => {
    expect(companyKey('Bank of America Corporation')).not.toBe(companyKey('Bank of Hawaii Corporation'));
    expect(companyKey('Apple Inc.')).not.toBe(companyKey('Apple Hospitality REIT, Inc.'));
  });

  const lockstep = Array.from({ length: 60 }, (_, i) => (i % 2 ? 0.01 : -0.008));
  const drifting = lockstep.map((r, i) => r + (i % 7 === 0 ? 0.05 : -0.004));

  const cand = (symbol: string, name: string, dv: number): Candidate =>
    ({ symbol, name, sector: 'Technology', industry: 'Software', dollarVolume: dv });

  it('keeps the most liquid listing and drops the other', () => {
    const out = dedupeShareClasses(
      [cand('GOOG', 'Alphabet Inc. Class C', 10e6), cand('GOOGL', 'Alphabet Inc. Class A', 30e6)],
      new Map([['GOOG', lockstep], ['GOOGL', lockstep]]),
    );
    expect(out.kept.map((c) => c.symbol)).toEqual(['GOOGL']);
    expect(out.removed.map((r) => r.symbol)).toEqual(['GOOG']);
  });

  it('needs the pair to trade alike, not merely to be named alike', () => {
    // Two same-named listings that do not move together are not one bet, and
    // merging them on the name alone would silently delete a real name.
    const out = dedupeShareClasses(
      [cand('AAA', 'Example Corp Class A', 10e6), cand('BBB', 'Example Corp Class B', 30e6)],
      new Map([['AAA', drifting], ['BBB', lockstep]]),
    );
    expect(out.kept.map((c) => c.symbol).sort()).toEqual(['AAA', 'BBB']);
  });

  it('does not merge the different companies the name key collapses', () => {
    // Every one of these is a real collision on the live universe. The name key
    // cannot separate them — stripping "Holdings" and "Corporation" makes both
    // Grahams "graham" — so the correlation gate is what keeps three genuine
    // companies in the universe. This is the case that makes the second gate
    // load-bearing rather than belt-and-braces.
    for (const [a, b] of [
      ['First Bancorp', 'First BanCorp.'],
      ['Graham Holdings Company', 'Graham Corporation'],
      ['Blue Owl Capital Corporation', 'Blue Owl Capital Inc.'],
    ]) {
      expect(companyKey(a as string), `${a} vs ${b}`).toBe(companyKey(b as string));
      const out = dedupeShareClasses(
        [cand('AAA', a as string, 10e6), cand('BBB', b as string, 30e6)],
        new Map([['AAA', drifting], ['BBB', lockstep]]),
      );
      expect(out.kept, `${a} and ${b} were merged`).toHaveLength(2);
    }
  });

  it('leaves unrelated companies alone even when both are liquid', () => {
    const out = dedupeShareClasses(
      [cand('BAC', 'Bank of America Corporation', 10e6), cand('BOH', 'Bank of Hawaii Corporation', 30e6)],
      new Map([['BAC', lockstep], ['BOH', lockstep]]),
    );
    expect(out.kept).toHaveLength(2);
  });
});

describe('concentration caps', () => {
  const make = (n: number, sector: string, industry: string, from = 0): Candidate[] =>
    Array.from({ length: n }, (_, i) => ({
      symbol: `${industry.slice(0, 3).toUpperCase()}${from + i}`,
      name: `${industry} ${from + i}`,
      sector,
      industry,
      // Descending, so "keeps the most liquid" is checkable by symbol number.
      dollarVolume: (n - i) * 1e6,
    }));

  it('trims an over-represented industry to the cap, keeping the most liquid', () => {
    const universe = [...make(40, 'Financials', 'Banks'), ...make(60, 'Various', 'Other')];
    const out = applyConcentrationCaps(universe, 0.075, 1);
    const banks = out.kept.filter((c) => c.industry === 'Banks');
    expect(banks).toHaveLength(Math.floor(100 * 0.075));
    // The seven kept are the seven largest, which is the stated preference.
    expect(banks.map((c) => c.symbol)).toEqual(['BAN0', 'BAN1', 'BAN2', 'BAN3', 'BAN4', 'BAN5', 'BAN6']);
    expect(out.removed.every((r) => r.reason === 'industryCap')).toBe(true);
  });

  it('applies the industry cap before the sector cap', () => {
    // One dominant industry inside a sector that is otherwise fine, and enough
    // spread elsewhere that no other industry is over its own cap. Trimming
    // the industry first removes the concentration where it actually is;
    // sector-first would thin Banks and Insurance evenly and leave Banks still
    // the largest industry in the universe.
    const universe = [
      ...make(30, 'Financials', 'Banks'),
      ...make(10, 'Financials', 'Insurance', 100),
      ...Array.from({ length: 12 }, (_, k) => make(5, `S${k}`, `I${k}`, 200 + k * 10)).flat(),
    ];
    expect(universe).toHaveLength(100);
    const out = applyConcentrationCaps(universe, 0.075, 0.2);
    const counts = (industry: string) => out.kept.filter((c) => c.industry === industry).length;
    // 7 of 100. Insurance at 10 is over that too and trims to 7; every other
    // industry sits at 5 and is untouched.
    expect(counts('Banks')).toBe(7);
    expect(counts('Insurance')).toBe(7);
    // Financials is then 14 of 74, under the 20% sector cap, so the second
    // pass has nothing left to do — which is the point of the ordering.
    const fin = out.kept.filter((c) => c.sector === 'Financials').length;
    expect(fin).toBe(14);
    expect(fin / out.kept.length).toBeLessThanOrEqual(0.2 + 1e-9);
    expect(out.removed.every((r) => r.reason === 'industryCap')).toBe(true);
  });

  it('leaves a balanced universe untouched', () => {
    const universe = Array.from({ length: 10 }, (_, k) => make(10, `S${k}`, `I${k}`, k * 10)).flat();
    const out = applyConcentrationCaps(universe, 0.075, 0.2);
    // Every industry is at exactly 10% of 100, above the 7.5% cap, so this is
    // not a no-op — it is the check that the cap is measured, not assumed.
    expect(out.kept.length).toBeLessThan(universe.length);
    for (const [, n] of countBy(out.kept, (c) => c.industry)) {
      expect(n).toBeLessThanOrEqual(Math.floor(universe.length * 0.075));
    }
  });

  it('is deterministic and independent of input order', () => {
    const universe = [...make(40, 'Financials', 'Banks'), ...make(60, 'Various', 'Other')];
    const a = applyConcentrationCaps(universe, 0.075, 0.2).kept.map((c) => c.symbol).sort();
    const b = applyConcentrationCaps([...universe].reverse(), 0.075, 0.2).kept.map((c) => c.symbol).sort();
    expect(a).toEqual(b);
  });
});

function countBy<T>(xs: readonly T[], keyOf: (x: T) => string): Map<string, number> {
  const out = new Map<string, number>();
  for (const x of xs) out.set(keyOf(x), (out.get(keyOf(x)) ?? 0) + 1);
  return out;
}


describe('the shipped universe', () => {
  const snapshot = JSON.parse(readFileSync('web/data/snapshot.json', 'utf8'));

  it('reports every cleanup rule that removed something', () => {
    // The snapshot has always surfaced each screener rejection so the universe
    // is auditable rather than a black box. The cleanup's rejections are the
    // same kind of fact, and this is what stops them being dropped on the floor.
    const ex = snapshot.meta.universe?.exclusions ?? snapshot.meta.exclusions ?? {};
    const named = Object.keys(ex);
    for (const reason of ['shortHistory', 'illiquid', 'flatVolatility', 'shareClassDuplicate']) {
      expect(named, `${reason} is not reported in the snapshot`).toContain(reason);
      expect(ex[reason]).toBeGreaterThan(0);
    }
  });

  it('holds no two listings that are the same bet', () => {
    // Not "no two share a company key" — they do, and that is fine. The name
    // key is only a candidate generator, and on the live universe it collapses
    // First Bancorp (NC) with First BanCorp (PR), Graham Holdings with Graham
    // Corporation, and Blue Owl's BDC with Blue Owl itself. All three are
    // different companies and all three survive, because the correlation gate
    // refused the merge. The property that actually matters is that any pair
    // still standing behaves differently, which is checked here on the shipped
    // momentum rather than on the function that made the decision.
    const byKey = new Map<string, number[]>();
    const symbols: string[] = snapshot.columns.symbol;
    const names: string[] = snapshot.columns.name;
    symbols.forEach((_, i) => {
      const key = companyKey(names[i] ?? '');
      if (!key) return;
      (byKey.get(key) ?? byKey.set(key, []).get(key) as number[]).push(i);
    });
    const same: string[] = [];
    for (const [, idx] of byKey) {
      if (idx.length < 2) continue;
      for (let a = 0; a < idx.length; a++) {
        for (let b = a + 1; b < idx.length; b++) {
          // columns.m is [horizon][name]; index 0 is 12-1, per meta.params.horizons.
          const twelveOne = snapshot.columns.m[0] as number[];
          const ma = twelveOne[idx[a] as number] as number;
          const mb = twelveOne[idx[b] as number] as number;
          // Two listings of one company differ only by a small, stable class
          // premium; their 12-1 returns land within a fraction of a percent.
          if (Math.abs(ma - mb) < 0.01) {
            same.push(`${symbols[idx[a] as number]}/${symbols[idx[b] as number]}`);
          }
        }
      }
    }
    expect(same).toEqual([]);
  });

  it('sits inside both concentration caps', () => {
    const sectors: string[] = snapshot.columns.sectors
      ? snapshot.columns.sector.map((i: number) => snapshot.columns.sectors[i])
      : snapshot.columns.sector;
    const n = sectors.length;
    const counts = countBy(sectors, (x) => x);
    for (const [sector, count] of counts) {
      expect(count / n, `${sector} is ${((count / n) * 100).toFixed(1)}% of the universe`)
        .toBeLessThanOrEqual(0.20 + 1e-9);
    }
  });
});
