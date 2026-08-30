/**
 * Comparison harness. Left pane is the shipped app in an iframe; right pane is
 * the concept, built from the product's own model and stylesheet so the only
 * difference on screen is the concept itself.
 */
import { buildRows, ranksFor, scoresFor, horizonIndexFor } from '../web/lib/model.js';
import { correlationMatrix, completeLinkageGroups, simpleReturns } from '../web/lib/quant.js';
import { comb, horizonRanks, railMarks, railStyle, weaveBlocks, effectiveBets, weaveOrder }
  from './concepts.js';

const stage = /** @type {HTMLElement} */ (document.getElementById('stage'));
const tabsEl = /** @type {HTMLElement} */ (document.getElementById('tabs'));

const APP = '../web/index.html';
/** The basket used for the watchlist concept: four names that are one trade,
 *  plus enough unrelated names to show what an open weave looks like. */
const BASKET = ['MU', 'STX', 'WDC', 'SNDK', 'AMAT', 'LRCX', 'IREN', 'CIFR', 'HUT',
  'AEM', 'NEM', 'ORKA', 'DFTX', 'ATEX', 'CLMT'];

let snapshot, rows, hRanks;

/** Correlation-grade decoder. Kept here, and named for what it decodes, because
 *  the product keeps its display decoder well away from `pearson` for exactly
 *  this reason: 64-level chart data run through a correlation is plausible,
 *  self-consistent and wrong. */
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

const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function frame(label, tag, node, scroll = false) {
  const col = document.createElement('div');
  col.className = 'lab-col';
  col.innerHTML = `<p class="lab-label">${label}${tag ? ` <span class="tagword">${tag}</span>` : ''}</p>`;
  const box = document.createElement('div');
  box.className = `lab-frame${scroll ? ' scroll' : ''}`;
  box.append(node);
  col.append(box);
  return col;
}

function liveApp(hash) {
  const f = document.createElement('iframe');
  f.src = APP + (hash ?? '');
  f.setAttribute('title', 'Live product');
  return f;
}

function notes(pairs) {
  const dl = document.createElement('dl');
  dl.className = 'lab-notes';
  for (const [k, v] of pairs) {
    const d = document.createElement('div');
    d.innerHTML = `<dt>${k}</dt><dd>${v}</dd>`;
    dl.append(d);
  }
  return dl;
}

function pitch(html) {
  const p = document.createElement('p');
  p.className = 'lab-pitch';
  p.innerHTML = html;
  return p;
}

/* ------------------------------------------------------------------------- */

/** The product's own row, rebuilt here so a concept can be added to it. */
function conceptRow(row, rank, valueText, tone, extras) {
  const wrap = document.createElement('div');
  wrap.className = 'stock';
  const open = document.createElement('div');
  open.className = `open ${extras.openClass ?? ''}`;
  open.innerHTML =
    (extras.railHtml ?? '') +
    `<div class="rank">${rank}</div>` +
    `<div class="ident"><div class="sym">${esc(row.symbol)}${extras.markHtml ?? ''}</div>` +
    `<div class="nm">${esc(row.name)}</div></div>`;
  if (extras.combNode) open.append(extras.combNode);
  const val = document.createElement('div');
  val.className = `val ${tone}`;
  val.textContent = valueText;
  open.append(val);
  const check = document.createElement('button');
  check.type = 'button';
  check.className = 'check';
  check.setAttribute('aria-pressed', 'false');
  check.setAttribute('aria-label', `Add ${row.symbol}`);
  wrap.append(open, check);
  return wrap;
}

function listShell(inner, headerHtml) {
  const box = document.createElement('div');
  box.style.padding = '0 0 20px';
  box.innerHTML = headerHtml;
  const list = document.createElement('div');
  list.className = 'rows';
  inner.forEach((n) => list.append(n));
  box.append(list);
  return box;
}

