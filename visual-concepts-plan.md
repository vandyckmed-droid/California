# Two changes to the ranked list, and what was rejected

> **Status: proposed, not built.** This PR contains a prototype lab and this
> plan. `web/` is untouched — `git diff main -- web/` is empty and should stay
> that way until the approach is agreed.
>
> Everything here is drawn from the committed `2026-08-28` snapshot. Neither
> proposal needs a new pipeline output, a new file, or a byte of extra payload.

## How to look at it

```bash
npx --yes serve . -l 5173        # repo root, not web/
open http://localhost:5173/lab/
```

Three tabs. Each puts the live product in an iframe on the left, unmodified, and
the concept on the right. Both read the same snapshot, and the concept panes are
built from `web/lib/model.js` and `web/lib/quant.js` rather than from copies, so
a concept cannot quietly disagree with the product about a rank or a correlation.

---

## Proposal 1 — the horizon comb

**A 54×26 glyph on each row showing the name's rank in all three windows.**

Three teeth, left to right: 12–1, 9–1, 6–1. Tooth height is rank on a log axis.
A spine joins the tips, green where the name is stronger over the short window
than the long one, red where it is weaker. The tooth for the horizon currently
being viewed is drawn heavier, so the glyph is anchored to the tab you are on.

### Why this and not another number

The list already lets you choose which number a row shows, and the ticker screen
already shows all three horizons in a table. What neither does is let you compare
horizons **while scrolling**, and that turns out to matter more than it sounds:

```
rank sym     12–1    9–1    6–1
   1 SNDK       1      5     54
   2 AXTI       2      6    614
   3 ERAS       3      3    329
   4 DMRA       4    200   1644
   5 MU         5     15     36
   ...
   9 PRAX       9    263   1947
  12 ALMS      12     13   1693
  20 BW        20    316   1267

of the top 20 on the product's default view: 18 decaying, 1 flat, 1 rising
```

Eighteen of the twenty names on the first screen of the default view are names
whose momentum has already rolled over. That is not a defect in the ranking —
12–1 is the longest window, so its leaders are long-run winners by construction —
but the *magnitude* is not structural. #4 is #1,644 over six months. The figures
are already on the row. The screen currently spends that row on a column of large
green percentages instead.

Switching to the 6–1 tab reveals this, at the cost of losing your place and your
comparison. The comb makes it a property of the row.

### Encoding notes

- **Log rank, not percentile.** At 2,572 names a linear percentile puts #1 and
  #100 within 3.8% of the axis, and every comb in the part of the list anyone
  reads flattens into the same rectangle. This was built the wrong way first.
- **Drift is judged on the same log axis**, so the green/red call is scale-free:
  a 20-place move at the front counts, the same 20 places at #1,500 does not.
- **Ranks come from `scoresFor()` + `ranksFor()`**, the product's own functions.
  The first draft ranked on `columns.zr`/`zv` instead and disagreed with the list
  on 1,085 of 15,432 rank cells — see `notes/winsorised-ranks.md`, which is a
  finding about `README.md` rather than about this proposal.

### Cost

One inline SVG of five elements per rendered row, built in the loop that already
builds the row. No fetch, no new field, no change to `snapshot.json`. The row
keeps its 44px tap target and its existing grid; the glyph takes the 54px the
name currently spends on truncation.

### Open question for review

Whether the comb sits **beside** the metric number, as prototyped, or **replaces**
it on narrow screens. Beside is the tighter fit and the harder test, so that is
what is drawn. A phone at 390px has room for both only because the company name
already truncates.

---

## Proposal 2 — the same-trade rail

**A coloured rail and an n-of-m mark on rows that repeat a trade already higher
in the list.**

`#1 SNDK 1/4`, `#5 MU 2/4`, `#8 WDC 3/4`, and `#21 STX 4/4` — one storage trade
occupying four of the top twenty-one places.

### Why

