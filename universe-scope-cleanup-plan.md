# Universe scope cleanup

> **Status: proposed, not built.** This PR is the plan and one documentation
> fix. No pipeline behaviour changes here. Every number below was measured
> offline against the shipped `web/data/snapshot.json` and `web/data/series/`,
> so the claims can be checked before any of them is turned into a constant.

## The complaint

Three things, in the user's words:

1. The universe is too broad — 2,572 names, more than there is any appetite to
   look at. Willing to go well under 2,000 if quality improves.
2. **Biotech and banks are over-represented.**
3. Noise from **the acquisition-announcement game**: a name gets a bid, jumps,
   and then sits idle at the deal price while still carrying a huge trailing
   return.

All three are real. But they are three *different* problems with three
different mechanisms, and the obvious single fix — raise the market cap floor —
solves almost none of it. That is the main result here.

## How this was measured

No FMP key is available in this session, so nothing could be re-run end to end.
Instead every scenario was evaluated by re-ranking the **shipped snapshot**:
2,572 names with per-horizon momentum and realized volatility already computed,
plus the per-symbol price series.

Two limits worth stating up front, because they bound how much these numbers
should be trusted:

- The 252-session **display** series is quantized to 64 levels, so the largest
  single-day move read off it is slightly overstated. Anything derived from it
  below (the one-day-share figures) would be marginally *less* aggressive on
  full-precision closes.
- FMP's `industry` field is fetched by the screener but **not carried into the
  snapshot**, so "biotech" and "bank" below are name-regex proxies
  (`therapeutic|biopharm|oncolog|…`, `bancorp|bancshares|bank|…`) scoped to the
  Healthcare and Financial Services sectors. They are good enough to size the
  problem and *not* good enough to ship as a filter. See "Step 1".

Where a number is a proxy it is called a proxy.

---

## Finding 1 — the size floor is not the lever

Raising `MIN_MARKET_CAP` cuts the universe and leaves the actual complaint
untouched. Healthcare and biotech-named counts in the **12–1 raw Top 100**:

| market cap floor | universe | Healthcare in Top 100 | biotech-named |
|---|---|---|---|
| $200M (today) | 2,572 | 48 | 28 |
| $1B | 2,301 | 49 | 28 |
| $2B | 1,945 | 44 | 29 |
| $3B | 1,675 | 36 | 26 |

Cutting 900 names — 35% of the universe — moves biotech in the Top 100 from 28
to 26. The reason is mechanical: a clinical-stage name that has run 300% in a
year is no longer small by the time it ranks. The size floor removes names that
were never going to appear anyway.

This is worth stating plainly because "cut the universe to under 2,000" and
"stop seeing so much biotech" sound like the same request and are not. The size
cut is fine to do — it just has to be justified on its own terms (less to scroll,
smaller payload), not as the fix for over-representation.

## Finding 2 — biotech over-representation is real, not an artifact

Biotech has the fattest right tail of 12-month returns in the U.S. cross-section.
A screen that ranks on trailing return **will** be biotech-heavy, and that is the
screen working, not failing. So the only honest ways to reduce it are to decide
you do not want to trade those names, or to rank within sector.

Measured: 125 of the 2,572 names are biotech-proxy Healthcare names under $10B.
Removing that 4.9% slice:

| | Healthcare in 12–1 raw Top 100 | biotech-named |
|---|---|---|
| today | 48 | 28 |
| without sub-$10B biotech | 26 | **3** |

Half the Top 100 is currently Healthcare; this is the single change that moves
it. Large-cap pharma and medical devices (LLY, TMO, ABT, ISRG …) are untouched —
what goes is the pre-revenue, readout-driven cohort, which is precisely the
cohort whose 300% year is a coin flip that landed.

## Finding 3 — the banks arrive through the volatility floor, and the floor never binds

Banks appear in the **vol-adjusted views only**: zero in every raw view, up to 16
of the Top 100 on 6–1 vol-adjusted. That is not a coincidence, and it is not
really a universe problem — it is a scoring one.

`VOL_FLOOR_ANNUALIZED = 0.175` exists so a quiet name gains no extra credit for
being quiet. Measured against the actual cross-section, it never gets the chance:

| | p05 | p10 | p25 | p50 |
|---|---|---|---|---|
| universe 12–1 realized vol | 21% | 24% | 29% | 40% |
| bank-proxy names | — | 22% | 26% (p50) | — |

The floor sits **below the 5th percentile of the universe**. It binds for
essentially nobody, so `volAdjusted` is very nearly an unfloored `momentum/vol`,
and the lowest-volatility cohort in the market — regional banks at ~22–26% —
gets full division credit for being sleepy. Exactly what the floor was written to
prevent.

