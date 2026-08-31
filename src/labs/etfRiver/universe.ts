/**
 * The ETF universe: a deliberately small set of industry and theme funds, each
 * standing for a different economic bet rather than a different wrapper on the
 * same one.
 *
 * Families exist for one reason: with twenty-odd trails on one chart, a colour
 * per fund is a rainbow and a single colour hides the thing the screen is for.
 * Colouring by family means the drawing answers "which part of the economy is
 * taking the lead" at a glance, and the fund is read from its label at the
 * right edge.
 */

export const FAMILY_KEYS = ['tech', 'fin', 'health', 'industry', 'energy', 'metals'] as const;
export type FamilyKey = (typeof FAMILY_KEYS)[number];

export const FAMILIES: Record<FamilyKey, string> = {
  tech: 'Technology',
  fin: 'Financials & real estate',
  health: 'Health care',
  industry: 'Industry & consumer',
  energy: 'Energy & power',
  metals: 'Metals & agriculture',
};

export interface EtfMember {
  symbol: string;
  /** What the fund is a bet on, not its legal name. */
  label: string;
  family: FamilyKey;
}

/**
 * Ordered by family, then by symbol inside it, so the legend, the leaderboard
 * and the column order all agree and none of them depends on today's scores.
 */
export const ETF_UNIVERSE: readonly EtfMember[] = [
  { symbol: 'XSD', label: 'Semiconductors', family: 'tech' },
  { symbol: 'XSW', label: 'Software & services', family: 'tech' },
  { symbol: 'XTL', label: 'Telecom', family: 'tech' },

  { symbol: 'KCE', label: 'Capital markets', family: 'fin' },
  { symbol: 'KIE', label: 'Insurance', family: 'fin' },
  { symbol: 'KRE', label: 'Regional banks', family: 'fin' },
  { symbol: 'RWR', label: 'REITs', family: 'fin' },

  { symbol: 'XBI', label: 'Biotech', family: 'health' },
  { symbol: 'XHE', label: 'Health care equipment', family: 'health' },
  { symbol: 'XHS', label: 'Health care services', family: 'health' },

  { symbol: 'XAR', label: 'Aerospace & defence', family: 'industry' },
  { symbol: 'XHB', label: 'Homebuilders', family: 'industry' },
  { symbol: 'XRT', label: 'Retail', family: 'industry' },
  { symbol: 'XTN', label: 'Transportation', family: 'industry' },

  { symbol: 'TAN', label: 'Solar', family: 'energy' },
  { symbol: 'URA', label: 'Uranium', family: 'energy' },
  { symbol: 'XES', label: 'Oil services & equipment', family: 'energy' },
  { symbol: 'XOP', label: 'Oil & gas E&P', family: 'energy' },

  { symbol: 'COPX', label: 'Copper miners', family: 'metals' },
  { symbol: 'GDX', label: 'Gold miners', family: 'metals' },
  { symbol: 'LIT', label: 'Lithium & battery', family: 'metals' },
  { symbol: 'MOO', label: 'Agribusiness', family: 'metals' },
];

/**
 * Removed from the starting list after measuring it, and why.
 *
 * Kept in the source rather than only in a commit message: the next person to
 * look at this universe needs to know the removal was measured, and on what,
 * or they will simply add it back.
 */
export const REMOVED: readonly { symbol: string; label: string; because: string }[] = [
  {
    symbol: 'XPH',
    label: 'Pharmaceuticals',
    because:
      'Redundant with XBI on both axes over the fetched history: daily-return correlation 0.80 ' +
      '(0.82 over the drawn year, the highest pair in the universe) and a blended-score path ' +
      'that tracks XBI at correlation 0.90 with a root-mean-square gap of 0.39z against a ' +
      'universe median of 1.20z — two lines that would sit on top of each other all year. ' +
      'XBI is kept as the more distinct bet: equal-weighted biotech is the risk-appetite ' +
      'expression, while XPH overlaps it and adds no separate leadership story.',
  },
];

export const SYMBOLS: readonly string[] = ETF_UNIVERSE.map((m) => m.symbol);
