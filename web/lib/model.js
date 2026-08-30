/**
 * Reads the snapshot and answers the questions the screens ask of it.
 *
 * Ranking happens here, in the browser, because filter-then-rank is the whole
 * point: eight pre-computed Top-100 lists cannot answer "the best healthcare
 * names" without re-ranking anyway. Sorting ~2,300 rows costs well under a
 * millisecond.
 *
 * What the browser cannot derive, and the pipeline therefore supplies, is the
 * cross-sectional z-scores: winsorized z depends on the full cross-section and
 * must not shift when a filter changes.
 */

export const HORIZONS = ['h12_1', 'h9_1', 'h6_1'];
export const SCORE_KEYS = ['h12_1', 'h9_1', 'h6_1', 'blend'];
const SCORE_LABELS_BASE = { h12_1: '12–1', h9_1: '9–1', h6_1: '6–1', blend: 'Blend' };
export const SCORE_LABELS = SCORE_LABELS_BASE;

/**
 * @typedef {object} Row
 * @property {number} i Index into the snapshot columns.
 * @property {string} symbol
 * @property {string} name
 * @property {string} sector
 * @property {string} exchange
 * @property {number} price
 * @property {number} marketCap In dollars.
 */

/**
 * Expands the columnar snapshot into row objects once, at load.
 * @param {any} snapshot
 * @returns {Row[]}
 */
export function buildRows(snapshot) {
  const c = snapshot.columns;
  return c.symbol.map((/** @type {string} */ symbol, /** @type {number} */ i) => ({
    i,
    symbol,
    name: c.name[i],
    sector: c.sectors[c.sector[i]] ?? '',
    exchange: c.exchanges[c.exchange[i]] ?? '',
    price: c.price[i],
    marketCap: c.marketCapM[i] * 1e6,
  }));
}

/**
 * The figure a view ranks and displays, for every row, in column order.
 *
 * Single horizons rank on the interpretable figure — a return, or a return per
 * unit of volatility. Only the blend ranks on normalized scores, because
 * that is the only place the three horizons have to be commensurable.
 *
 * @param {any} snapshot
 * @param {string} scoreKey
 * @param {string} mode
 * @returns {number[]}
 */
export function scoresFor(snapshot, scoreKey, mode) {
  const c = snapshot.columns;
  const volFloor = snapshot.meta.params.volFloorAnnualized;

  if (scoreKey === 'blend') {
    const key = mode === 'raw' ? 'zr' : 'zv';
    const n = c.symbol.length;
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      let sum = 0;
      for (let h = 0; h < HORIZONS.length; h++) sum += c[key][h][i];
      out[i] = sum / HORIZONS.length;
    }
    return out;
  }

  const h = HORIZONS.indexOf(scoreKey);
  if (mode === 'raw') return c.m[h].slice();
  // Vol-adjusted: the floor means a quiet name gets no extra credit.
  return c.m[h].map((/** @type {number} */ v, /** @type {number} */ i) =>
    v / Math.max(c.rv[h][i], volFloor),
  );
}

/**
 * Universe rank for every row under a view: 1 is best.
 *
 * Computed over the **whole eligible universe**, never over a filtered subset.
 * Filtering hides rows; it must never renumber them, or the number stops
 * meaning "position in the universe" and starts meaning "position in whatever
 * I happen to be looking at".
 *
 * @param {number[]} scores
 * @param {string[]} symbols
 * @returns {number[]} rank per row index
 */
export function ranksFor(scores, symbols) {
  const order = scores.map((_, i) => i);
  const score = (/** @type {number} */ i) => /** @type {number} */ (scores[i]);
  const sym = (/** @type {number} */ i) => /** @type {string} */ (symbols[i]);
  // Descending by score, ties broken on symbol, matching the pipeline exactly.
  order.sort((a, b) => {
    const d = score(b) - score(a);
    if (d !== 0) return d;
    return sym(a) < sym(b) ? -1 : sym(a) > sym(b) ? 1 : 0;
  });
  const ranks = new Array(scores.length);
  order.forEach((rowIndex, position) => {
    ranks[rowIndex] = position + 1;
  });
  return ranks;
}

/**
 * Rows passing the active filters, ordered by rank.
 * @param {Row[]} rows
 * @param {number[]} ranks
 * @param {{sectors: Set<string>, minMarketCap: number, search: string}} filters
 * @returns {Row[]}
 */
