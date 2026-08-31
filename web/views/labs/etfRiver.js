import { goBack } from '../../app.js';
import { escapeHtml } from '../list.js';

/**
 * ETF River — a year of relative momentum leadership across ~20 industry ETFs.
 *
 * Height is the blended cross-sectional z-score, not a rank: zero is the middle
 * of the group on that day, the distance from it is how far ahead or behind,
 * and the right edge is today. Rank would compress a runaway leader into the
 * same one place it always occupies; this keeps the gap visible, which is the
 * difference between "still first" and "pulling away".
 *
 * Everything the experiment needs is in this file and its sidecar. It shares no
 * module with the Rank River experiment beyond the two the whole product uses,
 * because two drawings that both look like rivers are not the same drawing and
 * coupling them would make either one hard to remove.
 *
 * Geometry lives in the SVG and every label lives in HTML beside it: the
 * drawing stretches to the container, and text inside a non-uniformly scaled
 * viewBox comes out squashed. Stroke widths are pinned with `vector-effect` so
 * the stretch does not thin the trails either.
 */

const W = 1000;
const H = 460;
/** Space kept above and below the extreme trails, in viewBox units. */
const PAD = 16;

/**
 * How many funds carry a name at the right edge.
 *
 * Not all of them, and the reason is measured rather than aesthetic: today's
 * scores occupy about half the chart's height, while twenty-two legible labels
 * need more than three quarters of it. Forcing them all in pushes every label
 * away from its own line until the column is evenly spaced and says nothing —
 * a label that no longer sits at its value is worse than no label. So the edge
 * names the ends, which is what "who is leading" means, and the ordered list
 * below names everything. The selected fund is always labelled.
 */
const LABEL_TOP = 5;
const LABEL_BOTTOM = 3;

/**
 * Roughly how many points each trail is drawn through.
 *
 * The signal itself moves slowly — its shortest window is 105 trading days —
 * but drawn at one point per session, twenty-two trails put 5,544 vertices into
 * a phone-width chart and the day-to-day wiggle becomes the loudest thing on
 * screen. Sampling to about one point a week is a drawing decision and nothing
 * more: every drawn point is a real session's score, the latest session is
 * always the last one, and no value is averaged or invented.
 */
const TARGET_POINTS = 56;

/**
 * The sidecar loader.
 *
 * Local to this file on purpose: this is the only thing that knows the file
 * exists, so deleting the experiment deletes the only reference to it. Core
 * never imports this module.
 */
let pending = null;

function loadEtfRiver() {
  if (!pending) {
    pending = fetch('data/labs/etf-river.json', { cache: 'no-cache' }).then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    });
    // A failed load must not be cached, or the screen is broken for the session.
    pending.catch(() => { pending = null; });
  }
  return pending;
}

/** The drawn range: symmetric around zero, so "above the middle" reads as one thing. */
function domainOf(blend) {
  let max = 0;
  for (const path of blend) for (const v of path) if (v !== null && Math.abs(v) > max) max = Math.abs(v);
  // The extent of the data itself; `PAD` supplies the breathing room. Rounding
  // out to the next whole z would leave a band of empty chart at both edges,
  // which on a phone is the scarcest thing there is.
  return Math.max(1.5, max);
}

const yUnits = (v, domain) => H / 2 - (v / domain) * (H / 2 - PAD);
const yPct = (v, domain) => (yUnits(v, domain) / H) * 100;

/** Session indices every trail is drawn through, always ending on the latest. */
function drawnIndices(n) {
  const stride = Math.max(1, Math.round(n / TARGET_POINTS));
  const out = [];
  // Counted back from the newest session so the right edge is exact and the
  // ragged end, if any, falls at the old edge where it means nothing.
  for (let i = n - 1; i >= 0; i -= stride) out.push(i);
  return out.reverse();
}

/**
 * One trail, broken wherever the fund has no score.
 *
 * A gap is a date the signal could not be computed — a missing bar, or history
 * that does not reach back far enough. Bridging it would draw a line through
 * data that was never there.
 */
