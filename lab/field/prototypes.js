/**
 * Five prototypes, each a different way of seeing the same screen.
 *
 * Experimental. Nothing here is loaded by the product, and none of it is
 * written to be shipped as-is — the point is to find out which ways of looking
 * are worth anything before arguing about implementation.
 */

export const SECHUE = [24, 268, 38, 96, 46, 205, 330, 8, 296, 172, 132];
export const hue = (s) => SECHUE[s % SECHUE.length];

/* ============================================================ 1. SPECTROGRAM */
/**
 * 2,572 names x 126 sessions as one image: every row a name, every column a
 * session, brightness that name's return standardised by its own volatility.
 *
 * Reordering the rows is the whole interaction. Sorted by rank it is noise —
 * which is itself the finding, since rank and co-movement are unrelated axes.
 * Sorted by correlation group it resolves into horizontal bands, because names
 * that move together become literally the same stripe.
 */
export function spectrogram(host, index, srcFor) {
  const wrap = document.createElement('div');
  wrap.className = 'proto';
  wrap.innerHTML = `
    <div class="proto-ctrl">
      <div class="seg" role="group" aria-label="Row order">
        <button type="button" data-o="cluster" aria-pressed="true">order: correlation group</button>
        <button type="button" data-o="rank" aria-pressed="false">rank</button>
        <button type="button" data-o="sector" aria-pressed="false">sector</button>
      </div>
      <div class="seg" role="group" aria-label="Pass">
        <button type="button" data-p="res" aria-pressed="true">market removed</button>
        <button type="button" data-p="abs" aria-pressed="false">as traded</button>
      </div>
    </div>
    <div class="spec-split">
      <div class="spec-overview">
        <canvas id="spec" width="620" height="620"></canvas>
        <div class="spec-lens" id="lens"></div>
        <div class="spec-ax"><span>126 sessions</span><span>2,572 names</span></div>
      </div>
      <div class="spec-detail">
        <canvas id="specd" width="620" height="620"></canvas>
        <div class="spec-rows" id="rows"></div>
      </div>
    </div>
    <p class="proto-hint" id="spec-hint">Move over the left panel. The right panel is 44 rows at
      full resolution — that is where a correlation group stops being a claim.</p>`;
  host.append(wrap);

  const cv = wrap.querySelector('#spec');
  const dv = wrap.querySelector('#specd');
  const lens = wrap.querySelector('#lens');
  const rowsEl = wrap.querySelector('#rows');
  const hint = wrap.querySelector('#spec-hint');
  let order = 'cluster', pass = 'res', top = 0;
  const DETAIL = 44;
  const imgs = {};

  function key() { return `${pass}-${order}`; }

  function paintOverview() {
    const img = imgs[key()];
    if (!img) return;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const W = cv.clientWidth || 500, H = 620;
    cv.width = W * dpr; cv.height = H * dpr; cv.style.height = H + 'px';
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.imageSmoothingEnabled = true;
    g.drawImage(img, 0, 0, W, H);
    const lh = Math.max(3, (DETAIL / index.n) * H);
    lens.style.top = ((top / index.n) * H) + 'px';
    lens.style.height = lh + 'px';
  }

  function paintDetail() {
    const img = imgs[key()];
    if (!img) return;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const W = dv.clientWidth || 500, H = 620;
    dv.width = W * dpr; dv.height = H * dpr; dv.style.height = H + 'px';
    const g = dv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.imageSmoothingEnabled = false;
    // One source row per 14px band, nearest-neighbour, so a row is a row.
    g.drawImage(img, 0, top, index.days, DETAIL, 0, 0, W, H);
    const list = index.order[order].slice(top, top + DETAIL);
    rowsEl.replaceChildren();
    list.forEach((r) => {
      const d = document.createElement('div');
      d.className = 'spec-row' + (r.g >= 0 ? ' grouped' : '');
      d.innerHTML = `<span>${r.s}</span><b>${r.g >= 0 ? 'g' + r.g : '·'}</b>`;
      rowsEl.append(d);
    });
    const groups = new Map();
    list.forEach((r) => { if (r.g >= 0) groups.set(r.g, (groups.get(r.g) ?? 0) + 1); });
    const biggest = [...groups.entries()].sort((a, b) => b[1] - a[1])[0];
    hint.textContent = biggest
      ? `Rows ${top + 1}–${top + DETAIL}. Largest group in view: ${biggest[1]} names sharing group ${biggest[0]} — those rows are the same stripe.`
      : `Rows ${top + 1}–${top + DETAIL}. No grouped names in view.`;
  }

  function load() {
    const k = key();
    if (imgs[k]) { paintOverview(); paintDetail(); return; }
    const im = new Image();
    im.onload = () => { imgs[k] = im; paintOverview(); paintDetail(); };
    im.src = srcFor(pass, order);
  }

  wrap.querySelectorAll('.seg').forEach((seg) => {
    seg.querySelectorAll('button').forEach((b) => {
      b.addEventListener('click', () => {
        if (b.dataset.o) order = b.dataset.o; else pass = b.dataset.p;
        seg.querySelectorAll('button')
          .forEach((o) => o.setAttribute('aria-pressed', String(o === b)));
        load();
      });
    });
  });

  function moveTo(clientY) {
    const r = cv.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (clientY - r.top) / r.height));
    top = Math.max(0, Math.min(index.n - DETAIL, Math.round(frac * index.n - DETAIL / 2)));
    paintOverview(); paintDetail();
  }
  cv.addEventListener('mousemove', (e) => moveTo(e.clientY));
  cv.addEventListener('click', (e) => moveTo(e.clientY));

  // Open on the largest group, which is the point of the picture.
  const seq = index.order.cluster;
  let best = 0, bestRun = 0, run = 0;
  for (let i = 1; i < seq.length; i++) {
    if (seq[i].g >= 0 && seq[i].g === seq[i - 1].g) { run++; if (run > bestRun) { bestRun = run; best = i - run; } }
    else run = 0;
  }
  top = Math.max(0, best - 4);

  load();
  addEventListener('resize', () => { paintOverview(); paintDetail(); }, { passive: true });
  return wrap;
}

