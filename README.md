# Momentum Screen

A personal, phone-first display of a multi-horizon momentum screen over U.S.-listed common stocks,
with correlation grouping so it is obvious when several highly ranked names are effectively the same trade.

It is deliberately a polished, glorified spreadsheet — not a trading terminal and not a portfolio
optimizer. It shows the ranked list and its concentration structure. It never picks positions.

```
FMP stable API  →  pipeline (npm run screen)  →  web/data/snapshot.json  →  static phone page
```

There is no server and no database. The snapshot *is* the storage.

## Running it

```bash
npm install
export API_KEY=...          # Financial Modeling Prep premium key
npm run screen              # ~5 minutes; writes web/data/snapshot.json
npm run serve               # then open http://localhost:5173
```

`npm run screen -- --as-of 2026-08-28` reproduces a past run.

**Financial Modeling Prep is the only data source.** If `API_KEY` is missing or rejected, the
pipeline stops and says so. It never falls back to another provider or to synthetic data.

## What it computes

### Universe

Common stocks on NASDAQ / NYSE / AMEX (which excludes OTC by construction), actively trading,
not an ETF or fund. On top of FMP's own flags — which do **not** filter out preferreds, warrants or
units — three further rules apply:

| Rule | Drops | Must not drop |
|---|---|---|
| `-P<letter>` symbol suffix | `MER-PK`, `FITB-PM`, `OAK-PA` | `BRK-B`, `BF-B`, `MOG-A`, `MKC-V`, `PBR-A` |
| security-type phrases in the name | `STRF`, `FCNCN`, `CCXIW`, `NOVTU`, `XELLL`, `PFH` | `PFBC` ("Preferred Bank"), `PTRN` ("… Series A Common Stock"), `ARM`/`PONY` (plain ADRs), `UNIT` |
| `industry == "Shell Companies"` | SPACs such as `APXT` | — |

The name rule is phrase-anchored rather than keyed on bare words precisely because
`\bpreferred\b` and `\bseries [A-Z]\b` were observed excluding two real common stocks.

Then data-driven tradability gates: market cap ≥ $1B, price ≥ $5, average daily dollar volume ≥ $5M,
and a real bar on ≥ 95% of the sessions spanning every horizon and the correlation window — which
also removes recent IPOs and heavily halted names. One eligibility test serves all eight views.

Two gates are worth explaining:

- **The price floor is applied to the current price, not to adjusted historical prices.** Testing the
  minimum adjusted close over the window would reject exactly the names momentum is looking for:
  a $12 stock that traded at $3 six months ago.
- **Dollar volume is the median of close × volume over the trailing 126 sessions, computed from
  end-of-day bars.** The screener's own `avgVolume × price` was tried first and rejected: both
  fields tick during the session, so a liquidity gate built on them can flip a borderline name in or
  out of the ranking between two otherwise identical runs — which is exactly what the reproducibility
  check caught. Against the screener figure across large caps the bar-derived measure tracks closely
  (median ratio ≈ 0.84, no name off by anywhere near the factor a split-adjustment mismatch would
  produce), and being a median it is robust to one-off volume spikes.

### Momentum

Three horizons, all ending 21 trading days back so the most recent month is excluded:

| Horizon | Window | Daily returns for volatility |
|---|---|---|
| 12–1 | `t−252 → t−21` | 231 |
| 9–1 | `t−189 → t−21` | 168 |
| 6–1 | `t−126 → t−21` | 105 |

Raw momentum is the point-to-point return on split- and dividend-adjusted closes. Anchors are
positions on a master trading calendar derived from the data (dates on which ≥ 60% of names traded),
resolved by as-of lookup so an isolated halt carries the prior close forward instead of dropping a name.

### Volatility adjustment (optional)

Realized volatility is the annualized sample standard deviation of daily returns **inside that
horizon's own window**. An effective volatility floor of **17.5% annualized** is applied
independently per horizon:

```
effectiveVol   = max(realizedVol, 0.175)
volAdjusted    = rawMomentum / effectiveVol
```

So a name gains no extra credit for realized volatility below 17.5%.

### Normalization and the blend

Each horizon's scores are winsorized at the 1st/99th percentile of the eligible cross-section and
then z-scored. The blend is the equal-weight (⅓ each) mean of those three normalized scores.

Winsorizing matters: the momentum cross-section is heavily right-skewed — in a live run the top
12–1 name was +2542% — and an unclipped z-score would let one name dominate the blend.

Normalization is a monotonic transform, so it does **not** reorder any single horizon; the three
single-horizon views rank identically whether sorted on the raw figure or its z-score. It changes
ordering only for the blend. Single-horizon views therefore display the interpretable raw figure,
and the blend displays its composite z-score.

This yields **eight views**: {12–1, 9–1, 6–1, Blend} × {raw, vol-adjusted}.

### Correlation grouping

Within each view's Top 100: Pearson correlation of daily simple returns over the last 126 sessions,
then hierarchical agglomerative clustering with **complete linkage**, cut at ρ ≥ threshold.

Complete linkage is the defensible choice because it guarantees that *every* pair inside a group
clears the threshold — an invariant the pipeline asserts on every run. Average linkage would admit
members only weakly related to the rest of their group; single linkage would chain the whole Top 100
into one blob, since nearly every equity is somewhat market-correlated.

Grouping is strictly downstream of ranking and never reorders or removes a ranked name. Groups are
presented in best-rank order, members in rank order, and a solo name is simply a group of one.
Thresholds 0.60 / 0.65 / 0.70 are all precomputed.

