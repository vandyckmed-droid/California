/**
 * Keeps a long-lived session from running an old build.
 *
 * A page saved to a phone's home screen is *relaunched*, not reloaded. iOS
 * restores the standalone window to whatever was last there, and there is no
 * address bar and no pull-to-refresh to force the issue — so a session opened
 * once can keep serving the same code for weeks. GitHub Pages compounds it:
 * every file goes out with a fixed `max-age=600` that cannot be configured, so
 * even a real reload is entitled to reuse what it already has.
 *
 * The data is not the problem; it is fetched `no-cache` and revalidates on
 * every boot. The code is. So the code checks itself: compare the version
 * baked into this build against the one the server is serving right now, and
 * when they differ, refetch the whole asset list and reload.
 *
 * Refetching everything first is what makes the update atomic. Each module has
 * its own independent ten-minute window, so a bare reload can assemble a new
 * `app.js` on top of a still-cached view — a mixed build that is harder to
 * diagnose than a uniformly old one.
 */

/** Long enough that returning to the app repeatedly costs one request, not many. */
const MIN_INTERVAL_MS = 60_000;

/** Which server version we have already reloaded for, so a bad one cannot loop. */
const ATTEMPT_KEY = 'california.updateAttempt';

/** @type {typeof import('./build.js') | null} */
let build = null;
let lastCheck = 0;
let checking = false;

/**
 * Starts watching. Never awaited by the caller: a version check must not sit
 * in front of the first paint.
 */
export async function watchForUpdates() {
  try {
    build = await import('./build.js');
  } catch {
    // An unstamped tree — a plain clone, opened with `npx serve`. There is
    // nothing to compare against, so there is nothing to do. Deliberately not
    // a static import: a missing generated file must not take the app down.
    return;
  }
  check();
  // The relaunch case. `visibilitychange` is what fires when the home-screen
  // window comes back to the foreground; there is no load event to hook.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') check();
  });
  // And the back-forward cache, which restores a page without running it.
  window.addEventListener('pageshow', (e) => { if (e.persisted) check(); });
}

async function check() {
  if (checking || Date.now() - lastCheck < MIN_INTERVAL_MS) return;
  checking = true;
  try {
    // `no-store` rather than `no-cache`: this one request has to reflect the
    // server, and it is the only request in the app that cannot be allowed to
    // answer from the very cache it exists to defeat.
    const res = await fetch('version.json', { cache: 'no-store' });
    if (!res.ok) return;
    const { version } = await res.json();
    // Only a check that got an answer counts against the interval. Holding off
    // for a minute because the network happened to be down at boot would make
    // the offline case the slow case, which is backwards.
    lastCheck = Date.now();
    if (!build || !version || version === build.VERSION) return;
    // One attempt per server version. If the reload does not take — a proxy
    // pinning an old file, a deploy caught mid-flight — the app stays usable
    // and old instead of reloading forever.
    if (attempted() === version) return;
    remember(version);
    await Promise.all(build.ASSETS.map((a) => fetch(a, { cache: 'reload' }).catch(() => {})));
    location.reload();
  } catch {
    // Offline, or a deploy in flight. Nothing is broken; check again next time
    // the app is opened.
  } finally {
    checking = false;
  }
}

function attempted() {
  try { return sessionStorage.getItem(ATTEMPT_KEY); } catch { return null; }
}

/** @param {string} version */
function remember(version) {
  // Session-scoped on purpose: a genuinely stuck version gets one more try the
  // next time the app is launched, rather than being written off for good.
  try { sessionStorage.setItem(ATTEMPT_KEY, version); } catch { /* private mode */ }
}