/* ============================================================ 2. TERRITORIES */
/**
 * The market as land rather than as a list.
 *
 * Every correlation group is a territory whose area is its member count, laid
 * out with a squarified treemap so shapes stay compact and comparable. Hue is
 * the dominant sector; a territory that reaches the top 100 is lit, and the
 * rest sit dark. Solo names are the unclaimed ground at the end.
 */
function squarify(items, x, y, w, h, out = []) {
  if (!items.length) return out;
  if (items.length === 1) { out.push({ ...items[0], x, y, w, h }); return out; }
  const total = items.reduce((a, i) => a + i.v, 0);
  let acc = 0, split = 0;
  const half = total / 2;
  for (; split < items.length - 1; split++) {
    if (acc + items[split].v > half) break;
    acc += items[split].v;
  }
  // Both sides must be non-empty or the recursion re-splits the same list for
  // ever. A run of equal-valued items never trips the half-way test, so without
  // this clamp the common case is the one that hangs.
  split = Math.min(split, items.length - 2);
  const a = items.slice(0, split + 1), b = items.slice(split + 1);
  const taken = a.reduce((s, i) => s + i.v, 0);
  const frac = total ? Math.max(0.02, Math.min(0.98, taken / total)) : 0.5;
  if (w >= h) {
    squarify(a, x, y, w * frac, h, out);
    squarify(b, x + w * frac, y, w * (1 - frac), h, out);
  } else {
    squarify(a, x, y, w, h * frac, out);
    squarify(b, x, y + h * frac, w, h * (1 - frac), out);
  }
  return out;
}

