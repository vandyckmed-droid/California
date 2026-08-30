/**
 * Bundles the whole app into one self-contained HTML file.
 *
 *   node scripts/build-preview.mjs [out.html]
 *
 * The real site is a static page that fetches its data — a 135 KB snapshot up
 * front and one small file per name, only when a chart or the watchlist wants
 * it. A preview has nowhere to fetch from, so this inlines both: the modules
 * are concatenated with their imports stripped (they are one dependency graph
 * with no cycles, so order alone resolves them) and the JSON is embedded.
 *
 * That makes the preview file large in a way the deployed site is not. It is a
 * faithful copy of the behaviour and a misleading one of the download, so the
 * size figures worth quoting come from `npm run verify:ui`, not from here.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const out = process.argv[2] ?? 'preview.html';
const read = (p) => readFileSync(join('web', p), 'utf8');

// Leaf-first, and `app.js` last of all. Order is what resolves the graph here,
// and app.js calls boot() as its final statement: anywhere earlier in the file
// and the render fires before the views' own top-level constants exist.
const MODULES = ['lib/quant.js', 'lib/model.js', 'views/list.js', 'views/ticker.js', 'views/watchlist.js', 'app.js'];

// Imports and re-exports go; `export` on a declaration just becomes a plain
// declaration, since everything lands in one scope.
const strip = (src) => src
  .replace(/^import\b[^;]*?from\s*['"][^'"]*['"]\s*;?/gm, '')
  .replace(/^export\s+(?=(const|let|var|function|async|class)\b)/gm, '');

const snapshot = JSON.parse(readFileSync('web/data/snapshot.json', 'utf8'));
const series = {};
for (const f of readdirSync('web/data/series')) {
  if (f.endsWith('.json')) series[f.replace(/\.json$/, '')] = JSON.parse(readFileSync(join('web/data/series', f), 'utf8'));
}

let js = MODULES.map((m) => `// ---- ${m} ----\n${strip(read(m))}`).join('\n');

// Two fetches to shim, and both are asserted here rather than assumed: a
// silent miss would produce a preview stuck on its loading message.
const snapshotFetch = /const res = await fetch\('data\/snapshot\.json'[^;]*;\s*if \(!res\.ok\)[^;]*;\s*snapshot = await res\.json\(\);/;
if (!snapshotFetch.test(js)) throw new Error('snapshot fetch not found — update build-preview.mjs');
js = js.replace(snapshotFetch, 'snapshot = window.__SNAPSHOT__;');

const seriesFetch = /pending = fetch\(`data\/series\/\$\{encodeURIComponent\(symbol\)\}\.json`\)[\s\S]*?\}\);/;
if (!seriesFetch.test(js)) throw new Error('series fetch not found — update build-preview.mjs');
js = js.replace(seriesFetch,
  'pending = window.__SERIES__[symbol] ? Promise.resolve(window.__SERIES__[symbol]) : Promise.reject(new Error("no series"));');

const html = `<title>Momentum Ranker</title>
<style>
${read('styles.css')}
</style>
<div id="app" class="app"><p class="loading">Loading screen…</p></div>
<script>window.__SNAPSHOT__ = ${JSON.stringify(snapshot)};
window.__SERIES__ = ${JSON.stringify(series)};</script>
<script type="module">
${js}
</script>`;

writeFileSync(out, html);
console.log(`${out}: ${(html.length / 1024 / 1024).toFixed(2)} MB, ${Object.keys(series).length} names inlined`);
