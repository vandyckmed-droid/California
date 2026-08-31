import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The boundary that makes an experiment safe to keep.
 *
 * **Experiments may depend on stable Cali; stable Cali may never depend on
 * experiments.** That is the whole basis for letting Labs exist in the repo at
 * all — it is what makes removal a delete rather than an untangling, and what
 * guarantees the ranked list, the ticker and the watchlist keep working if the
 * experiment is wrong, unfinished, or gone.
 *
 * Asserted rather than trusted, because the direction of a single import is
 * exactly the kind of thing that flips during a hurried change and is invisible
 * afterwards.
 */

const CORE_WEB = [
  'web/app.js',
  'web/lib/model.js',
  'web/lib/quant.js',
  'web/views/list.js',
  'web/views/ticker.js',
  'web/views/watchlist.js',
];

/**
 * Every `src/` file except the experiments' own modules and `run.ts`.
 *
 * `run.ts` is the orchestrator and the one sanctioned place that may reach the
 * rank-history backfill; it gets its own assertion below rather than an
 * exemption. Everything under `src/labs/` is an experiment and is excluded for
 * the same reason.
 */
function coreSrcFiles(dir = 'src'): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (path === join('src', 'labs')) return [];
    if (statSync(path).isDirectory()) return coreSrcFiles(path);
    if (!path.endsWith('.ts')) return [];
    if (path.endsWith('rankHistory.ts') || path.endsWith('run.ts')) return [];
    return [path];
  });
}

/** Every file belonging to one experiment. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

const ETF_RIVER_SRC = 'src/labs/etfRiver';
const ETF_RIVER_VIEW = 'web/views/labs/etfRiver.js';

const read = (path: string) => readFileSync(path, 'utf8');

/** Module specifiers a file imports, static and dynamic. */
function importsOf(src: string): string[] {
  return [
    ...[...src.matchAll(/^import\b[^;]*?from\s*['"]([^'"]+)['"]/gm)].map((m) => m[1] as string),
    ...[...src.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1] as string),
  ];
}

describe('the Labs boundary', () => {
  it('no core browser module imports anything from views/labs/', () => {
    for (const file of CORE_WEB) {
      const src = read(file);
      // A static import would pull the experiment into every page load; a
      // dynamic one in app.js is the single sanctioned entry point.
      const staticImports = [...src.matchAll(/^import\b[^;]*?from\s*['"]([^'"]+)['"]/gm)]
        .map((m) => m[1] as string);
      expect(staticImports.filter((p) => p.includes('labs')), `${file} statically imports Labs`)
        .toEqual([]);
    }
  });

  it('reaches Labs from exactly one place, dynamically', () => {
    const app = read('web/app.js');
    const dynamic = [...app.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1] as string);
    expect(dynamic.filter((p) => p.includes('labs'))).toEqual(['./views/labs/index.js']);
    // One reference, so deleting the branch deletes the route.
    expect(app.split('views/labs/').length - 1).toBe(1);
  });

  it('no core pipeline module imports the rank-history backfill', () => {
    // Imports, not mentions: snapshot.ts names the backfill in a comment
    // explaining why `roundTo` is exported, and prose is not a dependency.
    for (const file of coreSrcFiles()) {
      expect(
        importsOf(read(file)).filter((p) => p.includes('rankHistory')),
        `${file} imports the experiment`,
      ).toEqual([]);
    }
  });

  it('run.ts is the only core module that reaches the backfill', () => {
    const imports = importsOf(read('src/run.ts')).filter((p) => p.includes('rankHistory'));
    expect(imports).toEqual(['./pipeline/rankHistory.ts']);
  });

  it('the experiment depends on the product, which is the allowed direction', () => {
    // Not decoration: it is what stops a concept quietly disagreeing with the
    // product about a rank. The backfill must use the shipped scorer.
    const backfill = read('src/pipeline/rankHistory.ts');
    expect(backfill).toContain("from '../../web/lib/model.js'");
    expect(backfill).toMatch(/ranksFor|scoresFor/);
  });

  it('the snapshot does not carry or hash the sidecar', () => {
    const snapshot = read('src/pipeline/snapshot.ts');
    expect(importsOf(snapshot).filter((p) => p.includes('rankHistory'))).toEqual([]);
    // The sidecar is not a column and is not inside the hashed payload, so
    // adding or removing the experiment cannot move `dataHash`.
    expect(snapshot).not.toContain('rank-history.json');
    expect(snapshot).not.toMatch(/rankHistory:|rvHistory|history:/);
  });

  it('the sidecar is written after the snapshot and cannot throw past itself', () => {
    const run = read('src/run.ts');
    const snapshotWrite = run.indexOf('writeFileSync(out, json)');
    const sidecar = run.indexOf('writeRankHistory(');
    expect(snapshotWrite).toBeGreaterThan(-1);
    expect(sidecar).toBeGreaterThan(snapshotWrite);

    const body = run.slice(run.indexOf('function writeRankHistory'));
    expect(body).toContain('} catch (err) {');

    // Not just "the function contains a try": *every* call that can throw must
    // be inside it. An `rmSync` one line above the `try` passed the weaker
    // version of this test and was the single path by which the experiment
    // could still fail the daily refresh — `force` only swallows ENOENT, so an
    // EACCES or EBUSY would propagate out of `main()` and the day's snapshot
    // would never be committed.
    const tryAt = body.indexOf('try {');
    expect(tryAt).toBeGreaterThan(-1);
    const beforeTry = body.slice(0, tryAt);
    for (const call of ['rmSync', 'mkdirSync', 'writeFileSync', 'buildRankHistory', 'sessionRanks']) {
      expect(beforeTry, `${call} runs before the try in writeRankHistory`).not.toContain(call);
    }
  });

  it('only the Labs loader knows the sidecar path', () => {
    const owners = ['web/views/labs/data.js'];
    const all = [...CORE_WEB, 'web/views/labs/index.js', 'web/views/labs/rankRiver.js'];
    for (const file of all) {
      const mentions = read(file).includes('rank-history.json');
      expect(mentions, `${file} should not name the sidecar path`).toBe(owners.includes(file));
    }
    expect(read('web/views/labs/data.js')).toContain('rank-history.json');
  });
});

