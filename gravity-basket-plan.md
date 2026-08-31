# Gravity Basket, in Labs

**Status: proposal. Nothing here is built.** Assessment first, then the smallest
reversible version if it is wanted.

## Context

Gravity Basket is one of five concepts in the design library on PR #5. It draws
the names on your watchlist as bodies that attract when they move together, so
the basket arranges itself into clumps and **the number of clumps is the number
of distinct bets** — arrived at spatially rather than asserted as a statistic.

Its packet named the risk itself:

> **The honest counter-argument:** force layouts are non-deterministic, in a repo
> built on byte-identical reproducibility. Two runs settle to the same
> *structure* but not the same *picture* … If it graduates, the layout probably
> needs a deterministic seed and a fixed iteration count.

That is a real objection and it turns out to be the lesser one. Checking the
prototype against the product found something worse, and fixing it makes the
non-determinism problem disappear.

---

## The finding

**The prototype draws the wrong grouping.**

Its clumps are the connected components of the "ρ ≥ threshold" graph: every pair
above the line attracts, so anything transitively linked ends up in one mass.
That is single linkage. The product uses **complete linkage**, everywhere,
deliberately — `README.md` says why:

> Complete linkage is the defensible choice because it guarantees that *every*
> pair inside a group clears the threshold … single linkage would chain the whole
> Top 100 into one blob, since nearly every equity is somewhat market-correlated.

Run both rules over the prototype's own 24-name basket, on the committed
snapshot, at the threshold the product defaults to:

| ρ ≥ 0.65 | clumps | largest |
|---|---|---|
| connected components — *what the prototype drew* | **7** | **14 names** |
| complete linkage — *what the product uses* | **10** | 4 names |

```
components:   MU STX WDC SNDK AMAT LRCX ICHR UCTT IREN CIFR HUT RIOT MXL INTC   ← one "bet"
              AEM NEM PAAS AGI
              DELL NTAP

complete:     MU STX WDC SNDK          (storage)
              AMAT LRCX ICHR UCTT      (semicap)
              IREN CIFR HUT RIOT       (crypto miners)
              AEM NEM PAAS AGI         (gold)
              DELL NTAP · MXL INTC
```

The prototype fuses memory, semicap and crypto miners into a single fourteen-name
blob and reports **"24 names → 7 distinct bets."** By the product's own rule the
answer is **10**, and the four real clusters are visible and clean. The headline
number of the concept — the one thing it exists to say — is wrong, and wrong in
exactly the way the README predicted single linkage would be wrong.

### It cannot be fixed by tuning the physics

The instinct is to reweight the forces. That does not work, and the reason is
measurable rather than a matter of taste. On the same basket at ρ ≥ 0.65:

```
tightest cross-group pair:   MU / LRCX    0.790
loosest within-group pair:   MU / STX     0.688
```

**MU is more correlated with a name in a different group than with a name in its
own.** Any attraction that is a function of pairwise ρ pulls MU toward LRCX
harder than toward STX, so no parameterisation of a pairwise spring system
reproduces complete linkage. This is structural, not a tuning failure. A
simulation driven by pairwise correlation can only ever draw single linkage.

### What that buys

If the clumps must be complete-linkage groups, and complete linkage is already
computed exactly by `web/lib/quant.js` — the same call the watchlist already
makes for its *Moves together* panel — then **the groups are known before
anything is drawn.** There is nothing to search for.

So the simulation is not needed. Layout becomes deterministic placement of a
known partition, and the packet's counter-argument dissolves rather than being
mitigated:

| | prototype | **this plan** |
|---|---|---|
| Grouping rule | connected components (single linkage) | complete linkage, same call as the watchlist |
| "Distinct bets" | wrong by the product's own rule | the number the watchlist already states |
| Determinism | emergent; same structure, different picture | same basket → identical coordinates |
| Can disagree with the watchlist | yes, and did | **no, by construction** |
| Motion | the search itself | a scripted transition to a known answer |

