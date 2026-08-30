/**
 * End-to-end check of the static page against the committed snapshot.
 *
 *   node scripts/verify-ui.mjs
 *
 * Runs Chromium at a phone viewport, walks the list and detail screens, and
 * asserts the things that are easy to break silently: that every view renders,
 * that grouping partitions the Top 100, that tap targets stay thumb-sized, and
 * that nothing scrolls sideways.
 *
 * The TradingView request is intercepted by a stub that behaves the way their
 * loader does — read the JSON config out of the script tag, fill the __widget
 * slot with an iframe. That verifies our container structure, config and
 * sizing without depending on reaching s3.tradingview.com, which sandboxes and
 * CI runners often block.
 *
 * Requires `npm install --no-save playwright` and a Chromium build; set
 * CHROME_PATH to point at one.
 */
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { chromium } from 'playwright';

const PORT = Number(process.env.PORT ?? 5173);
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json' };

const TV_STUB = `
(function () {
  var s = document.currentScript;
  var cfg = JSON.parse(s.textContent);
  var slot = s.parentElement.querySelector('.tradingview-widget-container__widget');
  if (!slot) { window.__tvError = 'no __widget slot found'; return; }
  var f = document.createElement('iframe');
  f.style.cssText = 'width:100%;height:100%;border:0';
  f.srcdoc = '<html><body style="margin:0">stub ' + cfg.symbol + '</body></html>';
  slot.appendChild(f);
  window.__tvMounted = cfg;
})();
`;

const failures = [];
const check = (label, cond, detail = '') => {
  if (cond) console.log(`  ok    ${label}`);
  else { console.log(`  FAIL  ${label} ${detail}`); failures.push(label); }
};

const server = createServer((req, res) => {
  const url = (req.url ?? '/').split('?')[0];
  const path = join('web', url === '/' ? 'index.html' : url.replace(/^\//, ''));
  if (!existsSync(path)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' });
  res.end(readFileSync(path));
});
await new Promise((r) => server.listen(PORT, r));

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
const base = `http://localhost:${PORT}/`;
const snapshot = JSON.parse(readFileSync('web/data/snapshot.json', 'utf8'));

const newPage = async (colorScheme = 'light') => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, colorScheme });
  page.on('pageerror', (e) => { failures.push(`pageerror: ${e.message}`); });
  page.on('console', (m) => { if (m.type() === 'error') failures.push(`console: ${m.text()}`); });
  await page.route('**/embed-widget-advanced-chart.js', (r) =>
    r.fulfill({ status: 200, contentType: 'text/javascript', body: TV_STUB }));
  return page;
};

// ---- every view renders and partitions the Top 100 -------------------------
const page = await newPage();
for (const score of ['h12_1', 'h9_1', 'h6_1', 'blend']) {
  for (const mode of ['raw', 'voladj']) {
    for (const threshold of ['0.60', '0.65', '0.70']) {
      await page.goto(`${base}#/?score=${score}&mode=${mode}&threshold=${threshold}`, { waitUntil: 'networkidle' });
      await page.waitForSelector('.card');
      const r = await page.evaluate(() => ({
        rows: document.querySelectorAll('.stock').length,
        cards: document.querySelectorAll('.card').length,
        ranks: [...document.querySelectorAll('.rank')].map((e) => Number(e.textContent)),
        minTap: Math.min(...[...document.querySelectorAll('.stock, .seg button')].map((e) => e.getBoundingClientRect().height)),
        hScroll: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      }));
      const view = `${score}|${mode} @${threshold}`;
      const expected = snapshot.views[`${score}|${mode}`].ranked.length;
      check(`${view}: renders all ${expected} names once`,
        r.rows === expected && new Set(r.ranks).size === expected, `got ${r.rows} rows`);
      check(`${view}: groups read in ascending best rank`,
        r.ranks.length > 0 && r.ranks[0] === 1, `first rank ${r.ranks[0]}`);
      check(`${view}: tap targets >= 44px`, r.minTap >= 44, `min ${r.minTap}px`);
      check(`${view}: no horizontal scroll`, !r.hScroll);
    }
  }
}

