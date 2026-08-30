import {
  clearWatchlist, currentRanks, droppedSelections, getSnapshot, goBack, loadSeries,
  navigate, rerender, state, syncHash, toggleWatch, watchlist,
} from '../app.js';
import { completeLinkageGroups, correlationMatrix, simpleReturns } from '../lib/quant.js';
import { SCORE_LABELS } from '../lib/model.js';
import { escapeHtml } from './list.js';

const TRADING_DAYS = 252;

/**
 * Decodes the **correlation-grade** series.
 *
 * Deliberately separate from the chart's decoder: that data is quantized to 64
 * levels, which is invisible on a chart and roughly the size of a daily move —
 * feeding it here breaks group membership at the threshold. This reads the
 * 4096-level block, the only series a correlation may come from.
 */
function decodeCorrelation(block) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const w = block.w ?? 2;
  const top = A.length ** w - 1;
  const span = block.hi - block.lo;
  const out = [];
  for (let i = 0; i + w <= block.points.length; i += w) {
    let level = 0;
    for (let c = 0; c < w; c++) level = level * A.length + A.indexOf(block.points[i + c]);
    out.push(block.lo + (span * level) / top);
  }
  return out;
}

/** Annualized volatility over the same window the correlations use. */
function annualizedVol(returns) {
  const n = returns.length;
  if (n < 2) return 0;
  const mean = returns.reduce((a, b) => a + b, 0) / n;
  const ss = returns.reduce((a, b) => a + (b - mean) ** 2, 0);
  return Math.sqrt(ss / (n - 1)) * Math.sqrt(TRADING_DAYS);
}

/**
 * Portfolio risk decomposition.
 *
 * Weights are a stated assumption, never a recommendation: the question this
 * answers is "if you held these equal-weight, where does the risk come from",
 * not "what should you hold". Contributions sum to the portfolio volatility by
 * construction, which is what makes the percentages meaningful.
 */
function riskModel(vols, C, weighting) {
  const n = vols.length;
  const w = weighting === 'invvol'
    ? normalize(vols.map((v) => (v > 0 ? 1 / v : 0)))
    : new Array(n).fill(1 / n);

  // Covariance from correlation and volatility: cov = D C D.
  const cov = C.map((rowC, i) => rowC.map((r, j) => r * vols[i] * vols[j]));
  const marginal = cov.map((rowCov) => rowCov.reduce((acc, v, j) => acc + v * w[j], 0));
  const variance = marginal.reduce((acc, m, i) => acc + w[i] * m, 0);
  const sigma = Math.sqrt(Math.max(variance, 0));
  // Each name's share of portfolio risk; these sum to 1.
  const share = sigma > 0 ? w.map((wi, i) => (wi * marginal[i]) / (sigma * sigma)) : w.map(() => 0);
  return { weights: w, sigma, share };
}

function normalize(xs) {
  const total = xs.reduce((a, b) => a + b, 0);
  return total > 0 ? xs.map((x) => x / total) : xs.map(() => 1 / xs.length);
}

function pctText(v) {
  return `${(v * 100).toFixed(0)}%`;
}

export function renderWatchlist(app) {
  const snapshot = getSnapshot();
  app.replaceChildren();
  document.body.classList.remove('has-bar');

  const head = document.createElement('header');
  head.className = 'head';
  const back = document.createElement('a');
  back.className = 'back';
  back.href = '#';
  back.textContent = '‹ Back to list';
  back.addEventListener('click', (e) => { e.preventDefault(); goBack(); });
  head.append(back);
  head.insertAdjacentHTML('beforeend', `<h1>Watchlist <span class="as-of">${watchlist.size}</span></h1>`);
  app.append(head);

  if (watchlist.size === 0) {
    app.insertAdjacentHTML('beforeend',
      `<p class="loading">Nothing selected yet. Tap the circle on any row to add it here.</p>`);
    return;
  }

  // The snapshot is the authority on membership. A name whose row is gone has
  // no index, and every lookup keyed on it would yield `undefined` — sorting
  // on `ranks[undefined]` gives NaN, which silently scrambles the order rather
  // than throwing. Stale selections are already dropped at boot; this is the
  // guard that makes the invariant local to where it is relied on.
  const known = new Set(snapshot.columns.symbol);
  const symbols = [...watchlist].filter((s) => known.has(s));
  const body = document.createElement('div');
  body.className = 'wl';
  body.innerHTML = '<p class="loading">Loading prices…</p>';
  app.append(body);

  // One request per name, and only for names actually on the list.
  return Promise.all(symbols.map((s) => loadSeries(s).then((f) => ({ s, f })).catch(() => ({ s, f: null }))))
    .then((loaded) => {
      const usable = loaded.filter((x) => x.f?.correlation && known.has(x.s));
      const missing = loaded.filter((x) => !x.f?.correlation).map((x) => x.s);
      renderBody(body, snapshot, usable, missing);
    });
}

