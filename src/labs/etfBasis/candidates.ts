/**
 * The candidate ETF library: one entry per economic bet worth testing.
 *
 * Chosen for three properties. Each names an industry, subsector,
 * commodity-linked equity group or coherent theme rather than a factor, a
 * style or a market-cap band — the question is whether *what a company does*
 * compresses, not whether size or value does. Each is a liquid, established
 * U.S. listing with the three years of history the study needs. And the set is
 * deliberately broader than any plausible answer, so the pruning in stage 2
 * has something to prune rather than confirming a list already hand-pruned.
 *
 * **Positive controls.** The library deliberately includes pairs that are
 * near-certainly the same bet in different wrappers — SMH/SOXX, XBI/IBB,
 * ITA/XAR, XHB/ITB, XES/OIH, URA/URNM, GDX/GDXJ, XHE/IHI, RWR/VNQ. These are
 * not an oversight. A redundancy method that fails to merge two semiconductor
 * ETFs is broken, and without a known answer in the data there is no way to
 * tell a working method from a plausible one. They are flagged so the report
 * can say whether each was actually caught.
 */

export interface EtfCandidate {
  symbol: string;
  label: string;
  /** Reporting group. Not used by any statistic — the clustering is unsupervised. */
  group: string;
  /**
   * The symbol this is expected to be redundant with, if any. A stated
   * prediction the pruning is scored against, not an input to it.
   */
  control?: string;
}

export const MARKET_PROXY = 'SPY';

/**
 * Controls carried through the fetch but never eligible for the basis.
 *
 * SPY is the market factor every return is residualized against. IWM and RSP
 * exist to answer one question the study would otherwise beg: whether an
 * apparent "industry" cluster is really just small-cap or equal-weight beta
 * wearing an industry label.
 */
export const CONTROLS: readonly EtfCandidate[] = [
  { symbol: 'SPY', label: 'U.S. large-cap market', group: 'control' },
  { symbol: 'IWM', label: 'U.S. small-cap', group: 'control' },
  { symbol: 'RSP', label: 'S&P 500 equal weight', group: 'control' },
];

