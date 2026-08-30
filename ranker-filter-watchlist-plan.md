# Reshape into a ranker / filter / watchlist tool

> **Status: proposed, not built.** This PR contains the plan only — no
> implementation. It is here so the approach can be critiqued before any code
> is written, since this is a reshape of the primary screen rather than an
> addition to it. Implementation follows in a separate PR once this is agreed.

## Context

The app today opens on **correlation groups** computed automatically over the Top 100. That was the original brief, and it works, but it is not what the product is for.

What it should be: a fast, mobile ranking and filtering tool — "a few steps above a nice spreadsheet." Take a large universe of stocks, sort and filter it with quant tools, **pick the names you like**, and then see the risk analysis on *your basket* — not on a pre-cut hundred.

Four screens' worth of intent, in the user's words:

1. **Home** = the ranked list. Sort it, filter it, scan it.
2. **Tap a row** = per-ticker view with the light chart (already built in PR #2).
3. **Select rows** = build a watchlist.
4. **Watchlist view** = the correlation / risk analysis, on your picks.

The overriding constraint is that it stays light and fast. The TradingView episode is the cautionary tale: never trade responsiveness for capability.

This lands **after PR #2 merges**, as its own PR.

---

## The size problem, and the fix

Filtering a real universe means carrying more than 100 names. Measured, scaled from the current snapshot:

| | raw | **gzipped (what downloads)** |
|---|---|---|
| today — top 100, with prices | 387 KB | **96 KB** |
| naive — all 2,320 in one file | 2,002 KB | **619 KB** |

619 KB would be a 6× regression on exactly the thing that matters. So **split the payload by when it is needed**:

| file | contents | gzipped | loaded |
|---|---|---|---|
| `web/data/snapshot.json` | meta + one row per eligible name: name, sector, exchange, price, market cap, and per horizon `{momentum, realizedVol, zRaw, zVol}` | **114 KB** | immediately |
| `web/data/series.json` | the encoded daily price series per name | **351 KB** | lazily — first ticker tap, or opening the watchlist |

The home screen therefore covers **all 2,320 names** for roughly what 100 names cost today. Prices only arrive if you actually look at a chart or a basket.

Series fetch also kicks off in the background the moment the first name is selected, so the watchlist is warm by the time it is opened.

---

## Ranking moves to the browser

Today the pipeline ships eight pre-materialized Top-100 lists. That cannot support filtering — filter first, then rank, is the whole point.

Instead the snapshot carries **per-symbol cross-sectional z-scores** (computed in the pipeline, since winsorized z-scores depend on the full cross-section and must not shift when a filter changes), and the browser sorts. Sorting 2,320 rows is sub-millisecond.

`effectiveVol = max(realizedVol, 0.175)` and `volAdjusted = momentum / effectiveVol` are derived in the browser; the blend is the mean of three z-scores.

**Rank semantics are unchanged and must stay that way: rank is a name's position in the full eligible universe for the chosen view. Filtering hides rows, it never renumbers them.** You still see `#1`, `#7`, `#23` in a filtered list. A test asserts browser-side ranking reproduces the pipeline's ordering exactly.

This also drops the 8 ranked lists from the payload (−20 KB gz) and removes a duplicate source of truth.

---

## Shared quant code, one copy

The watchlist computes correlations and groups **client-side**, over whatever names are selected. That is the same maths the pipeline already runs.

Rather than reimplement it in the browser and let the two drift, move the canonical implementations to **`web/lib/quant.js`** — plain ESM, JSDoc-typed:

- `pearson`, `simpleReturns` (from `src/pipeline/stats.ts`)
- `completeLinkageGroups` (from `src/pipeline/cluster.ts`)
- `decodeSeries` (mirrors `src/pipeline/series.ts`)

The page imports it directly; the pipeline imports it too (`allowJs` in `tsconfig.json`). It lives under `web/` because only `web/` is deployed. Existing tests in `tests/cluster.test.ts` retarget to it, so one test suite covers both consumers.

---

## Screens

### Home — the ranked list

Sticky header, in order of how often it is touched:

- **View**: `12–1 · 9–1 · 6–1 · Blend` and a **vol-adjusted** toggle (as today)
- **Filters**: sector (multi-select chips), market cap (`All · ≥$2B · ≥$10B · ≥$50B`), and a symbol/name search box
- A live count: *"312 of 2,320 · showing 150"*

Rows: `rank · symbol · name · score · ☆`. Tap the row → ticker view. Tap the **star** → select. (Tap-to-open was confirmed earlier, so selection gets its own target rather than a long-press.)

2,320 rows will not all go in the DOM. Render ~150 and append on scroll via `IntersectionObserver` — about fifteen lines, keeps scrolling smooth, hides nothing.

The correlation-threshold control **moves off this screen** to the watchlist, where it belongs. Home gets simpler.

### Watchlist — risk analysis on your picks

Reached from a `Watchlist (n)` control in the header. Shows:

- your selected names, in current-view rank order, each removable
- **which of them move together** — complete-linkage groups over just this set, at ρ ≥ 0.60/0.65/0.70 (the threshold control lives here)
- the tightest pairs, highest ρ first
- two plain-language concentration lines: average pairwise correlation, and sector breakdown

Empty state explains how to add names. Selection persists in `localStorage`.

### Ticker — unchanged from PR #2

Plus one addition: an add/remove-from-watchlist button.

### Home marker (last item, droppable)

Once names are selected and `series.json` has loaded, rows that correlate ≥ threshold with something already picked get a subtle dot — *"this is the same trade as one you have."* It restores, on demand, the insight the automatic grouping used to give, without cluttering the default screen. Build this last; cut it if it complicates anything.

---

## Files

| file | change |
|---|---|
| `src/pipeline/snapshot.ts` | emit two files; per-symbol rows for the whole eligible universe; drop the 8 ranked lists |
| `src/pipeline/score.ts` | expose per-symbol z-scores; keep `buildViews` for invariant assertions and tests |
| `src/run.ts` | write `snapshot.json` + `series.json`; series for all eligible names |
| `web/lib/quant.js` | **new** — shared pearson / clustering / decode |
| `web/views/list.js` | rewritten: ranked list, filters, incremental render, selection |
| `web/views/watchlist.js` | **new** — the risk screen |
| `web/views/ticker.js` | add watchlist toggle |
| `web/app.js` | third route, lazy series loader, selection state in `localStorage` |
| `web/styles.css` | filter chips, list rows, watchlist panels |
| `tests/`, `scripts/verify-ui.mjs` | see below |

---

## Verification

- **Unit** — browser-side ranking reproduces the pipeline's ordering for all eight views; z-scores are stable under filtering; `web/lib/quant.js` passes the existing clustering suite unchanged; watchlist grouping over an arbitrary subset still guarantees every within-group pair clears the threshold.
- **Size budget, asserted in the UI check** — `snapshot.json` under **150 KB gzipped**, and the home screen must issue **no request for `series.json`** until a chart or the watchlist is opened. This is the regression that would quietly undo the whole point, so it gets a test.
- **UI** (`npm run verify:ui`, Chromium at 390×844) — filtering by sector narrows the list without renumbering ranks; search works; incremental scroll loads more; starring a row adds it to the watchlist and survives a reload; the watchlist groups the selected names correctly; the ticker view still renders its chart; nothing loads from a third-party host.
- **Performance** — measure time from load to first interactive row, and scroll smoothness with all 2,320 matching. Report both.

## Order

1. Pipeline: per-symbol rows + z-scores, split the two files
2. `web/lib/quant.js` + retarget tests
3. Home: ranked list, filters, incremental render
4. Selection + `localStorage` + lazy series loading
5. Watchlist screen
6. Ticker watchlist button
7. Home correlation marker (droppable)
8. Full verification, then PR

**Not doing:** portfolio optimization, position sizing, or any suggestion about what to buy. The tool ranks, filters, and shows concentration. The decision stays with the user.
