/**
 * The three concept renderers.
 *
 * Every figure drawn here already exists in the snapshot. Nothing is fetched,
 * derived from a new pipeline output, or approximated: the vol-adjusted comb
 * reads `columns.zv`, which the pipeline already ships per horizon, rather than
 * scaling the raw comb by a fudge factor.
 */

const SVG = 'http://www.w3.org/2000/svg';

/* ------------------------------------------------------------------ ranks -- */

/**
 * Per-horizon ranks under both modes, from the product's own scoring and
 * ranking functions rather than a second implementation.
 *
 * The first draft here ranked on `columns.zr` / `columns.zv` instead, on the
 * README's statement that normalisation is monotonic and so "does not reorder
 * any single horizon". Measured against the shipped `scoresFor`, that disagreed
 * on 1,085 of 15,432 rank cells. Winsorising at the 1st/99th percentile clips
 * the tails to a single value, so the z-score *ties* 26 names at each end and
 * the symbol tie-break then alphabetises them: ranking 12-1 on `zr` opens the
 * list ALMS · ANRO · AXTI · BFLY rather than SNDK · AXTI · ERAS · DMRA. The
 * product is right and the sentence in the README is not; see
 * `notes/winsorised-ranks.md`.
 *
 * @param {any} snapshot
 * @param {(s:any,k:string,m:string)=>number[]} scoresFor
 * @param {(scores:number[],symbols:string[])=>number[]} ranksFor
 */
export function horizonRanks(snapshot, scoresFor, ranksFor) {
  const keys = ['h12_1', 'h9_1', 'h6_1'];
  const per = (/** @type {string} */ mode) =>
    keys.map((k) => ranksFor(scoresFor(snapshot, k, mode), snapshot.columns.symbol));
  return { raw: per('raw'), voladj: per('voladj') };
}

/* ------------------------------------------------------- concept 1: comb -- */

/**
 * Tooth height from rank, on a log axis.
 *
 * A linear percentile is unusable here: with 2,572 eligible names, #1 and #100
 * differ by 3.8% of the axis, so every comb in the part of the list anyone
 * actually looks at flattens into the same rectangle. Log spends the axis where
 * the readers are.
 *
 * @param {number} rank
 * @param {number} n universe size
 */
export function toothHeight(rank, n) {
  return Math.max(0, 1 - Math.log(Math.max(1, Math.min(rank, n))) / Math.log(n));
}

/** Drift is judged on the same log axis the teeth use, so it is scale-free: a
 *  20-place move at the front is a real move, the same 20 places at #1,500 is
 *  not. */
const DRIFT_BAND = 0.035;

/**
 * @param {{r12:number,r9:number,r6:number}} ranks
 * @param {number} n
 * @param {number} viewedHorizon 0|1|2, or -1 under the blend
 */
export function comb(ranks, n, viewedHorizon = -1) {
  const W = 54, H = 26, base = H - 3, top = 3;
  const xs = [9, 27, 45];
  const hs = [ranks.r12, ranks.r9, ranks.r6].map((r) => toothHeight(r, n));
  const y = (h) => base - h * (base - top);

  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('class', 'comb');
  svg.setAttribute('width', String(W));
  svg.setAttribute('height', String(H));
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('aria-hidden', 'true');

  const rule = document.createElementNS(SVG, 'line');
  rule.setAttribute('x1', '4'); rule.setAttribute('x2', String(W - 4));
  rule.setAttribute('y1', String(base + 0.5)); rule.setAttribute('y2', String(base + 0.5));
  rule.setAttribute('class', 'comb-base');
  svg.append(rule);

  const drift = hs[2] - hs[0];
  const dir = drift > DRIFT_BAND ? 'up' : drift < -DRIFT_BAND ? 'dn' : 'flat';

  hs.forEach((h, i) => {
    const t = document.createElementNS(SVG, 'line');
    t.setAttribute('x1', String(xs[i])); t.setAttribute('x2', String(xs[i]));
    t.setAttribute('y1', String(base)); t.setAttribute('y2', String(y(h)));
    t.setAttribute('class', `comb-tooth${i === viewedHorizon ? ' on' : ''}`);
    svg.append(t);
  });

  const spine = document.createElementNS(SVG, 'polyline');
  spine.setAttribute('points', hs.map((h, i) => `${xs[i]},${y(h)}`).join(' '));
  spine.setAttribute('class', `comb-spine ${dir}`);
  svg.append(spine);

  return { svg, dir, drift };
}