export const CANDIDATES: readonly EtfCandidate[] = [
  // ---- Technology and communications ------------------------------------
  { symbol: 'SMH', label: 'Semiconductors', group: 'tech' },
  { symbol: 'SOXX', label: 'Semiconductors (alt wrapper)', group: 'tech', control: 'SMH' },
  { symbol: 'XSD', label: 'Semiconductors, equal weight', group: 'tech' },
  { symbol: 'IGV', label: 'Software', group: 'tech' },
  { symbol: 'XSW', label: 'Software & services, equal weight', group: 'tech' },
  { symbol: 'SKYY', label: 'Cloud computing', group: 'tech' },
  { symbol: 'WCLD', label: 'Cloud, small/mid', group: 'tech' },
  { symbol: 'CIBR', label: 'Cybersecurity', group: 'tech' },
  { symbol: 'HACK', label: 'Cybersecurity (alt wrapper)', group: 'tech', control: 'CIBR' },
  { symbol: 'FINX', label: 'Fintech', group: 'tech' },
  { symbol: 'BOTZ', label: 'Robotics & AI', group: 'tech' },
  { symbol: 'XTL', label: 'Telecom', group: 'tech' },
  { symbol: 'ESPO', label: 'Video gaming & esports', group: 'tech' },
  { symbol: 'IPAY', label: 'Payments', group: 'tech' },

  // ---- Financials --------------------------------------------------------
  { symbol: 'KRE', label: 'Regional banks', group: 'fin' },
  { symbol: 'KBE', label: 'Banks, broad', group: 'fin' },
  { symbol: 'KCE', label: 'Capital markets', group: 'fin' },
  { symbol: 'IAI', label: 'Broker-dealers & exchanges', group: 'fin' },
  { symbol: 'KIE', label: 'Insurance', group: 'fin' },
  { symbol: 'IAK', label: 'Insurance (alt wrapper)', group: 'fin', control: 'KIE' },

  // ---- Health care -------------------------------------------------------
  { symbol: 'XBI', label: 'Biotech, equal weight', group: 'health' },
  { symbol: 'IBB', label: 'Biotech, cap weighted', group: 'health', control: 'XBI' },
  { symbol: 'XPH', label: 'Pharmaceuticals', group: 'health' },
  { symbol: 'PPH', label: 'Pharmaceuticals (alt wrapper)', group: 'health', control: 'XPH' },
  { symbol: 'IHI', label: 'Medical devices', group: 'health' },
  { symbol: 'XHE', label: 'Health care equipment', group: 'health', control: 'IHI' },
  { symbol: 'XHS', label: 'Health care services', group: 'health' },
  { symbol: 'IHF', label: 'Health care providers', group: 'health' },

  // ---- Industry ----------------------------------------------------------
  { symbol: 'ITA', label: 'Aerospace & defence', group: 'industry' },
  { symbol: 'XAR', label: 'Aerospace & defence, equal weight', group: 'industry', control: 'ITA' },
  { symbol: 'IYT', label: 'Transportation', group: 'industry' },
  { symbol: 'XTN', label: 'Transportation, equal weight', group: 'industry', control: 'IYT' },
  { symbol: 'JETS', label: 'Airlines', group: 'industry' },
  { symbol: 'PAVE', label: 'Infrastructure development', group: 'industry' },
  { symbol: 'XHB', label: 'Homebuilders & supply', group: 'industry' },
  { symbol: 'ITB', label: 'Home construction', group: 'industry', control: 'XHB' },
  { symbol: 'PKB', label: 'Building & construction', group: 'industry' },

  // ---- Consumer ----------------------------------------------------------
  { symbol: 'XRT', label: 'Retail', group: 'consumer' },
  { symbol: 'PEJ', label: 'Leisure & entertainment', group: 'consumer' },
  { symbol: 'PBJ', label: 'Food & beverage', group: 'consumer' },
  { symbol: 'BJK', label: 'Gaming & casinos', group: 'consumer' },
  { symbol: 'IEDI', label: 'Consumer staples distribution', group: 'consumer' },

  // ---- Energy and power --------------------------------------------------
  { symbol: 'XOP', label: 'Oil & gas E&P', group: 'energy' },
  { symbol: 'XES', label: 'Oil services & equipment', group: 'energy' },
  { symbol: 'OIH', label: 'Oil services (alt wrapper)', group: 'energy', control: 'XES' },
  { symbol: 'AMLP', label: 'Midstream MLPs', group: 'energy' },
  { symbol: 'TAN', label: 'Solar', group: 'energy' },
  { symbol: 'ICLN', label: 'Clean energy, global', group: 'energy' },
  { symbol: 'FAN', label: 'Wind', group: 'energy' },
  { symbol: 'URA', label: 'Uranium', group: 'energy' },
  { symbol: 'URNM', label: 'Uranium miners (alt wrapper)', group: 'energy', control: 'URA' },
  { symbol: 'NLR', label: 'Nuclear energy', group: 'energy' },
  { symbol: 'XLU', label: 'Utilities', group: 'energy' },

  // ---- Metals, mining and agriculture ------------------------------------
  { symbol: 'GDX', label: 'Gold miners', group: 'metals' },
  { symbol: 'GDXJ', label: 'Junior gold miners', group: 'metals', control: 'GDX' },
  { symbol: 'SIL', label: 'Silver miners', group: 'metals' },
  { symbol: 'COPX', label: 'Copper miners', group: 'metals' },
  { symbol: 'LIT', label: 'Lithium & battery', group: 'metals' },
  { symbol: 'REMX', label: 'Rare earth & strategic metals', group: 'metals' },
  { symbol: 'XME', label: 'Metals & mining, broad', group: 'metals' },
  { symbol: 'SLX', label: 'Steel', group: 'metals' },
  { symbol: 'MOO', label: 'Agribusiness', group: 'metals' },
  { symbol: 'WOOD', label: 'Timber & forestry', group: 'metals' },
  { symbol: 'LIN.PLACEHOLDER', label: 'unused', group: 'unused' },

  // ---- Real estate -------------------------------------------------------
  { symbol: 'RWR', label: 'REITs, broad', group: 'realestate' },
  { symbol: 'VNQ', label: 'REITs (alt wrapper)', group: 'realestate', control: 'RWR' },
  { symbol: 'REZ', label: 'Residential REITs', group: 'realestate' },
  { symbol: 'INDS', label: 'Industrial REITs', group: 'realestate' },
  { symbol: 'SRVR', label: 'Data centre & infrastructure REITs', group: 'realestate' },

  // ---- Other coherent themes --------------------------------------------
  { symbol: 'IPO', label: 'Recent IPOs', group: 'theme' },
  { symbol: 'PBW', label: 'Clean energy, small cap', group: 'theme' },
  { symbol: 'ARKG', label: 'Genomics', group: 'theme' },
  { symbol: 'MJ', label: 'Cannabis', group: 'theme' },
  { symbol: 'BLOK', label: 'Blockchain', group: 'theme' },
  { symbol: 'SEA', label: 'Shipping', group: 'theme' },
  { symbol: 'COWZ', label: 'Cash-cow industrials', group: 'theme' },
].filter((c) => c.group !== 'unused');

export const CANDIDATE_SYMBOLS = CANDIDATES.map((c) => c.symbol);
export const CONTROL_SYMBOLS = CONTROLS.map((c) => c.symbol);
export const ALL_SYMBOLS = [...CONTROL_SYMBOLS, ...CANDIDATE_SYMBOLS];

/** The stated redundancy predictions, as pairs, for scoring the pruning. */
export const CONTROL_PAIRS: readonly [string, string][] = CANDIDATES
  .filter((c) => c.control)
  .map((c) => [c.symbol, c.control as string]);