const HEAD = (title, sub) => `
  <header class="head"><h1>Momentum <span class="as-of">${snapshot.meta.asOf}</span></h1></header>
  <div class="filters" style="padding-top:0">
    <p class="sub">${sub}</p>
  </div>`;

/* ----------------------------------------------------- concept 1: the comb -- */

function renderComb() {
  const scoreKey = 'h12_1', mode = 'raw';
  const scores = scoresFor(snapshot, scoreKey, mode);
  const ranks = ranksFor(scores, snapshot.columns.symbol);
  const n = snapshot.columns.symbol.length;
  const viewed = horizonIndexFor(scoreKey);
  const ordered = rows.slice().sort((a, b) => ranks[a.i] - ranks[b.i]).slice(0, 12);

  const nodes = ordered.map((row) => {
    const r = {
      r12: hRanks[mode][0][row.i], r9: hRanks[mode][1][row.i], r6: hRanks[mode][2][row.i],
    };
    const { svg } = comb(r, n, viewed);
    const m = snapshot.columns.m[0][row.i];
    return conceptRow(row, ranks[row.i], `${m >= 0 ? '+' : ''}${(m * 100).toFixed(0)}%`,
      m >= 0 ? 'pos' : 'neg', { openClass: 'has-comb', combNode: svg });
  });

  const box = listShell(nodes, HEAD('', '<b>2,572</b> eligible names · 12–1, raw'));
  box.insertAdjacentHTML('beforeend', `<div class="comb-key">
    <span><i style="background:var(--faint)"></i>12–1 · 9–1 · 6–1, tall = higher rank</span>
    <span><i style="background:var(--pos)"></i>strengthening</span>
    <span><i style="background:var(--neg)"></i>decaying</span></div>`);

  stage.replaceChildren(
    pitch(`Every row already carries a rank in all three windows; the list shows one of them.
      The comb draws all three as a shape in 54&times;26px, inside the row that exists today —
      and on the product's own default view it changes the conclusion.
      <b>Eighteen of the top twenty on 12&ndash;1 are names whose momentum has already rolled
      over</b>: #4 DMRA is #1,644 over six months, #9 PRAX is #1,947, #12 ALMS is #1,693. The
      figures are on the row already. The screen currently shows a column of large green
      percentages instead.`),
    (() => { const d = document.createElement('div'); d.className = 'lab-pair';
      d.append(frame('Live product', 'main', liveApp(), false),
               frame('Concept 1', 'horizon comb', box, true)); return d; })(),
    notes([
      ['Data needed', 'None. Per-horizon raw and volatility-adjusted z-scores are already in <b>columns.zr</b> and <b>columns.zv</b>.'],
      ['Cost', 'One inline SVG per rendered row. At the current 120-row page that is 120 five-element SVGs, built in the same loop as the row.'],
      ['Reads at a glance', 'Flat comb = led all year. Staircase down = a leader dying. Staircase up = arriving. On this view almost every comb is a staircase down, which is the point.'],
      ['Open question', 'Whether the comb replaces the metric number on a phone or sits beside it. Drawn here beside it, which is the tighter fit to test.'],
    ]),
  );
}

/* ----------------------------------------------- concept 2: same-trade rail -- */

