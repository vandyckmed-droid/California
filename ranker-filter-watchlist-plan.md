# Reshape into a ranker / filter / watchlist tool

> **Status: proposed, not built.** This PR contains the plan only — no
> implementation. It is here so the approach can be critiqued before any code
> is written, since this is a reshape of the primary screen rather than an
> addition to it. Implementation follows in a separate PR once this is agreed.
>
> **Revised after review.** The first draft reused the chart's display-grade
> price encoding for the watchlist's correlations. Measured, that would have
> broken 26 of the pipeline's 82 certified groups and produced risk numbers
> that were plausible, self-consistent and wrong — and the draft's own
> verification could not have caught it. Scoping precision to the selection
> fixes it and is *smaller* than what it replaces. Reviewing the plan before
> building it paid for itself here.

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

619 KB would be a 6× regression on exactly the thing that matters. So **split the payload by when it is needed, and fetch prices per symbol**:

| file | contents | size | loaded |
|---|---|---|---|
| `web/data/snapshot.json` | meta + one row per eligible name: name, sector, exchange, price, market cap, per horizon `{momentum, realizedVol, zRaw, zVol}`, and each name's top correlated neighbours | **~120 KB gz** | immediately |
| `web/data/series/<SYMBOL>.json` | that one name's display series **and** its correlation-grade returns | **~700 B** | on tapping or starring that name |

The home screen therefore covers **all 2,320 names** for roughly what 100 names cost today, and opening one chart costs 700 bytes rather than a bundle of every other name's prices. No background warming is needed — the unit of fetch is already the unit of use.

### Two grades of price data, because a chart and a correlation are not the same problem

The display encoding shipped in #2 — 64 levels, one character per day — is correct for a chart and wrong for a correlation, and reusing it for the watchlist was the load-bearing flaw in the first draft of this plan.

Correlation is measured on *daily returns*, and rounding invisible on a chart is not small next to a daily move. Measured against the committed snapshot, the quantization step is a **median 0.95× the median daily move** (p10 0.72×, p90 1.12×, worst 4.79×). The error is the same size as the signal.

The consequence is not theoretical. Recomputing the pipeline's **own certified groups** through the display encoding — the exact path the watchlist would have taken — breaks the invariant the pipeline asserts on every run:

```
MU · STX · SNDK · WDC        certified 0.6883  ->  recomputed 0.6484
DELL · HPE                   certified 0.6767  ->  recomputed 0.6439
RLJ · HST · APLE · PEB · DRH certified 0.6835  ->  recomputed 0.6330

26 of 82 certified groups fall below 0.65 when recomputed from shipped data
```

Validated against full-precision closes refetched from FMP for 14 names (91 pairs, 126-session window):

| chars/day | mean abs error | worst | pairs crossing ρ = 0.65 |
|---|---|---|---|
| 1 (display grade) | 0.03125 | 0.07010 | **6 of 91** |
| **2 (correlation grade)** | **0.00030** | **0.00081** | **0** |
| 3 | 0.00000 | 0.00001 | 0 |

So: **keep 1 char/day for the chart, use 2 chars/day over the 126-session window for correlation.** Two characters is ample and three is waste.

Applying correlation grade to the whole universe in one bundle would cost ~900 KB gzipped — the payload this plan opens by rejecting. It is affordable only because **correlation is needed solely for names the user picked**: at ~332 bytes per name, a 30-name watchlist is **9.7 KB**, smaller than the bundle it replaces by a factor of 36.

### Repository cost

Per-symbol files mean ~2,320 small files rewritten by each scheduled run. To offset, the pipeline stops writing the dated whole-snapshot archive (`web/data/archive/YYYY-MM-DD.json`, 387 KB per day for no current consumer) and archives only `snapshot.json`. Growth is a known cost worth revisiting if it becomes a problem; the alternative — generating series at build time and never committing them — is available but would leave a `push`-triggered deploy serving a site with no charts.

## Ranking moves to the browser

Today the pipeline ships eight pre-materialized Top-100 lists. That cannot support filtering — filter first, then rank, is the whole point.

Instead the snapshot carries **per-symbol cross-sectional z-scores** (computed in the pipeline, since winsorized z-scores depend on the full cross-section and must not shift when a filter changes), and the browser sorts. Sorting 2,320 rows is sub-millisecond.

`effectiveVol = max(realizedVol, 0.175)` and `volAdjusted = momentum / effectiveVol` are derived in the browser; the blend is the mean of three z-scores.

**Rank semantics are unchanged and must stay that way: rank is a name's position in the full eligible universe for the chosen view. Filtering hides rows, it never renumbers them.** You still see `#1`, `#7`, `#23` in a filtered list. A test asserts browser-side ranking reproduces the pipeline's ordering exactly.

This also drops the 8 ranked lists from the payload (−20 KB gz) and removes a duplicate source of truth.

---

## Shared quant code, one copy

The watchlist computes correlations and groups **client-side**, over whatever names are selected. That is the same maths the pipeline already runs.

Rather than reimplement it in the browser and let the two drift, move the canonical implementations to **`web/lib/quant.js`** — plain ESM, JSDoc-typed. This is a **move, not a mirror**: the shared module becomes the only copy, and `src/pipeline/stats.ts` / `cluster.ts` re-export from it.

- `pearson`, `simpleReturns` (from `src/pipeline/stats.ts`)
- `completeLinkageGroups` (from `src/pipeline/cluster.ts`)