Raising it, with everything else held constant, on the 12–1 vol-adjusted Top 100:

| floor | bank-proxy names | Financial Services |
|---|---|---|
| 17.5% (today) | 6 | 10 |
| 22% | 3 | 7 |
| 25% | 1 | 5 |
| 30% | 0 | 4 |

One constant. Nothing else in the Top 100 moves materially. A floor around the
universe's own 10th–25th percentile (25–30%) is the defensible setting, and the
principle is worth writing down: **the floor should be calibrated to the
cross-section it divides, not picked as a round number.**

## Finding 4 — the acquisition-announcement game is detectable from price alone

This one needs no new data. A name pinned to a deal price has a signature the
rest of the universe does not: its volatility collapses to near zero and stays
there while its trailing return stays large.

Names with 42-session annualized volatility under 12% (the universe p01 is
14.9%, so this is deep in the left tail):

| symbol | 42d vol | 42d range | prior vol | name |
|---|---|---|---|---|
| GBTG | 1.9% | 1.0% | 102.7% | Global Business Travel Group |
| APGE | 2.0% | 1.7% | 99.8% | Apogee Therapeutics |
| OGN | 2.9% | 2.3% | 89.0% | Organon |
| ACA | 3.3% | 0.6% | 36.2% | Arcosa |
| TBPH | 3.3% | 1.4% | 52.7% | Theravance Biopharma |
| TECH | 4.4% | 2.7% | 65.2% | Bio-Techne |
| PAYO | 4.4% | 1.1% | 57.5% | Payoneer Global |
| RAMP | 5.0% | 1.5% | 55.2% | LiveRamp |
| AES | 3.2% | 2.5% | 31.2% | AES |
| TWO | 4.8% | 1.6% | 35.5% | Two Harbors |
| … | | | | |

That is the pattern described in the complaint, isolated. APGE is the clean
illustration: **+255% on 12–1, ranked #40 on 12–1 vol-adjusted, and its price has
moved 1.6% in two months.** It is ranked on a move it has already finished
making.

Two gates fall out, and the second is deliberately mechanism-agnostic:

**(a) Dead money.** Whole 42-session price range under 4% of the last close. 17
names. Catches deals whether they were announced last month or last year, and it
does not need to know *why* — a momentum screen has nothing to say about a stock
that has not moved in two months. This matters because a volatility-*collapse*
test (recent vol ÷ prior vol) misses deals older than the window: DBRG sits at
2.8% vol over both halves, so its ratio is 0.98 and only the range test finds it.

**(b) One-day repricing.** Among names up more than 65% over the 12–1 window, the
single largest day accounts for more than 60% of the total log return. 25 names
(AGL, COGT, CRNX, DMRA, INBX, OMER, QURE, RAPP, TSHA …). This is a jump, not a
trend, and it is the same defect in a different costume — a binary readout and a
takeover bid both reprice once and then stop.

The separation is clean. The genuine trends sit nowhere near the threshold:
SNDK's 2,542% year has a 17% one-day share, MU 9%, STX 11%, LITE 12%.

Note what (b) does **not** do: it removes 8 of the current Top 100, not 28. Most
of the biotech in the Top 100 genuinely trended and is caught only by Finding 2.
The two findings are related but they are not the same fix, and it would be
wrong to sell (b) as solving the biotech problem.

---

## Proposal

Five changes, in dependency order. Each is independently revertible and each
gets its own exclusion counter in `meta.exclusions`, so the universe stays as
auditable as it is today.

### Step 1 — carry `industry` into the pipeline and the snapshot

Prerequisite for everything targeted. `ScreenerRow.industry` is already fetched
and already used (`industry === 'Shell Companies'`); it is simply dropped at the
`UniverseMember` boundary. Add it to `UniverseMember` and to the snapshot as a
dictionary-encoded column alongside `sector`, which also makes an industry
filter a UI change later rather than a re-run.

Cost: one string index per name, a few KB gzipped.

This must land first because **the name regexes used throughout this document
are not shippable.** They are the same class of mistake the existing exclusion
rules were carefully written to avoid — the repo already has scar tissue from
`\bpreferred\b` killing "Preferred Bank". `\bbio\b` would take Biogen and
BioNTech; `\bbank\b` would take Bank of America. The real rule keys on
`industry == 'Biotechnology'`, which FMP already supplies.

### Step 2 — exclude clinical-stage biotech below a size threshold

