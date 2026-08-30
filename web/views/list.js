import {
  clearWatchlist, currentRanks, currentScores, displayValue, getRows, getSnapshot,
  navigate, rerender, state, syncHash, toggleWatch, watchlist,
} from '../app.js';
import {
  applyFilters, horizonIndexFor, markedRows, METRICS, metricByKey, SCORE_LABELS,
} from '../lib/model.js';

/** Rows rendered per batch. The rest arrive as you scroll. */
const PAGE = 120;
let shown = PAGE;

/**
 * The search box, kept alive across re-renders.
 *
 * Everything else on this screen is cheap to rebuild; a focused text input is
 * not, because rebuilding it destroys the caret position and any in-flight IME
 * composition along with it.
 *
 * @type {HTMLInputElement | null}
 */
let searchInput = null;

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
      b.setAttribute('aria-pressed', String(state.sectors.has(sector)));
      shown = PAGE;
      syncHash();
      refreshRows();
    });
    chips.append(b);
  }
  filters.append(chips);

  // Reused across re-renders rather than rebuilt.
  //
  // Rebuilding it per keystroke and then reconstructing focus by hand forced
  // the caret to the end of the value, so fixing a typo mid-string threw the
  // caret to the end after one character; it also dropped any pending IME
  // composition, which makes the box unusable for a language that composes
  // characters — and company-name search is the reason this box exists. The
  // element's value is already the source of truth, so it never needed
  // rebuilding to stay correct.
  const search = searchInput ?? document.createElement('input');
  if (!searchInput) {
    search.className = 'search';
    search.type = 'search';
    search.placeholder = 'Symbol or company';
    search.value = state.search;
    search.addEventListener('input', () => {
      state.search = search.value;
      shown = PAGE;
      syncHash();
      // Rows only. A full re-render calls `replaceChildren`, which detaches
      // this input and so blurs it — the caret and any pending IME composition
      // go with it, and reconstructing them by hand is what put the caret at
      // the end. Leaving the header untouched means nothing to reconstruct.
      refreshRows();
    });
    searchInput = search;
  } else if (document.activeElement !== search) {
    // Only write into it when it is not being typed in: assigning `value` to a
    // focused input collapses the selection.
    search.value = state.search;
  }
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
    // A per-horizon metric names its horizon, so the number on the row is
    // always attributable to a window rather than to "volatility" in general.
    opt.textContent = m.labelFor?.(state.score) ?? m.label;
    opt.selected = m.key === state.metric;
    select.append(opt);
  }
  select.addEventListener('change', () => {
    state.metric = select.value;
    syncHash();
    refreshRows();
  });
  showRow.append(Object.assign(document.createElement('span'), { textContent: 'Show' }), select);
  filters.append(showRow);

  const sub = document.createElement('p');
  sub.className = 'sub';
  sub.innerHTML = countText(matched, total);
  filters.append(sub);

  return [head, viewbar, filters];
}

function stockRow(snapshot, row, rank, score, marked) {
  const selected = watchlist.has(row.symbol);
  const wrap = document.createElement('div');
  wrap.className = `stock${selected ? ' on' : ''}`;

  const metric = metricByKey(state.metric);
  const h = horizonIndexFor(state.score);
  const raw = metric.get(snapshot, row.i, score, h);
  const text = metric.key === 'score' ? displayValue(score).text : metric.fmt(raw);
  const tone = metric.key === 'score' || metric.key.startsWith('h')
    ? (raw >= 0 ? ' pos' : ' neg') : '';
  const floored = metric.floored?.(snapshot, row.i, h) ? '<span class="floor-mark">floor</span>' : '';

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
    refreshRows();
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
  clear.addEventListener('click', () => { clearWatchlist(); refreshRows(); });

  const go = document.createElement('button');
  go.type = 'button';
  go.className = 'primary';
  go.textContent = `Watchlist (${watchlist.size}) →`;
  go.addEventListener('click', () => navigate('watchlist'));

  bar.append(count, clear, go);
  return bar;
}

/** The rows the current filters admit, in universe rank order. */
function currentMatches() {
  return applyFilters(getRows(), currentRanks(), {
    sectors: state.sectors,
    minMarketCap: state.minMarketCap,
    search: state.search,
  });
}

function countText(matched, total) {
  return matched !== total
    ? `<b>${matched.toLocaleString()}</b> of ${total.toLocaleString()} · ranks stay universe-wide`
    : `<b>${total.toLocaleString()}</b> eligible names`;
}

/** Fills the rows container: the batch, the scroll sentinel, and the footer. */
function paintRows(body, snapshot, matches) {
  const ranks = currentRanks();
  const scores = currentScores();
  body.replaceChildren();

  if (matches.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'loading';
    empty.textContent = 'No names match these filters.';
    body.append(empty);
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
  body.append(list);

  if (matches.length > batch.length) {
    // 2,300 rows in the DOM would make scrolling stutter on a phone; the rest
    // arrive as the sentinel comes into view, so nothing is hidden.
    const sentinel = document.createElement('div');
    sentinel.className = 'more';
    sentinel.textContent = `${matches.length - batch.length} more`;
    body.append(sentinel);
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      observer.disconnect();
      shown += PAGE;
      refreshRows();
    }, { rootMargin: '400px' });
    observer.observe(sentinel);
  }

  const foot = document.createElement('p');
  foot.className = 'foot';
  foot.innerHTML = `Ranked on ${SCORE_LABELS[state.score]}${state.mode === 'voladj' ? ', volatility-adjusted' : ''}
    from ${snapshot.meta.universe.screened.toLocaleString()} screened listings.
    Filtering hides rows; it never renumbers them.<br>
    Data: Financial Modeling Prep · <code>${snapshot.meta.dataHash.slice(0, 16)}</code>`;
  body.append(foot);
}

/**
 * Repaints the rows and the count, leaving the header in place.
 *
 * Used by anything that changes only which rows qualify. Keeping the header's
 * DOM untouched is what lets a focused control survive the update — and it is
 * also the cheaper half of the work.
 */
export function refreshRows() {
  const body = document.querySelector('.listbody');
  if (!(body instanceof HTMLElement)) return;
  const matches = currentMatches();
  const sub = document.querySelector('.sub');
  if (sub) sub.innerHTML = countText(matches.length, getRows().length);
  paintRows(body, getSnapshot(), matches);
  paintActionBar();
}

/** The bar exists only while something is selected. */
function paintActionBar() {
  document.querySelector('.actionbar')?.remove();
  if (watchlist.size > 0) {
    document.getElementById('app')?.append(actionBar());
    document.body.classList.add('has-bar');
  } else {
    document.body.classList.remove('has-bar');
  }
}

export function renderList(app) {
  const snapshot = getSnapshot();
  const matches = currentMatches();

  app.replaceChildren();
  app.append(...headerParts(snapshot, matches.length, getRows().length));

  const body = document.createElement('div');
  body.className = 'listbody';
  app.append(body);
  paintRows(body, snapshot, matches);
  paintActionBar();
}