/**
 * The second boundary: between the experiments themselves.
 *
 * Rank River and ETF River are both rivers, which is exactly why this is
 * asserted. Two experiments that quietly grow a shared module stop being
 * separately removable, and the first one to be judged a failure takes the
 * other down with it — or worse, survives only because the other depends on
 * it. ETF River is deliberately its own program end to end: its own entry
 * point, its own universe, its own sidecar, its own view.
 */
describe('the ETF River experiment', () => {
  it('is not reachable from the product at all', () => {
    for (const file of [...coreSrcFiles(), 'src/run.ts']) {
      expect(
        importsOf(read(file)).filter((p) => p.includes('labs/')),
        `${file} imports the experiment`,
      ).toEqual([]);
    }
    for (const file of CORE_WEB) {
      expect(read(file).includes('etfRiver'), `${file} names the experiment`).toBe(false);
    }
  });

  it('runs as its own program, not inside the product refresh', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    expect(pkg.scripts['labs:etf-river']).toContain('src/labs/etfRiver/run.ts');
    // The product's own entry point is untouched by it: a failure in the
    // experiment cannot cost a day's snapshot because it is not in that run.
    expect(pkg.scripts.screen).not.toContain('labs');
    expect(read('src/run.ts')).not.toContain('etfRiver');
  });

  it('does not delete another experiment\'s sidecar', () => {
    // web/data/labs/ is shared. The product run used to clear the whole
    // directory, which would have removed this experiment's file on every
    // refresh — isolation has to hold in the filesystem too, not just in the
    // import graph.
    const run = read('src/run.ts');
    expect(run).toContain("rmSync(resolve(labsDir, 'rank-history.json')");
    expect(run).not.toMatch(/rmSync\(labsDir/);
  });

  it('is not downloaded by opening the other experiment', () => {
    // The Labs menu names both, so it is the one place the two could become
    // coupled. Static imports there would mean opening Rank River downloads
    // this experiment and its ~40 KB sidecar view, and vice versa.
    const index = read('web/views/labs/index.js');
    const statics = [...index.matchAll(/^import\b[^;]*?from\s*['"]([^'"]+)['"]/gm)].map((m) => m[1] as string);
    expect(statics.filter((p) => /rankRiver|etfRiver/.test(p))).toEqual([]);
    const dynamic = [...index.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1] as string);
    expect(dynamic.sort()).toEqual(['./etfRiver.js', './rankRiver.js']);
  });

  it('shares no module with the other experiment', () => {
    for (const file of filesUnder(ETF_RIVER_SRC)) {
      const imports = importsOf(read(file));
      expect(imports.filter((p) => /rankHistory|rankRiver/.test(p)), file).toEqual([]);
    }
    const view = importsOf(read(ETF_RIVER_VIEW));
    expect(view.filter((p) => /rankRiver|labs\/data/.test(p))).toEqual([]);
    // And nothing of the other experiment's reaches back into this one.
    expect(read('web/views/labs/rankRiver.js')).not.toContain('etfRiver');
    expect(read('src/pipeline/rankHistory.ts')).not.toContain('etfRiver');
  });

  it('depends on the product, which is the allowed direction', () => {
    // Not decoration: the experiment reuses the product's calendar alignment,
    // its statistics and its FMP client rather than growing a second copy that
    // agrees until it doesn't.
    const all = filesUnder(ETF_RIVER_SRC).map(read).join('\n');
    expect(all).toContain("from '../../pipeline/calendar.ts'");
    expect(all).toContain("from '../../pipeline/stats.ts'");
    expect(all).toContain("from '../../fmp/client.ts'");
  });

  it('only its own view knows its sidecar path', () => {
    const all = [...CORE_WEB, 'web/views/labs/index.js', 'web/views/labs/rankRiver.js',
      'web/views/labs/data.js', ETF_RIVER_VIEW];
    for (const file of all) {
      expect(read(file).includes('etf-river.json'), file).toBe(file === ETF_RIVER_VIEW);
    }
  });
});