function renderBody(body, snapshot, loaded, missing) {
  const ranks = currentRanks();
  const c = snapshot.columns;
  const index = new Map(c.symbol.map((s, i) => [s, i]));

  const symbols = loaded.map((x) => x.s).sort((a, b) => ranks[index.get(a)] - ranks[index.get(b)]);
  const returns = symbols.map((s) => {
    const entry = loaded.find((x) => x.s === s);
    return simpleReturns(decodeCorrelation(entry.f.correlation));
  });
  const vols = returns.map(annualizedVol);
  const C = correlationMatrix(returns);
  const { weights, sigma, share } = riskModel(vols, C, state.weighting ?? 'equal');

  body.replaceChildren();

  // --- weighting toggle -----------------------------------------------------
  const toggle = document.createElement('div');
  toggle.className = 'wl-toggle';
  for (const [key, label] of [['equal', 'Equal weight'], ['invvol', 'Inverse vol']]) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.setAttribute('aria-pressed', String((state.weighting ?? 'equal') === key));
    b.addEventListener('click', () => {
      state.weighting = key;
      syncHash('watchlist');
      rerender({ keepScroll: true });
    });
    toggle.append(b);
  }
  body.append(toggle);
  body.insertAdjacentHTML('beforeend',
    `<p class="wl-note">If you held these ${(state.weighting ?? 'equal') === 'equal' ? 'equally' : 'weighted by inverse volatility'},
     the basket's volatility would be <b>${pctText(sigma)}</b> a year. This is a description of the
     names you picked, not a suggestion of what to hold.</p>`);

  // --- which of these move together ----------------------------------------
  const groups = completeLinkageGroups(C, Number(state.threshold)).filter((g) => g.members.length > 1);
  const grouped = groups.reduce((n, g) => n + g.members.length, 0);
  const panel = document.createElement('div');
  panel.className = 'panel';
  panel.innerHTML = `<h3>Moves together (<span class="lc">&rho;</span> &ge; ${state.threshold})</h3>`;

  // The threshold lives here rather than on the list, because this is the only
  // screen whose answer changes when you move it.
  const thresholds = document.createElement('div');
  thresholds.className = 'wl-toggle small';
  for (const t of snapshot.clusters.thresholds.map((/** @type {number} */ v) => v.toFixed(2))) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = `\u03c1 \u2265 ${t}`;
    b.setAttribute('aria-pressed', String(state.threshold === t));
    b.addEventListener('click', () => {
      if (state.threshold === t) return;
      state.threshold = t;
      syncHash('watchlist');
      rerender({ keepScroll: true });
    });
    thresholds.append(b);
  }
  panel.append(thresholds);
  if (groups.length === 0) {
    panel.insertAdjacentHTML('beforeend',
      `<p class="wl-empty">None of these ${symbols.length} move together at this threshold — they are ${symbols.length} distinct bets.</p>`);
  } else {
    for (const g of groups) {
      const names = g.members.map((m) => symbols[m]);
      panel.insertAdjacentHTML('beforeend',
        `<div class="wl-group">
           <div class="wl-group-head">${names.length} names · <span class="lc">&rho;</span> &ge; ${g.minCorr.toFixed(2)}</div>
           <div class="wl-group-names">${names.map((n) => `#${ranks[index.get(n)]} ${escapeHtml(n)}`).join(' · ')}</div>
         </div>`);
    }
    panel.insertAdjacentHTML('beforeend',
      `<p class="wl-empty">${grouped} of your ${symbols.length} names sit in ${groups.length} group${groups.length === 1 ? '' : 's'}.</p>`);
  }
  body.append(panel);

  // --- per name -------------------------------------------------------------
  const rows = symbols.map((s, i) => {
    // Average correlation to the rest of the basket: how much this name
    // repeats what you already hold.
    const overlap = symbols.length > 1
      ? (C[i].reduce((a, v) => a + v, 0) - 1) / (symbols.length - 1)
      : 0;
    return `<tr data-symbol="${escapeHtml(s)}">
      <th>${escapeHtml(s)}</th>
      <td>#${ranks[index.get(s)]}</td>
      <td>${pctText(weights[i])}</td>
      <td>${pctText(vols[i])}</td>
      <td class="${overlap >= 0.5 ? 'neg' : ''}">${overlap.toFixed(2)}</td>
      <td><b>${pctText(share[i])}</b></td>
    </tr>`;
  }).join('');
  const perName = document.createElement('div');
  perName.className = 'panel';
  perName.innerHTML = `<h3>Per name</h3>
    <div class="scroll-x"><table class="stats">
      <thead><tr><th>Symbol</th><th>Rank</th><th>Weight</th><th>Vol</th><th>Overlap</th><th>Risk</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <p class="wl-empty">Overlap is the average correlation to the rest of your list — high means it repeats
      what you already hold. Risk is that name's share of the basket's volatility; the column sums to 100%.</p>`;
  perName.querySelectorAll('tr[data-symbol]').forEach((tr) => {
    tr.style.cursor = 'pointer';
    tr.addEventListener('click', () => navigate(tr.dataset.symbol));
  });
  body.append(perName);

  // --- tightest pairs -------------------------------------------------------
  const pairs = [];
  for (let i = 0; i < symbols.length; i++) {
    for (let j = i + 1; j < symbols.length; j++) pairs.push([symbols[i], symbols[j], C[i][j]]);
  }
  pairs.sort((a, b) => b[2] - a[2]);
  if (pairs.length > 0) {
    const top = pairs.slice(0, 6).map(([a, b, r]) =>
      `<tr><th>${escapeHtml(a)} · ${escapeHtml(b)}</th><td>${r.toFixed(2)}</td></tr>`).join('');
    body.insertAdjacentHTML('beforeend',
      `<div class="panel"><h3>Tightest pairs</h3>
        <table class="stats"><tbody>${top}</tbody></table></div>`);
  }

  // --- sector mix -----------------------------------------------------------
  const bySector = new Map();
  symbols.forEach((s) => {
    const sector = c.sectors[c.sector[index.get(s)]] ?? '—';
    bySector.set(sector, (bySector.get(sector) ?? 0) + 1);
  });
  const mix = [...bySector.entries()].sort((a, b) => b[1] - a[1]).map(([sector, n]) =>
    `<tr><th style="font-weight:500">${escapeHtml(sector)}</th><td>${n}</td><td>${pctText(n / symbols.length)}</td></tr>`).join('');
  body.insertAdjacentHTML('beforeend',
    `<div class="panel"><h3>Sector mix</h3><table class="stats"><tbody>${mix}</tbody></table></div>`);

  // --- the list itself ------------------------------------------------------
  const list = document.createElement('div');
  list.className = 'panel';
  list.innerHTML = `<h3>Your list</h3>`;
  const rowsWrap = document.createElement('div');
  rowsWrap.className = 'rows flat';
  for (const s of symbols) {
    const i = index.get(s);
    const item = document.createElement('div');
    item.className = 'stock on';
    const open = document.createElement('a');
    open.className = 'open';
    open.href = '#';
    open.addEventListener('click', (e) => { e.preventDefault(); navigate(s); });
    open.innerHTML = `<div class="rank">${ranks[i]}</div>
      <div class="ident"><div class="sym">${escapeHtml(s)}</div>
      <div class="nm">${escapeHtml(String(c.name[i]))}</div></div>`;
    const check = document.createElement('button');
    check.type = 'button';
    check.className = 'check';
    check.setAttribute('aria-pressed', 'true');
    check.setAttribute('aria-label', `Remove ${s}`);
    check.addEventListener('click', () => { toggleWatch(s); rerender({ keepScroll: true }); });
    item.append(open, check);
    rowsWrap.append(item);
  }
  list.append(rowsWrap);
  body.append(list);

  if (missing.length > 0) {
    body.insertAdjacentHTML('beforeend',
      `<p class="wl-empty">No price history for ${missing.map(escapeHtml).join(', ')}, so they are excluded from the figures above.</p>`);
  }

  // Someone who starred a name presumably still cares that it left.
  const gone = droppedSelections();
  if (gone.length > 0) {
    body.insertAdjacentHTML('beforeend',
      `<p class="wl-empty">${gone.map(escapeHtml).join(', ')} ${gone.length === 1 ? 'is' : 'are'} no longer in the
       screened universe — below the size or liquidity floor, delisted or acquired — so ${gone.length === 1 ? 'it has' : 'they have'}
       been removed from your list.</p>`);
  }

  const clear = document.createElement('button');
  clear.type = 'button';
  clear.className = 'wl-clear';
  clear.textContent = 'Clear watchlist';
  clear.addEventListener('click', () => { clearWatchlist(); rerender(); });
  body.append(clear);

  body.insertAdjacentHTML('beforeend',
    `<p class="foot">Correlations and volatility over the last ${snapshot.meta.params.corrWindow} sessions,
     from the same window, computed on this device from Financial Modeling Prep closes.</p>`);
}
