import {
  currentRanks, loadSeries, marketCapLabel, navigate, num, pct, state, syncHash,
  toggleWatch, watchlist,
} from '../app.js';
import { scoresFor, ranksFor } from '../lib/model.js';
import { HORIZONS, SCORE_LABELS } from '../lib/model.js';
import { escapeHtml } from './list.js';

/** Compact market cap: trillions once past 1000B, so it never reads "$1053.6B". */
function marketCap(v) {
  return v >= 1e12 ? `$${(v / 1e12).toFixed(2)}T` : `$${(v / 1e9).toFixed(1)}B`;
}

/** TradingView needs an exchange-prefixed symbol; the screener already gives us the prefix. */
function tvSymbol(meta, symbol) {
  const ex = meta?.exchange && ['NASDAQ', 'NYSE', 'AMEX'].includes(meta.exchange) ? meta.exchange : 'NASDAQ';
  return `${ex}:${symbol}`;
}

const SERIES_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/**
 * Decodes the **display** series, and is named so.
 *
 * Kept here with the chart rather than beside `pearson` in the shared quant
 * module: this data is lossy by design and must never reach a correlation.
 * Having the decoder sit next to the correlation function is what made feeding
 * one into the other feel natural, and produced numbers that were plausible,
 * self-consistent and wrong.
 */
function decodeDisplaySeries(series) {
  if (!series || !series.points) return [];
  const span = series.hi - series.lo;
  const width = series.w ?? 1;
  const base = SERIES_ALPHABET.length;
  const top = base ** width - 1;
  const out = [];
  for (let i = 0; i + width <= series.points.length; i += width) {
    let level = 0;
    for (let c = 0; c < width; c++) level = level * base + SERIES_ALPHABET.indexOf(series.points[i + c]);
    out.push(series.lo + (span * level) / top);
  }
  return out;
}

/**
 * Draws the price line for the charted span, with each momentum horizon marked
 * beneath it.
 *
 * Done as inline SVG from data already in the snapshot rather than by embedding
 * a charting library: one tap used to pull down a third-party charting app an
 * order of magnitude larger than this entire product. This renders instantly,
 * works offline, and — because the windows are drawn from the same anchors the
 * ranking uses — shows exactly which stretch of price produced each number.
 */