/* --------------------------------------------- concept 2: same-trade rail -- */

/**
 * Twelve hues, and collisions are accepted.
 *
 * Colour alone cannot separate 360 groups and does not have to: two groups
 * sharing a hue two hundred rows apart is invisible and harmless. The n-of-m
 * mark carries the whole message without colour, so it survives a colour-blind
 * reader and a greyscale screenshot; the hue only has to tie together rows that
 * are close enough to see at once. A first pass crossed the hues with four dash
 * patterns to reach 48 combinations, and it read as a rendering fault on a 5px
 * rail — noise bought to fix a collision the badge had already fixed.
 */
const RAIL_HUES = [172, 28, 262, 96, 340, 208, 44, 300, 128, 12, 240, 76];

/** @param {number} groupId */
export function railStyle(groupId) {
  return { hue: RAIL_HUES[groupId % RAIL_HUES.length] };
}

/**
 * Group membership over whatever rows are currently listed.
 *
 * Deliberately computed over the filtered list, not the universe: a group of
 * fourteen semicap names is a group of two once you filter to $50B+, and
 * claiming "3 of 14" beside two visible rows would be describing a list the
 * reader cannot see. The mark always counts what is in front of them.
 *
 * @param {{i:number}[]} rows rows in rank order, already filtered
 * @param {number[]} ids cluster id per universe index at the chosen threshold
 * @returns {Map<number, {ordinal:number, size:number, groupId:number}>} by row index
 */
export function railMarks(rows, ids) {
  /** @type {Map<number, number[]>} */
  const members = new Map();
  for (const row of rows) {
    const g = ids[row.i];
    if (g < 0) continue;
    if (!members.has(g)) members.set(g, []);
    members.get(g)?.push(row.i);
  }
  /** @type {Map<number, {ordinal:number,size:number,groupId:number}>} */
  const marks = new Map();
  for (const [g, list] of members) {
    if (list.length < 2) continue;
    list.forEach((i, k) => marks.set(i, { ordinal: k + 1, size: list.length, groupId: g }));
  }
  return marks;
}

/* -------------------------------------------------- concept 3: the weave -- */

/**
 * Contiguous runs on the diagonal that clear the threshold on *every* internal
 * pair.
 *
 * A chain test is cheaper and wrong: it draws a box around a block whose own
 * fill visibly contradicts it, because complete linkage — the rule the pipeline
 * asserts on every run — requires all pairs, not a path through them.
 *
 * @param {number[][]} m correlation matrix, ordered so groups are adjacent
 * @param {number} thr
 */
export function weaveBlocks(m, thr) {
  const n = m.length;
  const allPairs = (a, b) => {
    for (let r = a; r <= b; r++) for (let c = r + 1; c <= b; c++) if (m[r][c] < thr) return false;
    return true;
  };
  const blocks = [];
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && allPairs(i, j + 1)) j++;
    if (j > i) blocks.push([i, j]);
    i = j + 1;
  }
  return blocks;
}

/**
 * Effective number of independent bets, from the mean pairwise correlation.
 * At mean 0 it is n; at mean 1 it is 1. Stated as a description of the names
 * picked, in the wording the watchlist already uses for its risk figures.
 * @param {number[][]} m
 */
export function effectiveBets(m) {
  const n = m.length;
  if (n < 2) return n;
  let sum = 0, count = 0;
  for (let r = 0; r < n; r++) for (let c = r + 1; c < n; c++) { sum += m[r][c]; count++; }
  const mean = sum / count;
  return 1 / (1 / n + (1 - 1 / n) * Math.max(0, mean));
}

/**
 * Order names so that anything grouped sits together, groups in best-rank
 * order. Without it the slabs are scattered across the square and the whole
 * point of drawing it as cloth is lost.
 * @param {string[]} syms
 * @param {{members:number[]}[]} groups indices into syms
 */
export function weaveOrder(syms, groups) {
  const seen = new Set();
  const out = [];
  for (const g of groups) {
    for (const k of g.members) { if (!seen.has(k)) { seen.add(k); out.push(k); } }
  }
  syms.forEach((_, k) => { if (!seen.has(k)) out.push(k); });
  return out;
}
