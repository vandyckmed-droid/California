import { describe, expect, it } from 'vitest';
import { classify, hasNonCommonName, isPreferredSymbol } from '../src/pipeline/universe.ts';
import type { ScreenerRow } from '../src/fmp/types.ts';

function row(symbol: string, companyName: string, extra: Partial<ScreenerRow> = {}): ScreenerRow {
  return {
    symbol,
    companyName,
    marketCap: 5e9,
    sector: 'Technology',
    industry: 'Software',
    price: 50,
    volume: 1e6,
    avgVolume: 1e6,
    exchange: 'NASDAQ Global Select',
    exchangeShortName: 'NASDAQ',
    country: 'US',
    isEtf: false,
    isFund: false,
    isActivelyTrading: true,
    ...extra,
  };
}

/** Real listings observed in the live FMP screener that must survive. */
const KEEP: Array<[string, string]> = [
  ['AAPL', 'Apple Inc.'],
  ['PFBC', 'Preferred Bank'],
  ['PTRN', 'Pattern Group Inc. Series A Common Stock'],
  ['BRK-A', 'Berkshire Hathaway Inc.'],
  ['BRK-B', 'Berkshire Hathaway Inc.'],
  ['BF-B', 'Brown-Forman Corporation'],
  ['MOG-A', 'Moog Inc.'],
  ['MKC-V', 'McCormick & Company, Incorporated'],
  ['PBR-A', 'Petroleo Brasileiro S.A. - Petrobras'],
  ['ARM', 'Arm Holdings plc American Depositary Shares'],
  ['PONY', 'Pony AI Inc. American Depositary Shares'],
  ['UNIT', 'Uniti Group Inc.'],
  ['BTSG', 'BrightSpring Health Services, Inc. Common Stock'],
  ['PPTA', 'Perpetua Resources Corp.'],
  ['UAL', 'United Airlines Holdings, Inc.'],
  ['NESR', 'National Energy Services Reunited Corp.'],
];

/** Real listings observed in the live FMP screener that must be excluded. */
const DROP: Array<[string, string, string]> = [
  ['MER-PK', 'Merrill Lynch Preferred Capital Trust III', 'preferredSymbol'],
  ['EP-PC', 'El Paso Energy Capital Trust I PFD CV TR SECS', 'preferredSymbol'],
  ['FITB-PM', 'Fifth Third Bancorp', 'preferredSymbol'],
  ['OAK-PA', 'Brookfield Oaktree Holdings, LLC 6.625 % Non-Cum Red Perp Pfd Units Series A', 'preferredSymbol'],
  ['STRF', 'MicroStrategy Incorporated 10.00% Series A Perpetual Strife Preferred Stock', 'namePattern'],
  ['SATA', 'Strive Inc. Perp. Pfd. Series A', 'namePattern'],
  ['FCNCN', 'First Citizens BancShares Inc. Depositary Shs Repr 1/40th Non-Cum Perp Pfd Registered Shs Ser E', 'namePattern'],
  ['LILAP', 'Liberty Latin America Ltd. 9% Cum Perp Red Pfd Shs Series A When-issued', 'namePattern'],
  ['CCXIW', 'Churchill Capital Corp XI Warrants', 'namePattern'],
  ['NOVTU', 'Novanta Inc. Tangible Equity Units', 'namePattern'],
  ['OXLCG', 'Oxford Lane Capital Corp. 7.95% Notes due 2032', 'namePattern'],
  ['CGABL', 'The Carlyle Group Inc. 4.625% Subordinated Notes due 2061', 'namePattern'],
  ['MLCIL', 'Mount Logan Capital Inc. 8.00% Notes Due 2031', 'namePattern'],
  ['PFH', 'Prudential Financial, Inc. 4.125% Junior Subordinated Notes due 2060', 'namePattern'],
  ['DTW', 'DTE Energy Company 5.25 % Debentures 2017-01.12.77 Global', 'namePattern'],
  ['CMSD', 'CMS Energy Corporation 5.875% Junior Subordinated Notes due 2079', 'namePattern'],
  ['UZF', 'Array Digital Infrastructure, Inc. 5.500% Senior Notes due 2070', 'namePattern'],
  ['ABXL', 'Abacus Global Management, Inc. - 9.875% Fixed Rate Senior Notes due 2028', 'namePattern'],
  ['SFB', 'Stifel Financial Corporation 5.20% Senior Notes due 2047', 'namePattern'],
  ['SCCD', 'Sachem Capital Corp. 6.00% Notes Due 2026', 'namePattern'],
];

describe('security-type exclusions', () => {
  it.each(KEEP)('keeps %s (%s)', (symbol, name) => {
    expect(classify(row(symbol, name))).toBeNull();
  });

  it.each(DROP)('drops %s (%s) as %s', (symbol, name, reason) => {
    expect(classify(row(symbol, name))).toBe(reason);
  });

  it('drops SPACs by industry, not by name guesswork', () => {
    expect(classify(row('SPAC', 'Some Acquisition Corp.', { industry: 'Shell Companies' }))).toBe(
      'shellCompany',
    );
    expect(classify(row('NESR', 'National Energy Services Reunited Corp.'))).toBeNull();
  });

  it('treats -P<letter> as preferred but plain share-class suffixes as common', () => {
    expect(isPreferredSymbol('OAK-PA')).toBe(true);
    expect(isPreferredSymbol('CTA-PB')).toBe(true);
    expect(isPreferredSymbol('BRK-B')).toBe(false);
    expect(isPreferredSymbol('PBR-A')).toBe(false);
    expect(isPreferredSymbol('MOG-A')).toBe(false);
  });

  it('keeps plain ADRs but drops preferred depositary receipts', () => {
    expect(hasNonCommonName('Arm Holdings plc American Depositary Shares')).toBe(false);
    expect(
      hasNonCommonName('First Citizens BancShares Inc. Depositary Shs Repr 1/40th Non-Cum Perp Pfd'),
    ).toBe(true);
  });

  it('requires metadata needed downstream', () => {
    expect(classify(row('X', 'X Corp', { marketCap: null }))).toBe('missingMetadata');
    expect(classify(row('X', 'X Corp', { exchangeShortName: null }))).toBe('missingMetadata');
  });
});