export function territories(host, data) {
  const wrap = document.createElement('div');
  wrap.className = 'proto';
  wrap.innerHTML = `
    <div class="proto-ctrl">
      <div class="seg" role="group" aria-label="Area">
        <button type="button" data-v="size" aria-pressed="true">area = names in the group</button>
        <button type="button" data-v="cap" aria-pressed="false">area = market cap</button>
      </div>
      <span class="proto-hint" id="terr-hint">${data.territories.length} territories · ${data.solos.length} solo names in the top 400</span>
    </div>
    <canvas id="terr" width="1260" height="620"></canvas>`;
  host.append(wrap);
  const cv = wrap.querySelector('#terr');
  const hint = wrap.querySelector('#terr-hint');
  let mode = 'size';
  let cells = [];

  function paint() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const W = cv.clientWidth || 900, H = 620;
    cv.width = W * dpr; cv.height = H * dpr;
    cv.style.height = H + 'px';
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const cs = getComputedStyle(document.documentElement);
    const tok = (k) => cs.getPropertyValue(k).trim();
    g.fillStyle = tok('--sunk'); g.fillRect(0, 0, W, H);

    const items = data.territories
      .map((t) => ({ ...t, v: mode === 'size' ? t.size : Math.max(1, t.cap / 1000) }))
      .sort((a, b) => b.v - a.v);
    cells = squarify(items, 0, 0, W, H);

    for (const c of cells) {
      const lit = c.inTop100 > 0;
      // Lightness carries how far forward the territory reaches, so the eye
      // finds the strong ground before it reads a single label.
      const L = lit ? 62 - Math.min(28, Math.log10(Math.max(1, c.best)) * 9) : 26;
      const S = lit ? 55 : 18;
      g.fillStyle = `hsl(${hue(c.sec)} ${S}% ${L}%)`;
      g.fillRect(c.x, c.y, c.w, c.h);
      g.strokeStyle = tok('--sunk'); g.lineWidth = 1.5;
      g.strokeRect(c.x + .75, c.y + .75, c.w - 1.5, c.h - 1.5);
      if (c.w > 52 && c.h > 26) {
        g.fillStyle = L > 45 ? 'rgba(10,12,10,.88)' : 'rgba(255,255,255,.9)';
        g.font = `600 ${Math.min(13, Math.max(9, c.w / 7))}px ui-monospace, monospace`;
        g.fillText(c.top[0], c.x + 6, c.y + 15);
        if (c.h > 42) {
          g.font = '10px ui-monospace, monospace';
          g.globalAlpha = .8;
          g.fillText(`${c.size} · #${c.best}`, c.x + 6, c.y + 29);
          g.globalAlpha = 1;
        }
      }
    }
  }

  cv.addEventListener('mousemove', (e) => {
    const r = cv.getBoundingClientRect();
    const x = (e.clientX - r.left) * (cv.clientWidth / r.width);
    const y = (e.clientY - r.top) * (620 / r.height);
    const c = cells.find((c) => x >= c.x && x < c.x + c.w && y >= c.y && y < c.y + c.h);
    hint.textContent = c
      ? `${c.top.join(' · ')}${c.size > 5 ? ` +${c.size - 5}` : ''} — ${c.size} names, best #${c.best}, ${data.sectors[c.sec]}`
      : `${data.territories.length} territories · ${data.solos.length} solo names in the top 400`;
  });

  wrap.querySelectorAll('.seg button').forEach((b) => {
    b.addEventListener('click', () => {
      mode = b.dataset.v;
      wrap.querySelectorAll('.seg button')
        .forEach((o) => o.setAttribute('aria-pressed', String(o === b)));
      paint();
    });
  });
  paint();
  addEventListener('resize', paint, { passive: true });
  return wrap;
}

/* ============================================================== 3. TELESCOPE */
/**
 * One chart, three horizons, no tabs.
 *
 * The x-axis is compressed in *sessions before now* — a 0.7 power — so the
 * recent past is stretched and last autumn squeezed. The three windows are
 * nested by construction and stay nested; what changes is that the increments
 * between them, and the 21 sessions the ranking deliberately throws away, get
 * real estate proportional to how much they matter rather than to how long they
 * are.
 */
