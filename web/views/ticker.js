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

/**
 * Mounts TradingView's free Advanced Real-Time Chart.
 *
 * Chart features are deliberately left on — drawing tools and the side
 * toolbar, indicators, the full timeframe row, date ranges, symbol search and
 * volume. The only things switched off are the widget's account-backed
 * save/load hooks, which need a TradingView login this project does not have,
 * and on a narrow phone the auxiliary side panels (details, watchlist,
 * calendar), which would otherwise leave almost no room for the chart itself.
 *
 * The widget draws TradingView's own data and is display-only: no number in
 * this app is derived from it. Every figure shown comes from the FMP snapshot.
 */
function mountChart(container, meta, symbol) {
  const wide = window.matchMedia('(min-width: 700px)').matches;
  const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;

  // TradingView's loader looks for its own container structure and replaces the
  // __widget div with the chart iframe, so the markup below matches their
  // documented embed exactly.
  const wrap = document.createElement('div');
  wrap.className = 'tradingview-widget-container';
  wrap.style.cssText = 'height:100%;width:100%';

  const slot = document.createElement('div');
  slot.className = 'tradingview-widget-container__widget';
  slot.style.cssText = 'height:calc(100% - 20px);width:100%';
  wrap.append(slot);

  const credit = document.createElement('div');
  credit.className = 'tradingview-widget-copyright';
  credit.innerHTML =
    `<a href="https://www.tradingview.com/symbols/${tvSymbol(meta, symbol).replace(':', '-')}/" ` +
    `rel="noopener nofollow" target="_blank"><span>${symbol} chart by TradingView</span></a>`;
  wrap.append(credit);

  const script = document.createElement('script');
  script.src = 'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js';
  script.async = true;
  script.type = 'text/javascript';
  script.textContent = JSON.stringify({
    autosize: true,
    symbol: tvSymbol(meta, symbol),
    interval: 'D',
    timezone: 'America/New_York',
    theme: dark ? 'dark' : 'light',
    style: '1',
    locale: 'en',
    withdateranges: true,
    range: '12M',
    allow_symbol_change: true,
    hide_side_toolbar: false,
    hide_top_toolbar: false,
    hide_legend: false,
    hide_volume: false,
    save_image: true,
    details: wide,
    hotlist: false,
    calendar: false,
    support_host: 'https://www.tradingview.com',
  });
  wrap.append(script);
  container.append(wrap);

  // If the widget host is unreachable the container stays empty; say so rather
  // than leaving a blank rectangle.
  setTimeout(() => {
    if (!container.querySelector('iframe')) {
      const p = document.createElement('p');
      p.className = 'chart-fallback';
      p.textContent =
        'The TradingView chart could not load (no network, or the widget host is blocked). The figures below are unaffected.';
      container.replaceChildren(p);
    }
  }, 6000);
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
    <div class="meta">${escapeHtml(sym.sector || '—')} · ${sym.exchange} · ${marketCap(sym.marketCap)} · $${sym.price.toFixed(2)}</div>`;
  app.append(title);

  const chart = document.createElement('div');
  chart.className = 'chart-wrap';
  app.append(chart);
  mountChart(chart, sym, symbol);

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
  foot.innerHTML = `Chart by TradingView, display only — it feeds no calculation here.
    All figures above are computed from Financial Modeling Prep dividend-adjusted closes as of ${snapshot.meta.asOf}.`;
  app.append(foot);
}
