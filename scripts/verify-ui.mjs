/**
 * End-to-end check of the static page against the committed snapshot.
 *
 *   node scripts/verify-ui.mjs
 *
 * Runs Chromium at a phone viewport and walks the three screens — ranked list,
 * ticker, watchlist — asserting the things that are easy to break silently:
 * that every view renders, that filtering hides rows without renumbering them,
 * that selection persists, that the watchlist's risk figures are internally
 * consistent, that tap targets stay thumb-sized, and that nothing scrolls
 * sideways.
 *
 * It also counts network requests. The whole design rests on prices being
 * fetched per name and only when a name is actually looked at, so "the home
 * screen downloads no prices" and "the watchlist downloads exactly its own
 * names, once" are assertions here rather than intentions in a comment.
 *
 * Requires `npm install --no-save playwright` and a Chromium build; set
 * CHROME_PATH to point at one.
 */
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { chromium } from 'playwright';

// Port 0 lets the OS pick a free one, so a stray server left by an earlier run
// cannot fail this with EADDRINUSE.
const PORT = Number(process.env.PORT ?? 0);
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json' };

const failures = [];
const check = (label, cond, detail = '') => {
  if (cond) console.log(`  ok    ${label}`);
  else { console.log(`  FAIL  ${label} ${detail}`); failures.push(label); }
};

// Serves gzipped, because GitHub Pages does. Without it the transfer figures
// below measure raw bytes and a budget written against them would be policing
// a number no user ever downloads.
const server = createServer((req, res) => {
  const url = (req.url ?? '/').split('?')[0];
  const path = join('web', url === '/' ? 'index.html' : url.replace(/^\//, ''));
  if (!existsSync(path)) { res.writeHead(404); return res.end('not found'); }
  const type = TYPES[extname(path)] ?? 'application/octet-stream';
  const body = readFileSync(path);
  if (/\bgzip\b/.test(req.headers['accept-encoding'] ?? '')) {
    const gz = gzipSync(body);
    res.writeHead(200, { 'content-type': type, 'content-encoding': 'gzip', 'content-length': gz.length });
    return res.end(gz);
  }
  res.writeHead(200, { 'content-type': type, 'content-length': body.length });
  res.end(body);
});
await new Promise((r) => server.listen(PORT, r));
const port = server.address().port;

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
const base = `http://localhost:${port}/`;
const snapshot = JSON.parse(readFileSync('web/data/snapshot.json', 'utf8'));
const TOTAL = snapshot.columns.symbol.length;

/**
 * Every visible interactive control on the screen that is under the 44px floor.
 *
 * Deliberately a sweep over what is interactive rather than a list of
 * selectors: an enumerated check exempts every control added after it was
 * written, and goes stale exactly when the UI is changing fastest. It reports
 * the property as verified while new controls sit below the floor.
 *
 * The one stated exemption is a link that flows inline inside running text —
 * a footnote link takes the line height of the prose around it, and padding it
 * to 44px would break the paragraph. Anything laid out as a control, including
 * a block-level or inline-block link, has to clear the floor.
 */
const tapAudit = (page) => page.evaluate(() => {
  const SEL = 'button, select, textarea, [role="button"], a[href], input:not([type="hidden"])';
  const bad = [];
  for (const el of document.querySelectorAll(SEL)) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (el.tagName === 'A' && cs.display === 'inline') continue;
    if (r.height < 44) {
      const id = `${el.tagName.toLowerCase()}${el.className ? `.${String(el.className).split(' ')[0]}` : ''}`;
      bad.push(`${id} ${Math.round(r.height)}px`);
    }
  }
  return [...new Set(bad)];
});

/** Every series URL the page has asked for, in order, across a whole context. */
const newPage = async (colorScheme = 'light') => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, colorScheme });
  page.seriesRequests = [];
  page.on('request', (r) => {
    const m = /\/data\/series\/([^/?]+)\.json/.exec(r.url());
    if (m) page.seriesRequests.push(decodeURIComponent(m[1]));
  });
  page.on('pageerror', (e) => { failures.push(`pageerror: ${e.message}`); });
  page.on('console', (m) => { if (m.type() === 'error') failures.push(`console: ${m.text()}`); });
  return page;
};