export function telescope(host, data) {
  const wrap = document.createElement('div');
  wrap.className = 'proto';
  const buttons = data.names.map((n, i) =>
    `<button type="button" data-i="${i}" aria-pressed="${i === 0}">${n.s}</button>`).join('');
  wrap.innerHTML = `
    <div class="proto-ctrl">
      <div class="seg" role="group" aria-label="Name">${buttons}</div>
      <span class="proto-hint" id="tel-hint"></span>
    </div>
    <canvas id="tel" width="1260" height="380"></canvas>`;
  host.append(wrap);
  const cv = wrap.querySelector('#tel');
  const hint = wrap.querySelector('#tel-hint');
  let pick = 0;

  function paint() {
    const n = data.names[pick];
    const px = n.px, T = px.length;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const W = cv.clientWidth || 900, H = 380;
    cv.width = W * dpr; cv.height = H * dpr;
    cv.style.height = H + 'px';
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const cs = getComputedStyle(document.documentElement);
    const tok = (k) => cs.getPropertyValue(k).trim();
    g.clearRect(0, 0, W, H);

    const padL = 12, padR = 12, padT = 18, padB = 62;
    const iw = W - padL - padR, ih = H - padT - padB;
    // age 0 = today, age T-1 = oldest, drawn right to left on a compressed axis.
    //
    // A true log axis was the first attempt and it is far too aggressive: log1p
    // hands the skipped 21 sessions 56% of the frame, which trades one
    // distortion for a worse one. A 0.7 power gives the skip about 18% against
    // linear time's 8% — visible, without letting the month the ranking
    // deliberately ignores take over the picture.
    const maxAge = T - 1;
    const EXP = 0.7;
    const x = (age) => padL + iw * (1 - Math.pow(age / maxAge, EXP));
    const lo = Math.min(...px), hi = Math.max(...px);
    const y = (v) => padT + ih * (1 - (v - lo) / ((hi - lo) || 1));

    const SKIP = data.params.horizons.h12_1.skip;
    const WINS = [
      ['12–1', data.params.horizons.h12_1.lookback, n.r12],
      ['9–1', data.params.horizons.h9_1.lookback, n.r9],
      ['6–1', data.params.horizons.h6_1.lookback, n.r6],
    ];
    // window bands, widest first so the narrower ones sit on top
    WINS.forEach(([label, look], k) => {
      const x0 = x(look), x1 = x(SKIP);
      g.fillStyle = tok('--ink');
      g.globalAlpha = 0.05 + k * 0.035;
      g.fillRect(x0, padT, x1 - x0, ih);
      g.globalAlpha = 1;
    });
    // the skipped month
    g.fillStyle = tok('--neg'); g.globalAlpha = .10;
    g.fillRect(x(SKIP), padT, x(0) - x(SKIP), ih);
    g.globalAlpha = 1;

    // price
    g.beginPath();
    for (let i = 0; i < T; i++) {
      const age = T - 1 - i;
      const X = x(age), Y = y(px[i]);
      i ? g.lineTo(X, Y) : g.moveTo(X, Y);
    }
    g.strokeStyle = tok('--ink'); g.lineWidth = 1.8;
    g.lineJoin = 'round'; g.stroke();

    // window labels along the bottom
    g.font = '600 11px ui-monospace, monospace';
    WINS.forEach(([label, look, rank], k) => {
      const x0 = x(look), x1 = x(SKIP);
      const yy = H - padB + 15 + k * 13;
      g.strokeStyle = tok('--ink2'); g.lineWidth = 1;
      g.beginPath(); g.moveTo(x0, yy); g.lineTo(x1, yy); g.stroke();
      g.fillStyle = tok('--ink2');
      g.fillText(`${label}  #${rank}`, x0 + 5, yy - 4);
    });
    g.fillStyle = tok('--neg');
    g.font = '600 10px ui-monospace, monospace';
    g.fillText('skip 21', x(SKIP) + 4, padT + 12);

    // age ticks
    g.fillStyle = tok('--ink3'); g.font = '10px ui-monospace, monospace';
    [1, 5, 21, 63, 126, 252].filter((a) => a <= maxAge).forEach((a) => {
      g.fillText(`${a}d`, x(a) - 6, H - 6);
      g.strokeStyle = tok('--rule2'); g.lineWidth = 1;
      g.beginPath(); g.moveTo(x(a), padT); g.lineTo(x(a), H - padB); g.stroke();
    });
    hint.textContent = `${n.n} — 12–1 #${n.r12} · 9–1 #${n.r9} · 6–1 #${n.r6}`;
  }

  wrap.querySelectorAll('.seg button').forEach((b) => {
    b.addEventListener('click', () => {
      pick = Number(b.dataset.i);
      wrap.querySelectorAll('.seg button')
        .forEach((o) => o.setAttribute('aria-pressed', String(o === b)));
      paint();
    });
  });
  paint();
  addEventListener('resize', paint, { passive: true });
  return wrap;
}

/* ============================================================== 4. BROADSHEET */
/**
 * The top 100 as a page of type and nothing else.
 *
 * Size is rank, so the leaders are physically large and the tail is fine print;
 * weight is how much of a name's twelve-month standing survives into six; the
 * superscript is how many names are in its correlation group. No chart, no
 * chrome, no colour doing any work colour has to do alone. It reads like a
 * front page, which is a claim that a ranked list is an editorial object.
 */
export function broadsheet(host, top100) {
  const wrap = document.createElement('div');
  wrap.className = 'proto';
  wrap.innerHTML = `
    <div class="proto-ctrl">
      <span class="proto-hint">Size = rank · weight = how much of the 12–1 standing survives into 6–1
        · <sup>n</sup> = names in its correlation group</span>
    </div>
    <div class="sheet-page" id="sheet"></div>`;
  host.append(wrap);
  const page = wrap.querySelector('#sheet');
  const N = 2572;
  const univ = (r) => 1 - Math.log(Math.max(1, r)) / Math.log(N);

  top100.forEach((t) => {
    const a = document.createElement('span');
    a.className = 'sheet-item';
    // Scaled against the top 100, not the universe: measured against 2,572
    // names every one of these hundred is near the ceiling, and the page comes
    // out uniformly enormous. Within the hundred, #1 is twice #10 is twice #100.
    const strength = 1 - Math.log(Math.max(1, t.r)) / Math.log(100);
    const size = 10 + Math.max(0, strength) * 27;
    // Survival: how much of the twelve-month standing is still there at six.
    const surv = Math.max(0, Math.min(1, univ(t.r6) / (univ(t.r12) || 1)));
    a.style.fontSize = size.toFixed(1) + 'px';
    a.style.fontWeight = String(300 + Math.round(surv * 5) * 100);
    a.style.opacity = String(0.4 + surv * 0.6);
    a.innerHTML = `${t.s}${t.gs > 1 ? `<sup>${t.gs}</sup>` : ''}`;
    a.title = `${t.n} — #${t.r} blend, 12–1 #${t.r12}, 6–1 #${t.r6}`;
    page.append(a);
    // A real space, so the line has somewhere to break. Without it the hundred
    // names are one unbreakable word and the page runs off the screen.
    page.append(document.createTextNode(' '));
  });
  return wrap;
}