New exclusion reason `clinicalBiotech`: `industry === 'Biotechnology'` and
market cap below the threshold. **The threshold is the one number in this plan
that cannot be settled offline** — the proxy says ~$10B and 125 names, but the
proxy and FMP's own industry taxonomy will not agree on membership, and a
$10B cut on the real field may be too blunt or not blunt enough.

Proposed: implement with the threshold in `config.ts`, run once against live
data, print the excluded list, and settle the number by looking at it. Expected
effect if the proxy holds: Healthcare 48 → 26 in the 12–1 raw Top 100, biotech
28 → 3.

The judgement being encoded is explicit and belongs in the README: *this screen
does not rank companies whose price is a probability estimate of a trial
outcome.* That is a legitimate thing for a personal screen to decide, and it
should be written down as a decision rather than buried as a filter.

### Step 3 — raise `VOL_FLOOR_ANNUALIZED` to 0.25

One constant. Fixes the bank over-representation at its actual cause and makes
the floor mean what its comment already claims. Rewrite that comment to state
the calibration rule (floor tracks the cross-section's low decile) so the next
person knows what would make 0.25 wrong.

Affects the four vol-adjusted views only; the raw views are untouched.

### Step 4 — two event gates in `computeMetrics`

New `IneligibleReason` values, applied alongside the existing liquidity and
coverage gates so they land in the same audit trail:

- `deadMoney` — 42-session high/low range under 4% of the last close.
- `oneDayRepricing` — 12–1 log return above 0.5 **and** largest single-day log
  return above 60% of it.

Both compute from closes already in hand; no new fetches, negligible cost. Both
thresholds go in `config.ts` and therefore into `meta.params`, so a snapshot
records the rule that produced it.

Recalibrate on full-precision closes before settling the 60%: the quantized
series overstates the numerator, so the live figure will be a little lower.

### Step 5 — raise `MIN_MARKET_CAP` to $2B

Now, and only now, as a size cut justified on its own terms. Combined with the
above this lands at roughly **1,861 names**.

The existing comment on `MIN_MARKET_CAP` argues correctly that the liquidity
gate does the real work and the cap floor should stay low so the universe is
"everything you could actually trade". That argument was right for a screen
trying to be complete. It is being overridden by a preference for a smaller,
higher-quality list, and the comment should say so rather than being quietly
deleted — the reasoning is sound and the goal changed.

### Expected outcome

Measured on the current snapshot, using the proxies, with a 35% vol floor:

| | universe | 12–1 raw HC (bio) | 12–1 voladj FS (bank) | 6–1 voladj FS (bank) |
|---|---|---|---|---|
| today | 2,572 | 48 (28) | 10 (6) | 28 (16) |
| proposed | **1,861** | **22 (3)** | **4 (0)** | **11 (0)** |

Under 2,000 as asked, with the two over-represented cohorts brought back to
proportionate and the deal-pinned names gone.

## What is deliberately not proposed

- **Ranking within sector, or a per-sector cap on the Top 100.** It would fix
  the symptom without changing the universe, and it changes what the ranking
  *means* — a cross-sectional momentum screen that secretly ranks within buckets
  is a different product. Worth discussing separately if Step 2 proves too blunt.
- **A revenue or profitability floor.** Sharper than an industry exclusion for
  "no pre-revenue names", but it is a per-symbol fundamentals fetch — roughly
  +2,500 requests against a budget that already paces at 550/min to stay under
  the rate limit. Not worth it unless Step 2 fails.
- **A country or domicile filter.** Not part of the complaint, and the existing
  comment in `universe.ts` explains why FMP's `country` cannot support one.
- **Excluding banks by industry.** Step 3 fixes the mechanism. Once the floor
  binds, the banks that still rank are ranking on their returns like everything
  else, and there is no reason to exclude them.

## Verification

The existing `tests/exclusions.test.ts` KEEP list is the right pattern to extend,
and the new rules need the same treatment — real listings that must survive:

- Step 2: `LLY`, `ABBV`, `AMGN`, `GILD`, `REGN`, `VRTX` (large-cap biopharma),
  and any `industry == 'Drug Manufacturers'` name regardless of size.
- Step 4 `deadMoney`: a genuinely quiet-but-alive name — `CHT` at 4.5% over 42
  sessions clears a 4% gate, `KO`-like defensives clear it comfortably. Worth a
  fixture with a name close to the line.
- Step 4 `oneDayRepricing`: `SNDK` (17% one-day share on a 2,542% year) must
  survive; `OMER` (91%) must not.

Plus the invariant that already exists and should be asserted after these
changes too: the eligible universe is the same for all eight views.

Nothing here touches determinism — every gate is a pure function of closes
already in the snapshot's hash inputs, and the two new thresholds land in
`meta.params`.
