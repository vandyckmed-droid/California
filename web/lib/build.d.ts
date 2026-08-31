/**
 * The shape of `lib/build.js`, which is written at deploy time by
 * `scripts/stamp-version.mjs` and deliberately never committed.
 *
 * The declaration *is* committed, so that a tree which has not been stamped —
 * a fresh clone, and every CI run — still typechecks. That is not a workaround
 * for the gitignore: an unstamped tree is a supported state, because
 * `refresh.js` imports this module dynamically and keeps working without it.
 * Checking against the declaration rather than against whatever the last local
 * `npm run stamp` happened to leave behind is what makes CI test that state.
 */

/** The build this code belongs to, compared against the server's version.json. */
export declare const VERSION: string;

/**
 * Every asset the page loads, refetched as a set before an update reloads, so
 * the new build lands whole. Excludes index.html, which the reload refetches.
 */
export declare const ASSETS: string[];
