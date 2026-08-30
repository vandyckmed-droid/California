/**
 * Builds the data the field prototypes read. Run from the repo root:
 *   node lab/field/build.mjs
 *
 * Experimental. Writes only into lab/field/data/.
 */
import fs from 'node:fs';
import zlib from 'node:zlib';

const ROOT = process.cwd();
const OUT = `${ROOT}/lab/field/data`;
const snap = JSON.parse(fs.readFileSync(`${ROOT}/web/data/snapshot.json`, 'utf8'));
const c = snap.columns;
const N = c.symbol.length;

/* ---- product's own ranking, imported not reimplemented ---- */
const { scoresFor, ranksFor } = await import(`${ROOT}/web/lib/model.js`);
const rank = (k, m) => ranksFor(scoresFor(snap, k, m), c.symbol);
const R = { h12: rank('h12_1', 'raw'), h9: rank('h9_1', 'raw'), h6: rank('h6_1', 'raw'),
            bl: rank('blend', 'raw'), blv: rank('blend', 'voladj') };

/* ---- correlation-grade returns for every name ---- */
const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
function decode(b) {
  const w = b.w ?? 2, top = A.length ** w - 1, span = b.hi - b.lo, out = [];
  for (let i = 0; i + w <= b.points.length; i += w) {
    let lv = 0;
    for (let k = 0; k < w; k++) lv = lv * A.length + A.indexOf(b.points[i + k]);
    out.push(b.lo + (span * lv) / top);
  }
  return out;
}
const rets = [];
for (let i = 0; i < N; i++) {
  const f = JSON.parse(fs.readFileSync(`${ROOT}/web/data/series/${c.symbol[i]}.json`, 'utf8'));
  const px = decode(f.correlation);
  const r = [];
  for (let k = 1; k < px.length; k++) r.push(px[k] / px[k - 1] - 1);
  rets.push(r);
}
const DAYS = Math.min(...rets.map((r) => r.length));
console.log(`decoded ${N} names x ${DAYS} sessions`);

/* ---- the spectrogram image -------------------------------------------------
   Two passes over the same returns.

   `abs` standardises each name by its own volatility, so shape survives and
   size does not. It is dominated by the market: every name shares most of every
   day, so the picture is mostly vertical stripes — the days — and the rows all
   look alike whatever order they are in.

   `res` subtracts each session's cross-sectional mean first, which is a crude
   one-factor market model. What is left is what a name did *differently* from
   the market that day, and that is the only part correlation grouping is about.
   This is the pass where a group becomes visible as a band.                    */
function pack(rows) {
  const out = new Uint8Array(N * DAYS);
  for (let i = 0; i < N; i++) {
    const r = rows[i];
    let m = 0; for (let k = 0; k < DAYS; k++) m += r[k];
    m /= DAYS;
    let v = 0; for (let k = 0; k < DAYS; k++) v += (r[k] - m) ** 2;
    const sd = Math.sqrt(v / (DAYS - 1)) || 1e-9;
    for (let k = 0; k < DAYS; k++) {
      const z = Math.max(-3, Math.min(3, (r[k] - m) / sd));
      out[i * DAYS + k] = Math.round(((z + 3) / 6) * 255);
    }
  }
  return out;
}
const absRows = rets.map((r) => r.slice(0, DAYS));
const dayMean = new Float64Array(DAYS);
for (let k = 0; k < DAYS; k++) {
  let s = 0; for (let i = 0; i < N; i++) s += absRows[i][k];
  dayMean[k] = s / N;
}
const resRows = absRows.map((r) => r.map((v, k) => v - dayMean[k]));
const PASS = { abs: pack(absRows), res: pack(resRows) };
console.log('market factor: mean |daily cross-sectional mean| =',
  (dayMean.reduce((a, v) => a + Math.abs(v), 0) / DAYS * 100).toFixed(2) + '%');

