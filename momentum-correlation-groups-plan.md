# Multi-Horizon Momentum Screen with Correlation Grouping

## Context

`vandyckmed-droid/California` is an **empty repository** — only `.git`, zero commits, no code on the remote. Everything here is greenfield; there is no existing data flow, ranking logic, UI, or storage to preserve.

The goal is a personal, phone-first display of a simple momentum screen: rank a practical universe of U.S.-listed common stocks across **12–1, 9–1, and 6–1** momentum horizons plus an equal-weight **Blend**, with an optional **volatility-adjusted** mode, keep the Top 100 of the selected view, and group those 100 by recent return correlation so it is immediately visible when several highly ranked names are effectively the same trade.

Intentionally a polished, glorified spreadsheet — not a trading terminal, not a portfolio optimizer. It exposes the ranked list and its concentration structure; it never picks positions. Tapping any ranked name opens a **per-ticker detail view** carrying a full-featured free TradingView chart.

I validated the approach end-to-end against live FMP data before writing this plan. Findings below are measured, not assumed.

---

## Terminology (used consistently throughout)

| Term | Definition |
|---|---|
| **Horizon** | One of 12–1, 9–1, 6–1 |
| **Raw momentum** | Point-to-point return over the horizon window |
| **Realized volatility** | Annualized sample sd of daily returns *within that horizon's own window* |
| **Effective volatility** | `max(realized volatility, 17.5%)` — applied per horizon |
| **Vol-adjusted momentum** | `raw momentum ÷ effective volatility` |
| **Horizon score** | Raw momentum (vol-adj off) or vol-adjusted momentum (vol-adj on) |
| **Normalized score** | Cross-sectional winsorized z-score of a horizon score over the eligible universe |
| **Blended score** | Equal-weight mean of the three normalized scores (1/3 each) |
| **View** | A (horizon ∈ {12–1, 9–1, 6–1, Blend}) × (vol-adj ∈ {off, on}) pair — 8 total |
| **Rank** | Position in the selected view's ordering; assigned once, immutable downstream |
| **Group** | Complete-linkage correlation cluster within a view's Top 100 |

---

## Verified environment facts (probed live)

| Fact | Detail |
|---|---|
| FMP key | Present as env var **`API_KEY`** (32-char alphanumeric). Authenticates. |
| API surface | **Only `https://financialmodelingprep.com/stable/…` works.** Legacy `/api/v3/` returns HTTP 403 "Legacy Endpoint … no longer supported". |
| Screener | `GET /stable/company-screener?exchange={NASDAQ\|NYSE\|AMEX}&isEtf=false&isFund=false&isActivelyTrading=true&marketCapMoreThan=…&priceMoreThan=…&limit=10000` — one call per exchange. |
| Prices | `GET /stable/historical-price-eod/dividend-adjusted?symbol=X&from=&to=` → `{symbol,date,adjOpen,adjHigh,adjLow,adjClose,volume}`, **newest-first**. Split+dividend adjusted. |
| Not usable | `/stable/historical-price-eod/full` has **no `adjClose`** → wrong for momentum. `/stable/batch-eod` returns **HTTP 402 Restricted** → bulk is not on this plan; history must be fetched per-symbol. |
| Throughput | 8 concurrent ≈ 17 req/s. Full universe (~2,600 symbols) fetched in **188 s**. |
| Rate-limit headers | None exposed. |
| Toolchain | Node v22.22.2 runs TypeScript natively (type-stripping); npm reachable. **No numpy/scipy** → all math implemented in TS. |

**No fallback data source.** If `API_KEY` is missing or fails to authenticate, the pipeline exits non-zero with a clear message. Yahoo / Alpha Vantage / synthetic data are never substituted.

---

## Dry-run results (live, full universe)

Screener returned **2,595** names at cap ≥ $1B / price ≥ $5; after exclusions and data gates, **~2,205 eligible**. Anchors resolved to `2025-08-27` (t−252) → `2026-07-30` (t−21), latest bar `2026-08-28`.

Complete-linkage grouping at ρ ≥ 0.65 on the 12–1 Top 100 produced **8 multi-name groups (28 names) + 72 solo**, and the groups are economically coherent:

- `SNDK · WDC · STX` — storage (SanDisk was spun out of Western Digital)
- `ICHR · FORM · ASX · UCTT · TER · AMAT · LRCX · MKSI · ACMR` — **9 of the Top 100 are one semicap trade**
- `LITE · CIEN · VIAV · COHR` — optical networking
- `INTC · AIP · AMD`; `HUT · CIFR` (bitcoin miners); `PBF · DK` (refiners); `ROIV · IMVT` (Roivant + its majority-owned Immunovant); `DFTX · APGE`

