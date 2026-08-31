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
npm run labs:etf-river      # ~10 seconds; the ETF River experiment's own sidecar
npm run serve               # then open http://localhost:5173
```

`npm run screen -- --as-of 2026-08-28` reproduces a past run. `npm run serve` and
`npm run verify:ui` stamp the build first (see **Staying current** below); `npm run stamp` does it
on its own.

**Financial Modeling Prep is the only data source.** If `API_KEY` is missing or rejected, the
pipeline stops and says so. It never falls back to another provider or to synthetic data.

## The cleanup layer

The screener answers "is this a listed U.S. common stock". It cannot see that a
name stopped moving the day its acquisition was agreed, that a 177% one-day print
is a broken adjustment rather than a return, that two tickers are one company, or
that a name listed fourteen months ago has no track record. Each of those ranks
perfectly well and ranks on something that is not momentum.

`src/pipeline/cleanup.ts` sits between the screener and the ranking. Every rule is
a deterministic threshold on observable data; none consults a news feed or a
corporate-actions endpoint, because a rule the run cannot evaluate identically
twice is worse than no rule — and a pending merger is more reliably *observed*
(a price pinned to the deal terms) than it is retrieved.

| Rule | Threshold | Removed | Examples |
|---|---|---:|---|
| History | ≥ 756 sessions (3 years) | 384 | ABVX, AEBI |
| Market cap | ≥ $500M | 325 | ABEO, ACU |
| Liquidity | 252-day median dollar volume ≥ $5M | 282 | ACNB ($1.96M/day), ACEL ($3.49M) |
| Complete series | a real bar on every master-calendar session | 31 | BMNR (121 absent), COSO (40) |
| Flat volatility | 21-day annualized realized vol ≥ 5% | 17 | CRNX (1.9%), AES (2.8%), ACA (2.8%) |
| Extreme one-day move | none ≥ 50% in the last 63 sessions | 8 | MRNA (177%), QURE (78%) |
| Share classes | one listing per company | 6 | BRK-A, GOOG, FOX, NWS, ZG, PBR-A |
| Post-event flatline | ≥ 20% shock in 126d, then 21d vol < 10% | 2 | UTZ (88.7% then 5.8%), ATAI |
| Security type | ETF/ETN/SPAC/royalty-trust wrappers the vendor's flags miss | 19 | |
| Concentration caps | industry ≤ 7.5%, sector ≤ 20% | 0 | (see below) |

**2,572 → 2,280 names.** The counts are printed by the run itself rather than by a
script beside it, so the numbers quoted here are the ones the product used.

The two behavioural rules are the ones worth checking by eye, and they hold up.
Every name the volatility floor removed is genuinely pinned — CRNX prints
84.69, 84.78, 84.86, 84.84, 84.85, 84.84 on consecutive sessions, ACA sits at
145.2x, AES at 14.7x — which is what an agreed all-cash deal looks like from the
outside. **The rule finds acquisition targets from price behaviour alone, with no
corporate-actions feed.**

The extreme-move rule is less clean and the report says so. MRNA's 177% one-day
print is a broken adjustment and removing it is unambiguously right. AMLX's 63.8%
is a *real* biotech move on real news. Both are removed, and the justification
has to cover both: momentum measured across a single 60% print is measuring that
print, not a trend, and the vol-adjusted views then divide by a volatility the
jump itself inflated. It is a defensible rule for two different reasons, not one
rule doing one job — 8 names either way.

### What the measurement changed

Three parts of the starting specification did not survive contact with the data.

- **ADRs are not excluded.** The rule is well-posed but nothing available
  identifies one. Matching the name catches 9 listings out of 3,655 — it would
  remove ARM, whose name carries "American Depositary Shares", and keep TSM,
  BABA, MUFG and AZN, whose names do not. `country != US` catches 625 but
  conflates a receipt with a foreign-domiciled company whose primary listing *is*
  American, deleting Linde plc and Royal Bank of Canada. An inconsistently
  applied rule is worse than an absent one: it removes real names while reading
  in the exclusion counts as though the job were done. `CLEAN_EXCLUDE_ADR` keeps
  the decision one edit away.
- **SPACs are not matched by name.** Many are "<Something> Capital Corp", which is
  also what a great many ordinary lenders are called, and no phrase separates
  them. They are caught instead by FMP's own `Shell Companies` industry and by
  the volatility floor — a pre-deal SPAC sits pinned near its trust value, which
  is exactly what that floor looks for.
- **The missing-session allowance stayed at zero.** Not for strictness: 3,312 of
  3,343 names miss no session at all, and the ones that miss any tend to miss
  121, 78, 40. There is no population of otherwise-fine names losing a single
  halt day for an allowance to rescue — it would have spared 13.

### The concentration caps do not bind

The largest industry in the cleaned universe is Banks - Regional at 6.2%
(Biotechnology is next at 6.1%), the largest sector is Financial Services at
16.1%, and neither cap fires. That is the
result, not a defect — but it is worth being precise about why, because the caps
were asked for to solve a real problem.

FMP's industry taxonomy is fine-grained ("Banks - Regional", "Software -
Application", "Semiconductors"), so no single label reaches 7.5% of 2,280 names.
Even a 5% cap would remove only ~54. The redundancy a momentum ranking actually
suffers from — fifteen semiconductor names expressing one bet — is **not visible
at the label level**. It lives in the correlation structure, which is what the
existing grouping addresses. The caps are kept as armed guardrails against drift;
they are not what will fix repeated trades in the Top 100.

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

### Displayed volatility (126d)

Separate quantity, separate purpose. The `Show ▾` selector's **Volatility (126d)** is the
annualized sample standard deviation of daily returns over the **most recent 126 sessions,
including the month every horizon skips** — `t−126 → t`, 126 returns from 127 closes, annualized
with √252.

It is not any horizon's `realizedVol`, and that is the point. A horizon stops 21 sessions short so
a momentum signal is not contaminated by the short-term reversal window it excludes; "how volatile
is this name" is the opposite question, and an answer that ends a month ago is stale exactly when
it matters. Switching between 12–1, 9–1, 6–1 and Blend changes the ranking, not this number.

Two consequences worth stating:

- **Reported unfloored.** The 17.5% floor exists because the vol-adjusted views divide by it.
  Nothing divides by this figure, so flooring it would overstate every quiet name and a "floor"
  mark would point at a mechanism the number is not part of. The floored per-horizon figures are
  on the ticker screen, beside the ranking that uses them.
- **The window is the correlation window.** `TRAILING_VOL_WINDOW = CORR_WINDOW`, so the figure on
  the list is the same quantity the watchlist reports per name — two constants that both happened
  to read 126 could drift apart and the screens would quietly disagree about one name.

Shipped as `columns.rvT`, with `meta.params.trailingVolWindow` naming the window so the label
cannot drift from the data.

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
src/pipeline/cleanup      the stricter layer between screening and ranking
src/pipeline/calendar     master calendar, as-of alignment, coverage
src/pipeline/momentum     per-horizon momentum + volatility + the floor, and the
                          trailing 126d volatility the list displays
src/pipeline/normalize    winsorized cross-sectional z-score
src/pipeline/score        eight views, blending, ranking
src/pipeline/correlation  126d returns + Pearson matrix
src/pipeline/cluster      complete-linkage HAC
src/pipeline/snapshot     stable serialization + dataHash
web/                      static phone page (no framework)
web/lib/refresh.js        the build check that keeps a home-screen page current
scripts/stamp-version.mjs writes the build stamp the check compares against
src/labs/                 Labs experiments; nothing above imports anything here
```

