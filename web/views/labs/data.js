/**
 * The Labs sidecar loader.
 *
 * Kept apart from `app.js`'s `loadSeries` on purpose: this file is the only
 * thing that knows the sidecar exists, so removing the experiment removes the
 * only reference to it. Core never imports this module.
 */

/** @type {Promise<any> | null} */
let pending = null;

export function loadRankHistory() {
  if (!pending) {
    pending = fetch('data/labs/rank-history.json', { cache: 'no-cache' }).then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    });
    // A failed load must not be cached, or the screen is broken for the session.
    pending.catch(() => { pending = null; });
  }
  return pending;
}