/* ============================================================== 5. RANK RIVER */
/**
 * Where the top 20 have been, as a braid.
 *
 * **The path is invented.** Only the right-hand edge is real. Drawn so a
 * movement concept can be judged as a drawing before anyone decides whether the
 * pipeline should start keeping the history it would need.
 */
export function river(host, mock) {
  const wrap = document.createElement('div');
  wrap.className = 'proto';
  wrap.innerHTML = `
    <p class="mockflag"><b>Mock data.</b> The product keeps one snapshot and no archive, so no
      rank history exists. Only the final session on the right is real; every path leading to it
      is a seeded random walk. Shown to judge the drawing, not the market.</p>
    <canvas id="river" width="1260" height="560"></canvas>`;
  host.append(wrap);
  const cv = wrap.querySelector('#river');

  function paint() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const W = cv.clientWidth || 900, H = 560;
    cv.width = W * dpr; cv.height = H * dpr;
    cv.style.height = H + 'px';
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const cs = getComputedStyle(document.documentElement);
    const tok = (k) => cs.getPropertyValue(k).trim();
    g.clearRect(0, 0, W, H);

    const padL = 14, padR = 82, padT = 18, padB = 26;
    const iw = W - padL - padR, ih = H - padT - padB;
    const D = mock.days;
    const x = (d) => padL + (d / (D - 1)) * iw;
    const maxR = Math.max(...mock.names.flatMap((n) => n.path));
    const y = (r) => padT + (Math.log(Math.max(1, r)) / Math.log(maxR)) * ih;

    g.strokeStyle = tok('--rule2'); g.lineWidth = 1;
    [1, 10, 50, 200, 600].filter((r) => r <= maxR).forEach((r) => {
      g.beginPath(); g.moveTo(padL, y(r)); g.lineTo(W - padR, y(r)); g.stroke();
      g.fillStyle = tok('--ink3'); g.font = '10px ui-monospace, monospace';
      g.fillText('#' + r, padL + 2, y(r) - 3);
    });

    for (const n of mock.names) {
      g.beginPath();
      n.path.forEach((r, d) => {
        const X = x(d), Y = y(r);
        if (!d) g.moveTo(X, Y);
        else {
          const pX = x(d - 1), pY = y(n.path[d - 1]);
          g.bezierCurveTo(pX + (X - pX) / 2, pY, pX + (X - pX) / 2, Y, X, Y);
        }
      });
      const end = n.path[D - 1];
      // The two stories the sketch is really testing — a name arriving and a
      // name collapsing — are drawn heavier, because the question is whether
      // those two paths are findable in a braid at all.
      const story = n.story && n.story !== 'steady';
      g.strokeStyle = `hsl(${hue(n.sec)} 58% 47% / ${story ? .95 : .5})`;
      g.lineWidth = story ? 2.6 : 1.3;
      g.stroke();
    }
    // Labels, spread so none sits on another: twenty names converging on the
    // top of a log axis put half of them inside twenty pixels.
    g.font = '600 10.5px ui-monospace, monospace';
    const labels = mock.names
      .map((n) => ({ n, want: y(n.path[D - 1]) }))
      .sort((a, b) => a.want - b.want);
    labels.forEach((L) => { L.y = L.want; });
    for (let i = 1; i < labels.length; i++) {
      if (labels[i].y - labels[i - 1].y < 12) labels[i].y = labels[i - 1].y + 12;
    }
    labels.forEach((L) => {
      g.strokeStyle = `hsl(${hue(L.n.sec)} 55% 48% / .55)`;
      g.lineWidth = 1;
      g.beginPath(); g.moveTo(W - padR + 1, L.want); g.lineTo(W - padR + 5, L.y); g.stroke();
      g.fillStyle = tok('--ink');
      g.fillText(L.n.s, W - padR + 8, L.y + 3.5);
    });
    g.fillStyle = tok('--ink3'); g.font = '10px ui-monospace, monospace';
    g.fillText('60 sessions ago (invented)', padL, H - 6);
    g.textAlign = 'right';
    g.fillText('today (real)', W - padR - 4, H - 6);
    g.textAlign = 'left';
  }
  paint();
  addEventListener('resize', paint, { passive: true });
  return wrap;
}