## Staying current

The page is meant to be saved to a phone's home screen, and that is the case where a static site
goes wrong. iOS *relaunches* a home-screen window rather than reloading it — it restores whatever
was last on screen, with no address bar and no pull-to-refresh to force the issue — so one session
can serve the same code for weeks. GitHub Pages compounds it: every file goes out with a fixed
`Cache-Control: max-age=600` that cannot be configured, so even a genuine reload may reuse what it
already has.

The data was never the problem — the snapshot and both sidecars are fetched `no-cache` and
revalidate on every boot, which is why a merge to `main` shows up in the numbers but not in the
code. So the code checks itself:

- `scripts/stamp-version.mjs` runs last in the deploy, hashing the bytes *and* the names of every
  file under `web/` except `data/`. It writes two things: `web/lib/build.js`, which rides inside the
  module graph and therefore carries a stale version whenever the app itself is stale, and
  `web/version.json`, the version the server is holding right now.
- `web/lib/refresh.js` compares them at boot and again whenever the window returns to the
  foreground — `visibilitychange` is the event a relaunch actually fires. On a mismatch it refetches
  every asset with `cache: 'reload'` and only then reloads.

Refetching first is what makes the update atomic. Each module has its own independent ten-minute
window, so a bare reload can pair a new `app.js` with a view the cache still considers fresh, and a
mixed build is harder to diagnose than a uniformly old one. `data/` is excluded from the hash on
purpose: folding it in would move the version every weekday and reload the app for data it was
going to fetch anyway.

Both generated files are gitignored. A committed stamp is wrong the moment anyone edits a file next
to it, and a wrong stamp is worse than none — so an unstamped tree (a plain clone opened with
`npx serve`) simply does not self-update, which is why `refresh.js` imports `build.js` dynamically
and swallows the failure. `web/lib/build.d.ts` *is* committed, so that state typechecks: CI never
stamps before `npm run typecheck`, which is what makes the unstamped tree the one it verifies. The check gives any one server version a single attempt, recorded in
`sessionStorage`, so a deploy caught mid-flight leaves the app usable and old rather than reloading
forever.

## Labs

