import { HORIZONS, SCORE_LABELS, navigate, num, pct, state, syncHash, viewKey } from '../app.js';
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

/** Mirror of the pipeline's encoder: one character per day, 64 levels. */
function decodeSeries(series) {
  if (!series || !series.points) return [];
  const span = series.hi - series.lo;
  const out = [];
  for (const ch of series.points) {
    out.push(series.lo + (span * SERIES_ALPHABET.indexOf(ch)) / (SERIES_ALPHABET.length - 1));
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
  const closes = decodeSeries(sym.series);
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

function rankGrid(snapshot, symbol) {
  // Same order as the controls: horizon major, mode minor.
  const order = ['h12_1', 'h9_1', 'h6_1', 'blend'].flatMap((k) => [`${k}|raw`, `${k}|voladj`]);
  const cells = order.filter((id) => snapshot.views[id]).map((id) => {
    const view = snapshot.views[id];
    const hit = view.ranked.find((e) => e.symbol === symbol);
    const label = `${SCORE_LABELS[view.scoreKey]}${view.mode === 'voladj' ? ' vol-adj' : ''}`;
    return `<div class="rank-cell${hit ? '' : ' none'}">
      <span>${label}</span><b>${hit ? `#${hit.rank}` : 'not top 100'}</b>
    </div>`;
  }).join('');
  return `<div class="panel"><h3>Rank in each view</h3><div class="rank-grid">${cells}</div></div>`;
}

export function renderTicker(app, snapshot, symbol) {
  const sym = snapshot.symbols[symbol];
  app.replaceChildren();

  const head = document.createElement('header');
  head.className = 'head';
  const back = document.createElement('a');
  back.className = 'back';
  back.href = '#';
  back.textContent = '‹ Back to groups';
  back.addEventListener('click', (e) => {
    e.preventDefault();
    if (history.length > 1) history.back();
    else { syncHash(''); location.hash = `/?score=${state.score}&mode=${state.mode}&threshold=${state.threshold}`; }
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

  const view = snapshot.views[viewKey()];
  const entry = view.ranked.find((e) => e.symbol === symbol);

  const title = document.createElement('div');
  title.className = 'detail-head';
  title.innerHTML = `
    <h2>${symbol}${entry ? ` <span class="as-of">#${entry.rank}</span>` : ''}</h2>
    <div class="meta">${escapeHtml(sym.name)}</div>
    <div class="meta">${escapeHtml(sym.sector || '—')} · ${escapeHtml(sym.exchange)} · ${marketCap(sym.marketCap)} · $${sym.price.toFixed(2)}</div>`;
  app.append(title);

  const chart = document.createElement('div');
  chart.className = 'chart-wrap';
  chart.innerHTML = priceChart(sym, snapshot, state.score === 'blend' ? 'h12_1' : state.score);
  app.append(chart);

  app.insertAdjacentHTML('beforeend', statsTable(sym));

  // Peers in this name's correlation group, at the active threshold.
  const group = (view.groups[state.threshold] ?? []).find((g) => g.members.includes(symbol));
  if (group && group.members.length > 1) {
    const self = group.members.indexOf(symbol);
    const rows = group.members
      .filter((m) => m !== symbol)
      .map((m) => {
        const peer = view.ranked.find((e) => e.symbol === m);
        const rho = group.corr ? group.corr[self][group.members.indexOf(m)] : null;
        return `<tr data-symbol="${m}">
          <th>${m}</th>
          <td style="text-align:left;color:var(--muted);font-weight:400">${escapeHtml((snapshot.symbols[m]?.name ?? '').slice(0, 28))}</td>
          <td>${peer ? `#${peer.rank}` : '—'}</td>
          <td>${rho == null ? '—' : rho.toFixed(2)}</td>
        </tr>`;
      })
      .join('');
    const panel = document.createElement('div');
    panel.className = 'panel';
    panel.innerHTML = `<h3>Moves with (<span class="lc">&rho;</span> &ge; ${state.threshold})</h3>
      <table class="stats">
        <thead><tr><th>Symbol</th><th style="text-align:left">Name</th><th>Rank</th><th class="lc">&rho;</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
    panel.querySelectorAll('tr[data-symbol]').forEach((tr) => {
      tr.style.cursor = 'pointer';
      tr.addEventListener('click', () => navigate(tr.dataset.symbol));
    });
    app.append(panel);
  }

  app.insertAdjacentHTML('beforeend', rankGrid(snapshot, symbol));

  const foot = document.createElement('p');
  foot.className = 'foot';
  foot.innerHTML = `Dividend-adjusted closes from Financial Modeling Prep, as of ${snapshot.meta.asOf}.
    <br><a class="tv-link" href="https://www.tradingview.com/chart/?symbol=${encodeURIComponent(tvSymbol(sym, symbol))}"
      target="_blank" rel="noopener noreferrer">Open ${symbol} in TradingView &#8599;</a>`;
  app.append(foot);
}
