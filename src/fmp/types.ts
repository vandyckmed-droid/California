/** Shapes returned by the FMP `stable` API endpoints this project uses. */

export interface ScreenerRow {
  symbol: string;
  companyName: string | null;
  marketCap: number | null;
  sector: string | null;
  industry: string | null;
  price: number | null;
  volume: number | null;
  avgVolume: number | null;
  exchange: string | null;
  exchangeShortName: string | null;
  country: string | null;
  isEtf: boolean;
  isFund: boolean;
  isActivelyTrading: boolean;
}

/** One bar from `/historical-price-eod/dividend-adjusted` (split + dividend adjusted). */
export interface AdjustedBar {
  symbol: string;
  date: string;
  adjOpen: number;
  adjHigh: number;
  adjLow: number;
  adjClose: number;
  volume: number;
}

/** A symbol's history, normalized to oldest-first (FMP returns newest-first). */
export interface History {
  symbol: string;
  bars: AdjustedBar[];
}
