import { navigate, state, syncHash } from '../../app.js';
import { SCORE_LABELS } from '../../lib/model.js';
import { escapeHtml } from '../list.js';
import { loadRankHistory } from './data.js';

/**
 * Rank River — where the current top 20 have been over the last ~30 sessions.
 *
 * One thin trail per name, time across, rank up, today at the right edge. It
 * answers the one question the ranked list cannot: did these names arrive last
 * week, or have they been there all along.
 *
 * Geometry lives in the SVG and every label lives in HTML beside it, for the
 * same reason the price chart does it that way: the drawing stretches to the
 * container, and text inside a non-uniformly scaled viewBox comes out squashed
 * and far too small to read on a phone. Stroke widths are pinned with
 * `vector-effect` so the stretch does not thin the trails either.
 */

const W = 1000;
const H = 460;

/** Ranks 1..100 occupy the main band; everything beyond shares one lane. */
const TOP_PCT = 5;
const MID_PCT = 78;
const BEYOND_PCT = 92;
const BEYOND = 100;

/**
 * Vertical position of a rank, as a percentage of the frame.
 *
 * Shared by the SVG and the HTML axis labels so the two cannot drift: an axis
 * that disagrees with the trails by a few pixels is worse than no axis.
 */
function yPct(rank) {
  if (rank === null || rank > BEYOND) return BEYOND_PCT;
  return TOP_PCT + ((rank - 1) / (BEYOND - 1)) * (MID_PCT - TOP_PCT);
}

const yUnits = (rank) => (yPct(rank) / 100) * H;

/**
 * One trail, broken wherever the name has no rank.
 *
 * A gap means the name had not listed yet that far back. Bridging it would
 * draw a line through prices that never existed.
 */
function trailPath(ranks) {
  const n = ranks.length;
  let d = '';
  let pen = false;
  ranks.forEach((rank, i) => {
    if (rank === null) { pen = false; return; }
    const x = (i / (n - 1)) * W;
    const y = yUnits(rank);
    d += `${pen ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`;
    pen = true;
  });
  return d;
}

export function renderRankRiver(app) {
  app.replaceChildren();
  document.body.classList.remove('has-bar');

  const head = document.createElement('header');
  head.className = 'head';
  const back = document.createElement('a');
  back.className = 'back';
  back.href = '#';
  back.textContent = '‹ Labs';
  back.addEventListener('click', (e) => { e.preventDefault(); navigate('labs'); });
  head.append(back);
  head.insertAdjacentHTML('beforeend', `<h1>Rank River <span class="as-of">experiment</span></h1>`);
  app.append(head);

  const body = document.createElement('div');
  body.className = 'lab';
  body.innerHTML = '<p class="loading">Loading rank history…</p>';
  app.append(body);

  return loadRankHistory()
    .then((history) => draw(body, history))
    .catch(() => {
      body.replaceChildren();
      body.insertAdjacentHTML('beforeend',
        `<p class="loading">No rank history in this build.<br>
         It is produced by the daily refresh; a checkout without it shows this instead.</p>`);
    });
}

function draw(body, history) {
  const id = `${state.score}|${state.mode}`;
  const view = history.views?.[id];
  body.replaceChildren();

  if (!view || view.symbols.length === 0) {
    body.insertAdjacentHTML('beforeend',
      `<p class="loading">No history for the ${SCORE_LABELS[state.score]} view.</p>`);
    return;
  }

  const sessions = history.sessions;
  const span = sessions.length;

  // The view this follows is the one the list is on, so the drawing and the
  // ranking always agree about which twenty names are in question.
  body.insertAdjacentHTML('beforeend',
    `<p class="lab-note">The top ${view.symbols.length} on
     <b>${SCORE_LABELS[state.score]}${state.mode === 'voladj' ? ', vol-adjusted' : ''}</b>,
     over the last ${span} sessions. Today is the right edge.</p>`);

  const wrap = document.createElement('div');
  wrap.className = 'river-wrap';

  // --- axis labels, in HTML so they stay legible -----------------------------
  const axis = document.createElement('div');
  axis.className = 'river-axis';
  for (const rank of [1, 25, 50, 75, 100]) {
    axis.insertAdjacentHTML('beforeend',
      `<span style="top:${yPct(rank).toFixed(2)}%">#${rank}</span>`);
  }
  axis.insertAdjacentHTML('beforeend',
    `<span class="beyond" style="top:${BEYOND_PCT.toFixed(2)}%">&gt;100</span>`);

  // --- the drawing -----------------------------------------------------------
  const gridlines = [1, 25, 50, 75, 100]
    .map((r) => `<line class="river-grid" x1="0" y1="${yUnits(r).toFixed(1)}" x2="${W}" y2="${yUnits(r).toFixed(1)}" />`)
    .join('');
  const trails = view.symbols
    .map((symbol, n) =>
      `<path class="river-trail" data-symbol="${escapeHtml(symbol)}" d="${trailPath(view.ranks[n])}" />`)
    .join('');

  const svg = `<svg class="river" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img"
    aria-label="Rank of the top ${view.symbols.length} names over ${span} sessions, today at the right">
    ${gridlines}
    <line class="river-split" x1="0" y1="${yUnits(BEYOND).toFixed(1)}" x2="${W}" y2="${yUnits(BEYOND).toFixed(1)}" />
    ${trails}
    <line class="river-today" x1="${W}" y1="0" x2="${W}" y2="${H}" />
  </svg>`;

  wrap.innerHTML = svg;
  wrap.append(axis);
  body.append(wrap);

  body.insertAdjacentHTML('beforeend',
    `<div class="river-dates"><span>${escapeHtml(sessions[0])}</span><span>today</span></div>`);

  // --- the names, tappable ---------------------------------------------------
  const chips = document.createElement('div');
  chips.className = 'river-names';
  let selected = null;

  const paint = () => {
    wrap.querySelectorAll('.river-trail').forEach((p) => {
      p.classList.toggle('on', selected !== null && p.dataset.symbol === selected);
      p.classList.toggle('off', selected !== null && p.dataset.symbol !== selected);
    });
    chips.querySelectorAll('button').forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset.symbol === selected));
    });
  };

  view.symbols.forEach((symbol, n) => {
    const ranks = view.ranks[n];
    const today = ranks[ranks.length - 1];
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.symbol = symbol;
    b.setAttribute('aria-pressed', 'false');
    b.innerHTML = `<span class="r">#${today ?? '—'}</span> ${escapeHtml(symbol)}`;
    b.addEventListener('click', () => {
      // Tapping the selected name clears it, so there is always a way back to
      // seeing all twenty.
      selected = selected === symbol ? null : symbol;
      paint();
    });
    chips.append(b);
  });
  body.append(chips);

  body.insertAdjacentHTML('beforeend',
    `<p class="foot"><b>These are backfilled ranks, not a record of what this screen showed.</b>
     Each session is re-scored from prices as of that day, against today's eligible universe and
     today's size and liquidity gates — the product keeps no daily archive. Ranks beyond #100 share
     the bottom lane. A gap in a trail is a name that had not listed yet.</p>`);

  // The view control lives on the list, and this screen follows it; offering a
  // second copy here would be a second place to change the same thing.
  const backToList = document.createElement('button');
  backToList.type = 'button';
  backToList.className = 'wl-clear';
  backToList.textContent = 'Change view on the list';
  backToList.addEventListener('click', () => { syncHash(''); navigate(''); });
  body.append(backToList);
}