function priceChart(sym, snapshot, activeHorizon) {
  const closes = decodeDisplaySeries(sym.series);
  if (closes.length < 2) return '<p class="chart-fallback">No price series for this name.</p>';

  const dates = snapshot.meta.chartDates ?? [];
  const horizons = snapshot.meta.params.horizons;
  const last = closes.length - 1;

  // The SVG stretches to the container, so it carries only geometry. Every
  // label lives in HTML beside it: text inside a non-uniformly scaled viewBox
  // comes out squashed and far too small to read on a phone.
  const W = 1000;
  const H = 200;
  let lo = Infinity;
  let hi = -Infinity;
  for (const c of closes) {
    if (c < lo) lo = c;
    if (c > hi) hi = c;
  }
  const span = hi - lo || 1;
  const x = (i) => (i / last) * W;
  const y = (v) => H - ((v - lo) / span) * (H - 4) - 2;

  const line = closes.map((c, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(c).toFixed(1)}`).join('');
  const area = `${line}L${W},${H}L0,${H}Z`;

  // The skipped month: every horizon deliberately stops short of it.
  const skip = horizons.h12_1.skip;
  const skipX = x(last - skip);

  // Position along the viewBox, distinct from the imported `pct` display formatter.
  const xPct = (i) => ((i / last) * 100).toFixed(2);
  const bars = ['h12_1', 'h9_1', 'h6_1'].map((key) => {
    const h = horizons[key];
    const left = xPct(last - h.lookback);
    const width = (((h.lookback - h.skip) / last) * 100).toFixed(2);
    const stat = sym.horizons[key];
    const cls = `${stat.momentum >= 0 ? 'pos' : 'neg'}${key === activeHorizon ? ' on' : ''}`;
    return `<div class="hz-row">
      <div class="hz-bar ${cls}" style="left:${left}%;width:${width}%"></div>
      <span class="hz-label ${cls}" style="left:${left}%">${h.label} ${pct(stat.momentum)}</span>
    </div>`;
  }).join('');

  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img"
    aria-label="${escapeHtml(sym.name)} price from ${dates[0] ?? ''} to ${dates[dates.length - 1] ?? ''}">
    <rect class="skip" x="${skipX.toFixed(1)}" y="0" width="${(W - skipX).toFixed(1)}" height="${H}" />
    <path class="area" d="${area}" />
    <path class="line" d="${line}" />
    <line class="skip-edge" x1="${skipX.toFixed(1)}" y1="0" x2="${skipX.toFixed(1)}" y2="${H}" />
  </svg>
  <div class="chart-range"><span>low ${lo.toFixed(2)}</span><span>high ${hi.toFixed(2)}</span></div>
  <div class="hz-bars">${bars}</div>
  <div class="chart-axis">
    <span>${dates[0] ?? ''}</span>
    <span class="skip-note">shaded ${skip} sessions excluded</span>
    <span>${dates[dates.length - 1] ?? snapshot.meta.asOf}</span>
  </div>`;
}

function statsTable(sym) {
  const rows = HORIZONS.map((h) => {
    const s = sym.horizons[h];
    return `<tr>
      <th>${SCORE_LABELS[h]}</th>
      <td class="${s.momentum >= 0 ? 'pos' : 'neg'}">${pct(s.momentum)}</td>
      <td>${(s.realizedVol * 100).toFixed(0)}%</td>
      <td>${(s.effectiveVol * 100).toFixed(0)}%${s.floored ? '<span class="floored">floor</span>' : ''}</td>
      <td>${num(s.volAdjusted, 2)}</td>
    </tr>`;
  }).join('');

  return `<div class="panel">
    <h3>By horizon</h3>
    <table class="stats">
      <thead><tr><th>Horizon</th><th>Momentum</th><th>Real. vol</th><th>Eff. vol</th><th>Vol-adj</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

function rankGrid(snapshot, index) {
  const symbols = snapshot.columns.symbol;
  const cells = ['h12_1', 'h9_1', 'h6_1', 'blend'].flatMap((score) =>
    ['raw', 'voladj'].map((mode) => {
      const rank = ranksFor(scoresFor(snapshot, score, mode), symbols)[index];
      const label = `${SCORE_LABELS[score]}${mode === 'voladj' ? ' vol-adj' : ''}`;
      return `<div class="rank-cell"><span>${label}</span><b>#${rank}</b></div>`;
    }),
  ).join('');
  return `<div class="panel"><h3>Rank in each view</h3><div class="rank-grid">${cells}</div></div>`;
}

/** Everything the detail screen needs about one name, read from the columns. */
function rowData(snapshot, symbol) {
  const c = snapshot.columns;
  const i = c.symbol.indexOf(symbol);
  if (i < 0) return null;
  const horizons = {};
  HORIZONS.forEach((key, h) => {
    const momentum = c.m[h][i];
    const realizedVol = c.rv[h][i];
    const effectiveVol = Math.max(realizedVol, snapshot.meta.params.volFloorAnnualized);
    horizons[key] = {
      momentum, realizedVol, effectiveVol,
      volAdjusted: momentum / effectiveVol,
      floored: realizedVol < snapshot.meta.params.volFloorAnnualized,
    };
  });
  return {
    i, symbol,
    name: c.name[i],
    sector: c.sectors[c.sector[i]] ?? '',
    exchange: c.exchanges[c.exchange[i]] ?? '',
    price: c.price[i],
    marketCap: c.marketCapM[i] * 1e6,
    horizons,
  };
}

/** Names sharing this one's universe cluster, from ids already in the snapshot. */
function clusterPeers(snapshot, index) {
  const t = snapshot.clusters.thresholds.findIndex((v) => v.toFixed(2) === state.threshold);
  if (t < 0) return [];
  const ids = snapshot.clusters.ids[t];
  const id = ids[index];
  if (id === undefined || id < 0) return [];
  const out = [];
  for (let i = 0; i < ids.length; i++) {
    if (i !== index && ids[i] === id) out.push(i);
  }
  return out;
}