The concept survives intact. What is discarded is the mechanism, which was never
the point — the point was seeing your basket fall into separate piles.

---

## Does the drawing still work without the physics?

The thing that made the prototype legible was clumps with clear space between
them, and that is a property of the layout, not of how the layout was found.
Placing known groups produces *better* separation than the simulation did,
because nothing pulls two groups together.

What genuinely changes: the prototype's most-praised moment — dragging a name in
and watching it fly to its clump — becomes a transition to a computed position
rather than a discovery. It still reads as arrival. It is no longer evidence.
That is an honest loss and it is priced in *What is deferred* below.

---

## Assessment

Worth building, in Labs, at small scope. It is the spatial rendering of a number
the watchlist already computes and states in words, so it adds no new claim and
cannot contradict the product. It needs no pipeline change and no new payload.

The case against is that it is a second view of an existing panel. That is why it
belongs in Labs rather than on the watchlist: Labs is where something earns the
right to replace a panel, and the panel is not being touched.

---

## Architecture

One route, one file, no pipeline change.

```
web/views/labs/gravityBasket.js      the view          new
web/views/labs/index.js              one EXPERIMENTS entry   +6 lines
web/styles.css                       one .basket-* block     scoped
```

Everything it needs already exists and is already reachable from Labs:

- **The selection** — `watchlist` from `app.js`, the same set the watchlist screen
  reads.
- **The returns** — `loadSeries(symbol)` from `app.js`, one request per selected
  name, already cached per session. Labs may depend on stable Cali; that is the
  boundary rule, and this is a clean instance of it.
- **The grouping** — `correlationMatrix` and `completeLinkageGroups` from
  `web/lib/quant.js`. Not a copy: the same functions the watchlist calls, so the
  two screens cannot drift.
- **The decoder** — `decodeCorrelation` currently lives inside
  `web/views/watchlist.js` and is not exported. Either export it or move it to
  `quant.js`'s neighbourhood. **It must not be reimplemented** — the ranker plan
  records what happened the last time correlation input was duplicated, and the
  display-grade decoder is deliberately kept away from `pearson` for the same
  reason.

Unlike Rank River, **there is no sidecar.** Nothing is written by the pipeline,
`web/data/` is untouched, and `dataHash` cannot move.

### Layout

Deterministic, and stated precisely because "deterministic" is the property under
review:

1. Groups from `completeLinkageGroups(C, threshold)`, in the order it returns
   them (already sorted by best rank, already tie-broken).
2. Group centroids placed on a fixed phyllotaxis spiral — index *i* at angle
   *i·137.5°*, radius *k·√i* — which packs evenly with no search and no
   randomness.
3. Members placed on a circle inside their group's disc, in the order
   `completeLinkageGroups` returns them.
4. Radii scale with basket size so the frame stays full without overflowing.

Every step is a pure function of `(symbols, threshold, frame size)`. Same inputs,
same coordinates, every time.

### Motion

A single scripted transition from the frame's centre to the final positions,
~600 ms, eased. It reads as the basket settling, which is the concept's
character, without being a search.

`prefers-reduced-motion` paints the final frame directly. This is a real
requirement rather than a courtesy: the whole content is the final arrangement.

---

## What is deferred, simplified or rejected

**Deferred — dragging a candidate in.** The packet calls this "the move that
matters," and it is. It needs a name picker or a route from the ranked list, it
needs a preview state distinct from the basket itself, and it needs an answer to
"what does it mean to preview a name you have not selected." That is a second
feature. Building it on top of a working layout is easy; building both at once
means neither gets judged.

**Simplified — no per-pair bond lines.** The prototype drew a line for every
above-threshold pair. Those lines are what made single linkage look plausible,
since they connect names in different groups. Drawing them beside
complete-linkage clumps would show bonds crossing between clumps and invite
exactly the wrong reading. Groups are drawn as regions; pairs are not drawn.