function trailPath(values, domain, indices) {
  // A one-session river has no width to divide by. It cannot happen with a
  // sidecar this program wrote, but a NaN path renders as nothing at all and
  // says nothing about why.
  const n = Math.max(2, values.length);
  let d = '';
  let pen = false;
  for (const i of indices) {
    const v = values[i];
    if (v === null) { pen = false; continue; }
    const x = (i / (n - 1)) * W;
    d += `${pen ? 'L' : 'M'}${x.toFixed(1)},${yUnits(v, domain).toFixed(1)}`;
    pen = true;
  }
  return d;
}

/**
 * Pushes overlapping right-edge labels apart while keeping their order.
 *
 * Labels are the only way to read which trail is which, so a stack of them on
 * top of each other at the right edge is the difference between a legible
 * chart and a decorative one. Positions are nudged, never reordered: a label
 * that jumped above one it should sit below would misreport leadership.
 *
 * @param {number[]} pos    Ideal positions, in percent, in label order.
 * @param {number} gap      Minimum separation, in percent.
 */
function spreadLabels(pos, gap) {
  const out = pos.slice();
  const n = out.length;
  const lo = 0;
  const hi = 100;
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 1; i < n; i++) out[i] = Math.max(out[i], out[i - 1] + gap);
    if (out[n - 1] > hi) {
      out[n - 1] = hi;
      for (let i = n - 2; i >= 0; i--) out[i] = Math.min(out[i], out[i + 1] - gap);
    }
    if (out[0] < lo) out[0] = lo;
  }
  return out;
}

export function renderEtfRiver(app) {
  app.replaceChildren();
  document.body.classList.remove('has-bar');

  const head = document.createElement('header');
  head.className = 'head';
  const back = document.createElement('a');
  back.className = 'back';
  back.href = '#';
  back.textContent = '‹ Labs';
  // Pops rather than pushes, like every other in-app Back link.
  back.addEventListener('click', (e) => { e.preventDefault(); goBack(); });
  head.append(back);
  head.insertAdjacentHTML('beforeend', '<h1>ETF River <span class="as-of">experiment</span></h1>');
  app.append(head);

  const body = document.createElement('div');
  body.className = 'lab';
  body.innerHTML = '<p class="loading">Loading the river…</p>';
  app.append(body);

  return loadEtfRiver()
    .then((river) => draw(body, river))
    .catch(() => {
      body.replaceChildren();
      body.insertAdjacentHTML('beforeend',
        `<p class="loading">No ETF river in this build.<br>
         Run <code>npm run labs:etf-river</code> to produce
         <code>web/data/labs/etf-river.json</code>.</p>`);
    });
}

