# Single-horizon ranks are not interchangeable with their z-scores

**Found while building `lab/`. Not a product bug — the product ranks correctly.
It is a sentence in the README that is not true, and it is a trap.**

## The claim

`README.md`, under *Normalization and the blend*:

> Normalization is a monotonic transform, so it does **not** reorder any single
> horizon; the three single-horizon views rank identically whether sorted on the
> raw figure or its z-score.

## The measurement

`lab/concepts.js` originally ranked the horizon combs on `columns.zr` / `columns.zv`,
on the strength of that sentence. Against the shipped `scoresFor()` + `ranksFor()`:

```
rank cells compared: 15432   (2,572 names x 3 horizons x 2 modes)
mismatches:           1085
```

On the 12–1 raw view alone, 167 names rank differently.

## Why

Z-scoring is monotonic. **Winsorising is not.** Clipping at the 1st/99th
percentile maps every value beyond the clip onto a single number, so the tails
become one large tie, and `ranksFor`'s documented secondary sort on symbol then
orders that tie alphabetically.

At 2,572 eligible names, 1% is 25.7 names, so the clip catches 26 at each end:

```
names tied at the top 12–1 z (5.1591): 26
names tied at the bottom:              26

ranked on raw momentum (what ships):  SNDK  AXTI  ERAS  DMRA  MU  ANRO  FBRX  WDC
ranked on the z-score:                ALMS  ANRO  AXTI  BFLY  BIOA  BW  CLYM  DMRA
```

The tie is not in some obscure corner of the distribution. It is **ranks #1
through #26 of the default view** — the entire first screen and then some.

## Why it matters

The product is correct today: `scoresFor()` returns `c.m[h]` for a single horizon
in raw mode and `m / max(rv, floor)` in vol-adjusted mode, never the z-score. The
z-scores are used only for the blend, where they are the whole point.

The risk is that the README states the two are equivalent, so the next person to
touch this — reasonably wanting one code path for all four views, or reaching for
`zr` because it is already normalised and conveniently comparable across
horizons — will make the substitution the documentation endorses, and
alphabetise the top of every single-horizon list. Nothing would fail. The list
would still be 100 names, still in descending score order, still deterministic,
still hashing consistently. It would just be wrong, at the top, where it shows.

## Suggested wording

> Normalization is monotonic **except at the winsorised tails**, where clipping
> ties the top and bottom 1% of names at a single value. Sorting a single
> horizon on its z-score therefore alphabetises those 26 names at each end,
> while sorting on the raw figure orders them correctly. Single-horizon views
> rank on the raw figure for this reason, not only because it is the more
> interpretable number to display. Only the blend ranks on z-scores, where
> the clip is deliberate and applies before the three horizons are averaged.

A test asserting `ranksFor(scoresFor(s, h, mode))` disagrees with a z-ranking on
exactly the clipped names would keep the sentence honest, but the wording is the
load-bearing fix.