/* minimal 8-bit greyscale PNG */
function crc32(buf) {
  let t = crc32.t;
  if (!t) {
    t = crc32.t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let ch = n;
      for (let k = 0; k < 8; k++) ch = ch & 1 ? 0xedb88320 ^ (ch >>> 1) : ch >>> 1;
      t[n] = ch;
    }
  }
  let ch = -1;
  for (let i = 0; i < buf.length; i++) ch = t[(ch ^ buf[i]) & 0xff] ^ (ch >>> 8);
  return (ch ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(w, h, gray) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  // Filter 2 (Up): consecutive rows are near-identical inside a correlation
  // group, which is the whole point of the picture, so the filter that encodes
  // row-to-row difference is also the one that compresses it best.
  const raw = Buffer.alloc(h * (w + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w + 1)] = 2;
    for (let x = 0; x < w; x++) {
      const cur = gray[y * w + x], up = y ? gray[(y - 1) * w + x] : 0;
      raw[y * (w + 1) + 1 + x] = (cur - up) & 0xff;
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* three row orderings of the same image */
const ids65 = snap.clusters.ids[1];
const bySize = new Map();
for (let i = 0; i < N; i++) if (ids65[i] >= 0) bySize.set(ids65[i], (bySize.get(ids65[i]) ?? 0) + 1);
const orderRank = [...Array(N).keys()].sort((a, b) => R.bl[a] - R.bl[b]);
const orderCluster = [...Array(N).keys()].sort((a, b) => {
  const ga = ids65[a], gb = ids65[b];
  const sa = ga < 0 ? 0 : bySize.get(ga), sb = gb < 0 ? 0 : bySize.get(gb);
  return sb - sa || (ga - gb) || R.bl[a] - R.bl[b];
});
const orderSector = [...Array(N).keys()].sort((a, b) => c.sector[a] - c.sector[b] || R.bl[a] - R.bl[b]);

for (const [pass, px] of Object.entries(PASS)) {
  for (const [name, order] of [['rank', orderRank], ['cluster', orderCluster], ['sector', orderSector]]) {
    const g = new Uint8Array(N * DAYS);
    order.forEach((src, y) => g.set(px.subarray(src * DAYS, src * DAYS + DAYS), y * DAYS));
    const buf = png(DAYS, N, g);
    fs.writeFileSync(`${OUT}/spectro-${pass}-${name}.png`, buf);
    console.log(`  spectro-${pass}-${name}.png  ${(buf.length / 1024).toFixed(0)} KB`);
  }
}

/* ---- row legends, so the image can be labelled and probed ---- */
const legend = (order) => order.map((i) => ({
  s: c.symbol[i], r: R.bl[i], g: ids65[i], sec: c.sector[i],
}));
fs.writeFileSync(`${OUT}/spectro-index.json`, JSON.stringify({
  days: DAYS, n: N, sectors: c.sectors,
  order: { rank: legend(orderRank), cluster: legend(orderCluster), sector: legend(orderSector) },
}));

/* ---- territories: every group, for the cartogram ---- */
const members = new Map();
for (let i = 0; i < N; i++) { const g = ids65[i]; if (g < 0) continue;
  if (!members.has(g)) members.set(g, []); members.get(g).push(i); }
const territories = [...members.entries()].map(([g, mem]) => {
  mem.sort((a, b) => R.bl[a] - R.bl[b]);
  const cnt = {}; mem.forEach((i) => { cnt[c.sector[i]] = (cnt[c.sector[i]] ?? 0) + 1; });
  return {
    g, size: mem.length, best: R.bl[mem[0]],
    sec: Number(Object.entries(cnt).sort((a, b) => b[1] - a[1])[0][0]),
    cap: Math.round(mem.reduce((a, i) => a + c.marketCapM[i], 0)),
    top: mem.slice(0, 5).map((i) => c.symbol[i]),
    inTop100: mem.filter((i) => R.bl[i] <= 100).length,
  };
}).sort((a, b) => a.best - b.best);
const solos = [...Array(N).keys()].filter((i) => ids65[i] < 0 && R.bl[i] <= 400)
  .map((i) => ({ s: c.symbol[i], r: R.bl[i], sec: c.sector[i], cap: c.marketCapM[i] }));
fs.writeFileSync(`${OUT}/territories.json`, JSON.stringify({ territories, solos, sectors: c.sectors }));

/* ---- the top 100, for the broadsheet ---- */
const top100 = orderRank.slice(0, 100).map((i) => ({
  s: c.symbol[i], n: c.name[i], r: R.bl[i], sec: c.sectors[c.sector[i]],
  r12: R.h12[i], r6: R.h6[i], m: Math.round(c.m[0][i] * 100), rv: Math.round(c.rv[0][i] * 100),
  cap: Math.round(c.marketCapM[i]), g: ids65[i], gs: ids65[i] >= 0 ? bySize.get(ids65[i]) : 1,
}));
fs.writeFileSync(`${OUT}/top100.json`, JSON.stringify(top100));

/* ---- one name's full display series, for the telescope ---- */
function decDisplay(b) {
  const w = b.w ?? 1, top = A.length ** w - 1, span = b.hi - b.lo, out = [];
  for (let i = 0; i + w <= b.points.length; i += w) {
    let lv = 0;
    for (let k = 0; k < w; k++) lv = lv * A.length + A.indexOf(b.points[i + k]);
    out.push(b.lo + (span * lv) / top);
  }
  return out;
}
const scopeSyms = ['MU', 'DMRA', 'ALMS', 'VOR', 'ORKA', 'AEM'];
const bySym = new Map(c.symbol.map((s, i) => [s, i]));
fs.writeFileSync(`${OUT}/telescope.json`, JSON.stringify({
  dates: snap.meta.chartDates, anchors: snap.meta.anchors, params: snap.meta.params,
  names: scopeSyms.map((s) => {
    const i = bySym.get(s);
    return { s, n: c.name[i], px: decDisplay(JSON.parse(
      fs.readFileSync(`${ROOT}/web/data/series/${s}.json`, 'utf8')).display).map((v) => Math.round(v * 1000) / 1000),
      r12: R.h12[i], r9: R.h9[i], r6: R.h6[i] };
  }),
}));

console.log('wrote', fs.readdirSync(OUT).join(', '));

/* ---- MOCK rank history -----------------------------------------------------
   THIS IS INVENTED DATA. The product keeps one snapshot and no archive, so no
   real rank history exists to draw. Day 60 is anchored to the real blend ranks
   so the right-hand edge of any drawing built on this is true; everything to
   the left of it is a seeded random walk with mean reversion, and is fiction.
   It exists so a movement concept can be judged as a drawing before anyone
   decides whether to start storing the real thing.                            */
let seed = 20260828;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const gauss = () => {
  let u = 0, v = 0;
  while (u === 0) u = rnd();
  while (v === 0) v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};
const DAYS_H = 60;
const tracked = orderRank.slice(0, 20);

/* An Ornstein-Uhlenbeck walk in log-rank, generated backwards from today.
   The first attempt was a plain random walk with a pull toward the endpoint,
   and it produced something no ranking has ever looked like: every path
   slamming into the #1 ceiling and a converging funnel at the right-hand edge.
   Real ranks are persistent — a name at #5 is near #5 next week — so the walk
   needs strong mean reversion around its own level and small steps, with the
   drift that matters supplied deliberately rather than by noise. */
const STORY = {
  0: { kind: 'arrival', from: 380 },   // climbs into the leaders over the window
  3: { kind: 'collapse', to: 240 },    // was a leader, has been sliding
  7: { kind: 'arrival', from: 150 },
  11: { kind: 'collapse', to: 90 },
};
const history = tracked.map((idx, k) => {
  const end = R.bl[idx];
  const story = STORY[k];
  // Where the path started, in log-rank.
  const x1 = Math.log(end);
  const x0 = Math.log(story?.kind === 'arrival' ? story.from
    : story?.kind === 'collapse' ? Math.max(1, Math.round(end / 6))
    : Math.max(1, end * (0.65 + rnd() * 0.7)));
  const path = new Array(DAYS_H);
  for (let d = 0; d < DAYS_H; d++) {
    const t = d / (DAYS_H - 1);
    // A smooth level to walk around, plus persistent noise on top of it.
    const level = x0 + (x1 - x0) * (t * t * (3 - 2 * t));
    path[d] = level;
  }
  let noise = 0;
  for (let d = 0; d < DAYS_H; d++) {
    noise = noise * 0.86 + gauss() * 0.075;
    path[d] = Math.max(1, Math.round(Math.exp(path[d] + noise)));
  }
  path[DAYS_H - 1] = end;                       // the one real point
  return { s: c.symbol[idx], sec: c.sector[idx], g: ids65[idx], path,
           story: story?.kind ?? 'steady' };
});
fs.writeFileSync(`${OUT}/mock-history.json`, JSON.stringify({
  MOCK: true,
  disclaimer: 'Invented. Only the final session is real; the path is a seeded mean-reverting walk.',
  days: DAYS_H, names: history,
}));
console.log('  mock-history.json (INVENTED DATA, final session real)');