function renderRail() {
  const scoreKey = 'h12_1', mode = 'raw';
  const scores = scoresFor(snapshot, scoreKey, mode);
  const ranks = ranksFor(scores, snapshot.columns.symbol);
  const ids = snapshot.clusters.ids[1];              // rho >= 0.65
  // Counted over every row the filters admit, then sliced for display. Counting
  // over the rendered page instead would relabel a group every time the infinite
  // scroll appended a batch.
  const ordered = rows.slice().sort((a, b) => ranks[a.i] - ranks[b.i]);
  const marks = railMarks(ordered, ids);

  const nodes = ordered.slice(0, 14).map((row) => {
    const mark = marks.get(row.i);
    const style = mark ? railStyle(mark.groupId) : null;
    const railHtml = style
      ? `<span class="rail" style="background:hsl(${style.hue} 58% 46%)"></span>`
      : '<span class="rail solo"></span>';
    const markHtml = mark
      ? `<span class="nof${mark.ordinal === 1 ? ' first' : ''}" style="background:hsl(${
          style.hue} 58% 46% / .14);color:hsl(${style.hue} 62% 34%)">${mark.ordinal}/${mark.size}</span>`
      : '';
    const m = snapshot.columns.m[0][row.i];
    return conceptRow(row, ranks[row.i], `${m >= 0 ? '+' : ''}${(m * 100).toFixed(0)}%`,
      m >= 0 ? 'pos' : 'neg', { openClass: 'has-rail', railHtml, markHtml });
  });

  const shownRows = ordered.slice(0, 14);
  const repeats = shownRows.filter((r) => (marks.get(r.i)?.ordinal ?? 1) > 1).length;
  const box = listShell(nodes, HEAD('', '<b>2,572</b> eligible names · 12–1, raw'));
  box.insertAdjacentHTML('beforeend', `<p class="railnote">
    ${repeats} of these 14 names repeat a trade that is already above them, at &rho; &ge; 0.65.
    The mark counts across every row the filters admit — not the rendered page — so it is stable
    while you scroll and changes when you filter.</p>`);

  stage.replaceChildren(
    pitch(`The product's headline promise is that it is obvious when several highly ranked names
      are the same trade — but on the list that signal only appears <b>after</b> you have already
      put something on your watchlist. Universe-wide cluster ids are in the snapshot and already
      loaded, so the structure can be shown from the first paint.
      <b>#1 SNDK, #8 WDC and #21 STX are one storage trade and the live list says nothing.</b>`),
    (() => { const d = document.createElement('div'); d.className = 'lab-pair';
      d.append(frame('Live product', 'main', liveApp(), false),
               frame('Concept 2', 'same-trade rail', box, true)); return d; })(),
    notes([
      ['Data needed', 'None. <b>clusters.ids</b> already carries a group id per name at each of the three thresholds, and the list already loads it.'],
      ['Why n-of-m', 'Colour cannot separate 360 groups and should not have to. <b>3/4</b> is unambiguous in greyscale and says the actionable thing: this is the third-best name in a trade you have already passed twice.'],
      ['Counted over the filtered list', 'A fourteen-name semicap group is a group of two once you filter to $50B+. Marking 3/14 beside two visible rows would describe a list the reader cannot see.'],
      ['Open question', 'Whether the rail belongs on the row or whether one-per-group collapsing is the better default, with the rest expandable.'],
    ]),
  );
}

/* ------------------------------------------------------ concept 3: the weave -- */

