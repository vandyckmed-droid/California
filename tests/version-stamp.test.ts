import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { assetFiles, stamp, versionOf } from '../scripts/stamp-version.mjs';

const read = (p: string) => readFileSync(p, 'utf8');

/** A miniature `web/` tree: the shapes that matter, none of the bulk. */
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'stamp-'));
  mkdirSync(join(root, 'lib'));
  mkdirSync(join(root, 'views', 'labs'), { recursive: true });
  mkdirSync(join(root, 'data', 'labs'), { recursive: true });
  writeFileSync(join(root, 'index.html'), '<!doctype html>\n');
  writeFileSync(join(root, 'app.js'), 'export const a = 1;\n');
  writeFileSync(join(root, 'styles.css'), '.a{}\n');
  writeFileSync(join(root, 'lib', 'model.js'), 'export const m = 1;\n');
  writeFileSync(join(root, 'views', 'labs', 'index.js'), 'export const l = 1;\n');
  writeFileSync(join(root, 'data', 'snapshot.json'), '{"asOf":"2026-08-31"}');
  writeFileSync(join(root, 'data', 'labs', 'etf-river.json'), '{"asOf":"2026-08-31"}');
  roots.push(root);
  return root;
}

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

describe('the build stamp', () => {
  it('covers the code and skips the data', () => {
    const files = assetFiles(fixture());
    expect(files).toEqual([
      'app.js',
      'index.html',
      'lib/model.js',
      'styles.css',
      'views/labs/index.js',
    ]);
    // The snapshot and the sidecars are already revalidated on every boot, so
    // folding them in would move the version every weekday and reload the app
    // for data it was going to fetch anyway.
    expect(files.some((f: string) => f.startsWith('data/'))).toBe(false);
  });

  it('never hashes its own output', () => {
    // Otherwise the stamp changes what it is measuring and no two runs agree.
    const root = fixture();
    const before = stamp(root).version;
    expect(stamp(root).version).toBe(before);
    expect(assetFiles(root)).not.toContain('lib/build.js');
    expect(assetFiles(root)).not.toContain('version.json');
  });

  it('is the same version for the same bytes', () => {
    const a = fixture();
    const b = fixture();
    expect(versionOf(a, assetFiles(a))).toBe(versionOf(b, assetFiles(b)));
  });

  it('moves when any covered file changes', () => {
    for (const file of ['app.js', 'index.html', 'styles.css', 'lib/model.js', 'views/labs/index.js']) {
      const root = fixture();
      const before = versionOf(root, assetFiles(root));
      writeFileSync(join(root, file), `${read(join(root, file))}\n// touched\n`);
      expect(versionOf(root, assetFiles(root)), `${file} did not move the version`).not.toBe(before);
    }
  });

  it('does not move when only the data changes', () => {
    const root = fixture();
    const before = versionOf(root, assetFiles(root));
    writeFileSync(join(root, 'data', 'snapshot.json'), '{"asOf":"2026-09-01"}');
    expect(versionOf(root, assetFiles(root))).toBe(before);
  });

  it('moves on a rename that leaves every byte intact', () => {
    // A renamed module is a different URL to fetch, so the browser's copy of
    // the old one is stale even though no file's contents changed.
    const root = fixture();
    const before = versionOf(root, assetFiles(root));
    const body = read(join(root, 'lib', 'model.js'));
    rmSync(join(root, 'lib', 'model.js'));
    writeFileSync(join(root, 'lib', 'rows.js'), body);
    expect(versionOf(root, assetFiles(root))).not.toBe(before);
  });

  it('writes a build the page can compare against a server version', () => {
    const root = fixture();
    const { version } = stamp(root);
    const build = read(join(root, 'lib', 'build.js'));
    expect(build).toContain(`export const VERSION = ${JSON.stringify(version)}`);
    expect(JSON.parse(read(join(root, 'version.json'))).version).toBe(version);

    // ASSETS is what gets refetched before the reload, so it has to be every
    // module the page loads — and not the document, which the reload covers.
    const assets = JSON.parse(build.slice(build.indexOf('['), build.lastIndexOf(']') + 1));
    expect(assets).toContain('app.js');
    expect(assets).toContain('styles.css');
    expect(assets).toContain('lib/model.js');
    expect(assets).toContain('views/labs/index.js');
    expect(assets).not.toContain('index.html');
  });

  it('runs as a program', () => {
    const root = fixture();
    const out = execFileSync('node', ['scripts/stamp-version.mjs', root], { encoding: 'utf8' });
    expect(out).toMatch(/^stamped [0-9a-f]{12} over \d+ assets$/m);
  });
});

describe('the update check', () => {
  const refresh = read('web/lib/refresh.js');

  it('is started by the app, and not awaited', () => {
    const app = read('web/app.js');
    expect(app).toContain("from './lib/refresh.js'");
    // Awaiting it would put a network round trip in front of the first paint.
    expect(app).toMatch(/^\s*watchForUpdates\(\);$/m);
    expect(app).not.toMatch(/await watchForUpdates/);
  });

  it('reads the server version past every cache', () => {
    // `no-cache` would revalidate — correct for data, useless here, because a
    // 304 from the very cache we are trying to defeat proves nothing.
    expect(refresh).toMatch(/fetch\('version\.json', \{ cache: 'no-store' \}\)/);
  });

  it('refetches the whole build before reloading', () => {
    // A bare reload can pair a new app.js with a still-cached view: each file
    // has its own independent freshness window.
    expect(refresh).toMatch(/build\.ASSETS\.map\(/);
    expect(refresh).toMatch(/fetch\(a, \{ cache: 'reload' \}\)/);
    expect(refresh.indexOf('ASSETS')).toBeLessThan(refresh.indexOf('location.reload()'));
  });

  it('tolerates a tree that was never stamped', () => {
    // A plain clone has no lib/build.js. A static import would make that a
    // blank screen instead of an app that simply does not self-update.
    expect(refresh).toMatch(/await import\('\.\/build\.js'\)/);
    expect(refresh).not.toMatch(/^import .*build\.js/m);
  });

  it('cannot reload in a loop', () => {
    expect(refresh).toContain('attempted() === version');
    expect(refresh).toContain('sessionStorage');
  });

  it('rechecks when the app is brought back to the foreground', () => {
    // The reported symptom: a home-screen window is relaunched, not reloaded,
    // so there is no load event to hang this on.
    expect(refresh).toContain("addEventListener('visibilitychange'");
    expect(refresh).toContain("document.visibilityState === 'visible'");
    expect(refresh).toContain("addEventListener('pageshow'");
  });

  it('is generated, never committed', () => {
    const ignored = read('.gitignore');
    expect(ignored).toContain('web/lib/build.js');
    expect(ignored).toContain('web/version.json');
    const tracked = execFileSync('git', ['ls-files', 'web/lib/build.js', 'web/version.json'], {
      encoding: 'utf8',
    });
    expect(tracked.trim()).toBe('');
  });

  it('is stamped by the workflow, over the bytes actually deployed', () => {
    const wf = read('.github/workflows/screen.yml');
    expect(wf).toContain('node scripts/stamp-version.mjs');
    // After the refresh writes web/data and before the artifact is packed.
    expect(wf.indexOf('stamp-version.mjs')).toBeLessThan(wf.indexOf('upload-pages-artifact'));
    expect(wf.indexOf('Commit refreshed snapshot')).toBeLessThan(wf.indexOf('stamp-version.mjs'));
  });
});
