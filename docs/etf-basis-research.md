# Can ~2,300 stocks be compressed into a small set of ETF bets?

**Short answer: no, not usefully — and the machinery already in Cali does the job better.**

An ETF basis represents about **28% of the universe** at a lenient bar, and the compression
it does achieve is concentrated in ~10 rate-sensitive and commodity-linked groups.
Cali's existing correlation grouping already puts **48–59%** of the same names into
**326–386** finer groups. The proposed hierarchy would replace a finer instrument with a
coarser one.

Study date 2026-08-28 · 756 sessions (2023-08-23 → 2026-08-28) · 2,280 cleaned stocks ·
75 candidate ETFs · reproduce with `npm run labs:etf-basis`.

---

## Changes I made to the proposed plan

**1. The baseline is not "no grouping". This is the important one.**
The plan compares an ETF basis against treating every ticker as independent. But Cali
*already* clusters its whole universe by correlation into 293–386 complete-linkage groups.
Any ETF basis has to beat that, not beat nothing. This single change is what turns a
promising-looking result into a negative one, and it is the reason for the recommendation
below.

**2. I seeded the candidate library with 13 known-redundant pairs as positive controls**
(SMH/SOXX, XBI/IBB, ITA/XAR, XHB/ITB, XES/OIH, URA/URNM, GDX/GDXJ, XHE/IHI, RWR/VNQ,
KIE/IAK, HACK/CIBR, XTN/IYT, PPH/XPH). Without a known answer in the data there is no way
to distinguish a working redundancy method from a plausible one. The method caught 12 of 13.

**3. I report each stock's *median* fit alongside its *best* fit.** A best-of-45 maximum is
an order statistic and looks impressive even on noise. The median across the same basis is
what the same search returns when there is nothing to find, so every fit is readable against
its own null rather than an assumed one. (Median ETF explains 1.0%; best explains 19%.)

**4. I dropped the plan's suggested factor-model elaborations.** A single market regression
is enough. Adding size and value factors would strip out variation an industry ETF is
entitled to explain and would answer a different question.

**5. I ran the study on the cleaned universe** (2,280 names, per the universe-cleanup work),
not the raw 2,572. On the raw universe the "genuinely idiosyncratic" tail is dominated by
shells and crypto-adjacent names — BMNR, SBET, ASST, BULL — which flatters the residual
bucket with junk rather than with real independent bets.

---

## Method

1. Daily returns, 756 sessions, split- and dividend-adjusted, all on one master calendar.
2. Every series residualized against SPY: `r = α + β·SPY + e`.
3. Similarity measured on residuals only. **This step is load-bearing**: median pairwise
   |ρ| between two candidate ETFs is **0.43 raw** and **0.15 after removing the market**.
   Without it, everything looks like everything because everything is U.S. equity.
4. Redundancy: complete-linkage clustering on residual |ρ| ≥ 0.70. Complete linkage, not
   single, or semis chain to software to cloud to fintech through a run of adjacent pairs.
5. Stock → ETF: partial R² between the stock's market residual and each basis member's.
6. Compression curve: greedy forward selection — at each step add the ETF that newly
   represents the most still-unrepresented stocks.

---

## Stage 2 — the pruned basis: 75 → 45

**Positive controls: 12 of 13 caught.** The method merged every pair it was supposed to
except PPH/XPH, and that miss is informative rather than a failure: XPH (equal-weight,
generics-heavy) merged into **XBI**, while PPH (cap-weighted big pharma) stayed on its own.
Big pharma really is a different bet from biotech; equal-weight pharma is not.

Merges the method found that I had *not* predicted, and which look right:

| Kept | Absorbed | Reading |
|---|---|---|
| IGV | XSW, SKYY, WCLD | Software, cloud and SaaS are one bet |
| XBI | IBB, **XPH** | Biotech absorbs equal-weight pharma |
| XOP | XES, OIH | E&P and oil services do not separate |
| TAN | ICLN, PBW | Solar *is* the clean-energy trade |
| URA | URNM, NLR | Uranium and nuclear are one bet |
| GDX | GDXJ, SIL | Silver miners are gold miners |
| RWR | VNQ, REZ, INDS | REIT subsectors do not separate |
| KRE | KBE | Bank breadth adds nothing |

25 of the 45 survived as singletons, so the library was not merely redundant.

---

## Stage 3/4 — the compression curve, and its ceiling

Best-match partial R² across 2,280 stocks: **p10 0.06 · p25 0.11 · p50 0.19 · p75 0.32 · p90 0.54.**
Null (median ETF): 0.010.

The signal is real — the best match is ~19× the null — but real is not sufficient.

| Bar | Stocks represented | Share |
|---|---:|---:|
| R² ≥ 0.2 | 1,040 | 45.6% |
| R² ≥ 0.3 | 646 | 28.3% |
| R² ≥ 0.4 | 404 | 17.7% |
| R² ≥ 0.5 | 287 | 12.6% |

**The curve elbows almost immediately and then flatlines** (at R² ≥ 0.3):

