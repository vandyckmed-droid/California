# Visual concepts lab

Experimental work. **Nothing here is loaded by the product.** `web/` is untouched;
this directory only reads `web/data/`.

The lab puts the live product and a concept side by side at a 390 x 844 phone
viewport. The baseline pane is the real app in an iframe, unmodified, so it can
never drift from what actually ships.

```bash
npx --yes serve . -l 5173      # from the repo root, not from web/
open http://localhost:5173/lab/
```

Three concepts, each rendered from the committed `web/data/snapshot.json`:

| | concept | screen | new data needed |
|---|---|---|---|
| 1 | Horizon comb | ranked list row | none |
| 2 | Same-trade rail | ranked list | none |
| 3 | The weave | watchlist | none |

Opening the weave tab writes the demo basket to `localStorage` under
`california.watchlist.v1` — the same key the product uses — so the live pane has
something to analyse. Clear it from the app's own **Clear watchlist** button.

All three are drawn from figures the snapshot already carries. The correlation
maths comes from `web/lib/quant.js` — the shipped implementation, imported, not
copied, so the lab cannot quietly disagree with the pipeline.

## `field/` — the wider exploration

`lab/field/` is the second pass: five ways of seeing the whole universe rather
than five ways of decorating a row. Same server, `http://localhost:5173/lab/field/`.

| | concept | scope | data |
|---|---|---|---|
| 1 | Spectrogram | 2,572 x 126 as one image | real |
| 2 | Territories | all 360 groups as a map | real |
| 3 | Telescope | one chart, three horizons | real |
| 4 | Broadsheet | top 100 as pure type | real |
| 5 | Rank river | 20 paths over 60 sessions | **invented, flagged in the UI** |

`node lab/field/build.mjs` regenerates everything in `lab/field/data/` from the
committed snapshot. The twenty-concept field the five were chosen from is in
`visual-concept-field.md`.

## Why no rank-history concepts

The pipeline overwrites `web/data/snapshot.json` on every run and keeps no
archive, so the browser has exactly one snapshot and no yesterday. Rank trails,
bump charts, new-entrant badges, persistence dots, churn meters and "what
changed" diffs are all unbuildable today — not hard, unbuildable — and none of
them are prototyped here. `notes/rank-history-cost.md` costs the smallest change
that would unlock that whole family, so the decision can be made on a number.
