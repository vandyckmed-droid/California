import { CLEAN_EXCLUDE_ADR, EXCHANGES, MIN_MARKET_CAP, MIN_PRICE } from '../config.ts';
import { securityTypeReason } from './cleanup.ts';
import type { FmpClient } from '../fmp/client.ts';
import type { ScreenerRow } from '../fmp/types.ts';

/**
 * Reasons a screener row is rejected. Every rejection is counted and surfaced
 * in the snapshot so the universe is auditable rather than a black box.
 */
export type ExclusionReason =
  | 'preferredSymbol'
  | 'namePattern'
  | 'partnership'
  | 'shellCompany'
  | 'securityType'
  | 'notActivelyTrading'
  | 'missingMetadata'
  | 'duplicateSymbol';

export interface UniverseMember {
  symbol: string;
  name: string;
  sector: string;
  industry: string;
  exchange: string;
  marketCap: number;
  price: number;
  avgVolume: number | null;
  country: string;
}

export interface UniverseResult {
  members: UniverseMember[];
  screenedCount: number;
  exclusions: Record<ExclusionReason, number>;
  excludedSamples: Partial<Record<ExclusionReason, string[]>>;
}

/**
 * Preferred issues carry a `-P<letter>` suffix on FMP (MER-PK, FITB-PM, OAK-PA).
 * A blanket "hyphen means exclude" rule would be wrong: BRK-A, BRK-B, BF-B,
 * MOG-A, MKC-V and PBR-A are ordinary share classes and must survive.
 */
const PREFERRED_SYMBOL = /-P[A-Z]?$/;

/**
 * Security-type phrases that mark a listing as something other than common
 * equity. These are deliberately phrase-anchored rather than keyed on bare
 * words: a live check showed `\bpreferred\b` wrongly killing "Preferred Bank"
 * (PFBC, a real bank holding company) and `\bseries [A-Z]\b` wrongly killing
 * "Pattern Group Inc. Series A Common Stock" (PTRN).
 */
const NON_COMMON_NAME = new RegExp(
  [
    String.raw`\bwarrants?\b`,
    String.raw`\brights?\b`,
    String.raw`\bequity units?\b`,
    String.raw`\bdepositary units?\b`,
    String.raw`\bunits?$`,
    String.raw`\bpreferred (?:stock|shares?|securities)\b`,
    String.raw`\bpfd\b`,
    String.raw`\bperp(?:etual)?\b`,
    String.raw`\bnon-?cum\b`,
    String.raw`\bcum(?:ulative)?\s+(?:red\s+)?(?:perp\w*\s+)?pfd\b`,
    String.raw`\bdebentures?\b`,
    String.raw`\bnotes?\s+due\b`,
    String.raw`\b(?:senior|subordinated|junior)\s+notes?\b`,
    String.raw`\btrust preferred\b`,
    String.raw`\bwhen-?issued\b`,
    String.raw`\bdepositary sh\w*\s+repr\b`,
  ].join('|'),
  'i',
);

/**
 * Publicly traded partnerships distribute K-1s rather than 1099s, which is
 * real friction for a personal account regardless of how the units trade.
 *
 * Matched on the legal suffix, not on the word "Partners": a loose match would
 * wrongly exclude 23 ordinary corporations in the current universe, among them
 * Coca-Cola Europacific Partners, Construction Partners and Surgery Partners.
 * Same shape of mistake as "Preferred Bank" — the giveaway is the entity type,
 * not a word in the name.
 */
const PARTNERSHIP = /\bL\.?P\.?$|\bL\.?P\.?[,\s]|\bLimited Partnership\b/i;

export function isPartnership(name: string): boolean {
  return PARTNERSHIP.test(name ?? '');
}

/**
 * A plain ADR of common equity ("Arm Holdings plc American Depositary Shares")
 * is a normal listing and must not be caught by the depositary rule. Only
 * depositary receipts that also carry a preferred marker are excluded, and
 * that combination is already matched by the pfd/non-cum/perp alternatives.
 */