Pairwise ρ across that Top 100: min −0.32, median 0.21, p90 0.46, max 0.92. Group counts by threshold: **0.60 → 10**, **0.65 → 8**, **0.70 → 8**.

This confirms the data source, the pipeline, the threshold, and the display concept on real data.

---

## Two defects the dry run exposed (designed against)

**1. Transient fetch failures silently corrupt the ranking.** 70 symbols returned no history — a contiguous alphabetical block (`DXPE, EC, ECG, ECHO, ECL, ECO, ECPG, ECVT, ED, EDN, EDU, EE, EEFT, EFC…`). Refetching `ECL, ED, EDU, DXPE, EFC` individually returned **395 bars each**. These were network failures, not absent data; dropping them silently changes the Top 100 run-to-run.

→ The client distinguishes **HTTP/network error** (retry with backoff + jitter; if still failing, **abort the run non-zero**) from a **200 with an empty array** (legitimately dataless symbol → recorded as a normal exclusion). Default `maxFetchFailures = 0`.

**2. A naive name filter had false positives.** Two real common stocks were wrongly excluded: `PFBC` — "**Preferred** Bank" (a real bank holding company) — and `PTRN` — "Pattern Group Inc. **Series A** Common Stock". The regex must key on security-type *phrases*, not bare words.

---

## Universe and eligibility (one definition, shared by all 8 views)

1. **Exchange whitelist** NASDAQ / NYSE / AMEX (excludes OTC by construction) + `isActivelyTrading=true`, `isEtf=false`, `isFund=false`.
2. **Preferred by symbol**: drop `-P[A-Z]?$`. Verified drops: `MER-PK, EP-PC, FITB-PM, FITB-PA, CTA-PA, CTA-PB, CMS-PB, SEAL-PB, TRTN-PC, OAK-PA, OAK-PB`.
   Must **keep** ordinary share classes: `BRK-A, BRK-B, BF-B, MOG-A, MKC-V, PBR-A`. A blanket "hyphen ⇒ exclude" rule is wrong.
3. **Name regex** (word-boundary anchored, security-type phrases only): drop `warrants`, `rights`, `equity units` / trailing `units`, `preferred stock` / `pfd` / `perp` / `non-cum` / `cum … pfd`, `notes due` / `senior|subordinated notes` / `debenture`, `depositary sh… repr … pfd`, `when-issued`.
   Verified drops: `STRF, SATA, FCNCN, LILAP, CCXIW, NOVTU, OXLCG, CGABL, MLCIL, PFH, DTW, CMSD, UZD, UZE, UZF, ABXL, SFB, SCCD`.
   Verified keeps: **`PFBC`, `PTRN`**, plus plain ADRs `ARM`, `PONY`, and `UNIT` (Uniti Group).
4. **`industry === "Shell Companies"`** → drop SPACs.
5. **Data-driven gates**, computed from fetched bars rather than trusted screener fields:
   - market cap ≥ **$1B**, price ≥ **$5**
   - median daily dollar volume over the trailing 126 d ≥ **$5M**
   - first bar on-or-before `cal[L−252]`, and **≥ 95 % actual (non-filled) bars across `cal[L−252] … cal[L]`** — the union of every horizon window and the correlation window. This single coverage rule removes recent IPOs and heavily halted names, and guarantees every eligible symbol has enough data for all three horizons, all volatilities, and the correlation matrix.

Every rule increments a named counter surfaced in the snapshot as an audit trail.

---

## Scoring

**Master trading calendar** — the sorted set of dates appearing in ≥ 60 % of fetched histories (robust to individual halts, deterministic given the data). Anchors are calendar **positions**, never calendar arithmetic. With `L = lastIndex`:

| Horizon | Start | End | Vol window (daily returns) |
|---|---|---|---|
| 12–1 | `cal[L−252]` | `cal[L−21]` | 231 returns |
| 9–1 | `cal[L−189]` | `cal[L−21]` | 168 returns |
| 6–1 | `cal[L−126]` | `cal[L−21]` | 105 returns |

All three deliberately end at t−21, excluding the most recent month.

Each symbol's series is aligned to the master calendar by **as-of lookup** (binary search for the last bar on-or-before each date), so an isolated halt does not drop a name.

**Raw momentum** `= adjClose(end) / adjClose(start) − 1`.

**Realized volatility** `= sampleStdDev(daily simple returns within that horizon's window) × √252`, sample (n−1) denominator.