export function applyFilters(rows, ranks, filters) {
  const q = filters.search.trim().toUpperCase();
  const out = rows.filter((r) => {
    if (filters.sectors.size > 0 && !filters.sectors.has(r.sector)) return false;
    if (r.marketCap < filters.minMarketCap) return false;
    if (q && !r.symbol.includes(q) && !r.name.toUpperCase().includes(q)) return false;
    return true;
  });
  out.sort((a, b) => /** @type {number} */ (ranks[a.i]) - /** @type {number} */ (ranks[b.i]));
  return out;
}

/**
 * The metrics a row can display, one at a time.
 *
 * The list shows one number, not four — everything is available on the ticker
 * screen, so the list stays scannable. Adding a metric is one entry here.
 *
 * @type {{key: string, label: string, labelFor?: (s: any) => string, get: (s: any, i: number, score: number) => number, fmt: (v: number) => string}[]}
 */
export const METRICS = [
  {
    key: 'score', label: 'Score',
    get: (_s, _i, score) => score,
    fmt: (v) => String(v),
  },
  .../** @type {const} */ (['h12_1', 'h9_1', 'h6_1']).map((h, idx) => ({
    key: /** @type {string} */ (h), label: SCORE_LABELS_BASE[h],
    get: (/** @type {any} */ s, /** @type {number} */ i) => s.columns.m[idx][i],
    fmt: (/** @type {number} */ v) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(0)}%`,
  })),
  {
    key: 'vol', label: 'Volatility',
    /**
     * Trailing realized volatility, right up to the latest session.
     *
     * Deliberately *not* a horizon volatility. Every horizon stops 21 sessions
     * short, because a momentum signal must not be contaminated by the
     * short-term reversal window it excludes — but "how volatile is this name"
     * is the opposite question, and an answer that ends a month ago is stale
     * exactly when it matters. So this reads one column that does not vary
     * with the view: switching between 12-1 and 6-1 changes the ranking, not
     * this number.
     *
     * Reported unfloored. The 17.5% floor exists because the vol-adjusted
     * views divide by it; nothing divides by this, so flooring it would
     * overstate every quiet name for no reason, and a "floor" mark here would
     * point at a mechanism this figure is not part of.
     *
     * The label names the window from the snapshot rather than hardcoding it,
     * so the two cannot drift apart.
     */
    labelFor: (s) => `Volatility (${s.meta.params.trailingVolWindow ?? 126}d)`,
    get: (s, i) => s.columns.rvT[i],
    fmt: (v) => `${(v * 100).toFixed(0)}%`,
  },
  {
    key: 'marketCap', label: 'Market cap',
    get: (s, i) => s.columns.marketCapM[i] * 1e6,
    fmt: (v) => (v >= 1e12 ? `$${(v / 1e12).toFixed(2)}T` : v >= 1e9 ? `$${(v / 1e9).toFixed(1)}B` : `$${(v / 1e6).toFixed(0)}M`),
  },
  {
    key: 'price', label: 'Price',
    get: (s, i) => s.columns.price[i],
    fmt: (v) => `$${v.toFixed(2)}`,
  },
];

export const metricByKey = (/** @type {string} */ key) =>
  METRICS.find((m) => m.key === key) ?? /** @type {typeof METRICS[0]} */ (METRICS[0]);

/**
 * Row indices sharing a universe cluster with any of `selection`, at a given
 * threshold.
 *
 * This is the "moves with something you hold" marker. It is set membership
 * against ids already in the snapshot — no correlation is computed in the
 * browser and no price series is needed, so it resolves before any fetch.
 *
 * @param {any} snapshot
 * @param {Iterable<string>} selection
 * @param {string} threshold
 * @returns {Set<number>}
 */
export function markedRows(snapshot, selection, threshold) {
  const t = snapshot.clusters.thresholds.findIndex(
    (/** @type {number} */ v) => v.toFixed(2) === threshold,
  );
  const marked = new Set();
  if (t < 0) return marked;
  const ids = snapshot.clusters.ids[t];
  const bySymbol = new Map(
    snapshot.columns.symbol.map((/** @type {string} */ s, /** @type {number} */ i) => [s, i]),
  );

  const held = new Set();
  for (const symbol of selection) {
    const i = bySymbol.get(symbol);
    if (i !== undefined && ids[i] >= 0) held.add(ids[i]);
  }
  if (held.size === 0) return marked;
  for (let i = 0; i < ids.length; i++) {
    if (ids[i] >= 0 && held.has(ids[i]) && !bySymbolHas(selection, snapshot.columns.symbol[i])) {
      marked.add(i);
    }
  }
  return marked;
}

/** @param {Iterable<string>} selection @param {string} symbol */
function bySymbolHas(selection, symbol) {
  for (const s of selection) if (s === symbol) return true;
  return false;
}