It lives under `web/` because only `web/` is deployed. Existing tests in `tests/cluster.test.ts` retarget to it, so one suite covers both consumers.

Two constraints on doing this safely:

- **`checkJs: true`, not just `allowJs`.** These are the numerical core of the product and they currently sit in checked TypeScript. `allowJs` alone would let the pipeline import the module *without type-checking its body*, silently dropping these functions out of the typed surface — a regression nothing would fail on. If `checkJs` proves unworkable, keep the functions in TypeScript and give the browser a generated copy rather than accepting untyped numerics.
- **The display decoder stays out of this module.** Putting `decodeSeries` beside `pearson` is what made the precision flaw feel natural — the decoder sits next to the correlation function, so of course one feeds the other. The display decoder is named `decodeDisplaySeries` and lives with the chart; the watchlist reads the correlation block, which needs no decoder shared with charting. Naming is the cheapest guardrail available here.

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

### "Same trade" marking — precomputed, not client-side

The automatic grouping leaves the default screen, and that is the right trade: structure over a list you did not choose is interesting, structure over a basket you did choose is actionable.

The first draft proposed restoring the lost insight as a client-side marker on rows correlating with your picks, listed last as "droppable". That had it backwards. Every other part of the watchlist needs correlation data **only for selected names**, which is what makes per-symbol fetching viable; a marker over the ranked list needs to know whether *any of 2,320 rows* correlates with a pick — correlation-grade data for the whole universe, the ~900 KB payload this plan exists to avoid. The cheapest-looking item was the one forcing the expensive design.

Instead, **precompute it in the pipeline**, where full-precision prices already exist: each name carries its top few neighbours above ρ 0.60, as `[symbol, ρ]` pairs in `snapshot.json`. A few dozen bytes per row.

This is strictly better than the client-side marker on every axis. It is more accurate (full precision, not quantized), needs no series loaded, works before any fetch resolves, and — because it does not depend on having selected anything — it restores the *original* insight more faithfully than the marker would: "nine of your top 100 are one semicap trade" is a statement about the ranked list, visible on arrival.

---

## Files

| file | change |
|---|---|
| `src/pipeline/snapshot.ts` | per-symbol rows for the whole eligible universe + neighbour lists; drop the 8 ranked lists; stop archiving the whole snapshot daily |
| `src/pipeline/score.ts` | expose per-symbol z-scores; keep `buildViews` for invariant assertions and tests |
| `src/pipeline/series.ts` | add a correlation-grade encoding (2 chars/day) alongside the display one |
| `tests/fixtures/` | **new** — full-precision closes for the ground-truth precision test |
| `src/run.ts` | write `snapshot.json` + one `web/data/series/<SYM>.json` per eligible name |
| `web/lib/quant.js` | **new** — shared pearson / clustering (the only copy; no decoder) |
| `web/views/list.js` | rewritten: ranked list, filters, incremental render, selection |
| `web/views/watchlist.js` | **new** — the risk screen |
| `web/views/ticker.js` | add watchlist toggle |
| `web/app.js` | third route, per-symbol series loader with cache, selection state in `localStorage` |
| `web/styles.css` | filter chips, list rows, watchlist panels |
| `tests/`, `scripts/verify-ui.mjs` | see below |

---

## Verification

**The ground-truth test comes first, because the first draft's verification could not have caught the flaw that draft contained.** "Watchlist grouping over a subset still guarantees every within-group pair clears the threshold" computes ρ from shipped data, forms groups from those ρ values, then checks the groups against the same ρ values. That is internally consistent no matter how wrong the correlations are — it tests the clustering algorithm, which was never in doubt, and is structurally blind to degraded input. It would have gone green on wrong risk numbers.

- **Ground truth (new, and the important one).** A committed fixture of full-precision adjusted closes for a dozen names. For every pair: the correlation computed from *shipped* data matches the pipeline's full-precision correlation within **0.005**, and produces the **same groups** at each threshold. This fails at 1 char/day, passes at 2, and runs offline. It is also what keeps the encoding honest later — anyone shaving bytes off the series to hit a size budget trips it, which is exactly when they should be stopped.
- **Unit** — browser-side ranking reproduces the pipeline's ordering for all eight views; z-scores are stable under filtering; `web/lib/quant.js` passes the existing clustering suite unchanged; precomputed neighbour lists match a full-precision recomputation.
- **Size budget, asserted in tests** — `snapshot.json` under **150 KB gzipped**; a single per-symbol series file under **2 KB**; and the home screen issues **no series request at all** until a chart is opened or a name is starred.
- **UI** (`npm run verify:ui`, Chromium at 390×844) — filtering narrows the list without renumbering ranks; search works; incremental scroll loads more; starring survives a reload; the watchlist groups the selected names correctly; the ticker chart still renders; nothing loads from a third-party host.
- **Performance** — time from load to first interactive row, and scroll smoothness with all 2,320 matching. Report both.

## Order

1. Correlation-grade encoding + **the ground-truth test** — first, so everything downstream is built on verified numbers
2. Pipeline: per-symbol rows, z-scores, neighbour lists, per-symbol series files
3. `web/lib/quant.js` + retarget tests (`checkJs` confirmed)
4. Home: ranked list, filters, incremental render
5. Selection + `localStorage` + per-symbol fetching
6. Watchlist screen
7. Ticker watchlist button + "same trade" marking from the neighbour lists
8. Full verification, then PR

**Not doing:** portfolio optimization, position sizing, or any suggestion about what to buy. The tool ranks, filters, and shows concentration. The decision stays with the user.
