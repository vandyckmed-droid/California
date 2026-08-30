# The field — twenty ways of seeing 2,572 names

> Discovery, not implementation readiness. Five of these are built and running in
> `lab/field/`; the rest are sketches. Whether the data exists is recorded but is
> **not** a filter — one of the five is drawn on openly invented data because the
> question it answers is about the drawing, not about the market.

The first pass at this produced three row indicators. This one deliberately
avoids that: a row indicator can only ever answer *"what about this name?"*, and
most of the interesting questions about a ranked list are not about a row.

---

## Built (`lab/field/`)

> Five drawn in the first field round, two more added after review picked a
> shortlist. Packets for the five shortlisted concepts are in `concepts/`.

**1 · Spectrogram.** 2,572 rows, 126 columns, one pixel per name-session,
brightness what that name did that day standardised by its own volatility.
Overview plus a 44-row lens. Sorted by correlation group, the 28 gold miners are
a single band of shared texture and the 21 regional banks below them are visibly
a *different* fabric — you can see the seam between two groups. A toggle removes
the market factor; leave it in and the whole picture collapses into vertical
stripes, which is a picture of why correlation grouping needs residuals.
*Correlation stops being a matrix you decode and becomes a texture you recognise.*

**2 · Territories.** Every correlation group as a landmass, area = members,
hue = dominant sector, brightness = how far forward it reaches. The map inverts
the list: the lit territories are small — 14 semicap names at #24, 7 miners at
#18 — while the vast dark regions are the 28 gold names at #470 and the 21 banks
at #687. A list answers *what is best*; a map answers *what is there*.

**3 · Telescope.** One chart, three horizons, no tabs. Time compressed by a 0.7
power so recent weeks are stretched. The 21 sessions the ranking deliberately
throws away go from 8% of the frame to about 18% — present, and not pretending
to be the whole story. A true log axis was tried first and gave the skip 56%.

**4 · Broadsheet.** The top 100 as a page of type and nothing else. Size is rank,
weight is how much of the twelve-month standing survives into six, superscript is
group size. No axes, no colour doing work alone. The finding is legible in the
type itself: **superscript ¹⁴ appears five times**, so one semicap trade holds
five of the hundred, and the faded names — SNDK, ALMS, ERAS, AXTI — are the ones
whose lead has already gone.

**5 · Rank river.** *Mock data, clearly flagged.* Twenty paths converging on
today, two arrivals and two collapses drawn heavy. Answers the only question
worth asking before buying storage: can a braid carry an arrival legibly? It can,
at twenty names. It would be mud at a hundred.

---

## Sketched

**6 · Threshold dial.** *Built — see `concepts/threshold-dial/`.* Swept
continuously, each member-set has a lifetime, drawn as a persistence barcode.
76 distinct sets across ρ 0.50–0.90; `HUT · CIFR` survives 0.50–0.76, and 4 of
the 21 groups the product shows at 0.65 do not survive a 0.10-wide band.

**7 · The seam.** Two names, one log-time chart, their price paths overlaid and
the gap between them shaded. "Why are these grouped" answered as a picture. The
natural companion to the telescope.

**8 · Constellation.** Names as points, edges above threshold, force-laid. The
familiar move — and worth sketching mainly to establish that it is *worse* than
the territories map here, because a force layout wastes its strongest channel
(position) on nothing in particular.

**9 · Orrery.** One name at the centre, its correlates orbiting at radius 1−ρ.
Per-ticker rather than universe-scale. Elegant, and probably a toy.

**10 · Sector-versus-structure.** Sector labels faded behind correlation groups
so the disagreements show. `DOCN`+`STRL` are one trade across Technology and
Industrials; `AGL`+`XMTR` across Healthcare and Industrials. The places where
statistics and taxonomy disagree are the interesting ones and nothing surfaces
them today.

**11 · Waterline.** Bars half-submerged at the 17.5% volatility floor. Worth one
sketch and probably no more: not one name in the top 120 is near the floor — the
calmest runs at 40% — so the picture would be all water and no line.

**12 · Universe quilt.** All 2,572 as a pixel field, hue by sector, ordered by
rank. Superseded by the spectrogram, which does the same compression and carries
time as well.

**13 · Breadth ribbon.** A single band across the top of the list: what fraction
of the universe is positive over each window. Three numbers, no chart, permanent.
The one concept here that would fit on a lock screen.

**14 · Momentum sigil.** A generative five-stroke mark per ticker encoding rank,
drift, volatility, group. Names become recognisable the way logos are. High risk:
it is a private alphabet, and nobody learns one for a screen they check weekly.

**15 · Departure board.** The list as a split-flap timetable, ranks flapping into
place. Motion as the carrier of rotation. Needs history.

**16 · Ghost.** Yesterday's list rendered faintly behind today's. The cheapest
possible movement display — no chart, no new screen, just a second position for
every row. Needs history.

**17 · Drift field.** Volatility against momentum with every name a short vector
pointing where it is heading. A weather map of the cross-section.

**18 · Gravity basket.** *Built — see `concepts/gravity-basket/`.* A force
simulation over the selection: bonded pairs pull, everything else repels, and the
settled clumps are the distinct bets. 24 names → 7 bets at ρ 0.60, four of them
standing alone.

**19 · Empty ground.** Your holdings lit on the territories map, and the question
inverted: not "is this crowded" but *"which territories do you have no exposure
to at all"*. Falls straight out of concept 2 once selection is wired in.

**20 · The seam wall.** Small multiples of every group's internal disagreement —
one tile per group showing its weakest internal pair. Finds the groups that are
about to stop being groups.

---

## What the field is actually saying

Three of the five built concepts turned out to be about **the same blind spot**:
the product ranks names, and almost nothing on any screen describes the market
those names sit in. The spectrogram, the territories map and the broadsheet all
independently surfaced the same fact from different directions — that the large,
crowded, coherent regions of this market are nowhere near the top of the list,
and the list has no way to say so.

That is a more interesting result than any single drawing.

The second thing: **removing the market factor changed a picture from noise to
structure.** It is a one-line change in a build script and it is the difference
between the spectrogram working and not working. Whatever else is built, the
residual view is worth having.
