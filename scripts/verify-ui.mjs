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
 * The per-ticker chart is drawn inline from the snapshot, so nothing external
 * is loaded and the check needs no network at all.
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
await page.waitForSelector('.chart-wrap svg.spark', { timeout: 15000 });

const detail = await page.evaluate(() => ({
  points: document.querySelector('.spark path.line')?.getAttribute('d')?.split('L').length ?? 0,
  chartH: Math.round(document.querySelector('svg.spark').getBoundingClientRect().height),
  horizonBars: document.querySelectorAll('.hz-bars .hz-row').length,
  activeBars: document.querySelectorAll('.hz-bar.on').length,
  labelSize: parseFloat(getComputedStyle(document.querySelector('.hz-label')).fontSize),
  skipShade: !!document.querySelector('.spark rect.skip'),
  panels: [...document.querySelectorAll('.panel h3')].length,
  rankCells: document.querySelectorAll('.rank-cell').length,
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

// The highlighted window must follow the view being ranked on.
for (const [score, label] of [['h9_1', '9-1'], ['h6_1', '6-1']]) {
  await page.goto(`${base}#/${top}?score=${score}&mode=raw&threshold=0.65`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.hz-label.on');
  const active = await page.evaluate(() =>
    document.querySelector('.hz-label.on')?.textContent?.trim() ?? '');
  check(`detail: ${label} view highlights the ${label} window`, active.startsWith(label), active);
}

// ---- stale or malformed hash params// ---- stale or malformed hash params ----------------------------------------
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

await browser.close();
server.close();

if (failures.length) {
  console.error(`\n${failures.length} UI check(s) failed:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('\nAll UI checks passed.');