**Effective volatility** `= max(realized, 0.175)` — applied **independently per horizon**. A stock therefore gains no additional benefit from realized volatility below 17.5 %.

**Horizon score** = raw momentum when vol-adj is off; `raw momentum ÷ effective volatility` when on.

**Cross-sectional normalization** — each horizon's scores are winsorized at the 1st/99th percentile of the eligible cross-section, then z-scored (mean 0, sd 1) across that same cross-section. Winsorizing matters: the 12–1 distribution is heavily right-skewed (top name +2542 % against a far lower median), and an un-winsorized z-score would let a single outlier dominate the blend. This step is what places the three horizons on a comparable scale so the longer horizon is not mechanically rewarded for spanning more time.

**Blended score** `= (z₁₂₋₁ + z₉₋₁ + z₆₋₁) / 3`, equal 1/3 weights.

**Ranking** — sort the selected view's score descending, ties broken by symbol ascending. Rank is assigned once and is immutable downstream. Top 100 retained per view.

> Worth noting for clarity: normalization is a monotonic transform, so for the three **single-horizon** views the ranking is identical whether one sorts by the raw horizon score or its z-score. Normalization changes ordering **only for the Blend**. Single-horizon views therefore display the interpretable raw figure (a return, or a return-per-unit-vol) while the Blend displays its composite z-score.

---

## Correlation grouping (downstream of ranking, never alters it)

Within the selected view's Top 100: Pearson correlation of **daily simple returns** of `adjClose` over the last **126** master-calendar dates.

**Hierarchical agglomerative clustering, COMPLETE linkage, cut at ρ ≥ threshold.** Complete linkage is the defensible choice: it guarantees **every pair inside a group is ≥ threshold correlated**, which is the honest reading of "may effectively represent the same underlying trade" and is a checkable invariant. Average linkage would admit weakly-related members; single linkage would chain 100 market-correlated names into one blob.

Deterministic tie-breaking: similarity rounded to 12 dp; among tied candidate merges, pick the pair whose key `sorted([minRank(A), minRank(B)])` is lexicographically smallest. Ranks are unique integers ⇒ total order ⇒ permutation-invariant.

**Group ordering** — by each group's best (lowest) member rank. Within a group, strict momentum-rank order. Solo names are size-1 groups rendered with the same card, so the page reads top-to-bottom in ascending rank.

Thresholds **0.60 / 0.65 / 0.70** are precomputed for every view, so the on-screen toggle is instant and still fully deterministic. Grouping provides context only — it never reorders or removes a ranked name.

---

## Architecture

Offline pipeline → one static JSON snapshot → static phone page. No server, no database; the snapshot *is* the storage. Deterministic, instant on a phone, trivially auditable.

```
package.json  tsconfig.json  .gitignore  README.md
src/
  config.ts               all constants: windows, horizons, 17.5% vol floor,
                          winsorize pcts, thresholds, gates
  fmp/client.ts           stable-API client: auth check, bounded pool (concurrency 8),
                          retry w/ backoff + jitter, HARD FAIL on exhaustion,
                          empty-200 vs network-error distinction
  fmp/types.ts
  pipeline/universe.ts    screener fetch + exclusion rules, tallied
  pipeline/calendar.ts    master calendar, anchor resolution, as-of alignment
  pipeline/momentum.ts    per-horizon raw momentum + realized/effective volatility
  pipeline/normalize.ts   winsorize + cross-sectional z-score
  pipeline/score.ts       8 views, blending, ranking, Top-100 selection
  pipeline/correlation.ts 126d daily returns + Pearson matrix
  pipeline/cluster.ts     complete-linkage HAC, deterministic tie-break
  pipeline/snapshot.ts    assemble + stable-key serialization + dataHash
  run.ts                  CLI: npm run screen  [--as-of YYYY-MM-DD]
web/
  index.html  styles.css
  app.js                  hash router + shared snapshot load
  views/list.js           primary group-list screen + the three controls
  views/ticker.js         per-ticker detail: TradingView embed, stats, group peers
  data/snapshot.json                    (generated)
  data/archive/YYYY-MM-DD.json          (dated archive)
tests/  exclusions · calendar · momentum · volatility · normalize · cluster · determinism
.github/workflows/screen.yml            weekday post-close refresh → commit → deploy Pages
```

**Snapshot schema** — symbol metadata is stored **once** in a shared dictionary; each view stores only an ordered list, keeping the payload small (target < 250 KB) despite 8 views:

```jsonc
{
  "meta": {
    "generatedAt": "…",          // excluded from dataHash
    "asOf": "2026-08-28",
    "anchors": { "h12_1": {"start":"2025-08-27","end":"2026-07-30"},
                 "h9_1":  {"start":"…","end":"2026-07-30"},
                 "h6_1":  {"start":"…","end":"2026-07-30"} },
    "params": { "horizons": {"h12_1":[252,21], "h9_1":[189,21], "h6_1":[126,21]},
                "volFloorAnnualized": 0.175, "winsorPct": [0.01, 0.99],
                "blendWeights": [0.3333,0.3333,0.3333],
                "corrWindow": 126, "thresholds": [0.60,0.65,0.70],
                "minMarketCap": 1e9, "minPrice": 5, "minMedianDollarVolume": 5e6 },
    "universe": { "screened": 2595, "eligible": 2205 },
    "exclusions": { "preferredSymbol":…, "namePattern":…, "shellCompany":…,
                    "sparseHistory":…, "illiquid":…, "priceUnderFloor":… },
    "dataHash": "sha256(deterministic payload)"
  },
  // "exchange" is the TradingView prefix, taken straight from exchangeShortName
  "symbols": { "SNDK": { "name":"…", "sector":"…", "exchange":"NASDAQ",
                         "price":…, "marketCap":… } },
  "views": {
    "h12_1|raw": {
      "ranked": [ { "rank":1, "symbol":"SNDK", "score":…, "momentum":25.42,
                    "realizedVol":…, "effectiveVol":… } ],
      "groups": { "0.65": [ { "members":["SNDK","WDC","STX"], "minCorr":0.71, "bestRank":1 } ] }
    },
    "h12_1|voladj": { … }, "h9_1|raw": { … }, …, "blend|voladj": { … }
  }
}
```

### Primary screen — the group list

Single scrolling column of uniform cards, one per group, ordered by best member rank; solo names are size-1 cards of the same shape. Each row: rank · symbol · name · the selected view's figure. A compact sticky header carries the as-of date, universe counts, and three controls, all switching instantly against precomputed data:

- a 4-way segmented control: **12–1 / 9–1 / 6–1 / Blend**
- a **vol-adjusted** switch (with the 17.5 % floor noted in small caption text)
- the **ρ 0.60 / 0.65 / 0.70** toggle, rendered smaller and secondary

System font stack, no framework, `prefers-color-scheme` aware, tap targets ≥ 44 px.

### Per-ticker detail screen

Tapping any row opens `#/SYMBOL` (hash routing, so the phone back button and shareable links both work). The detail screen shows:

1. **A full TradingView chart.** Embedded via TradingView's free **Advanced Real-Time Chart** widget (`s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js`, verified reachable, HTTP 200). Features are left **on**, not stripped: drawing tools and side toolbar, indicator/studies access, the full timeframe row and date ranges, symbol detail, legend, and volume. Only genuinely inapplicable chrome is disabled — the widget's own "save/load chart" hooks, which need a TradingView account this project does not have. Rendered full-bleed and tall on a phone, sized against `100dvh` minus the header.
   - Symbol is prefixed for TradingView from the `exchangeShortName` already captured by the screener: `NASDAQ:` / `NYSE:` / `AMEX:` map one-to-one, so no extra lookup or hand-maintained table is needed.
   - **Interpretation note:** "TradingView Lite" is read as the free embeddable widget, not the *Lightweight Charts* library — Lightweight Charts is a bare canvas you feed yourself and would deliver the opposite of "the full TradingView chart experience." If the other reading was intended it is a contained swap of this one component.
   - **Data provenance:** the widget renders TradingView's own market data and is **display-only**. It feeds no calculation. Every number in the screen — momentum, volatility, normalization, ranking, correlation — remains FMP-derived. No alternative data source enters the analytics path.
2. **That ticker's numbers across all six horizon/mode combinations** — raw momentum, realized volatility, effective volatility (with the floor visibly binding where it does), and its rank in each of the 8 views. This is where per-name statistics live, keeping the primary screen uncluttered.
3. **Its correlation group** at the active threshold — the co-moving names with their ranks and pairwise ρ to this ticker — each tappable through to its own detail screen.

The widget requires network access and will not render offline; the detail screen degrades to the numbers plus a plain notice rather than a broken frame.

---

## Determinism

