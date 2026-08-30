import {
  clearWatchlist, currentRanks, currentScores, displayValue, getRows, getSnapshot,
  navigate, rerender, state, syncHash, toggleWatch, watchlist,
} from '../app.js';
import { applyFilters, markedRows, METRICS, metricByKey, SCORE_LABELS } from '../lib/model.js';

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

  // One number per row, chosen here. Everything else lives on the ticker
  // screen, so the list stays scannable.
  const showRow = document.createElement('label');
  showRow.className = 'showrow';
  const select = document.createElement('select');
  select.className = 'metric';
  for (const m of METRICS) {
    const opt = document.createElement('option');
    opt.value = m.key;
    opt.textContent = m.label;
    opt.selected = m.key === state.metric;
    select.append(opt);
  }
  select.addEventListener('change', () => {
    state.metric = select.value;
    syncHash();
    rerender({ keepScroll: true });
  });
  showRow.append(Object.assign(document.createElement('span'), { textContent: 'Show' }), select);
  filters.append(showRow);

  const sub = document.createElement('p');
  sub.className = 'sub';
  sub.innerHTML = matched !== total
    ? `<b>${matched.toLocaleString()}</b> of ${total.toLocaleString()} · ranks stay universe-wide`
    : `<b>${total.toLocaleString()}</b> eligible names`;
  filters.append(sub);

  return [head, viewbar, filters];
}

function stockRow(snapshot, row, rank, score, marked) {
  const selected = watchlist.has(row.symbol);
  const wrap = document.createElement('div');
  wrap.className = `stock${selected ? ' on' : ''}`;

  const metric = metricByKey(state.metric);
  const raw = metric.get(snapshot, row.i, score);
  const text = metric.key === 'score' ? displayValue(score).text : metric.fmt(raw);
  const tone = metric.key === 'score' || metric.key.startsWith('h')
    ? (raw >= 0 ? ' pos' : ' neg') : '';
  const floored = metric.floored?.(snapshot, row.i) ? '<span class="floor-mark">floor</span>' : '';

  const open = document.createElement('a');
  open.className = 'open';
  open.href = '#';
  open.addEventListener('click', (e) => { e.preventDefault(); navigate(row.symbol); });
  open.innerHTML = `
    <div class="rank">${rank}</div>
    <div class="ident">
      <div class="sym">${escapeHtml(row.symbol)}${marked ? '<span class="dot" title="Moves with something on your list"></span>' : ''}</div>
      <div class="nm">${escapeHtml(row.name)}</div>
    </div>
    <div class="val${tone}">${text}${floored}</div>`;

  // Its own target, so tapping the row still opens the chart.
  const check = document.createElement('button');
  check.type = 'button';
  check.className = 'check';
  check.setAttribute('aria-pressed', String(selected));
  check.setAttribute('aria-label', `${selected ? 'Remove' : 'Add'} ${row.symbol}`);
  check.addEventListener('click', () => {
    toggleWatch(row.symbol);
    rerender({ keepScroll: true });
  });

  wrap.append(open, check);
  return wrap;
}

/** Fixed bar, only present once something is selected. */
function actionBar() {
  const bar = document.createElement('div');
  bar.className = 'actionbar';

  const count = document.createElement('span');
  count.className = 'count';
  count.textContent = `${watchlist.size} selected`;

  const clear = document.createElement('button');
  clear.type = 'button';
  clear.className = 'linkish';
  clear.textContent = 'Clear';
  clear.addEventListener('click', () => { clearWatchlist(); rerender({ keepScroll: true }); });

  const go = document.createElement('button');
  go.type = 'button';
  go.className = 'primary';
  go.textContent = `Watchlist (${watchlist.size}) →`;
  go.addEventListener('click', () => navigate('watchlist'));

  bar.append(count, clear, go);
  return bar;
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
  // "Moves with something you hold": set membership against precomputed
  // cluster ids, so it needs no correlation in the browser and no prices.
  const marked = markedRows(snapshot, watchlist, state.threshold);
  for (const row of batch) {
    list.append(stockRow(snapshot, row, ranks[row.i], scores[row.i], marked.has(row.i)));
  }
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

  if (watchlist.size > 0) {
    app.append(actionBar());
    document.body.classList.add('has-bar');
  } else {
    document.body.classList.remove('has-bar');
  }
}