Experiments live behind a small `Labs ›` link on the list's title row. **Experiments may depend on
stable Cali; stable Cali may never depend on experiments** — `tests/labs-boundary.test.ts` asserts
that rather than trusting it, and asserts the same between the experiments themselves, so removing
one is a delete rather than an untangling.

| | |
|---|---|
| **Rank River** | Where the current top 20 have been over the last 30 sessions, backfilled from the prices a run already holds. Emitted at the tail of `npm run screen`, inside a `try` that cannot cost a day's snapshot. |
| **ETF River** | A year of relative momentum leadership across 22 industry ETFs. Its own program: `npm run labs:etf-river`. |
| **ETF Basis** | A research study, not a screen: can 2,280 stocks be compressed into a small set of ETF bets? Answer: no — see [docs/etf-basis-research.md](docs/etf-basis-research.md). `npm run labs:etf-basis`. |

### ETF River

A rolling cross-sectional relative-strength picture over ~20 deliberately distinct industry and
theme ETFs, drawn as one trail per fund over the last 252 sessions. Height is the blended
cross-sectional z-score, so a fund rises only by beating the others — a bull market lifts nothing.

For each session, two volatility-adjusted momentum legs:

```
R12  = P[t−21] / P[t−252] − 1      AnnVol12 = stdev(daily returns over t−252 → t−21) × √252
R6   = P[t−21] / P[t−126] − 1      AnnVol6  = stdev(daily returns over t−126 → t−21) × √252
VA   = R / AnnVol                  (no floor)
Z    = cross-sectional z-score of VA across the funds, per leg, per date
Blend = 0.50 × Z12 + 0.50 × Z6
```

Two deliberate departures from the stock ranking above:

- **No volatility floor.** The 17.5% floor exists to stop a *pinned* single name — an acquisition
  target trading at a deal price — being rewarded for standing still. A sector fund cannot be
  pinned that way, and 10.4% of leg-volatilities here fall below 17.5%, so applying it would
  quietly compress the whole quiet half of the universe (`MOO`, `RWR`, `KIE`, `XHS`).
- **No annualization of the horizon return.** Each leg is standardized within its own date, so its
  fixed scale is already removed; annualizing first only adds a nonlinear transform that changes
  no ordering.

The universe is re-screened for redundancy on every run: a pair is flagged only when its daily
returns move together (ρ ≥ 0.75 over the full fetched history) **and** its drawn paths coincide
(path ρ ≥ 0.85, RMS gap ≤ 0.5z). `XPH` was removed on that test against `XBI`; nothing else in the
current set clears both bars.

The run refuses to write a wrong file. Every session's legs are recomputed for a deterministic
sample by a second, deliberately naive implementation that indexes by date off the raw bars rather
than by calendar position, every date's legs are checked to be mean 0 / sd 1, and the window
anchors are printed as dates.

```
src/labs/etfRiver/        the experiment's own program, config, universe and signal
web/data/labs/etf-river.json   its sidecar (~43 KB)
web/views/labs/etfRiver.js     its screen
```

## Verification

`npm test` covers the exclusion rules against real listings, the momentum and volatility math
against closed-form answers, the 17.5% floor, winsorized z-scores, calendar alignment across a halt,
and clustering invariants including permutation-invariance, plus the price-series
encoder's round-trip accuracy. It pins the build stamp's contract — that it skips `data/`, never
hashes its own output, and moves for a rename that leaves every byte intact. For ETF River it pins the two departures from that math as
properties — that the floor is absent and the horizon return unannualized, with values that would
visibly move if either came back — along with the window anchors, the per-date standardization,
what happens to a bad bar mid-window, and the redundancy screen's two bars.

`npm run verify:ui` drives the built page in Chromium at a 390×844 phone viewport and asserts that
each of the 24 view/threshold combinations renders all 100 names exactly once in ascending rank,
that tap targets stay ≥ 44px, that nothing scrolls sideways, that the per-ticker chart draws the full
series with all three horizon windows marked and the viewed one highlighted, that its labels stay
legible, that the page loads nothing from a third-party host, and that the back button restores the
chosen view. It also walks both Labs experiments — that the ranked list downloads neither, that
opening one downloads none of the other, that a missing sidecar degrades to a sentence while every
other screen keeps working, and for ETF River that a higher score is drawn higher, that the
right-edge labels never stack, and that selecting a fund or a family emphasises exactly the trails
it should. It drives the update check against a real browser rather than reading the source for it:
that a matching version leaves the page alone, that a moved one refetches every asset in the build
before reloading and lands on a working screen, that a version gets one attempt and not a loop, and
that a check which failed at boot is retried when the window next comes to the foreground. It needs `npm install --no-save playwright` and a Chromium build (`CHROME_PATH`).

The pipeline additionally asserts its own invariants on every run: ranks are exactly 1..100, each
threshold's grouping partitions the ranked list once, group members are in rank order, and no group
contains a pair below its threshold.
