/**
 * Phone-first reader for the momentum snapshot.
 *
 * Everything on the home screen comes from one file with no prices in it, so
 * the ranked list is interactive immediately. Price series are fetched per
 * symbol, only when a chart or the watchlist actually needs one.
 */
import { buildRows, METRICS, ranksFor, scoresFor } from './lib/model.js';
import { watchForUpdates } from './lib/refresh.js';
import { renderList } from './views/list.js';
import { renderTicker } from './views/ticker.js';
import { renderWatchlist } from './views/watchlist.js';

const app = /** @type {HTMLElement} */ (document.getElementById('app'));

/** Display state, mirrored into the URL hash so the back button behaves. */
export const state = {
  score: 'h12_1',
  mode: 'raw',
  threshold: '0.65',
  sectors: /** @type {Set<string>} */ (new Set()),
  minMarketCap: 0,
  search: '',
  /** Which number each row shows. One at a time, not all of them. */
  metric: 'score',
  /** Weighting assumption on the watchlist. A description, not a proposal. */
  weighting: 'equal',
};

/**
 * The watchlist: a plain set of symbols that persists on this device.
 *
 * Checking a box *is* saving. There is no separate save step, because a second
 * concept (ad-hoc selection vs a saved list) would double the mental model for
 * a tool whose requirement is "a list I can check and clear".
 */
const WATCHLIST_KEY = 'california.watchlist.v1';

/** @type {Set<string>} */
export const watchlist = new Set(readWatchlist());

function readWatchlist() {
  try {
    const raw = localStorage.getItem(WATCHLIST_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((s) => typeof s === 'string') : [];
  } catch {
    // Private mode, cleared storage, a browser blocking site data: start empty
    // rather than failing to render.
    return [];
  }
}

function persistWatchlist() {
  try {
    localStorage.setItem(WATCHLIST_KEY, JSON.stringify([...watchlist]));
  } catch {
    // Nothing to do; the list still works for this session.
  }
}

/** @param {string} symbol */
export function toggleWatch(symbol) {
  if (watchlist.has(symbol)) watchlist.delete(symbol);
  else watchlist.add(symbol);
  persistWatchlist();
}

export function clearWatchlist() {
  watchlist.clear();
  persistWatchlist();
}

/** Selections the current snapshot no longer contains, dropped at boot. */
let dropped = /** @type {string[]} */ ([]);
export const droppedSelections = () => dropped;

/**
 * Repairs the saved list against the snapshot.
 *
 * The list persists indefinitely but the universe is rebuilt every weekday,
 * and names leave it routinely — below the cap, below the liquidity gate,
 * delisted, acquired. A symbol that outlived its row has no index, so every
 * lookup keyed on it yields `undefined` and the failure surfaces as garbage
 * rows rather than as an error. Dropping them here means the state repairs
 * itself once instead of failing again on every open.
 *
 * @param {Iterable<string>} known
 */
function pruneWatchlist(known) {
  const set = known instanceof Set ? known : new Set(known);
  dropped = [...watchlist].filter((s) => !set.has(s));
  if (dropped.length === 0) return;
  for (const s of dropped) watchlist.delete(s);
  persistWatchlist();
}

/** @type {any} */
let snapshot = null;
/** @type {ReturnType<typeof buildRows>} */
let rows = [];
/** Ranks are per view, so they are memoized rather than recomputed per render. */
const rankCache = new Map();

export const getSnapshot = () => snapshot;
export const getRows = () => rows;

export function viewKey() {
  return `${state.score}|${state.mode}`;
}

/** Universe ranks for the active view. */
export function currentRanks() {
  const key = viewKey();
  let ranks = rankCache.get(key);
  if (!ranks) {
    ranks = ranksFor(scoresFor(snapshot, state.score, state.mode), snapshot.columns.symbol);
    rankCache.set(key, ranks);
  }
  return ranks;
}

export const currentScores = () => scoresFor(snapshot, state.score, state.mode);

export const pct = (/** @type {number} */ x) =>
  `${x >= 0 ? '+' : ''}${(x * 100).toFixed(0)}%`;
export const num = (/** @type {number} */ x, dp = 2) => x.toFixed(dp);

/** The figure the active view displays for a row. */
export function displayValue(score) {
  if (state.score === 'blend' || state.mode === 'voladj') return { text: num(score, 2), sign: score };
  return { text: pct(score), sign: score };
}

/**
 * Per-symbol price data, fetched on demand and cached for the session.
 *
 * The unit of fetch is the unit of use: opening one chart costs that one
 * name's ~640 bytes, not a bundle of every other name's prices. Nothing is
 * warmed in the background because there is nothing to warm.
 *
 * @type {Map<string, Promise<any>>}
 */
const seriesCache = new Map();

/** @param {string} symbol */
export function loadSeries(symbol) {
  let pending = seriesCache.get(symbol);
  if (!pending) {
    // Revalidated like the snapshot is. Left to the default the browser can
    // hold a stale series for a name the fresh snapshot has already dropped —
    // the fetch then succeeds and the bad row looks valid all the way down.
    pending = fetch(`data/series/${encodeURIComponent(symbol)}.json`, { cache: 'no-cache' }).then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    });
    // A failed fetch must not be cached, or the name is broken for the session.
    pending.catch(() => seriesCache.delete(symbol));
    seriesCache.set(symbol, pending);
  }
  return pending;
}

/** Test hook: how many distinct symbols have been requested. */
export const seriesRequests = () => seriesCache.size;