function draw(body, river) {
  body.replaceChildren();

  const members = river.members ?? [];
  if (members.length === 0 || (river.sessions ?? []).length === 0) {
    body.insertAdjacentHTML('beforeend', '<p class="loading">The river is empty.</p>');
    return;
  }
  const domain = domainOf(river.blend);
  const today = members.map((m, i) => {
    const path = river.blend[i];
    return { i, m, now: path[path.length - 1], then: path.find((v) => v !== null) ?? null };
  });
  const ranked = today
    .filter((x) => x.now !== null)
    .sort((a, b) => b.now - a.now);

  body.insertAdjacentHTML('beforeend',
    `<p class="lab-note">Relative momentum leadership across <b>${members.length} industry
     ETFs</b> over ${river.sessions.length} sessions. Height is each fund's standing
     <b>within the group on that day</b> — zero is the group's middle, so a line rises only by
     beating the others, not by rising with the market. Today is the right edge.</p>`);

  // ---- the drawing ---------------------------------------------------------
  const wrap = document.createElement('div');
  wrap.className = 'etf-wrap';

  const grid = [];
  for (let z = -Math.floor(domain); z <= Math.floor(domain); z++) {
    if (z === 0) continue;
    grid.push(`<line class="etf-grid" x1="0" y1="${yUnits(z, domain).toFixed(1)}" x2="${W}" y2="${yUnits(z, domain).toFixed(1)}" />`);
  }

  const drawn = drawnIndices(river.sessions.length);
  const trails = members.map((m, i) =>
    `<path class="etf-trail etf-f${m.family}" data-symbol="${escapeHtml(m.symbol)}" data-family="${m.family}"
      d="${trailPath(river.blend[i], domain, drawn)}" />`).join('');
  // A 1.3px line is not a pointer target. These invisible twins carry the
  // clicks; the leaderboard below is the keyboard-and-thumb equivalent, so the
  // interaction is never mouse-only.
  const hits = members.map((m, i) =>
    `<path class="etf-hit" data-symbol="${escapeHtml(m.symbol)}"
      d="${trailPath(river.blend[i], domain, drawn)}" />`).join('');

  wrap.innerHTML = `<svg class="etf-river" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img"
    aria-label="Blended relative-strength score for ${members.length} industry ETFs over ${river.sessions.length} sessions, today at the right edge">
    ${grid.join('')}
    <line class="etf-zero" x1="0" y1="${yUnits(0, domain).toFixed(1)}" x2="${W}" y2="${yUnits(0, domain).toFixed(1)}" />
    ${trails}
    ${hits}
  </svg>`;

  const axis = document.createElement('div');
  axis.className = 'etf-axis';
  for (let z = Math.floor(domain); z >= -Math.floor(domain); z--) {
    const label = z === 0 ? '0' : `${z > 0 ? '+' : '−'}${Math.abs(z)}`;
    axis.insertAdjacentHTML('beforeend',
      `<span class="${z === 0 ? 'zero' : ''}" style="top:${yPct(z, domain).toFixed(2)}%">${label}</span>`);
  }
  wrap.append(axis);

  const edge = document.createElement('div');
  edge.className = 'etf-edge';
  wrap.append(edge);
  body.append(wrap);

  body.insertAdjacentHTML('beforeend',
    `<div class="etf-dates"><span>${escapeHtml(river.sessions[0])}</span>
     <span class="etf-hint">leaders above the line, laggards below</span>
     <span>today</span></div>`);

  // ---- the readout, and the names ------------------------------------------
  const readout = document.createElement('p');
  readout.className = 'etf-readout';
  body.append(readout);

  const legend = document.createElement('div');
  legend.className = 'etf-legend';
  river.families.forEach((f, n) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `etf-f${n}`;
    b.dataset.family = String(n);
    b.setAttribute('aria-pressed', 'false');
    b.innerHTML = `<i></i>${escapeHtml(f.label)}`;
    legend.append(b);
  });
  body.append(legend);

  const chips = document.createElement('div');
  chips.className = 'etf-names';
  for (const x of ranked) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `etf-f${x.m.family}`;
    b.dataset.symbol = x.m.symbol;
    b.setAttribute('aria-pressed', 'false');
    b.innerHTML = `<i></i>${escapeHtml(x.m.symbol)} <span class="v">${fmt(x.now)}</span>`;
    chips.append(b);
  }
  body.append(chips);

  // ---- selection -----------------------------------------------------------
  // One fund, or one family, at a time. Selecting again clears it, so there is
  // always a way back to the whole picture.
  let sel = null;

  const isOn = (symbol, family) =>
    sel === null || (sel.type === 'fund' ? sel.key === symbol : sel.key === String(family));

  const paint = () => {
    for (const p of wrap.querySelectorAll('.etf-trail')) {
      const on = isOn(p.dataset.symbol, p.dataset.family);
      p.classList.toggle('on', sel !== null && on);
      p.classList.toggle('off', sel !== null && !on);
      // SVG has no z-index: the only way to lift the emphasised trail clear of
      // the twenty-one it crosses is to move it last in the document.
      if (sel !== null && on) p.parentNode.append(p);
    }
    layoutEdge();
    for (const b of chips.querySelectorAll('button')) {
      b.setAttribute('aria-pressed', String(sel?.type === 'fund' && sel.key === b.dataset.symbol));
    }
    for (const b of legend.querySelectorAll('button')) {
      b.setAttribute('aria-pressed', String(sel?.type === 'family' && sel.key === b.dataset.family));
    }
    readout.innerHTML = describe(sel, river, today);
  };

  const select = (type, key) => {
    sel = sel && sel.type === type && sel.key === key ? null : { type, key };
    paint();
  };

  for (const p of wrap.querySelectorAll('.etf-hit')) {
    p.addEventListener('click', () => select('fund', p.dataset.symbol));
  }
  for (const b of chips.querySelectorAll('button')) {
    b.addEventListener('click', () => select('fund', b.dataset.symbol));
  }
  for (const b of legend.querySelectorAll('button')) {
    b.addEventListener('click', () => select('family', b.dataset.family));
  }

  body.insertAdjacentHTML('beforeend',
    `<p class="foot">Each date is scored on its own: two volatility-adjusted momentum legs
     (12–1 and 6–1, both ending 21 sessions back), z-scored across the ${members.length} funds and
     averaged. No volatility floor is applied — unlike the stock ranking, where the floor exists to
     stop a pinned single name being rewarded for standing still. Prices are split- and
     dividend-adjusted, and trails are drawn through roughly one session a week — every point is
     a real day, none is averaged. This is an experiment: nothing on the ranked list, the ticker screen or the
     watchlist depends on it.</p>`);

  /**
   * Draws the right-edge names for the current selection.
   *
   * Positions need the container's real height, which exists only once it is in
   * the document — and changes when the phone rotates — so this runs after the
   * first paint and again on resize, rather than being baked into the markup.
   */
  function layoutEdge() {
    const shown = ranked.filter((x, n) =>
      n < LABEL_TOP || n >= ranked.length - LABEL_BOTTOM || isSelected(x.m));
    const height = wrap.clientHeight || 340;
    // One label is ~13px tall; any closer and they overlap, at exactly the edge
    // people read first.
    const gap = Math.min(100 / Math.max(shown.length, 1), (13 / height) * 100);
    const placed = spreadLabels(shown.map((x) => yPct(x.now, domain)), gap);
    edge.replaceChildren();
    shown.forEach((x, n) => {
      const on = isOn(x.m.symbol, x.m.family);
      edge.insertAdjacentHTML('beforeend',
        `<span class="etf-tag etf-f${x.m.family}${sel === null ? '' : on ? ' on' : ' off'}"
          data-symbol="${escapeHtml(x.m.symbol)}" style="top:${placed[n].toFixed(2)}%"
          ><i></i>${escapeHtml(x.m.symbol)}</span>`);
    });
  }

  function isSelected(m) {
    return sel !== null && (sel.type === 'fund' ? sel.key === m.symbol : sel.key === String(m.family));
  }

  paint();
  window.addEventListener('resize', layoutEdge, { passive: true });
}

