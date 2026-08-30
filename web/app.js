/**
 * Phone-first reader for the momentum snapshot.
 *
 * Everything on screen is precomputed by the pipeline: switching horizon,
 * volatility mode or correlation threshold only re-reads the snapshot, so the
 * UI never recomputes a ranking and cannot disagree with the stored one.
 */
import { renderList } from './views/list.js';
import { renderTicker } from './views/ticker.js';

const app = document.getElementById('app');

/** Display state. Kept in the URL hash so the back button behaves. */
export const state = {
  score: 'h12_1',
  mode: 'raw',
  threshold: '0.65',
};

export const SCORE_LABELS = { h12_1: '12–1', h9_1: '9–1', h6_1: '6–1', blend: 'Blend' };
export const HORIZONS = ['h12_1', 'h9_1', 'h6_1'];

let snapshot = null;

export const pct = (x) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(0)}%`;
export const num = (x, dp = 2) => x.toFixed(dp);

/** The figure a given view ranks and displays, for one ranked entry. */
export function displayValue(view, entry) {
  if (view.scoreKey === 'blend') return { text: num(entry.score, 2), sign: entry.score };
  if (view.mode === 'voladj') return { text: num(entry.score, 2), sign: entry.score };
  return { text: pct(entry.score), sign: entry.score };
}

export function viewKey() {
  return `${state.score}|${state.mode}`;
}

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [route, query] = raw.split('?');
  const params = new URLSearchParams(query ?? '');
  for (const key of ['score', 'mode', 'threshold']) {
    const v = params.get(key);
    if (v) state[key] = v;
  }
  return route ?? '';
}

/** Rewrites the hash without pushing history, for control changes. */
export function syncHash(route = '') {
  const params = new URLSearchParams({ score: state.score, mode: state.mode, threshold: state.threshold });
  const next = `#/${route}?${params}`;
  if (location.hash !== next) history.replaceState(null, '', next);
}

/** Navigates to a route, pushing history so Back returns to the list. */
export function navigate(route) {
  const params = new URLSearchParams({ score: state.score, mode: state.mode, threshold: state.threshold });
  location.hash = `/${route}?${params}`;
}

export function rerender() {
  const route = parseHash();
  window.scrollTo(0, 0);
  if (route && route !== '') {
    renderTicker(app, snapshot, decodeURIComponent(route));
  } else {
    renderList(app, snapshot);
  }
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
  parseHash();
  if (!snapshot.views[viewKey()]) {
    state.score = 'h12_1';
    state.mode = 'raw';
  }
  const available = Object.keys(snapshot.views[viewKey()].groups);
  if (!available.includes(state.threshold)) {
    state.threshold = available.includes('0.65') ? '0.65' : available[0];
  }
  window.addEventListener('hashchange', rerender);
  rerender();
}

boot();