A live run at ρ ≥ 0.65 on the 12–1 view grouped, among others,
`SNDK · MU · WDC · STX` (storage), `ICHR · FORM · ASX · UCTT · TER · AMAT · LRCX · MKSI · ACMR`
(nine of the Top 100 in one semicap trade), `LITE · CIEN · VIAV · COHR` (optical networking),
and `HUT · CIFR` (bitcoin miners).

## Determinism

Two runs over the same data produce byte-identical output, verified by the `meta.dataHash` stamped
on every snapshot — a SHA-256 over the rankings, the groupings, and the parameters, anchors and
universe counts that produced them.

Descriptive per-symbol metadata sits outside the hash on purpose: market cap comes from the screener
and ticks during the session, so folding it in would make two identical rankings hash differently.
If that drift ever flips a name across the eligibility floor, the universe counts and the views
themselves change, so the hash still moves. Verified by running the pipeline twice end to end:

```
run A dataHash: 7ffdd4ac06c81dcdd871260a0f2e8c97ae3b7e4beeebd019b81b8640c4b934e1
run B dataHash: 7ffdd4ac06c81dcdd871260a0f2e8c97ae3b7e4beeebd019b81b8640c4b934e1
```

| Risk | Mitigation |
|---|---|
| async completion order | results land in a `Map`, always iterated through a pre-sorted symbol list |
| transient fetch failures | retried, then **fatal** — see below |
| score ties | secondary sort on symbol |
| float summation order | every sum accumulates over the symbol-sorted array in fixed order |
| percentile convention | one explicit interpolation rule (type 7), unit-tested |
| clustering ties | similarity rounded to 12 dp, then a lexicographic best-rank tie-break |
| JSON key order | explicit key ordering throughout |
| wall clock | `asOf` comes from the data's latest bar, never `Date.now()` |

**Fetch failures are fatal by design.** A dry run lost a contiguous alphabetical block of ~70
symbols to HTTP 429 rate limiting; treating those as "no data" would silently shrink the universe and
change the ranking between runs. The client therefore distinguishes three cases: a genuine `200` with
an empty body is a dataless symbol and an ordinary exclusion; a transient error is retried and then
aborts the run; and an authentication failure is re-thrown immediately rather than collected, so a
key revoked mid-run reports the real cause instead of thousands of downstream "fetch failures".

Pacing is scoped to a rate-limit **episode**, not to each 429 response. With N workers in flight one
episode produces up to N responses, and easing the rate once per response compounds — at concurrency
8 that is a 6× cut from a single episode, and repeated episodes drive the budget to nearly zero with
no way back. So the first report opens an episode window, later reports inside it are ignored, the
easing is clamped to a ceiling, and clean responses decay the rate back toward the configured
~550/minute budget. `FMP_RATE_LIMIT_PER_MIN` overrides that budget and is validated: a malformed
value falls back to the default rather than producing a `NaN` interval, which would make every wait
comparison false and disable rate limiting altogether.

## The per-ticker screen

Tapping any name opens `#/SYMBOL`: a price chart over the charted span with all
three momentum windows marked beneath it, the per-horizon statistics, the names
it moves with, and its rank across all eight views.

The chart is **drawn inline as SVG from data in the snapshot** — no charting
library, no iframe, no third-party request. An embedded TradingView widget was
tried first and removed: those 75 lines pulled in a 14 KB loader that opened an
iframe to a full charting application (78 KB of HTML plus a dozen JS bundles and
a live data socket), which is an order of magnitude larger than this entire
product, on every tap.

Shipping the prices instead costs **+83 KB** for the whole displayed universe.
Each series is normalized to its own range and quantized to one character per
day (`src/pipeline/series.ts`); 64 levels sounds coarse, but because the
normalization is per series the error is always 1/63 of that name's own visible
range — about two pixels on a phone chart, whether the stock moved 5% or 2500%.

Because the windows are drawn from the same anchors the ranking uses, the chart
shows exactly which stretch of price produced each momentum figure, with the
skipped final 21 sessions shaded. The horizon matching the current view is
highlighted. A plain text link out to TradingView remains for when the full
charting tools are wanted; it costs one anchor tag.

## Layout

```
src/config.ts             every tunable constant
src/fmp/                  stable-API client: rate limiting, retry, hard-fail
src/pipeline/universe     screener + exclusion rules
src/pipeline/calendar     master calendar, as-of alignment, coverage
src/pipeline/momentum     per-horizon momentum + volatility + the floor
src/pipeline/normalize    winsorized cross-sectional z-score
src/pipeline/score        eight views, blending, ranking
src/pipeline/correlation  126d returns + Pearson matrix
src/pipeline/cluster      complete-linkage HAC
src/pipeline/snapshot     stable serialization + dataHash
web/                      static phone page (no framework)
```

## Verification

`npm test` covers the exclusion rules against real listings, the momentum and volatility math
against closed-form answers, the 17.5% floor, winsorized z-scores, calendar alignment across a halt,
and clustering invariants including permutation-invariance, plus the price-series
encoder's round-trip accuracy.

`npm run verify:ui` drives the built page in Chromium at a 390×844 phone viewport and asserts that
each of the 24 view/threshold combinations renders all 100 names exactly once in ascending rank,
that tap targets stay ≥ 44px, that nothing scrolls sideways, that the per-ticker chart draws the full
series with all three horizon windows marked and the viewed one highlighted, that its labels stay
legible, that the page loads nothing from a third-party host, and that the back button restores the
chosen view. It needs `npm install --no-save playwright` and a Chromium build (`CHROME_PATH`).

The pipeline additionally asserts its own invariants on every run: ranks are exactly 1..100, each
threshold's grouping partitions the ranked list once, group members are in rank order, and no group
contains a pair below its threshold.