**Rejected — the force simulation.** See *The finding*.

**Rejected — inventing a separate "distinct bets" number.** The count is
`completeLinkageGroups(...).length`, which is what the watchlist already reports
as *"n of your m names sit in k groups."* One number, one source.

---

## Risks

**Basket size is unbounded.** The watchlist takes any number of names. At 390px
a labelled disc needs roughly 34px across, so about 30 names is the ceiling
before labels must go. Above that the view needs a stated degradation — drop
labels, or draw group discs sized by membership with names listed beneath.
Unresolved, and gate 2 decides it.

**It duplicates a panel that works.** Mitigated by living in Labs and by taking
its number from the same call, but if nobody prefers it to the list, that is the
correct outcome and the experiment is deleted.

**A basket with no groups.** Every name solo is a legitimate and good answer —
"you hold ten distinct things" — and must not look like a failed render. Needs
its own copy, not an empty frame.

**Fewer than two names.** No correlation exists. Needs an explicit state.

---

## Validation

Two gates, each able to end the feature.

**Gate 1 — the drawing agrees with the product, exactly.** For a fixed basket at
each of the three thresholds, the set of drawn clumps must equal
`completeLinkageGroups(C, threshold)` as a set of sets. Not "looks similar" —
set equality. This is the gate the prototype would have failed, and it is the
only thing standing between this and drawing single linkage again by accident.

**Gate 2 — legible on a phone.** At 390×844, with a basket of 24 names: every
ticker readable, every clump visually separate from every other, no overlap. If
it fails, the fallback is a labelled group-disc view; if that also fails, the
concept is a desktop object and does not ship.

Plus the ordinary checks: same basket rendered twice produces identical
coordinates; `verify:ui` covers the route, the empty state, the single-name
state, the all-solo state, and reduced motion; the Labs boundary test extends to
the new file with no change to its rules.

---

## Removal

One revert: delete `web/views/labs/gravityBasket.js`, remove one entry from
`EXPERIMENTS`, remove one CSS block. Nothing in core references it. No pipeline
output to clean up, no data file to delete, and `web/data/` never changed.

If `decodeCorrelation` was exported from `watchlist.js` to share it, that export
stays — it is a good change on its own and reverting it is unrelated.

## Rollback, in order of severity

1. **The layout is wrong** — delete the file, remove the entry. Labs loses one row.
2. **Labs is wrong** — the boundary test already guarantees core is unaffected.
3. **Nothing** — the pipeline, the snapshot and `dataHash` are untouched by
   construction, so there is no rollback that reaches the data.

## Order

1. Export or relocate `decodeCorrelation` so the view can reach it without a copy.
2. The view: groups, layout, static frame. No motion, no controls.
3. **Gate 1.** If it fails, stop.
4. Threshold control, matching the watchlist's three values.
5. **Gate 2** at 390×844. If it fails, try the group-disc fallback, then stop.
6. Motion and `prefers-reduced-motion`.
7. Empty, single-name and all-solo states.
8. `verify:ui` coverage and the boundary test entry.

## Open questions

1. **Solos.** Show every unclustered name as its own mark, or only the groups?
   Showing them is honest and makes a ten-name all-solo basket meaningful;
   hiding them makes the clumps louder. Leaning toward showing them, dimmer.
2. **Does it eventually replace the *Moves together* panel?** Not proposed, and
   deliberately not designed for. If Labs shows people prefer it, that is a
   separate change to a shipped screen.
3. **The threshold control.** Three fixed values matching the watchlist, or a
   continuous slider? Continuous is what the Threshold Dial packet argues for
   and is a different concept; three values keeps this one honest.

## Not doing

- No pipeline change, no sidecar, no new payload, no change to `web/data/`.
- No change to the watchlist, the ranked list or the ticker screen.
- No new correlation maths. The one existing implementation, called once.
- No drag-in, no candidate preview, no basket editing from this screen.