export function marketCapLabel(v) {
  return v >= 1e12 ? `$${(v / 1e12).toFixed(2)}T` : v >= 1e9 ? `$${(v / 1e9).toFixed(1)}B` : `$${(v / 1e6).toFixed(0)}M`;
}

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [route, query] = raw.split('?');
  const params = new URLSearchParams(query ?? '');
  for (const key of ['score', 'mode', 'threshold', 'search', 'metric', 'weighting']) {
    const v = params.get(key);
    if (v !== null) state[key] = v;
  }
  const sectors = params.get('sectors');
  if (sectors !== null) state.sectors = new Set(sectors ? sectors.split(',') : []);
  const cap = params.get('cap');
  if (cap !== null) state.minMarketCap = Number(cap) || 0;
  return route ?? '';
}

/**
 * Clamps state to what the snapshot actually contains.
 *
 * Runs on every render, not once at boot: rerender re-reads the hash, so a
 * correction applied only at startup is overwritten before anything renders,
 * and a stale bookmark would show an empty screen or hang on the loader.
 */
function clampState() {
  if (!['h12_1', 'h9_1', 'h6_1', 'blend'].includes(state.score)) state.score = 'h12_1';
  if (!['raw', 'voladj'].includes(state.mode)) state.mode = 'raw';
  const thresholds = snapshot.clusters.thresholds.map((/** @type {number} */ t) => t.toFixed(2));
  if (!thresholds.includes(state.threshold)) {
    state.threshold = thresholds.includes('0.65') ? '0.65' : thresholds[0];
  }
  if (!METRICS.some((m) => m.key === state.metric)) state.metric = 'score';
  if (!['equal', 'invvol'].includes(state.weighting)) state.weighting = 'equal';
  const known = new Set(snapshot.columns.sectors);
  state.sectors = new Set([...state.sectors].filter((s) => known.has(s)));
  if (!Number.isFinite(state.minMarketCap) || state.minMarketCap < 0) state.minMarketCap = 0;
}

function queryString() {
  const params = new URLSearchParams({ score: state.score, mode: state.mode, threshold: state.threshold });
  if (state.metric !== 'score') params.set('metric', state.metric);
  if (state.weighting !== 'equal') params.set('weighting', state.weighting);
  if (state.sectors.size > 0) params.set('sectors', [...state.sectors].join(','));
  if (state.minMarketCap > 0) params.set('cap', String(state.minMarketCap));
  if (state.search) params.set('search', state.search);
  return params.toString();
}

/** Rewrites the hash without pushing history, for control changes. */
export function syncHash(route = '') {
  const next = `#/${route}?${queryString()}`;
  // Carries the existing state forward: dropping it here would erase the depth
  // stamp below on every control change, and Back would stop popping.
  if (location.hash !== next) history.replaceState(history.state, '', next);
}

/**
 * Navigates, pushing history so Back returns to the list, and stamps how deep
 * into the app this entry is.
 *
 * The depth is what lets an in-app Back link *pop* rather than push. Pushing a
 * second entry to go "back" leaves the device's own back gesture returning
 * into the screen you just left, which on a phone is the button people
 * actually use.
 */
export function navigate(route) {
  const depth = (history.state?.depth ?? 0) + 1;
  location.hash = `/${route}?${queryString()}`;
  history.replaceState({ depth }, '');
}

/**
 * The in-app Back link: pop when there is somewhere to pop to, navigate when
 * there is not — a shared link or a bookmark opens straight onto a screen with
 * no history behind it.
 */
export function goBack() {
  if ((history.state?.depth ?? 0) > 0) history.back();
  else navigate('');
}

export function rerender({ keepScroll = false } = {}) {
  const route = parseHash();
  clampState();
  const y = window.scrollY;
  const restore = () => window.scrollTo(0, keepScroll ? y : 0);

  // The watchlist and the ticker paint a placeholder synchronously and their
  // real content a fetch later. Restoring only on the synchronous return
  // scrolls a one-line document, which clamps to 0 — so `keepScroll` silently
  // did nothing on exactly the screen where you are most likely to be
  // mid-scroll. Restore again once the content is in the DOM.
  let painted;
  if (route === 'watchlist') painted = renderWatchlist(app);
  // Labs is one branch and one dynamic import, so core knows a single name and
  // downloads none of the experiment unless someone asks for it. Everything
  // under `labs/` is the experiment's own business.
  else if (route === 'labs' || route.startsWith('labs/')) {
    painted = import('./views/labs/index.js').then((m) => m.renderLabs(app, route.slice(5)));
  }
  else if (route && route !== '') painted = renderTicker(app, snapshot, decodeURIComponent(route));
  else painted = renderList(app);
  restore();
  if (painted && typeof painted.then === 'function') painted.then(restore, restore);
}

async function boot() {
  try {
    const res = await fetch('data/snapshot.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    snapshot = await res.json();
  } catch (err) {
    app.innerHTML = `<p class="loading">Could not load the snapshot (${String(err)}).<br>
      Run <code>npm run screen</code> to generate <code>web/data/snapshot.json</code>.</p>`;
    return;
  }
  rows = buildRows(snapshot);
  pruneWatchlist(snapshot.columns.symbol);
  // Not awaited: the screen renders now, and the version check settles behind
  // it. See lib/refresh.js for why a home-screen page needs one at all.
  watchForUpdates();
  window.addEventListener('hashchange', () => rerender());
  rerender();
}

boot();