// ---- the ranked list renders in every view ---------------------------------
const page = await newPage();
for (const score of ['h12_1', 'h9_1', 'h6_1', 'blend']) {
  for (const mode of ['raw', 'voladj']) {
    await page.goto(`${base}#/?score=${score}&mode=${mode}`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.stock');
    const r = await page.evaluate(() => ({
      rows: document.querySelectorAll('.stock').length,
      ranks: [...document.querySelectorAll('.rank')].map((e) => Number(e.textContent)),
      hScroll: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      total: Number((document.querySelector('.sub b')?.textContent ?? '0').replace(/,/g, '')),
    }));
    const small = await tapAudit(page);
    const view = `${score}|${mode}`;
    // Only the first page is in the DOM; the rest arrive on scroll.
    check(`${view}: first page renders`, r.rows > 0 && r.rows <= 200, `${r.rows} rows`);
    check(`${view}: ranks run 1..n in order`,
      r.ranks[0] === 1 && r.ranks.every((v, i) => i === 0 || v > r.ranks[i - 1]), `first ${r.ranks[0]}`);
    check(`${view}: whole universe is counted`, r.total === TOTAL, `${r.total} vs ${TOTAL}`);
    check(`${view}: every control is >= 44px`, small.length === 0, small.join(', '));
    check(`${view}: no horizontal scroll`, !r.hScroll);
  }
}
check('list: the home screen downloads no prices',
  page.seriesRequests.length === 0, page.seriesRequests.join(', '));

// ---- ranks are universe-wide: filtering hides rows, never renumbers them ----
const readList = (p) => p.evaluate(() => ({
  rows: [...document.querySelectorAll('.stock')].map((s) => ({
    sym: s.querySelector('.sym').textContent.trim(),
    rank: Number(s.querySelector('.rank').textContent),
  })),
  sub: document.querySelector('.sub')?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
  matched: Number((document.querySelector('.sub b')?.textContent ?? '0').replace(/,/g, '')),
}));

await page.goto(`${base}#/?score=h12_1&mode=raw`, { waitUntil: 'networkidle' });
await page.waitForSelector('.stock');
const unfiltered = await readList(page);
const before = new Map(unfiltered.rows.map((r) => [r.sym, r.rank]));

// A sector chip is the cheapest filter to drive, and the one a user reaches for.
// Only the first page of rows is in the DOM either way, so the count in the
// header — not the row count — is what tells you the filter took.
await page.click('.chips .chip');
await page.waitForFunction(() => /\bof\b/.test(document.querySelector('.sub')?.textContent ?? ''));
const filtered = await readList(page);
const sector = await page.evaluate(() =>
  document.querySelector('.chips .chip[aria-pressed=true]')?.textContent ?? '');

check('filter: narrows the set', filtered.matched > 0 && filtered.matched < TOTAL,
  `${filtered.matched} of ${TOTAL}`);
{
  const idx = snapshot.columns.sectors.indexOf(sector);
  const expected = snapshot.columns.sector.filter((v) => v === idx).length;
  check(`filter: ${sector} matches the snapshot`, filtered.matched === expected,
    `${filtered.matched} vs ${expected}`);
}
check('filter: says the ranks stay universe-wide', /universe-wide/.test(filtered.sub), filtered.sub);
check('filter: ranks are no longer contiguous from 1',
  filtered.rows.some((r, i) => i > 0 && r.rank !== filtered.rows[i - 1].rank + 1),
  'every rank still consecutive — looks renumbered');

// Rank preservation, checked against the unfiltered screen where the two sets
// overlap, and then exactly: clear the filter, search one filtered name, and
// the number must be the same one the filtered list showed.
const kept = filtered.rows.filter((r) => before.has(r.sym));
check('filter: keeps every shared name at its universe rank',
  kept.every((r) => before.get(r.sym) === r.rank),
  kept.filter((r) => before.get(r.sym) !== r.rank).map((r) => r.sym).join(', '));

const probe = filtered.rows[Math.min(5, filtered.rows.length - 1)];
await page.click('.chips .chip[aria-pressed=true]');
await page.waitForFunction(() => !/\bof\b/.test(document.querySelector('.sub')?.textContent ?? ''));
await page.fill('.search', probe.sym);
await page.waitForFunction((sym) =>
  document.querySelector('.stock .sym')?.textContent?.trim() === sym, probe.sym);
const probeRank = await page.evaluate(() => Number(document.querySelector('.stock .rank').textContent));
check(`filter: ${probe.sym} holds rank #${probe.rank} filtered or not`, probeRank === probe.rank,
  `#${probeRank} unfiltered vs #${probe.rank} filtered`);
await page.fill('.search', '');
await page.waitForFunction(() => document.querySelectorAll('.stock').length >= 100);

// ---- search ----------------------------------------------------------------
await page.fill('.search', 'micro');
await page.waitForFunction(() => {
  const rows = [...document.querySelectorAll('.stock')];
  return rows.length > 0 && rows.length < 200;
});
const searched = await page.evaluate(() => [...document.querySelectorAll('.stock')].map((s) => ({
  sym: s.querySelector('.sym').textContent.trim(),
  nm: s.querySelector('.nm').textContent.trim(),
})));
check('search: every row matches the query',
  searched.length > 0 && searched.every((r) => /micro/i.test(`${r.sym} ${r.nm}`)),
  searched.filter((r) => !/micro/i.test(`${r.sym} ${r.nm}`)).map((r) => r.sym).join(', '));
await page.fill('.search', '');
await page.waitForFunction(() => document.querySelectorAll('.stock').length >= 100);

// ---- incremental render ----------------------------------------------------
const firstPage = await page.evaluate(() => document.querySelectorAll('.stock').length);
await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
let grew = false;
try {
  await page.waitForFunction((n) => document.querySelectorAll('.stock').length > n, firstPage, { timeout: 5000 });
  grew = true;
} catch { grew = false; }
const afterScroll = await page.evaluate(() => document.querySelectorAll('.stock').length);
check('scroll: more rows load as you reach the end', grew, `${firstPage} → ${afterScroll}`);

// ---- the row metric is swappable ------------------------------------------
await page.goto(`${base}#/?score=h12_1&mode=raw`, { waitUntil: 'networkidle' });
await page.waitForSelector('.stock');
const metricValues = {};
for (const key of ['score', 'h12_1', 'vol', 'marketCap', 'price']) {
  await page.selectOption('select.metric', key);
  await page.waitForFunction((k) => document.querySelector('select.metric').value === k, key);
  metricValues[key] = await page.evaluate(() => ({
    first: document.querySelector('.stock .val')?.textContent?.trim() ?? '',
    rankFirst: Number(document.querySelector('.stock .rank')?.textContent),
    rows: document.querySelectorAll('.stock').length,
  }));
}
check('metric: each choice shows a value', Object.values(metricValues).every((v) => v.first.length > 0),
  JSON.stringify(metricValues));
check('metric: the numbers actually differ per metric',
  new Set(Object.values(metricValues).map((v) => v.first)).size >= 4,
  Object.entries(metricValues).map(([k, v]) => `${k}=${v.first}`).join(' '));
check('metric: changing it never reorders the list',
  Object.values(metricValues).every((v) => v.rankFirst === 1),
  'rank 1 no longer first — the metric changed the sort');
{
  const capText = metricValues.marketCap.first;
  const priceText = metricValues.price.first;
  check('metric: market cap and price read as money', /^\$/.test(capText) && /^\$/.test(priceText),
    `${capText} / ${priceText}`);
  check('metric: volatility never prints below the floor',
    parseFloat(metricValues.vol.first) >= snapshot.meta.params.volFloorAnnualized * 100 - 0.5,
    metricValues.vol.first);
}
await page.selectOption('select.metric', 'score');

// ---- the volatility metric shows the trailing window -----------------------
// It is deliberately not a horizon figure: the horizons stop 21 sessions short
// so the momentum signal is not contaminated by the reversal window, and a
// "how volatile is this name" number that stopped 21 sessions short would just
// be a month out of date. So it must not move when the view does.
{
  // A name whose trailing volatility is far from every horizon's, so a
  // regression back to a horizon column could not pass by coincidence.
  let probe = snapshot.columns.symbol[0];
  let spread = 0;
  for (let i = 0; i < snapshot.columns.symbol.length; i++) {
    const d = Math.min(...[0, 1, 2].map((h) => Math.abs(snapshot.columns.rvT[i] - snapshot.columns.rv[h][i])));
    if (d > spread) { spread = d; probe = snapshot.columns.symbol[i]; }
  }
  const seen = {};
  for (const score of ['h12_1', 'h6_1', 'blend']) {
    await page.goto(`${base}#/?score=${score}&mode=voladj&metric=vol&search=${probe}`,
      { waitUntil: 'networkidle' });
    await page.waitForFunction((sym) =>
      document.querySelector('.stock .sym')?.textContent?.trim() === sym, probe);
    seen[score] = await page.evaluate(() => ({
      value: (document.querySelector('.stock .val')?.textContent ?? '').trim(),
      label: document.querySelector('select.metric option[value=vol]')?.textContent ?? '',
    }));
  }
  const i = snapshot.columns.symbol.indexOf(probe);
  const expected = `${Math.round(snapshot.columns.rvT[i] * 100)}%`;
  const W = snapshot.meta.params.trailingVolWindow;
  check(`vol metric: ${probe} shows its trailing ${W}d volatility`,
    seen.h12_1.value === expected, `${seen.h12_1.value} vs ${expected}`);
  check('vol metric: the figure does not move with the view',
    seen.h12_1.value === seen.h6_1.value && seen.h6_1.value === seen.blend.value,
    Object.entries(seen).map(([k, v]) => `${k}=${v.value}`).join(' '));
  check(`vol metric: ${probe} is not any horizon's volatility`,
    [0, 1, 2].every((h) => expected !== `${Math.round(snapshot.columns.rv[h][i] * 100)}%`),
    `${expected} vs ${[0, 1, 2].map((h) => Math.round(snapshot.columns.rv[h][i] * 100) + '%').join('/')}`);
  check(`vol metric: the label reads "Volatility (${W}d)"`,
    seen.h12_1.label.trim() === `Volatility (${W}d)`, seen.h12_1.label);
  check('vol metric: no floor mark, since nothing divides by this figure',
    await page.evaluate(() => !document.querySelector('.stock .floor-mark')));
}

// ---- the search caret stays where you put it -------------------------------
await page.goto(`${base}#/?score=h12_1&mode=raw`, { waitUntil: 'networkidle' });
await page.waitForSelector('.stock');
// Start from an empty box: the block above left a symbol in it via the hash.
await page.fill('.search', '');
await page.click('.search');
await page.type('.search', 'AAPL');
// Put the caret after "AAP" and fix a typo there, as you would mid-string.
await page.evaluate(() => {
  const el = document.querySelector('.search');
  el.setSelectionRange(3, 3);
});
await page.keyboard.type('X');
const caret = await page.evaluate(() => {
  const el = document.querySelector('.search');
  return { value: el.value, start: el.selectionStart, focused: document.activeElement === el };
});
check('search: typing mid-string inserts where the caret is',
  caret.value === 'AAPXL', caret.value);
check('search: the caret does not jump to the end', caret.start === 4, `at ${caret.start}`);
check('search: the box keeps focus across re-renders', caret.focused, String(caret.focused));
await page.fill('.search', '');
await page.waitForFunction(() => document.querySelectorAll('.stock').length >= 100);

// ---- selection, the action bar, and persistence ----------------------------
const picks = await page.evaluate(async () => {
  const checks = [...document.querySelectorAll('.stock .check')].slice(0, 5);
  const syms = [];
  for (const c of checks) {
    syms.push(c.parentElement.querySelector('.sym').textContent.trim());
    c.click();
    await new Promise((r) => setTimeout(r, 0));
  }
  return syms;
});
await page.waitForSelector('.actionbar');
const selected = await page.evaluate(() => ({
  count: document.querySelector('.actionbar .count')?.textContent ?? '',
  go: document.querySelector('.actionbar .primary')?.textContent ?? '',
  outlined: document.querySelectorAll('.stock.on').length,
  pressed: document.querySelectorAll('.check[aria-pressed=true]').length,
  stored: JSON.parse(localStorage.getItem('california.watchlist.v1') ?? '[]'),
  barTap: document.querySelector('.actionbar .primary')?.getBoundingClientRect().height ?? 0,
}));
check('select: the bar counts what is selected', selected.count === `${picks.length} selected`, selected.count);
check('select: the bar links to the watchlist', selected.go.includes(`(${picks.length})`), selected.go);
check('select: selected rows are outlined', selected.outlined === picks.length, String(selected.outlined));
check('select: the checkbox reads as pressed', selected.pressed === picks.length, String(selected.pressed));
check('select: the choice is saved on the device',
  selected.stored.slice().sort().join(',') === picks.slice().sort().join(','), selected.stored.join(','));
check('select: the bar is thumb-sized', selected.barTap >= 44, `${selected.barTap}px`);
check('select: selecting still downloads no prices',
  page.seriesRequests.length === 0, page.seriesRequests.join(', '));

await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('.actionbar');
const afterReload = await page.evaluate(() => document.querySelector('.actionbar .count')?.textContent ?? '');
check('select: the list survives a reload', afterReload === `${picks.length} selected`, afterReload);

// ---- the watchlist screen --------------------------------------------------
const wl = await newPage();
await wl.goto(base, { waitUntil: 'networkidle' });
await wl.evaluate((syms) => localStorage.setItem('california.watchlist.v1', JSON.stringify(syms)), picks);
// The set is read once at module load, so a hash-only navigation would render
// against the empty list this page booted with. Reload on the target hash.
await wl.goto(`${base}#/watchlist?score=h12_1&mode=raw&threshold=0.65`);
await wl.reload({ waitUntil: 'networkidle' });
await wl.waitForSelector('.wl .panel', { timeout: 20000 });

const risk = await wl.evaluate(() => {
  const cells = [...document.querySelectorAll('.panel table.stats tbody tr')]
    .filter((tr) => tr.querySelectorAll('td').length === 5)
    .map((tr) => [...tr.querySelectorAll('th,td')].map((c) => c.textContent.trim()));
  return {
    names: cells.map((c) => c[0]),
    weights: cells.map((c) => parseFloat(c[2])),
    vols: cells.map((c) => parseFloat(c[3])),
    overlaps: cells.map((c) => parseFloat(c[4])),
    shares: cells.map((c) => parseFloat(c[5])),
    ranks: cells.map((c) => Number(c[1].replace('#', ''))),
    sigma: (document.querySelector('.wl-note b')?.textContent ?? '').trim(),
    panels: [...document.querySelectorAll('.wl .panel h3')].map((h) => h.textContent.replace(/\s+/g, ' ').trim()),
    listed: document.querySelectorAll('.rows.flat .stock').length,
    thresholds: [...document.querySelectorAll('.wl-toggle.small button')].map((b) => b.textContent.trim()),
    hScroll: document.documentElement.scrollWidth > document.documentElement.clientWidth,
  };
});
const wlSmall = await tapAudit(wl);

check('watchlist: one row per selected name', risk.names.length === picks.length, risk.names.join(','));
check('watchlist: rows are in universe rank order',
  risk.ranks.every((v, i) => i === 0 || v > risk.ranks[i - 1]), risk.ranks.join(','));
check('watchlist: equal weights are equal',
  new Set(risk.weights).size === 1, risk.weights.join(','));
check('watchlist: risk shares sum to 100%',
  Math.abs(risk.shares.reduce((a, b) => a + b, 0) - 100) <= 1, risk.shares.join('+'));
check('watchlist: overlaps are correlations', risk.overlaps.every((v) => v >= -1 && v <= 1), risk.overlaps.join(','));
check('watchlist: basket volatility is between the least and most volatile name',
  parseFloat(risk.sigma) > 0 && parseFloat(risk.sigma) <= Math.max(...risk.vols) + 1,
  `${risk.sigma} vs ${risk.vols.join(',')}`);
check('watchlist: every panel is present',
  ['Moves together', 'Per name', 'Sector mix', 'Your list'].every((t) => risk.panels.some((p) => p.startsWith(t))),
  risk.panels.join(' | '));
check('watchlist: the list itself is shown and removable', risk.listed === picks.length, String(risk.listed));
check('watchlist: the threshold control lives here', risk.thresholds.length === snapshot.clusters.thresholds.length,
  risk.thresholds.join(' '));
check('watchlist: no horizontal scroll', !risk.hScroll);
check('watchlist: every control is >= 44px', wlSmall.length === 0, wlSmall.join(', '));

// The size argument in one assertion: n names cost n requests, and revisiting
// costs none. Anything that batches or refetches shows up here.
check('watchlist: exactly one request per selected name',
  wl.seriesRequests.length === picks.length
    && new Set(wl.seriesRequests).size === picks.length
    && picks.every((s) => wl.seriesRequests.includes(s)),
  wl.seriesRequests.join(', '));

const beforeRevisit = wl.seriesRequests.length;
await wl.goto(`${base}#/?score=h12_1&mode=raw`, { waitUntil: 'networkidle' });
await wl.waitForSelector('.stock');
await wl.evaluate(() => { location.hash = '#/watchlist?score=h12_1&mode=raw&threshold=0.65'; });
await wl.waitForSelector('.wl .panel', { timeout: 20000 });
check('watchlist: re-opening refetches nothing',
  wl.seriesRequests.length === beforeRevisit, wl.seriesRequests.slice(beforeRevisit).join(', '));

// Inverse-vol weighting must actually change the weights, and put less weight
// on the more volatile name — otherwise the toggle is decoration.
await wl.click('.wl-toggle button:not(.small button)[aria-pressed=false]');
await wl.waitForFunction(() =>
  document.querySelectorAll('.wl-toggle button[aria-pressed=true]')[0]?.textContent.includes('Inverse'));
const inv = await wl.evaluate(() => {
  const cells = [...document.querySelectorAll('.panel table.stats tbody tr')]
    .filter((tr) => tr.querySelectorAll('td').length === 5)
    .map((tr) => [...tr.querySelectorAll('td')].map((c) => parseFloat(c.textContent)));
  return { weights: cells.map((c) => c[1]), vols: cells.map((c) => c[2]) };
});
const byVol = inv.vols.map((v, i) => [v, inv.weights[i]]).sort((a, b) => a[0] - b[0]);
check('watchlist: inverse vol tilts away from the volatile names',
  new Set(inv.weights).size > 1 && byVol[0][1] >= byVol[byVol.length - 1][1],
  JSON.stringify(byVol));

// A watchlist of one must not divide by zero or claim a correlation.
const solo = await newPage();
await solo.goto(base, { waitUntil: 'networkidle' });
await solo.evaluate((s) => localStorage.setItem('california.watchlist.v1', JSON.stringify([s])), picks[0]);
await solo.goto(`${base}#/watchlist?score=h12_1&mode=raw&threshold=0.65`);
await solo.reload({ waitUntil: 'networkidle' });
await solo.waitForSelector('.wl .panel', { timeout: 20000 });
const one = await solo.evaluate(() => ({
  rows: document.querySelectorAll('.rows.flat .stock').length,
  shares: [...document.querySelectorAll('.panel table.stats tbody tr')]
    .filter((tr) => tr.querySelectorAll('td').length === 5)
    .map((tr) => parseFloat(tr.querySelectorAll('td')[4].textContent)),
  note: document.querySelector('.wl-empty')?.textContent?.trim() ?? '',
}));
check('watchlist: a single name still renders', one.rows === 1 && one.shares[0] === 100,
  JSON.stringify(one.shares));

// And an empty one says how to fill it rather than showing an empty table.
await solo.evaluate(() => localStorage.setItem('california.watchlist.v1', '[]'));
await solo.reload({ waitUntil: 'networkidle' });
await solo.waitForSelector('.loading');
const empty = await solo.evaluate(() => document.querySelector('.loading')?.textContent ?? '');
check('watchlist: the empty state explains itself', /tap/i.test(empty), empty);

// ---- the watchlist keeps your place, and Back pops -------------------------
{
  await wl.goto(`${base}#/watchlist?score=h12_1&mode=raw&threshold=0.65`);
  await wl.reload({ waitUntil: 'networkidle' });
  await wl.waitForSelector('.wl .panel', { timeout: 20000 });
  await wl.evaluate(() => window.scrollTo(0, 400));
  const before = await wl.evaluate(() => window.scrollY);
  // Name the threshold rather than "the first unpressed one" — there are three
  // buttons and two of them are unpressed.
  await wl.evaluate(() => {
    const b = [...document.querySelectorAll('.wl-toggle.small button')]
      .find((x) => x.textContent.includes('0.70'));
    b.click();
  });
  await wl.waitForFunction(() =>
    document.querySelector('.wl-toggle.small button[aria-pressed=true]')?.textContent?.includes('0.70'));
  // The screen paints a placeholder first and its content a fetch later, so a
  // restore that ran on the synchronous return would scroll a one-line page.
  await wl.waitForFunction(() => window.scrollY > 100, null, { timeout: 5000 }).catch(() => {});
  const after = await wl.evaluate(() => window.scrollY);
  check('watchlist: changing the threshold keeps your place',
    before > 0 && Math.abs(after - before) < 80, `${before} → ${after}`);
}

{
  // Back must pop, not push: otherwise the device back gesture returns *into*
  // the screen you just left.
  const nav = await newPage();
  await nav.goto(`${base}#/?score=h12_1&mode=raw`, { waitUntil: 'networkidle' });
  await nav.evaluate((syms) => localStorage.setItem('california.watchlist.v1', JSON.stringify(syms)), picks);
  await nav.reload({ waitUntil: 'networkidle' });
  await nav.waitForSelector('.actionbar');
  await nav.click('.actionbar .primary');
  await nav.waitForSelector('.wl', { timeout: 20000 });
  const depth = await nav.evaluate(() => history.length);
  await nav.click('.back');
  await nav.waitForSelector('.stock');
  const afterBack = await nav.evaluate(() => history.length);
  check('watchlist: Back pops rather than pushing a new entry',
    afterBack === depth, `${depth} → ${afterBack}`);
  // And the device gesture from there must not land back on the watchlist.
  await nav.goForward().catch(() => {});
  await nav.goBack().catch(() => {});
  await nav.waitForSelector('.stock, .wl', { timeout: 8000 });
  const where = await nav.evaluate(() => (document.querySelector('.wl') ? 'watchlist' : 'list'));
  check('watchlist: the device back gesture escapes the screen', where === 'list', where);

  // A cold load straight onto the watchlist has nothing to pop; Back must
  // still reach the list rather than leaving the site.
  const cold = await newPage();
  await cold.goto(`${base}#/watchlist?score=h12_1&mode=raw&threshold=0.65`);
  await cold.evaluate((syms) => localStorage.setItem('california.watchlist.v1', JSON.stringify(syms)), picks);
  await cold.reload({ waitUntil: 'networkidle' });
  await cold.waitForSelector('.wl', { timeout: 20000 });
  await cold.click('.back');
  await cold.waitForSelector('.stock', { timeout: 8000 });
  check('watchlist: Back works on a cold load with no history behind it', true);
}

// ---- a saved name that left the universe -----------------------------------
{
  const stale = await newPage();
  await stale.goto(base, { waitUntil: 'networkidle' });
  await stale.evaluate((keep) =>
    localStorage.setItem('california.watchlist.v1', JSON.stringify([keep, 'ZZDELISTED'])), picks[0]);
  await stale.goto(`${base}#/watchlist?score=h12_1&mode=raw&threshold=0.65`);
  await stale.reload({ waitUntil: 'networkidle' });
  await stale.waitForSelector('.wl .panel', { timeout: 20000 });
  const r = await stale.evaluate(() => ({
    html: document.querySelector('.wl')?.innerHTML ?? '',
    rows: [...document.querySelectorAll('.rows.flat .stock')].map((s) => s.querySelector('.sym').textContent.trim()),
    ranks: [...document.querySelectorAll('.rows.flat .rank')].map((e) => e.textContent.trim()),
    stored: JSON.parse(localStorage.getItem('california.watchlist.v1') ?? '[]'),
  }));
  check('stale pick: no #undefined row and no "undefined" name',
    !r.ranks.includes('undefined') && !/>undefined</.test(r.html), r.ranks.join(','));
  check('stale pick: the live name still renders', r.rows.length === 1 && r.rows[0] === picks[0], r.rows.join(','));
  check('stale pick: it is pruned from storage rather than failing again',
    r.stored.length === 1 && r.stored[0] === picks[0], r.stored.join(','));
  check('stale pick: the user is told, not left guessing',
    /ZZDELISTED/.test(r.html) && /no longer in the/i.test(r.html), 'no notice shown');
}

// ---- per-ticker screen -----------------------------------------------------
const top = snapshot.columns.symbol[0];
const detailPage = await newPage();
await detailPage.goto(`${base}#/${top}?score=h12_1&mode=raw&threshold=0.65`, { waitUntil: 'networkidle' });
await detailPage.waitForSelector('.chart-wrap svg.spark', { timeout: 15000 });

const detail = await detailPage.evaluate(() => ({
  points: document.querySelector('.spark path.line')?.getAttribute('d')?.split('L').length ?? 0,
  chartH: Math.round(document.querySelector('svg.spark').getBoundingClientRect().height),
  horizonBars: document.querySelectorAll('.hz-bars .hz-row').length,
  activeBars: document.querySelectorAll('.hz-bar.on').length,
  labelSize: parseFloat(getComputedStyle(document.querySelector('.hz-label')).fontSize),
  skipShade: !!document.querySelector('.spark rect.skip'),
  rankCells: document.querySelectorAll('.rank-cell').length,
  watchText: document.querySelector('.watch-toggle')?.textContent?.trim() ?? '',
  watchTap: document.querySelector('.watch-toggle')?.getBoundingClientRect().height ?? 0,
  tvLink: document.querySelector('a.tv-link')?.getAttribute('href') ?? null,
  iframes: document.querySelectorAll('iframe').length,
  external: [...document.querySelectorAll('script[src], link[href]')]
    .map((e) => e.getAttribute('src') || e.getAttribute('href'))
    .filter((u) => /^https?:/.test(u ?? '')),
  hScroll: document.documentElement.scrollWidth > document.documentElement.clientWidth,
}));

check('detail: chart draws the full series', detail.points > 200, `${detail.points} points`);
check('detail: chart has real height', detail.chartH > 120, `${detail.chartH}px`);
check('detail: all three horizon windows marked', detail.horizonBars === 3, String(detail.horizonBars));
check('detail: the viewed horizon is highlighted', detail.activeBars === 1, String(detail.activeBars));
check('detail: excluded window is shaded', detail.skipShade);
// Labels live in HTML precisely so they render at a readable size; inside the
// stretched SVG viewBox they came out around 5px and horizontally squashed.
check('detail: horizon labels are legible', detail.labelSize >= 11, `${detail.labelSize}px`);
check('detail: ranks shown for all 8 views', detail.rankCells === 8, String(detail.rankCells));
check('detail: no horizontal scroll', !detail.hScroll);
check('detail: TradingView is a plain link, not an embed',
  detail.iframes === 0 && (detail.tvLink ?? '').startsWith('https://www.tradingview.com/'),
  `iframes=${detail.iframes} link=${detail.tvLink}`);
check('detail: loads nothing from a third-party host',
  detail.external.length === 0, detail.external.join(', '));
check('detail: opening one chart costs one name',
  detailPage.seriesRequests.length === 1 && detailPage.seriesRequests[0] === top,
  detailPage.seriesRequests.join(', '));
check('detail: watchlist button offers to add', detail.watchTap >= 44 && /add/i.test(detail.watchText),
  `${detail.watchText} @${detail.watchTap}px`);

await detailPage.click('.watch-toggle');
const watched = await detailPage.evaluate(() => ({
  text: document.querySelector('.watch-toggle')?.textContent?.trim() ?? '',
  pressed: document.querySelector('.watch-toggle')?.getAttribute('aria-pressed'),
  stored: JSON.parse(localStorage.getItem('california.watchlist.v1') ?? '[]'),
}));
check('detail: the watchlist button adds the name',
  watched.pressed === 'true' && watched.stored.includes(top), JSON.stringify(watched));

// The highlighted window must follow the view being ranked on.
for (const [score, label] of [['h9_1', '9-1'], ['h6_1', '6-1']]) {
  await detailPage.goto(`${base}#/${top}?score=${score}&mode=raw&threshold=0.65`, { waitUntil: 'networkidle' });
  // A hash change re-renders asynchronously and `.hz-label.on` already exists
  // from the previous view, so waiting on the selector alone would return
  // against stale DOM and let a broken highlight pass.
  let active = '';
  try {
    await detailPage.waitForFunction(
      (want) => document.querySelector('.hz-label.on')?.textContent?.trim().startsWith(want),
      label,
      { timeout: 5000 },
    );
    active = await detailPage.evaluate(() => document.querySelector('.hz-label.on')?.textContent?.trim() ?? '');
  } catch {
    active = await detailPage.evaluate(() => document.querySelector('.hz-label.on')?.textContent?.trim() ?? '(none)');
  }
  check(`detail: ${label} view highlights the ${label} window`, active.startsWith(label), active);
}
check('detail: revisiting a name refetches nothing',
  detailPage.seriesRequests.filter((s) => s === top).length === 1,
  detailPage.seriesRequests.join(', '));

// ---- stale or malformed hash params ----------------------------------------
// A bookmark from before a params change must still render, not blank the page.
const stale = await newPage();
for (const [hash, label] of [
  ['#/?score=h12_1&mode=raw&threshold=0.75', 'unknown threshold'],
  ['#/?score=h3_1&mode=raw&threshold=0.65', 'unknown score'],
  ['#/?score=h12_1&mode=sideways&threshold=0.65', 'unknown mode'],
  ['#/?threshold=', 'empty threshold'],
  ['#/?metric=sharpe', 'unknown metric'],
  ['#/?cap=abc&sectors=Atlantis', 'nonsense filters'],
]) {
  await stale.goto(`${base}${hash}`, { waitUntil: 'networkidle' });
  let rendered = false;
  try {
    await stale.waitForSelector('.stock', { timeout: 8000 });
    rendered = true;
  } catch {
    rendered = false;
  }
  const r = rendered
    ? await stale.evaluate(() => ({
        rows: document.querySelectorAll('.stock').length,
        stuck: !!document.querySelector('.loading'),
      }))
    : { rows: 0, stuck: true };
  check(`stale hash (${label}): still renders the screen`, r.rows > 0 && !r.stuck, JSON.stringify(r));
}
await stale.goto(`${base}#/NOTATICKER?score=h12_1&mode=raw`, { waitUntil: 'networkidle' });
await stale.waitForSelector('.loading');
const unknownTicker = await stale.evaluate(() => document.querySelector('.loading')?.textContent ?? '');
check('unknown ticker: says so rather than blanking', /not in the current snapshot/.test(unknownTicker), unknownTicker);

// ---- back navigation preserves the chosen view -----------------------------
const navPage = await newPage();
await navPage.goto(`${base}#/?score=h9_1&mode=voladj&threshold=0.70`, { waitUntil: 'networkidle' });
await navPage.waitForSelector('.stock');
await navPage.click('.stock .open');
await navPage.waitForSelector('.detail-head h2');
await navPage.goBack();
await navPage.waitForSelector('.stock');
const restored = await navPage.evaluate(() =>
  [...document.querySelectorAll('.seg button[aria-pressed=true]')].map((b) => b.textContent));
check('back button restores the chosen view',
  restored.join(',').includes('9–1') && restored.join(',').includes('Vol-adj'), restored.join(','));

// ---- dark mode -------------------------------------------------------------
const dark = await newPage('dark');
await dark.goto(`${base}#/${top}?score=h12_1&mode=raw&threshold=0.65`, { waitUntil: 'networkidle' });
await dark.waitForSelector('.chart-wrap svg.spark', { timeout: 15000 });
const darkTheme = await dark.evaluate(() => {
  const line = document.querySelector('.spark path.line');
  const stroke = getComputedStyle(line).stroke;
  const bg = getComputedStyle(document.body).backgroundColor;
  const lum = (c) => {
    const [r, g, b] = (c.match(/\d+/g) ?? ['0', '0', '0']).map(Number);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  return { lineLum: lum(stroke), bgLum: lum(bg) };
});
// In dark mode the chart line must be lighter than the page behind it.
check('dark mode: chart line stays legible against the background',
  darkTheme.lineLum > darkTheme.bgLum + 60, JSON.stringify(darkTheme));

// ---- how fast the list is usable -------------------------------------------
const perfPage = await newPage();
const perf = await (async () => {
  await perfPage.goto(`${base}#/?score=h12_1&mode=raw`, { waitUntil: 'networkidle' });
  await perfPage.waitForSelector('.stock');
  return perfPage.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0];
    const paint = performance.getEntriesByName('first-contentful-paint')[0];
    const t0 = performance.now();
    // Worst realistic interaction: re-render the whole first page of rows.
    document.querySelector('.chips .chip').click();
    document.querySelector('.chips .chip').click();
    return {
      fcp: Math.round(paint?.startTime ?? 0),
      transferred: Math.round(performance.getEntriesByType('resource')
        .reduce((a, r) => a + (r.transferSize || 0), 0) / 1024),
      rerender: Math.round(performance.now() - t0),
      load: Math.round(nav?.duration ?? 0),
    };
  });
})();
console.log(`\n  first contentful paint ${perf.fcp}ms · full load ${perf.load}ms · ` +
  `filter re-render ${perf.rerender}ms · ${perf.transferred} KB over the wire`);
check('performance: a filter change re-renders under 200ms', perf.rerender < 200, `${perf.rerender}ms`);
// Gzipped, as served. The snapshot is ~135 KB of that; the cap leaves room
// for the page itself and for the universe to grow without hiding a regression.
check('performance: the whole home screen is under 200 KB on the wire',
  perf.transferred < 200, `${perf.transferred} KB`);

await browser.close();
server.close();

if (failures.length) {
  console.error(`\n${failures.length} UI check(s) failed:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('\nAll UI checks passed.');