const PLAIN_ADR = /\bamerican depositary (?:shares?|receipts?)\b/i;

export function isPreferredSymbol(symbol: string): boolean {
  return PREFERRED_SYMBOL.test(symbol);
}

export function hasNonCommonName(name: string): boolean {
  if (!name) return false;
  if (PLAIN_ADR.test(name) && !/\bpfd\b|\bpreferred\b|\bnon-?cum\b|\bperp/i.test(name)) return false;
  return NON_COMMON_NAME.test(name);
}

/**
 * Classifies one screener row. Returns null when the row is an acceptable
 * common-stock listing.
 */
export function classify(row: ScreenerRow): ExclusionReason | null {
  if (!row.symbol) return 'missingMetadata';
  if (isPreferredSymbol(row.symbol)) return 'preferredSymbol';
  if (hasNonCommonName(row.companyName ?? '')) return 'namePattern';
  if (isPartnership(row.companyName ?? '')) return 'partnership';
  if (row.industry === 'Shell Companies') return 'shellCompany';
  // The screener is *asked* for isEtf=false&isFund=false; this checks the flags
  // the vendor actually returned on the row, which is not the same promise, and
  // adds the wrappers those flags do not cover (ETNs, SPACs, royalty trusts).
  const type = securityTypeReason(row, CLEAN_EXCLUDE_ADR);
  if (type === 'securityType' || type === 'notActivelyTrading') return type;
  if (row.marketCap == null || row.price == null || !row.exchangeShortName) return 'missingMetadata';
  return null;
}

/**
 * Fetches the screener for each U.S. exchange and applies the static
 * exclusions. Liquidity, price and history gates are applied later, once
 * actual bars are in hand, rather than trusting the screener's own fields.
 */
export async function buildUniverse(client: FmpClient): Promise<UniverseResult> {
  const exclusions: Record<ExclusionReason, number> = {
    preferredSymbol: 0,
    namePattern: 0,
    partnership: 0,
    shellCompany: 0,
    securityType: 0,
    notActivelyTrading: 0,
    missingMetadata: 0,
    duplicateSymbol: 0,
  };
  const excludedSamples: Partial<Record<ExclusionReason, string[]>> = {};
  const note = (reason: ExclusionReason, symbol: string) => {
    exclusions[reason]++;
    const bucket = (excludedSamples[reason] ??= []);
    if (bucket.length < 25) bucket.push(symbol);
  };

  const rows: ScreenerRow[] = [];
  for (const exchange of EXCHANGES) {
    rows.push(...(await client.screener(exchange, MIN_MARKET_CAP, MIN_PRICE)));
  }

  const bySymbol = new Map<string, UniverseMember>();
  for (const row of rows) {
    const reason = classify(row);
    if (reason) {
      note(reason, row.symbol ?? '(no symbol)');
      continue;
    }
    if (bySymbol.has(row.symbol)) {
      note('duplicateSymbol', row.symbol);
      continue;
    }
    bySymbol.set(row.symbol, {
      symbol: row.symbol,
      name: row.companyName ?? row.symbol,
      sector: row.sector ?? '',
      industry: row.industry ?? '',
      exchange: row.exchangeShortName as string,
      marketCap: row.marketCap as number,
      price: row.price as number,
      avgVolume: row.avgVolume ?? null,
      // Carried so a domicile filter is a UI change later rather than a
      // pipeline re-run. Not filtered on: the field cannot identify the thing
      // that would justify it — FMP puts PDD in Ireland and Trip.com in
      // Singapore, so a "China" rule would drop Alibaba and keep PDD.
      country: row.country ?? '',
    });
  }

  // Sorted by symbol so every downstream stage iterates in a fixed order.
  const members = [...bySymbol.values()].sort((a, b) => (a.symbol < b.symbol ? -1 : 1));
  return { members, screenedCount: rows.length, exclusions, excludedSamples };
}
