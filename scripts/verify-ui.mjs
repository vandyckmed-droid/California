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
/**
 * @param colorScheme
 * @param ignore Console errors this page is expected to produce. Only for
 *   failures the check itself provokes — a blanket filter would hide the very
 *   regressions this listener exists to catch.
 */
const newPage = async (colorScheme = 'light', ignore = null) => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, colorScheme });
  page.seriesRequests = [];
  page.on('request', (r) => {
    const m = /\/data\/series\/([^/?]+)\.json/.exec(r.url());
    if (m) page.seriesRequests.push(decodeURIComponent(m[1]));
  });
  page.on('pageerror', (e) => { failures.push(`pageerror: ${e.message}`); });
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    if (ignore && ignore.test(m.text())) return;
    failures.push(`console: ${m.text()}`);
  });
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

// ---- Labs: the experiment, and the boundary around it ----------------------
{
  const labs = await newPage();
  labs.labsRequests = [];
  labs.on('request', (r) => {
    if (/rank-history\.json/.test(r.url())) labs.labsRequests.push(r.url());
    if (/views\/labs\//.test(r.url())) labs.labsRequests.push('module');
  });

  // The home screen must download none of the experiment.
  await labs.goto(`${base}#/?score=h12_1&mode=raw`, { waitUntil: 'networkidle' });
  await labs.waitForSelector('.stock');
  check('labs: the ranked list downloads none of the experiment',
    labs.labsRequests.length === 0, labs.labsRequests.join(', '));

  const link = await labs.evaluate(() => {
    const a = document.querySelector('.labs-link');
    if (!a) return null;
    const r = a.getBoundingClientRect();
    return {
      text: a.textContent.trim(),
      h: Math.round(r.height),
      top: Math.round(r.top),
      scrollY: window.scrollY,
      headerH: Math.round(document.querySelector('.head').getBoundingClientRect().height),
    };
  });
  check('labs: a secondary entry point exists on the list',
    !!link && /labs/i.test(link.text), JSON.stringify(link));
  // The real requirement, and the one the first version failed: it must be
  // reachable. It was in the footer, below 2,572 rows, which is discreet only
  // in the sense that nobody will ever find it.
  check('labs: the entry point is visible without scrolling',
    !!link && link.scrollY === 0 && link.top >= 0 && link.top < 120,
    JSON.stringify(link));
  // Reachable, but still not allowed to bloat the header it sits on.
  check('labs: it does not inflate the header',
    !!link && link.headerH <= 56, `header ${link?.headerH}px`);
  check('labs: the entry point is not a primary tab',
    await labs.evaluate(() => !document.querySelector('nav, [role=tablist], .tabbar')));

  await labs.click('.labs-link');
  await labs.waitForSelector('.lab .rows .stock');
  const index = await labs.evaluate(() => ({
    heading: document.querySelector('.head h1')?.textContent?.trim() ?? '',
    entries: [...document.querySelectorAll('.lab .rows .sym')].map((e) => e.textContent.trim()),
    warns: /experiments/i.test(document.querySelector('.lab-note')?.textContent ?? ''),
  }));
  check('labs: the index lists the experiment', index.entries.includes('Rank River'), index.entries.join(','));
  check('labs: the index says these are experiments', index.warns, index.heading);

  await labs.click('.lab .rows .stock .open');
  await labs.waitForSelector('svg.river', { timeout: 20000 });
  const river = await labs.evaluate(() => {
    const trails = [...document.querySelectorAll('.river-trail')];
    const d = (p) => p.getAttribute('d') ?? '';
    const ys = (p) => [...d(p).matchAll(/[ML][\d.]+,([\d.]+)/g)].map((m) => Number(m[1]));
    return {
      trails: trails.length,
      names: document.querySelectorAll('.river-names button').length,
      points: trails.map((p) => ys(p).length),
      firstY: ys(trails[0]),
      chartH: Math.round(document.querySelector('svg.river').getBoundingClientRect().height),
      axis: [...document.querySelectorAll('.river-axis span')].map((e) => e.textContent.trim()),
      dates: [...document.querySelectorAll('.river-dates span')].map((e) => e.textContent.trim()),
      caveat: document.querySelector('.lab .foot')?.textContent ?? '',
      hScroll: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    };
  });

  check('labs: one trail per name', river.trails === river.names && river.trails > 0,
    `${river.trails} trails / ${river.names} names`);
  check('labs: trails span the sessions', river.points.every((n) => n > 1) && Math.max(...river.points) >= 20,
    river.points.join(','));
  check('labs: the chart has real height', river.chartH > 200, `${river.chartH}px`);
  check('labs: the axis is labelled, including the beyond-100 lane',
    river.axis.includes('#1') && river.axis.some((t) => t.includes('>100')), river.axis.join(' '));
  check('labs: today is the right edge', river.dates[river.dates.length - 1] === 'today', river.dates.join(' → '));
  check('labs: it says these are backfilled ranks, not what the screen showed',
    /backfilled/i.test(river.caveat) && /not a record/i.test(river.caveat), river.caveat.slice(0, 80));
  check('labs: no horizontal scroll', !river.hScroll);
  {
    const small = await tapAudit(labs);
    check('labs: every control is >= 44px', small.length === 0, small.join(', '));
  }
  check('labs: exactly one sidecar request', 
    labs.labsRequests.filter((u) => u !== 'module').length === 1,
    labs.labsRequests.join(', '));

  // Better ranks sit higher: rank 1 must be nearer the top than rank 100.
  const monotone = await labs.evaluate(() => {
    const band = [...document.querySelectorAll('.river-axis span')]
      .map((e) => ({ label: e.textContent.trim(), top: parseFloat(e.style.top) }));
    const at = (t) => band.find((b) => b.label === t)?.top;
    return { one: at('#1'), fifty: at('#50'), hundred: at('#100') };
  });
  check('labs: better ranks are drawn higher',
    monotone.one < monotone.fifty && monotone.fifty < monotone.hundred, JSON.stringify(monotone));

  // Tapping a name emphasises it and fades the rest.
  await labs.click('.river-names button');
  // The trails cross-fade over 120ms; reading straight after the click samples
  // the transition mid-flight and both trails still report the base opacity.
  await labs.waitForFunction(() => {
    const on = document.querySelector('.river-trail.on');
    return on && parseFloat(getComputedStyle(on).opacity) > 0.95;
  }, null, { timeout: 5000 });
  const focused = await labs.evaluate(() => ({
    on: document.querySelectorAll('.river-trail.on').length,
    off: document.querySelectorAll('.river-trail.off').length,
    pressed: document.querySelectorAll('.river-names button[aria-pressed=true]').length,
    onOpacity: parseFloat(getComputedStyle(document.querySelector('.river-trail.on')).opacity),
    offOpacity: parseFloat(getComputedStyle(document.querySelector('.river-trail.off')).opacity),
  }));
  check('labs: tapping a name emphasises exactly one trail',
    focused.on === 1 && focused.pressed === 1 && focused.off === river.trails - 1,
    JSON.stringify(focused));
  check('labs: the others actually fade', focused.offOpacity < focused.onOpacity / 2,
    `${focused.onOpacity} vs ${focused.offOpacity}`);

  await labs.click('.river-names button[aria-pressed=true]');
  const cleared = await labs.evaluate(() => document.querySelectorAll('.river-trail.off').length);
  check('labs: tapping again clears the emphasis', cleared === 0, String(cleared));

  // It follows the view the list is on, rather than pinning to 12-1.
  const perView = {};
  for (const score of ['h12_1', 'h6_1']) {
    await labs.goto(`${base}#/labs/rank-river?score=${score}&mode=raw`, { waitUntil: 'networkidle' });
    await labs.waitForSelector('.river-names button', { timeout: 20000 });
    perView[score] = await labs.evaluate(() =>
      [...document.querySelectorAll('.river-names button')].map((b) => b.textContent.replace(/#\d+\s*/, '').trim()));
  }
  check('labs: it follows the selected view',
    perView.h12_1.join(',') !== perView.h6_1.join(','),
    `${perView.h12_1.slice(0, 3)} vs ${perView.h6_1.slice(0, 3)}`);
  {
    const top20 = JSON.parse(readFileSync('web/data/labs/rank-history.json', 'utf8'));
    check('labs: the names match the sidecar for that view',
      perView.h6_1.join(',') === top20.views['h6_1|raw'].symbols.join(','),
      perView.h6_1.slice(0, 3).join(','));
  }

  // Back must pop, like every other in-app Back link. Pushing a second entry
  // leaves the phone's back gesture re-entering the screen you just left.
  {
    const nav = await newPage();
    await nav.goto(`${base}#/?score=h12_1&mode=raw`, { waitUntil: 'networkidle' });
    await nav.waitForSelector('.stock');
    const start = await nav.evaluate(() => history.length);
    await nav.click('.labs-link');
    await nav.waitForSelector('.lab .rows .stock');
    await nav.click('.lab .rows .stock .open');
    await nav.waitForSelector('svg.river', { timeout: 20000 });
    await nav.click('.back');                       // river -> labs index
    await nav.waitForSelector('.lab .rows .stock');
    const end = await nav.evaluate(() => history.length);
    // Two forward navigations, one Back: a popping Back leaves the count where
    // the forward moves put it, a pushing one would add a third entry.
    check('labs: Back pops rather than pushing', end === start + 2, `${start} → ${end}`);

    // From the Labs index the device gesture must reach the list, not re-enter
    // Rank River — which is what a pushed Back entry would give you.
    await nav.goBack();
    await nav.waitForSelector('.stock .sym', { timeout: 8000 });
    const where = await nav.evaluate(() =>
      document.querySelector('svg.river') ? 'river' : document.querySelector('.lab') ? 'labs' : 'list');
    check('labs: the device back gesture does not re-enter the experiment',
      where === 'list', where);
  }

  // "Change view on the list" must actually navigate. It used to call
  // syncHash('') first, which rewrote the hash via replaceState so the
  // navigate() that followed assigned an identical hash and did nothing.
  {
    const dead = await newPage();
    await dead.goto(`${base}#/labs/rank-river?score=h12_1&mode=raw`, { waitUntil: 'networkidle' });
    await dead.waitForSelector('svg.river', { timeout: 20000 });
    await dead.click('.wl-clear');
    await dead.waitForSelector('.stock .sym', { timeout: 8000 });
    const landed = await dead.evaluate(() => ({
      rows: document.querySelectorAll('.stock').length,
      river: !!document.querySelector('svg.river'),
      hash: location.hash,
    }));
    check('labs: "Change view on the list" reaches the list',
      landed.rows > 0 && !landed.river && !landed.hash.includes('labs'), JSON.stringify(landed));
  }

  // Core keeps working when the experiment's data is gone.
  // This page provokes a 404 on purpose, so its own console error is expected.
  const noData = await newPage('light', /rank-history\.json|404/);
  await noData.route('**/rank-history.json', (r) => r.fulfill({ status: 404, body: 'gone' }));
  await noData.goto(`${base}#/labs/rank-river?score=h12_1&mode=raw`, { waitUntil: 'networkidle' });
  await noData.waitForSelector('.lab .loading', { timeout: 15000 });
  const empty = await noData.evaluate(() => document.querySelector('.lab .loading')?.textContent ?? '');
  check('labs: a missing sidecar degrades to a sentence', /no rank history/i.test(empty), empty.trim().slice(0, 60));
  await noData.goto(`${base}#/?score=h12_1&mode=raw`, { waitUntil: 'networkidle' });
  await noData.waitForSelector('.stock');
  const coreOk = await noData.evaluate(() => document.querySelectorAll('.stock').length);
  check('labs: the ranked list is unaffected by the sidecar being gone', coreOk > 0, String(coreOk));
}

// ---- Labs: ETF River -------------------------------------------------------
// A second experiment, checked on its own terms. The point of the Labs boundary
// is that these two share nothing, so the assertions do not share anything
// either — including that opening one downloads none of the other.
{
  const etf = JSON.parse(readFileSync('web/data/labs/etf-river.json', 'utf8'));
  const page = await newPage();
  page.etfRequests = [];
  page.otherLab = [];
  page.on('request', (r) => {
    if (/etf-river\.json/.test(r.url())) page.etfRequests.push(r.url());
    if (/rank-history\.json|rankRiver\.js/.test(r.url())) page.otherLab.push(r.url());
  });

  await page.goto(`${base}#/?score=h12_1&mode=raw`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.stock');
  check('etf river: the ranked list downloads none of it', page.etfRequests.length === 0,
    page.etfRequests.join(', '));

  await page.click('.labs-link');
  await page.waitForSelector('.lab .rows .stock');
  const listed = await page.evaluate(() =>
    [...document.querySelectorAll('.lab .rows .sym')].map((e) => e.textContent.trim()));
  check('etf river: the index lists it beside the other experiment',
    listed.includes('ETF River') && listed.includes('Rank River'), listed.join(','));

  await page.goto(`${base}#/labs/etf-river`, { waitUntil: 'networkidle' });
  await page.waitForSelector('svg.etf-river', { timeout: 20000 });

  const view = await page.evaluate(() => {
    const trails = [...document.querySelectorAll('.etf-trail')];
    const endY = (p) => {
      const pts = [...(p.getAttribute('d') ?? '').matchAll(/[ML]([\d.]+),([\d.]+)/g)];
      const last = pts[pts.length - 1];
      return last ? { x: Number(last[1]), y: Number(last[2]) } : null;
    };
    return {
      trails: trails.length,
      symbols: trails.map((p) => p.dataset.symbol),
      points: trails.map((p) => ((p.getAttribute('d') ?? '').match(/[ML]/g) ?? []).length),
      ends: Object.fromEntries(trails.map((p) => [p.dataset.symbol, endY(p)])),
      zero: !!document.querySelector('.etf-zero'),
      zeroY: Number(document.querySelector('.etf-zero')?.getAttribute('y1')),
      axis: [...document.querySelectorAll('.etf-axis span')].map((e) => e.textContent.trim()),
      tags: [...document.querySelectorAll('.etf-tag')].map((e) => ({
        symbol: e.dataset.symbol,
        top: e.getBoundingClientRect().top,
      })),
      names: [...document.querySelectorAll('.etf-names button')].map((b) => b.dataset.symbol),
      families: document.querySelectorAll('.etf-legend button').length,
      dates: [...document.querySelectorAll('.etf-dates span')].map((e) => e.textContent.trim()),
      chartH: Math.round(document.querySelector('svg.etf-river').getBoundingClientRect().height),
      hScroll: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      foot: document.querySelector('.lab .foot')?.textContent ?? '',
      readout: document.querySelector('.etf-readout')?.textContent ?? '',
    };
  });

  const members = etf.members.map((m) => m.symbol);
  check('etf river: one trail per fund in the sidecar',
    view.trails === members.length && view.symbols.slice().sort().join(',') === members.slice().sort().join(','),
    `${view.trails} trails / ${members.length} funds`);
  check('etf river: trails span the year', view.points.every((n) => n > 20), view.points.join(','));
  check('etf river: the chart has real height', view.chartH > 250, `${view.chartH}px`);
  check('etf river: the axis is a z-score scale around zero',
    view.zero && view.axis.includes('0') && view.axis.includes('+1') && view.axis.includes('−1'),
    view.axis.join(' '));
  check('etf river: today is the right edge', view.dates[view.dates.length - 1] === 'today',
    view.dates.join(' → '));
  check('etf river: it names its legend families', view.families === etf.families.length,
    `${view.families} of ${etf.families.length}`);
  check('etf river: no horizontal scroll', !view.hScroll);
  check('etf river: it says the floor is not applied and the data is real',
    /no volatility floor/i.test(view.foot) && /dividend-adjusted/i.test(view.foot),
    view.foot.slice(0, 60));
  check('etf river: the resting readout names today\'s leader',
    view.readout.includes(etf.members[etf.today.reduce(
      (best, t, i) => (t && (!etf.today[best] || t.blend > etf.today[best].blend) ? i : best), 0)].symbol),
    view.readout.trim().slice(0, 60));

  // The drawing must agree with the file: a higher blended score is drawn
  // higher, and every trail ends on the same right edge.
  {
    const byScore = etf.members
      .map((m, i) => ({ symbol: m.symbol, v: etf.today[i]?.blend }))
      .filter((x) => typeof x.v === 'number')
      .sort((a, b) => b.v - a.v);
    const ys = byScore.map((x) => view.ends[x.symbol]?.y);
    check('etf river: a higher score is drawn higher',
      ys.every((y, i) => i === 0 || y >= ys[i - 1] - 1e-6), ys.slice(0, 4).join(' '));
    const xs = Object.values(view.ends).map((e) => e?.x);
    check('etf river: every trail reaches today', xs.every((x) => x === xs[0]), String(xs[0]));
  }

  // Right-edge labels: the ends, in order, and never stacked on each other.
  {
    const ordered = etf.members
      .map((m, i) => ({ symbol: m.symbol, v: etf.today[i]?.blend }))
      .sort((a, b) => b.v - a.v)
      .map((x) => x.symbol);
    const shown = view.tags.map((t) => t.symbol);
    check('etf river: the edge names the leaders and the laggards',
      shown.length > 4 && shown.length < members.length &&
      shown.slice(0, 3).join(',') === ordered.slice(0, 3).join(',') &&
      shown.slice(-2).join(',') === ordered.slice(-2).join(','),
      shown.join(','));
    const gaps = view.tags.slice(1).map((t, i) => t.top - view.tags[i].top);
    check('etf river: no two labels sit on top of each other',
      gaps.every((g) => g >= 11), gaps.map((g) => Math.round(g)).join(','));
  }

  {
    const small = await tapAudit(page);
    check('etf river: every control is >= 44px', small.length === 0, small.join(', '));
  }
  check('etf river: exactly one sidecar request', page.etfRequests.length === 1,
    page.etfRequests.join(', '));
  check('etf river: it downloads none of the other experiment', page.otherLab.length === 0,
    page.otherLab.join(', '));

  // Selecting a fund emphasises it and subordinates the rest.
  await page.click('.etf-names button');
  // Waited on the *faded* trails, not the emphasised one: the emphasised path
  // is re-appended to lift it above the rest, and re-inserting a node skips its
  // transition, so it reaches full opacity instantly while the other twenty-one
  // are still 120ms from settling.
  await page.waitForFunction(() => {
    const off = document.querySelector('.etf-trail.off');
    return off && parseFloat(getComputedStyle(off).opacity) < 0.2;
  }, null, { timeout: 5000 });
  const one = await page.evaluate(() => ({
    on: document.querySelectorAll('.etf-trail.on').length,
    off: document.querySelectorAll('.etf-trail.off').length,
    pressed: document.querySelectorAll('.etf-names button[aria-pressed=true]').length,
    onOpacity: parseFloat(getComputedStyle(document.querySelector('.etf-trail.on')).opacity),
    offOpacity: parseFloat(getComputedStyle(document.querySelector('.etf-trail.off')).opacity),
    labelled: [...document.querySelectorAll('.etf-tag.on')].map((e) => e.dataset.symbol),
    readout: document.querySelector('.etf-readout')?.textContent ?? '',
  }));
  check('etf river: selecting a fund emphasises exactly one trail',
    one.on === 1 && one.pressed === 1 && one.off === view.trails - 1, JSON.stringify(one));
  check('etf river: the others actually recede', one.offOpacity < one.onOpacity / 4,
    `${one.onOpacity} vs ${one.offOpacity}`);
  check('etf river: the selected fund is named at the edge and in a sentence',
    one.labelled.length === 1 && one.readout.includes('a year ago'),
    `${one.labelled.join(',')} | ${one.readout.trim().slice(0, 50)}`);

  await page.click('.etf-names button[aria-pressed=true]');
  const cleared = await page.evaluate(() => document.querySelectorAll('.etf-trail.off').length);
  check('etf river: selecting again clears it', cleared === 0, String(cleared));

  // Selecting a family emphasises exactly its members — the question the
  // colouring exists to answer.
  await page.click('.etf-legend button');
  await page.waitForFunction(() => document.querySelectorAll('.etf-trail.on').length > 0,
    null, { timeout: 5000 });
  const family = await page.evaluate(() => ({
    on: [...document.querySelectorAll('.etf-trail.on')].map((p) => p.dataset.symbol).sort(),
    pressed: document.querySelectorAll('.etf-legend button[aria-pressed=true]').length,
  }));
  const expected = etf.members.filter((m) => m.family === 0).map((m) => m.symbol).sort();
  check('etf river: selecting a family emphasises exactly its funds',
    family.pressed === 1 && family.on.join(',') === expected.join(','),
    `${family.on.join(',')} vs ${expected.join(',')}`);

  // Back pops, like every other in-app Back link.
  {
    const nav = await newPage();
    await nav.goto(`${base}#/?score=h12_1&mode=raw`, { waitUntil: 'networkidle' });
    await nav.waitForSelector('.stock');
    const start = await nav.evaluate(() => history.length);
    await nav.click('.labs-link');
    await nav.waitForSelector('.lab .rows .stock');
    await nav.click('.lab .rows .stock:nth-child(2) .open');
    await nav.waitForSelector('svg.etf-river', { timeout: 20000 });
    await nav.click('.back');
    await nav.waitForSelector('.lab .rows .stock');
    const end = await nav.evaluate(() => history.length);
    check('etf river: Back pops rather than pushing', end === start + 2, `${start} → ${end}`);
  }

  // Core, and the other experiment, keep working when this sidecar is gone.
  const gone = await newPage('light', /etf-river\.json|404/);
  await gone.route('**/etf-river.json', (r) => r.fulfill({ status: 404, body: 'gone' }));
  await gone.goto(`${base}#/labs/etf-river`, { waitUntil: 'networkidle' });
  await gone.waitForSelector('.lab .loading', { timeout: 15000 });
  const sentence = await gone.evaluate(() => document.querySelector('.lab .loading')?.textContent ?? '');
  check('etf river: a missing sidecar degrades to a sentence', /no etf river/i.test(sentence),
    sentence.trim().slice(0, 60));
  await gone.goto(`${base}#/labs/rank-river?score=h12_1&mode=raw`, { waitUntil: 'networkidle' });
  await gone.waitForSelector('svg.river', { timeout: 20000 });
  check('etf river: the other experiment is unaffected',
    (await gone.evaluate(() => document.querySelectorAll('.river-trail').length)) > 0);
  await gone.goto(`${base}#/?score=h12_1&mode=raw`, { waitUntil: 'networkidle' });
  await gone.waitForSelector('.stock');
  check('etf river: the ranked list is unaffected',
    (await gone.evaluate(() => document.querySelectorAll('.stock').length)) > 0);
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