| Risk | Mitigation |
|---|---|
| Async completion order | Results collected into a `Map`; **always** iterated via a pre-sorted symbol array, never completion order |
| Transient fetch drops | Retry then **abort** (defect 1) — never silently shrink the universe |
| Score ties | Secondary sort on symbol ascending |
| Float summation order | Correlation, mean/sd, and winsorize percentiles all accumulated over the symbol-sorted array in fixed order |
| Percentile definition | Single explicit interpolation convention, unit-tested |
| Clustering ties | Round to 12 dp; lexicographic `minRank` tie-break |
| Object key iteration / JSON key order | Explicit key ordering in a stable serializer |
| Wall-clock leakage | `asOf` derived from the data's latest bar, not `Date.now()`; `--as-of` reproduces past runs; `generatedAt` excluded from `dataHash` |

---

## Verification

1. **Unit tests (vitest)** — exclusions table-driven on the real symbols above (`PFBC`/`PTRN`/`BRK-B`/`ARM`/`UNIT` kept; `STRF`/`FCNCN`/`CCXIW`/`NOVTU`/`OAK-PA` dropped); momentum and annualized volatility on synthetic series with known closed-form answers; the **17.5 % floor** asserted to bind (a 10 %-vol name and a 17 %-vol name receive identical divisors); winsorized z-score against a hand-computed vector; as-of lookup across a halt; clustering invariant plus a **permutation test** (shuffle input order → byte-identical output).
2. **Pipeline invariants** — for every view and threshold: all within-group pairwise ρ ≥ threshold; group members ascending by rank; ranks a permutation of 1..100. Each single-horizon view's ranking asserted identical to sorting by its raw score (normalization monotonicity). Blend weights sum to 1.
3. **Reproducibility** — run `npm run screen` twice at the same `--as-of`; assert identical `dataHash`.
4. **Spot-check against FMP** — recompute 12–1, 9–1, 6–1 and each realized volatility by hand for 3 names from raw `dividend-adjusted` responses; match the snapshot.
5. **Phone render** — load the built page in Chromium at 390×844 via Playwright (pre-installed) and screenshot each of the 8 views to confirm layout, control behavior, and tap targets.
6. **Per-ticker screen** — navigate to `#/SNDK`, assert the TradingView iframe mounts and reports a non-zero height, that the symbol resolves as `NASDAQ:SNDK`, that the stats table matches the snapshot for that name, and that the back button returns to the list with the prior view/threshold intact. Also assert graceful degradation with the widget host blocked.

---

## Implementation order

1. Scaffold (`package.json`, `tsconfig`, `.gitignore`, `config.ts`)
2. FMP client with retry / hard-fail
3. Universe + exclusions **+ tests**
4. Calendar, as-of alignment, coverage gate **+ tests**
5. Per-horizon momentum + volatility with the 17.5 % floor **+ tests**
6. Winsorized cross-sectional z-score, blending, 8-view ranking **+ tests**
7. Correlation + complete-linkage clustering **+ determinism test**
8. Snapshot writer + `dataHash`
9. Run the full pipeline live; verify counts and 12–1 groups against the dry-run figures above
10. Web UI: primary group list, then the per-ticker detail screen with the TradingView embed + Playwright render checks
11. GitHub Action + Pages

## Cloudflare

The linked `agent-setup/prompt.md` turns out to be **agent tooling setup**, not project architecture — it installs the Cloudflare skills plugin and registers five Cloudflare MCP servers (API, Docs, Bindings, Builds, Observability). This session **already exposes those Cloudflare MCP tools** (D1, KV, R2, Workers, docs search), so that setup is effectively already satisfied; installing the plugin would add nothing and would trigger an OAuth login this project does not need.

Per the explicit instruction, **the build does not use Cloudflare**. Recording the one genuinely obvious free-tier fit for later: the deliverable is a static page plus a static JSON snapshot, which is exactly a **Cloudflare Pages** workload — swapping GitHub Pages for Pages (or serving from both) is a single deploy-step change in `.github/workflows/screen.yml` and needs no application code change. Worth doing only if global CDN latency or the Pages build minutes ever matter; GitHub Pages was the chosen delivery and covers this today. Nothing else in the design (no server, no database, no edge compute) would benefit from Workers, D1, KV, or R2.

## Review workflow

Work proceeds on `claude/momentum-correlation-groups-1rzok2`. A **draft PR** is opened early for CI and visibility, and work continues on the same branch — implementation, tests, self-review, and fixes — without stopping merely because the PR exists.

Before handing off I will leave the branch reviewable: implementation complete against this plan, tests and build passing, acceptance criteria checked, repository clean, PR description updated with a concise account of what changed, and any real limitations stated plainly. At that point I mark the PR **Ready for review**, provide the link and a summary of what to scrutinize, and **pause before merging to main** so an external reviewer can inspect it. Requested changes are addressed on the same branch and returned to a review-ready state.