/* ========================================================== 6. THRESHOLD DIAL */
/**
 * How much of the grouping is structure and how much is where the line was drawn.
 *
 * The product offers three thresholds and treats them as three settings. Swept
 * continuously instead, each distinct member-set has a *lifetime* — the band of
 * rho over which it exists unchanged. Drawn as a barcode, a long bar is a group
 * that would survive any reasonable choice; a short one is an artefact.
 *
 * This is a persistence diagram, borrowed from topology, and it is the only
 * drawing here that treats a parameter as a dimension rather than a control.
 */
export function dial(host, data) {
  const wrap = document.createElement('div');
  wrap.className = 'proto';
  wrap.innerHTML = `
    <div class="proto-ctrl">
      <label class="dialer">
        <span>&rho;</span>
        <input type="range" id="rho" min="50" max="90" value="65" step="1">
        <output id="rho-out" class="mono">0.65</output>
      </label>
      <span class="proto-hint" id="dial-hint"></span>
    </div>
    <canvas id="dial" width="1260" height="600"></canvas>
    <div class="dial-list" id="dial-list"></div>`;
  host.append(wrap);
  const cv = wrap.querySelector('#dial');
  const sl = wrap.querySelector('#rho');
  const out = wrap.querySelector('#rho-out');
  const hint = wrap.querySelector('#dial-hint');
  const list = wrap.querySelector('#dial-list');
  let thr = 0.65;

  const bars = data.bars;
  const nameAt = (k) => data.names[k];

  function paint() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const W = cv.clientWidth || 900, H = 600;
    cv.width = W * dpr; cv.height = H * dpr; cv.style.height = H + 'px';
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const cs = getComputedStyle(document.documentElement);
    const tok = (k) => cs.getPropertyValue(k).trim();
    g.clearRect(0, 0, W, H);

    const padL = 118, padR = 16, padT = 30, padB = 34;
    const iw = W - padL - padR, ih = H - padT - padB;
    const x = (r) => padL + ((r - 0.5) / 0.4) * iw;
    const rowH = ih / bars.length;

    // rho grid
    g.font = '10px ui-monospace, monospace';
    for (let r = 0.5; r <= 0.9001; r += 0.05) {
      const isSet = Math.abs(r - 0.6) < 1e-9 || Math.abs(r - 0.65) < 1e-9 || Math.abs(r - 0.7) < 1e-9;
      g.strokeStyle = isSet ? tok('--border-strong') : tok('--rule2') || tok('--border');
      g.lineWidth = 1;
      g.setLineDash(isSet ? [] : [2, 3]);
      g.beginPath(); g.moveTo(x(r), padT - 8); g.lineTo(x(r), H - padB + 2); g.stroke();
      g.setLineDash([]);
      g.fillStyle = isSet ? tok('--text') : tok('--faint');
      g.textAlign = 'center';
      g.fillText(r.toFixed(2), x(r), padT - 13);
    }
    g.textAlign = 'left';
    g.fillStyle = tok('--faint');
    g.fillText('the three thresholds the product ships are the solid lines', padL, H - 8);

    bars.forEach((b, i) => {
      const y = padT + i * rowH;
      const h = Math.max(1.4, rowH - 1.2);
      const live = thr >= b.lo && thr <= b.hi;
      // Lightness is span: robust groups are solid, fragile ones nearly ghosts.
      const strength = Math.min(1, b.span / 0.22);
      g.fillStyle = live
        ? `hsl(${hue(nameAt(b.m[0]).sec)} 58% ${44 + (1 - strength) * 22}%)`
        : tok('--border');
      g.globalAlpha = live ? 1 : 0.35 + strength * 0.3;
      g.fillRect(x(b.lo), y, Math.max(2, x(b.hi) - x(b.lo)), h);
      g.globalAlpha = 1;
      // Label only the rows worth reading. Seventy-six labels in 600px collide
      // into a grey smear, and the ones that matter are the bars alive under the
      // dial — the rest are context, and context does not need naming.
      if (live && rowH > 5.5) {
        g.fillStyle = tok('--text');
        g.font = '600 9.5px ui-monospace, monospace';
        g.textAlign = 'right';
        const label = b.m.slice(0, 2).map((k) => nameAt(k).s).join(' ') +
          (b.size > 2 ? ` +${b.size - 2}` : '');
        g.fillText(label.slice(0, 17), padL - 6, y + h / 2 + 3);
        g.textAlign = 'left';
      }
    });

    // the dial itself
    g.strokeStyle = tok('--accent-strong'); g.lineWidth = 2;
    g.beginPath(); g.moveTo(x(thr), padT - 8); g.lineTo(x(thr), H - padB + 2); g.stroke();

    const liveBars = bars.filter((b) => thr >= b.lo && thr <= b.hi);
    const robust = liveBars.filter((b) => b.span >= 0.1).length;
    hint.textContent =
      `${liveBars.length} groups at this threshold · ${robust} of them survive a 0.10-wide sweep`;

    list.replaceChildren();
    liveBars.slice(0, 10).forEach((b) => {
      const d = document.createElement('div');
      d.className = 'dial-row' + (b.span >= 0.1 ? ' robust' : '');
      d.innerHTML =
        `<b>${b.m.map((k) => nameAt(k).s).join(' · ')}</b>` +
        `<span>&rho; ${b.lo.toFixed(2)}–${b.hi.toFixed(2)}` +
        `${b.span >= 0.1 ? ' · robust' : ' · fragile'}</span>`;
      list.append(d);
    });
  }

  sl.addEventListener('input', () => {
    thr = Number(sl.value) / 100;
    out.textContent = thr.toFixed(2);
    paint();
  });
  paint();
  addEventListener('resize', paint, { passive: true });
  return wrap;
}