async function renderWeave() {
  // The live pane reads its selection from localStorage, and the lab shares an
  // origin with it, so the baseline is only a baseline once the same basket is
  // there. Documented in the README: running the lab writes this key.
  try {
    localStorage.setItem('california.watchlist.v1', JSON.stringify(BASKET));
  } catch { /* private mode: the live pane just shows its empty state */ }

  const bySymbol = new Map(snapshot.columns.symbol.map((s, i) => [s, i]));
  const present = BASKET.filter((s) => bySymbol.has(s));
  const files = await Promise.all(present.map((s) =>
    fetch(`../web/data/series/${s}.json`).then((r) => r.json())));
  const returns = files.map((f) => simpleReturns(decodeCorrelation(f.correlation)));
  const raw = correlationMatrix(returns);

  const scores = scoresFor(snapshot, 'h12_1', 'raw');
  const ranks = ranksFor(scores, snapshot.columns.symbol);

  const wrap = document.createElement('div');
  wrap.className = 'panel';
  wrap.style.margin = '12px';
  wrap.innerHTML = '<h3>Moves together</h3>';
  const holder = document.createElement('div');
  holder.className = 'weave-wrap';
  const cv = document.createElement('canvas');
  cv.className = 'weave-canvas';
  holder.append(cv);
  wrap.append(holder);

  const ctrl = document.createElement('div');
  ctrl.className = 'wl-toggle small';
  wrap.insertBefore(ctrl, holder);
  const read = document.createElement('dl');
  read.className = 'weave-read';
  wrap.append(read);
  const cap = document.createElement('p');
  cap.className = 'weave-cap';
  wrap.append(cap);

  let thr = 0.65;
  let order = null;

  function paint() {
    const groups = completeLinkageGroups(raw, thr);
    if (!order) order = weaveOrder(present, groups);
    const syms = order.map((k) => present[k]);
    const m = order.map((a) => order.map((b) => (a === b ? 1 : raw[a][b])));
    const n = syms.length;

    const dpr = Math.min(devicePixelRatio || 1, 2);
    const W = Math.max(300, holder.clientWidth || 350);
    cv.width = W * dpr; cv.height = W * dpr;
    cv.style.height = W + 'px';
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const cs = getComputedStyle(document.documentElement);
    const tok = (k) => cs.getPropertyValue(k).trim();
    g.clearRect(0, 0, W, W);

    const pad = 46, size = W - pad - 6, cell = size / n, ox = pad, oy = pad;
    g.font = `600 ${Math.max(7.5, Math.min(10, cell * .44))}px ui-monospace, monospace`;
    g.fillStyle = tok('--muted');
    syms.forEach((s, i) => {
      g.textAlign = 'right';
      g.fillText(s, ox - 6, oy + i * cell + cell / 2 + 3);
      g.save(); g.translate(ox + i * cell + cell / 2, oy - 6); g.rotate(-Math.PI / 2);
      g.textAlign = 'left'; g.fillText(s, 0, 3); g.restore();
    });
    g.textAlign = 'left';

    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
      const x = ox + c * cell, y = oy + r * cell;
      const v = r === c ? 1 : m[r][c];
      g.fillStyle = tok('--chip'); g.fillRect(x, y, cell, cell);
      if (v >= thr) {
        g.fillStyle = r === c ? tok('--text') : tok('--accent-strong');
        g.globalAlpha = r === c ? .9 : .34 + Math.min(1, (v - thr) / .3) * .6;
        g.fillRect(x + .5, y + .5, cell - 1, cell - 1);
        g.globalAlpha = 1;
      } else {
        // Below the line the pair is still drawn, as thread: a group list shows
        // only what cleared the bar, so a pair sitting just under it — the thing
        // most worth knowing about — is exactly what it cannot show.
        const k = Math.max(0, Math.min(1, (v + .15) / (thr + .15)));
        const tw = Math.max(.6, k * cell * .46);
        g.fillStyle = v < 0 ? tok('--neg') : tok('--muted');
        g.globalAlpha = .16 + k * .5;
        g.fillRect(x + cell / 2 - tw / 2, y + 1, tw, cell - 2);
        g.fillRect(x + 1, y + cell / 2 - tw / 2, cell - 2, tw);
        g.globalAlpha = 1;
      }
    }
    g.strokeStyle = tok('--accent-strong'); g.lineWidth = 1.6;
    for (const [a, b] of weaveBlocks(m, thr)) {
      g.strokeRect(ox + a * cell + .5, oy + a * cell + .5, (b - a + 1) * cell - 1, (b - a + 1) * cell - 1);
    }

    let best = { v: -2, a: '', b: '' };
    for (let r = 0; r < n; r++) for (let c = r + 1; c < n; c++) {
      if (m[r][c] > best.v) best = { v: m[r][c], a: syms[r], b: syms[c] };
    }
    const eff = effectiveBets(m);
    read.innerHTML =
      `<div><dt>Names</dt><dd>${n}</dd></div>` +
      `<div><dt>Distinct trades</dt><dd>${eff.toFixed(1)}</dd></div>` +
      `<div><dt>Tightest pair</dt><dd>${best.a}·${best.b}</dd></div>` +
      `<div><dt class="lc">at &rho;</dt><dd>${best.v.toFixed(2)}</dd></div>`;
    cap.innerHTML = `Solid where a pair clears &rho; &ge; ${thr.toFixed(2)}; thread thickness
      carries every pair below it. Outlined blocks clear the threshold on every internal pair,
      the same complete-linkage rule the pipeline asserts. Ranks
      ${syms.slice(0, 4).map((s) => `#${ranks[bySymbol.get(s)]}`).join(' · ')} …`;
  }

  ctrl.replaceChildren(...snapshot.clusters.thresholds.map((v) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = `ρ ≥ ${v.toFixed(2)}`;
    b.setAttribute('aria-pressed', String(Math.abs(v - thr) < 1e-9));
    b.addEventListener('click', () => {
      thr = v;
      ctrl.querySelectorAll('button').forEach((o) => o.setAttribute('aria-pressed', String(o === b)));
      paint();
    });
    return b;
  }));

  const box = document.createElement('div');
  box.innerHTML = `<header class="head"><h1>Watchlist <span class="as-of">${present.length}</span></h1></header>`;
  box.append(wrap);

  stage.replaceChildren(
    pitch(`<b>Explored, not proposed.</b> Built to test whether a correlation matrix drawn as
      cloth beats the panel the product already has — and side by side it does not. The live
      <b>Moves together</b> panel names four groups with their ranks and each group's minimum
      &rho; in about the same height, and the weave cannot show either. What the weave does add
      is real but small: every sub-threshold pair, as thread, and a single count of distinct
      trades. Those two belong in the existing panel, at a fraction of the cost. See
      <code>visual-concepts-plan.md</code>.`),
    (() => { const d = document.createElement('div'); d.className = 'lab-pair';
      d.append(frame('Live product', 'watchlist', liveApp('#/watchlist'), false),
               frame('Concept 3', 'the weave', box, true)); return d; })(),
    notes([
      ['Verdict', '<b>Does not clear the bar.</b> A lateral move against a panel that already works, and it drops the group ranks and per-group minimum &rho; that the list shows plainly.'],
      ['What survives', 'Two things worth lifting out: the <b>near-miss</b> pairs sitting just under the threshold, which a group list throws away by construction, and <b>distinct trades — 2.5 of 15</b>.'],
      ['Cheaper route', 'Both fit the existing panel as one extra line and one extra row. No canvas, no matrix, no new interaction.'],
      ['Kept because', 'It is the clearest way to see that a group list is a threshold applied and then discarded. Worth keeping in the lab; not worth shipping.'],
    ]),
  );
  requestAnimationFrame(paint);
  addEventListener('resize', paint, { passive: true });
}

/* ------------------------------------------------------------------------- */

const TABS = [
  ['comb', 'Horizon comb', renderComb],
  ['rail', 'Same-trade rail', renderRail],
  ['weave', 'The weave', renderWeave],
];

function show(key) {
  const t = TABS.find((x) => x[0] === key) ?? TABS[0];
  tabsEl.querySelectorAll('button').forEach((b) =>
    b.setAttribute('aria-pressed', String(b.dataset.k === t[0])));
  location.hash = t[0];
  t[2]();
}

(async function boot() {
  snapshot = await (await fetch('../web/data/snapshot.json')).json();
  rows = buildRows(snapshot);
  hRanks = horizonRanks(snapshot, scoresFor, ranksFor);
  tabsEl.replaceChildren(...TABS.map(([k, label]) => {
    const b = document.createElement('button');
    b.type = 'button'; b.dataset.k = k; b.textContent = label;
    b.addEventListener('click', () => show(k));
    return b;
  }));
  show(location.hash.replace('#', '') || 'comb');
  addEventListener('hashchange', () => show(location.hash.replace('#', '') || 'comb'));
})();