const fmt = (v) => (v === null ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)}`);

/** The one line under the chart. A sentence, not a statistics panel. */
function describe(sel, river, today) {
  if (sel === null) {
    const ranked = today.filter((x) => x.now !== null).sort((a, b) => b.now - a.now);
    if (ranked.length === 0) return 'No fund has a score on the latest session.';
    const top = ranked[0];
    const bottom = ranked[ranked.length - 1];
    return `Leading today: <b>${escapeHtml(top.m.symbol)}</b> ${escapeHtml(top.m.label.toLowerCase())}.
      Trailing: <b>${escapeHtml(bottom.m.symbol)}</b> ${escapeHtml(bottom.m.label.toLowerCase())}.
      Tap a fund or a family to follow it.`;
  }
  if (sel.type === 'family') {
    const family = river.families[Number(sel.key)];
    const names = today.filter((x) => x.m.family === Number(sel.key));
    const moved = names
      .filter((x) => x.now !== null && x.then !== null)
      .sort((a, b) => b.now - a.now)
      .map((x) => `${escapeHtml(x.m.symbol)} ${fmt(x.then)}→${fmt(x.now)}`);
    return `<b>${escapeHtml(family.label)}</b> over the year: ${moved.join(', ')}.`;
  }
  const x = today.find((t) => t.m.symbol === sel.key);
  const stats = river.today[x.i];
  // Leg labels come from the file, so the sentence cannot drift from the legs
  // the pipeline actually computed.
  const legs = stats
    ? ` ${river.legs.map((l, n) => `${escapeHtml(l.label)} leg ${fmt(stats.z[n])}`).join(', ')}.`
    : '';
  return `<b>${escapeHtml(x.m.symbol)}</b> ${escapeHtml(x.m.label.toLowerCase())} —
    <b>${fmt(x.now)}</b> today, ${fmt(x.then)} a year ago.${legs}`;
}