/* ========================================================== 7. GRAVITY BASKET */
/**
 * A basket that arranges itself.
 *
 * Every selected name is a body. Pairs pull on each other with a force
 * proportional to how far their correlation clears the threshold, and everything
 * repels everything else. Left alone the basket settles into clumps, and the
 * number of clumps is the number of distinct bets — arrived at physically rather
 * than asserted as a statistic.
 *
 * The interaction that matters is adding a name: it either flies into an
 * existing clump, which is the duplicate-bet warning, or it settles in open
 * space, which is the only visual the product has ever had for "this is new".
 */
export function basket(host, data) {
  const wrap = document.createElement('div');
  wrap.className = 'proto';
  wrap.innerHTML = `
    <div class="proto-ctrl">
      <label class="dialer">
        <span>&rho;</span>
        <input type="range" id="brho" min="45" max="85" value="60" step="1">
        <output id="brho-out" class="mono">0.60</output>
      </label>
      <div class="seg" role="group" aria-label="Size">
        <button type="button" data-z="equal" aria-pressed="true">equal weight</button>
        <button type="button" data-z="cap" aria-pressed="false">size = market cap</button>
      </div>
      <button type="button" class="reheat" id="reheat">shake</button>
    </div>
    <canvas id="basket" width="1260" height="600"></canvas>
    <p class="proto-hint" id="b-hint"></p>`;
  host.append(wrap);
  const cv = wrap.querySelector('#basket');
  const hint = wrap.querySelector('#b-hint');
  const sl = wrap.querySelector('#brho');
  const out = wrap.querySelector('#brho-out');
  let thr = 0.60, sizeMode = 'equal', raf = 0;

  const N = data.syms.length;
  const nodes = data.syms.map((s, i) => ({
    s, i, sec: data.meta[i].sec, r: data.meta[i].r, cap: data.meta[i].cap,
    x: 0, y: 0, vx: 0, vy: 0,
  }));

  function seed() {
    nodes.forEach((n, i) => {
      const a = (i / N) * Math.PI * 2;
      n.x = Math.cos(a) * 190 + (Math.random() - 0.5) * 24;
      n.y = Math.sin(a) * 150 + (Math.random() - 0.5) * 24;
      n.vx = 0; n.vy = 0;
    });
  }
  seed();

  /** Connected components at the current threshold: the clump count. */
  function components() {
    const seen = new Array(N).fill(-1);
    let c = 0;
    for (let i = 0; i < N; i++) {
      if (seen[i] >= 0) continue;
      const stack = [i]; seen[i] = c;
      while (stack.length) {
        const a = stack.pop();
        for (let b = 0; b < N; b++) {
          if (seen[b] < 0 && data.m[a][b] >= thr) { seen[b] = c; stack.push(b); }
        }
      }
      c++;
    }
    return { label: seen, count: c };
  }

  function radius(n) {
    return sizeMode === 'equal' ? 15
      : 9 + Math.min(26, Math.sqrt(Math.max(1, n.cap)) / 26);
  }

  function step() {
    for (let a = 0; a < N; a++) {
      const A = nodes[a];
      for (let b = a + 1; b < N; b++) {
        const B = nodes[b];
        let dx = B.x - A.x, dy = B.y - A.y;
        let d = Math.hypot(dx, dy) || 0.01;
        const ux = dx / d, uy = dy / d;
        // Attraction only above the line, and proportional to how far above.
        const rho = data.m[a][b];
        const pull = rho >= thr ? (rho - thr) * 0.9 : 0;
        const want = pull > 0 ? 46 : 150;
        // Repulsion keeps unrelated names apart and stops clumps collapsing.
        const rep = 1600 / (d * d);
        const f = pull * (d - want) * 0.0016 - rep;
        A.vx += ux * f; A.vy += uy * f;
        B.vx -= ux * f; B.vy -= uy * f;
      }
      // Weak centring so the basket does not drift off frame.
      A.vx -= A.x * 0.0042; A.vy -= A.y * 0.0042;
      A.vx *= 0.86; A.vy *= 0.86;
      A.x += A.vx; A.y += A.vy;
    }
  }

  function paint() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const W = cv.clientWidth || 900, H = 600;
    if (cv.width !== Math.round(W * dpr)) {
      cv.width = W * dpr; cv.height = H * dpr; cv.style.height = H + 'px';
    }
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const cs = getComputedStyle(document.documentElement);
    const tok = (k) => cs.getPropertyValue(k).trim();
    g.clearRect(0, 0, W, H);
    g.save();
    g.translate(W / 2, H / 2);

    const { label, count } = components();

    // bonds
    for (let a = 0; a < N; a++) for (let b = a + 1; b < N; b++) {
      const rho = data.m[a][b];
      if (rho < thr) continue;
      const A = nodes[a], B = nodes[b];
      g.strokeStyle = tok('--accent-strong');
      g.globalAlpha = 0.14 + Math.min(1, (rho - thr) / 0.3) * 0.5;
      g.lineWidth = 0.7 + Math.min(1, (rho - thr) / 0.3) * 2.6;
      g.beginPath(); g.moveTo(A.x, A.y); g.lineTo(B.x, B.y); g.stroke();
    }
    g.globalAlpha = 1;

    for (const n of nodes) {
      const rr = radius(n);
      const solo = label.filter((l) => l === label[n.i]).length === 1;
      g.beginPath(); g.arc(n.x, n.y, rr, 0, 7);
      g.fillStyle = solo ? tok('--surface') : `hsl(${hue(n.sec)} 52% 48%)`;
      g.fill();
      g.strokeStyle = solo ? tok('--border-strong') : 'rgba(0,0,0,.22)';
      g.lineWidth = solo ? 1.6 : 1;
      g.stroke();
      g.fillStyle = solo ? tok('--muted') : '#fff';
      g.font = `600 ${Math.max(8.5, Math.min(11, rr * 0.72))}px ui-monospace, monospace`;
      g.textAlign = 'center';
      g.fillText(n.s, n.x, n.y + 3.5);
    }
    g.textAlign = 'left';
    g.restore();

    const solos = [...new Set(label)].filter((c) =>
      label.filter((l) => l === c).length === 1).length;
    hint.innerHTML = `<b>${N} names → ${count} distinct bets</b> at &rho; &ge; ${thr.toFixed(2)}` +
      ` · ${solos} of them stand alone · the clumps are the duplicate bets`;
  }

  function loop() {
    step(); paint();
    raf = requestAnimationFrame(loop);
  }
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduced) { for (let k = 0; k < 400; k++) step(); paint(); }
  else loop();

  sl.addEventListener('input', () => {
    thr = Number(sl.value) / 100;
    out.textContent = thr.toFixed(2);
    // A threshold change is a change of physics, so let it re-settle visibly.
    nodes.forEach((n) => { n.vx += (Math.random() - .5) * 3; n.vy += (Math.random() - .5) * 3; });
    if (reduced) { for (let k = 0; k < 400; k++) step(); paint(); }
  });
  wrap.querySelectorAll('.seg button').forEach((b) => {
    b.addEventListener('click', () => {
      sizeMode = b.dataset.z;
      wrap.querySelectorAll('.seg button')
        .forEach((o) => o.setAttribute('aria-pressed', String(o === b)));
      if (reduced) paint();
    });
  });
  wrap.querySelector('#reheat').addEventListener('click', () => {
    seed();
    if (reduced) { for (let k = 0; k < 400; k++) step(); paint(); }
  });
  return wrap;
}