export function renderTicker(app, snapshot, symbol) {
  const sym = rowData(snapshot, symbol);
  app.replaceChildren();

  const head = document.createElement('header');
  head.className = 'head';
  const back = document.createElement('a');
  back.className = 'back';
  back.href = '#';
  back.textContent = '‹ Back to list';
  back.addEventListener('click', (e) => {
    e.preventDefault();
    if (history.length > 1) history.back();
    else { syncHash(''); location.hash = '/'; }
  });
  head.append(back);
  app.append(head);

  if (!sym) {
    const p = document.createElement('p');
    p.className = 'loading';
    p.textContent = `${symbol} is not in the current snapshot.`;
    app.append(p);
    return;
  }

  const ranks = currentRanks();
  const title = document.createElement('div');
  title.className = 'detail-head';
  title.innerHTML = `
    <h2>${escapeHtml(symbol)} <span class="as-of">#${ranks[sym.i]}</span></h2>
    <div class="meta">${escapeHtml(sym.name)}</div>
    <div class="meta">${escapeHtml(sym.sector || '—')} · ${escapeHtml(sym.exchange)} · ${marketCapLabel(sym.marketCap)} · $${sym.price.toFixed(2)}</div>`;
  app.append(title);

  // Same one-tap model as the list: checking is saving, and the button states
  // what it will do rather than what the name currently is.
  const watch = document.createElement('button');
  watch.type = 'button';
  watch.className = 'watch-toggle';
  const paintWatch = () => {
    const on = watchlist.has(symbol);
    watch.setAttribute('aria-pressed', String(on));
    watch.textContent = on ? '✓ On your watchlist' : '+ Add to watchlist';
  };
  paintWatch();
  watch.addEventListener('click', () => { toggleWatch(symbol); paintWatch(); });
  title.append(watch);

  // The chart needs this one name's prices — ~640 bytes, fetched on arrival.
  const chart = document.createElement('div');
  chart.className = 'chart-wrap';
  chart.innerHTML = '<p class="chart-fallback">Loading chart…</p>';
  app.append(chart);
  loadSeries(symbol)
    .then((file) => {
      chart.innerHTML = priceChart(
        { ...sym, series: file.display },
        snapshot,
        state.score === 'blend' ? 'h12_1' : state.score,
      );
    })
    .catch(() => {
      chart.innerHTML =
        '<p class="chart-fallback">Could not load this name\'s price history. The figures below are unaffected.</p>';
    });

  app.insertAdjacentHTML('beforeend', statsTable(sym));

  const peers = clusterPeers(snapshot, sym.i);
  if (peers.length > 0) {
    const c = snapshot.columns;
    const rows = peers
      .sort((a, b) => ranks[a] - ranks[b])
      .slice(0, 12)
      .map((i) => `<tr data-symbol="${escapeHtml(c.symbol[i])}">
        <th>${escapeHtml(c.symbol[i])}</th>
        <td style="text-align:left;color:var(--muted);font-weight:400">${escapeHtml(String(c.name[i]).slice(0, 28))}</td>
        <td>#${ranks[i]}</td>
      </tr>`).join('');
    const panel = document.createElement('div');
    panel.className = 'panel';
    panel.innerHTML = `<h3>Moves with (<span class="lc">&rho;</span> &ge; ${state.threshold})</h3>
      <table class="stats">
        <thead><tr><th>Symbol</th><th style="text-align:left">Name</th><th>Rank</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
    panel.querySelectorAll('tr[data-symbol]').forEach((tr) => {
      tr.style.cursor = 'pointer';
      tr.addEventListener('click', () => navigate(tr.dataset.symbol));
    });
    app.append(panel);
  }

  app.insertAdjacentHTML('beforeend', rankGrid(snapshot, sym.i));

  const foot = document.createElement('p');
  foot.className = 'foot';
  foot.innerHTML = `Dividend-adjusted closes from Financial Modeling Prep, as of ${snapshot.meta.asOf}.
    <br><a class="tv-link" href="https://www.tradingview.com/chart/?symbol=${encodeURIComponent(tvSymbol(sym, symbol))}"
      target="_blank" rel="noopener noreferrer">Open ${escapeHtml(symbol)} in TradingView &#8599;</a>`;
  app.append(foot);
}