| Basis size | Stocks covered | Share | Last added |
|---:|---:|---:|---|
| 1 | 129 | 5.7% | KRE |
| 3 | 275 | 12.1% | XOP |
| 5 | 372 | 16.3% | KIE |
| 10 | 503 | 22.1% | PAVE |
| 15 | 558 | 24.5% | ARKG |
| 20 | 598 | 26.2% | TAN |
| 30 | 641 | 28.1% | XBI |
| 45 | 646 | 28.3% | — |

Ten ETFs deliver 78% of everything all 45 achieve. ETFs 30→45 add **0.2 percentage points**.
The hoped-for "30–60 bets" range is the flat part of the curve: there is nothing there.

---

## Where compression works, and where it fails

ETFs absorbing the most stocks (R² ≥ 0.3):

| ETF | Stocks | |
|---|---:|---|
| KRE | 125 | Regional banks |
| RWR | 67 | REITs |
| XOP | 63 | Oil & gas E&P |
| XHB | 52 | Homebuilders |
| KIE | 46 | Insurance |
| XLU | 40 | Utilities |
| GDX | 38 | Gold miners |
| KCE | 25 | Capital markets |
| SMH | 23 | Semiconductors |

**Compression works where the company is a proxy for a rate or a commodity** — a regional
bank is an interest-rate position with a logo; a gold miner is levered gold. It fails where
companies have idiosyncratic products.

**The motivating example is the case that fails.** "Fifteen highly correlated semiconductor
stocks" was the premise. SMH is the best match for 93 stocks, but only **23** clear R² ≥ 0.3,
and their median R² is **0.17**. Semiconductor stocks are *not* one bet on this data — AMD,
Broadcom and Micron have genuinely different businesses, and the ETF captures a sixth of what
moves them once the market is out.

Strongest mappings are all rates/commodities: AEM→GDX 0.88, FNB→KRE 0.85, WPM→GDX 0.85,
UBSI→KRE 0.84, PHM→XHB 0.80. Weakest: IDCC→XTL 0.02 (patent licensing, not telecom),
CORT→XHS 0.01, PSKY→KIE 0.01 — mostly single-product pharma and misfiled conglomerates.

---

## Stage 6 — momentum, where the news is better

For the 646 represented stocks, the hierarchy genuinely carries information:

- **64 of the top 100** stocks by 12-1 momentum sit in a top-quintile ETF (chance ≈ 20).
- Spearman(stock 12-1, its ETF's 12-1 rank) = **0.60**.
- Stock 12-1 regressed on its ETF's 12-1: **R² 0.36**, β 1.55 — a stock moves about 1.5× its
  group and roughly a third of its momentum *is* its group's.
- Only **8 of the top 100** come from a below-median ETF group.

So ETF-first ranking would successfully find where most leaders are — **within the 28% of
the universe it can see at all.** Applied to the whole universe it would be blind to 72%.

---

## Failure modes

1. **Coverage, not accuracy, is the binding constraint.** The mappings that exist are good.
   There are not enough of them.
2. **Best-of-N flattery.** Handled by reporting the median null, but any future work that
   drops it will overstate fit substantially.
3. **One regime.** 756 sessions covers a single rate cycle. KRE's 125-stock absorption may
   be "everything was a rate trade in 2023–2026" rather than a structural fact.
4. **Sector labels are not bets.** IDCC sits in Technology and behaves like a patent
   annuity; PSKY is classified Communication Services and matched Insurance at R² 0.01.
5. **The ETF basis is not neutral.** ARKG and IPO absorb names by being high-beta junk
   proxies, not by naming an industry.

---

## Recommendation: do not change Cali

The compression the premise hoped for is not in the data, and the specific thing an ETF
basis would add is already present in a better form:

| | ETF basis | Cali's existing grouping |
|---|---|---|
| Groups | 45 | 326 (ρ≥0.65) / 386 (ρ≥0.60) |
| Names grouped | 646 (28.3%) | 1,103 (48.4%) / 1,351 (59.3%) |
| Derived from | 45 external proxies | the universe's own returns |
| Largest group | 125 | 23 / 40 |

The correlation grouping covers roughly twice as many names at an order of magnitude finer
granularity, and it is derived from the stocks themselves rather than from an editorial list
of ETFs that has to be maintained.

**What I would keep from this work.** The finding that ~10 ETFs summarise the rate-sensitive
and commodity-linked block well is real and useful — and it is essentially what ETF River
already displays. The honest framing is not "ETFs replace stocks" but "a dozen ETFs are a good
*context* panel for the third of the universe that is a macro proxy."

## What I would test next

1. **Attack the real problem directly.** The Top-100 "same trade" complaint is measurable:
   how many of the top 100 sit in a shared correlation group *today*? If that number is small,
   the problem is smaller than assumed. If large, the fix is presenting the existing groups
   better, not adding an ETF layer.
2. **Regime split.** Re-run on 2023–2024 vs 2025–2026 separately. If KRE's absorption halves,
   the compression is a rate-cycle artefact.
3. **Do the groups predict?** Test whether last month's group momentum predicts next month's
   member returns better than the members' own. That is the only test that would justify
   ranking groups before stocks, and this study does not answer it.