// ---- per-ticker screen -----------------------------------------------------
const top = snapshot.views['h12_1|raw'].ranked[0].symbol;
await page.goto(`${base}#/${top}?score=h12_1&mode=raw&threshold=0.65`, { waitUntil: 'networkidle' });
await page.waitForSelector('.chart-wrap iframe', { timeout: 15000 });
const detail = await page.evaluate(() => ({
  mounted: window.__tvMounted,
  chartH: Math.round(document.querySelector('.chart-wrap iframe').getBoundingClientRect().height),
  panels: [...document.querySelectorAll('.panel h3')].length,
  rankCells: document.querySelectorAll('.rank-cell').length,
  fallback: !!document.querySelector('.chart-fallback'),
  hScroll: document.documentElement.scrollWidth > document.documentElement.clientWidth,
}));
const expectedSymbol = `${snapshot.symbols[top].exchange}:${top}`;
check(`detail: chart mounts as ${expectedSymbol}`, detail.mounted?.symbol === expectedSymbol, String(detail.mounted?.symbol));
check('detail: chart has real height', detail.chartH > 250, `${detail.chartH}px`);
check('detail: no fallback shown when the widget loads', !detail.fallback);
check('detail: ranks shown for all 8 views', detail.rankCells === 8, String(detail.rankCells));
check('detail: no horizontal scroll', !detail.hScroll);

const cfg = detail.mounted ?? {};
check('detail: chart features left enabled',
  cfg.hide_side_toolbar === false && cfg.hide_top_toolbar === false && cfg.hide_legend === false &&
  cfg.hide_volume === false && cfg.withdateranges === true && cfg.allow_symbol_change === true);

// ---- stale or malformed hash params ----------------------------------------
// A bookmark from before a params change must still render, not blank the page.
const stale = await newPage();
for (const [hash, label] of [
  ['#/?score=h12_1&mode=raw&threshold=0.75', 'unknown threshold'],
  ['#/?score=h3_1&mode=raw&threshold=0.65', 'unknown score'],
  ['#/?score=h12_1&mode=sideways&threshold=0.65', 'unknown mode'],
  ['#/?threshold=', 'empty threshold'],
]) {
  await stale.goto(`${base}${hash}`, { waitUntil: 'domcontentloaded' });
  let rendered = false;
  try {
    await stale.waitForSelector('.card', { timeout: 8000 });
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

// ---- back navigation preserves the chosen view -----------------------------
// A fresh page: navigating by hash away from a page that already holds a chart
// iframe never reaches "networkidle", which is a harness quirk, not a bug.
const navPage = await newPage();
await navPage.goto(`${base}#/?score=h9_1&mode=voladj&threshold=0.70`, { waitUntil: 'domcontentloaded' });
await navPage.waitForSelector('.card');
await navPage.click('.stock');
await navPage.waitForSelector('.detail-head h2');
await navPage.goBack();
await navPage.waitForSelector('.card');
const restored = await navPage.evaluate(() =>
  [...document.querySelectorAll('.seg button[aria-pressed=true]')].map((b) => b.textContent));
check('back button restores the chosen view', restored.join(',').includes('9–1') && restored.join(',').includes('Vol-adjusted'), restored.join(','));

// ---- dark mode -------------------------------------------------------------
const dark = await newPage('dark');
await dark.goto(`${base}#/${top}?score=h12_1&mode=raw&threshold=0.65`, { waitUntil: 'domcontentloaded' });
await dark.waitForSelector('.chart-wrap iframe', { timeout: 15000 });
check('dark mode passes the theme to the chart',
  (await dark.evaluate(() => window.__tvMounted?.theme)) === 'dark');

await browser.close();
server.close();

if (failures.length) {
  console.error(`\n${failures.length} UI check(s) failed:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('\nAll UI checks passed.');
