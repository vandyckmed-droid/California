import {
  currentRanks, currentScores, displayValue, getRows, getSnapshot,
  marketCapLabel, navigate, rerender, state, syncHash,
} from '../app.js';
import { applyFilters, SCORE_LABELS } from '../lib/model.js';

/** Rows rendered per batch. The rest arrive as you scroll. */
const PAGE = 120;
let shown = PAGE;

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

const CAP_STEPS = [
  [0, 'Any'],
  [2e9, '$2B+'],
  [1e10, '$10B+'],
  [5e10, '$50B+'],
];

function segmented(options, current, onPick, small = false) {
  const wrap = document.createElement('div');
  wrap.className = small ? 'seg small' : 'seg';
  for (const [value, label] of options) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.setAttribute('aria-pressed', String(value === current));
    b.addEventListener('click', () => {
      if (value === current) return;
      onPick(value);
      shown = PAGE;
      syncHash();
      rerender();
    });
    wrap.append(b);
  }
  return wrap;
}

/**
 * Builds the header as three pieces, only one of which stays pinned.
 *
 * The view selector is the control you reach for constantly, so it sticks. The
 * filters are set once and then forgotten, so they scroll away — pinning all
 * of it cost a third of the screen on a phone, on a screen whose whole job is
 * showing a list.
 */
function headerParts(snapshot, matched, total) {
  const head = document.createElement('header');
  head.className = 'head';
  head.innerHTML = `<h1>Momentum <span class="as-of">${snapshot.meta.asOf}</span></h1>`;

  const viewbar = document.createElement('div');
  viewbar.className = 'viewbar';
  viewbar.append(
    segmented(Object.entries(SCORE_LABELS), state.score, (v) => { state.score = v; }),
  );

  const filters = document.createElement('div');
  filters.className = 'filters';

  const row2 = document.createElement('div');
  row2.className = 'row2';
  row2.append(
    segmented([['raw', 'Raw'], ['voladj', 'Vol-adj']], state.mode, (v) => { state.mode = v; }, true),
  );
  filters.append(row2);
  filters.append(segmented(CAP_STEPS, state.minMarketCap, (v) => { state.minMarketCap = v; }, true));

  // Sector chips: multi-select, empty means all.
  const chips = document.createElement('div');
  chips.className = 'chips';
  for (const sector of snapshot.columns.sectors) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.textContent = sector;
    b.setAttribute('aria-pressed', String(state.sectors.has(sector)));
    b.addEventListener('click', () => {
      if (state.sectors.has(sector)) state.sectors.delete(sector);
      else state.sectors.add(sector);
      shown = PAGE;
      syncHash();
      rerender({ keepScroll: true });
    });
    chips.append(b);
  }
  filters.append(chips);

  const search = document.createElement('input');
  search.className = 'search';
  search.type = 'search';
  search.placeholder = 'Symbol or company';
  search.value = state.search;
  search.addEventListener('input', () => {
    state.search = search.value;
    shown = PAGE;
    syncHash();
    // Keep the caret and the keyboard: re-render without jumping to the top.
    rerender({ keepScroll: true });
    const next = document.querySelector('.search');
    if (next instanceof HTMLInputElement) {
      next.focus();
      next.setSelectionRange(next.value.length, next.value.length);
    }
  });
  filters.append(search);

  const sub = document.createElement('p');
  sub.className = 'sub';
  sub.innerHTML = matched !== total
    ? `<b>${matched.toLocaleString()}</b> of ${total.toLocaleString()} · ranks stay universe-wide`
    : `<b>${total.toLocaleString()}</b> eligible names`;
  filters.append(sub);

  return [head, viewbar, filters];
}

function stockRow(row, rank, score) {
  const a = document.createElement('a');
  a.className = 'stock';
  a.href = '#';
  a.addEventListener('click', (e) => {
    e.preventDefault();
    navigate(row.symbol);
  });
  const { text, sign } = displayValue(score);
  a.innerHTML = `
    <div class="rank">${rank}</div>
    <div class="ident">
      <div class="sym">${row.symbol}</div>
      <div class="nm">${escapeHtml(row.name)}</div>
    </div>
    <div class="val ${sign >= 0 ? 'pos' : 'neg'}">${text}</div>`;
  return a;
}

export function renderList(app) {
  const snapshot = getSnapshot();
  const rows = getRows();
  const ranks = currentRanks();
  const scores = currentScores();
  const matches = applyFilters(rows, ranks, {
    sectors: state.sectors,
    minMarketCap: state.minMarketCap,
    search: state.search,
  });

  app.replaceChildren();
  app.append(...headerParts(snapshot, matches.length, rows.length));

  if (matches.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'loading';
    empty.textContent = 'No names match these filters.';
    app.append(empty);
    return;
  }

  const list = document.createElement('div');
  list.className = 'rows';
  const batch = matches.slice(0, shown);
  for (const row of batch) list.append(stockRow(row, ranks[row.i], scores[row.i]));
  app.append(list);

  if (matches.length > batch.length) {
    // 2,300 rows in the DOM would make scrolling stutter on a phone; the rest
    // arrive as the sentinel comes into view, so nothing is hidden.
    const sentinel = document.createElement('div');
    sentinel.className = 'more';
    sentinel.textContent = `${matches.length - batch.length} more`;
    app.append(sentinel);
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      observer.disconnect();
      shown += PAGE;
      rerender({ keepScroll: true });
    }, { rootMargin: '400px' });
    observer.observe(sentinel);
  }

  const foot = document.createElement('p');
  foot.className = 'foot';
  foot.innerHTML = `Ranked on ${SCORE_LABELS[state.score]}${state.mode === 'voladj' ? ', volatility-adjusted' : ''}
    from ${snapshot.meta.universe.screened.toLocaleString()} screened listings.
    Filtering hides rows; it never renumbers them.<br>
    Data: Financial Modeling Prep · <code>${snapshot.meta.dataHash.slice(0, 16)}</code>`;
  app.append(foot);
}