The README's first sentence is that this is a momentum screen *"with correlation
grouping so it is obvious when several highly ranked names are effectively the
same trade."* On the ranked list, that signal currently appears **only after you
have already put something on your watchlist** — `markedRows()` returns an empty
set for an empty selection, so the screen that is supposed to make crowding
obvious says nothing until you have committed to a name.

The data to fix this is already loaded. `clusters.ids` carries a group id per
name at each of the three thresholds, over the whole eligible universe, and the
list parses it on boot for the existing marking. Nothing needs to be fetched,
computed, or added.

### Encoding notes

- **The mark is `n/m`, not a colour.** Colour cannot separate 360 groups and does
  not have to; hue only has to tie together rows near enough to see at once, so
  twelve hues with accepted collisions is sufficient. `3/4` is unambiguous in
  greyscale, survives a colour-blind reader, and says the actionable thing: this
  is the third-best name in a trade you have already scrolled past twice.
- **A first pass crossed twelve hues with four dash patterns** for 48 distinct
  rails. On a 5px rail it read as a rendering fault — noise bought to solve a
  collision the mark had already solved. Removed.
- **Counted over the filtered list, not the rendered page.** A fourteen-name
  semicap group is a group of two once you filter to $50B+, and marking `3/14`
  beside two visible rows would describe a list the reader cannot see. Counting
  over the rendered page instead would relabel groups as the infinite scroll
  appends. The filtered list is the only stable, honest denominator.
- **The rail is a separate channel from selection.** `.stock` already uses its
  left border for "on your watchlist". The rail sits inside the row, so the outer
  edge stays yours and the inner rail is the market's structure.

### Cost

One span and one badge per row. No new data, no new payload, no correlation
computed in the browser — the same set-membership test the marking already uses,
run against the whole list rather than against the selection.

### Open question for review

Whether the rail is the right default at all, or whether the stronger default is
**one row per group**, collapsed, with the redundant names expandable. The rail
shows you the crowding; collapsing would act on it. Collapsing changes what rank
means on screen, which is a bigger decision than a glyph and is deliberately not
proposed here.

---

## Explored and rejected — the weave

**A correlation matrix drawn as cloth, replacing the watchlist's group panels.**

Prototyped in full (`lab/` tab 3) and it does not clear the bar. Side by side, the
existing **Moves together** panel is better: it names each group with its members'
ranks and the group's minimum ρ, in about the same vertical space, and the weave
can show neither. The matrix looks more sophisticated and communicates less.

Two things in it are genuinely worth having, and neither needs a matrix:

1. **Near-miss pairs.** A group list is a threshold applied and then discarded, so
   the pair sitting at ρ 0.64 — the thing most worth knowing when the threshold is
   0.65 — is exactly what it cannot report. One line under the panel naming the
   tightest pair that did *not* group would cover it.
2. **Distinct trades.** The demo basket is 15 names and 2.5 distinct trades. The
   panel already says "11 of your 15 names sit in 4 groups"; a single derived
   number is a sharper version of the same sentence, computed from the mean
   pairwise correlation the screen has already loaded.

Both fit the existing panel as one extra line and one extra row. Recorded here
rather than opened as a proposal, because a one-line addition does not need a
plan and the matrix it came from should not be built.

The prototype stays in `lab/` — it is the clearest demonstration of what a group
list throws away, which is why the near-miss line is worth adding at all.

---

## Not prototyped: anything involving movement over time

Rank trails, bump charts, new-entrant badges, persistence dots, churn meters,
ghosted yesterday-behind-today. All unbuildable today, not merely hard: the
pipeline overwrites `snapshot.json` on every run and keeps no archive, so the
browser has today and no yesterday.

`notes/rank-history-cost.md` costs the smallest change that would unlock the whole
family — a rolling 60 sessions of ranks for the names that touched the top 200,
70 KB raw — so that decision can be made on a number rather than on enthusiasm.
It needs a pipeline change and two weeks of runs before the first trail can be
drawn, so it is a note, not a proposal.

Both proposals above deliberately take their sense of movement from the data that
**is** present: three nested lookback windows, which are already a time axis and
are not yet drawn as one.
