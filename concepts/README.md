# Concept library

Portable design records. **Each packet is written to survive this branch.**

The lab (`lab/`, `lab/field/`) is a snapshot of what the product looked like when
an idea was drawn. Main moves on; old prototypes are allowed to go stale. These
packets are the part that is meant to last, so each one carries enough to
recreate the idea against whatever version of the product exists at the time —
without reading the prototype's source, and without the branch being mergeable.

## What is in a packet

Every `packet.md` has the same seven sections, in the same order:

| section | what it answers |
|---|---|
| **Concept** | the name, and the one-line claim |
| **What the user sees** | the drawing, described well enough to redraw it |
| **What it communicates** | which questions it answers that the current screens do not |
| **Prototype** | screenshot, plus where the running version was |
| **Interaction and motion** | the behaviour that does not survive a screenshot |
| **Data required** | what the product had at the time, and what it did not |
| **Why it is worth preserving** | the argument, and the honest counter-argument |

Plus a short **Provenance** line: which snapshot it was drawn against, and which
commit of main the product was at. That is how a future reader knows how much of
the packet to trust.

## The library

| packet | the question it answers |
|---|---|
| [`territories/`](territories/packet.md) | understand the universe |
| [`gravity-basket/`](gravity-basket/packet.md) | understand selected names and duplicate bets |
| [`horizon-comb/`](horizon-comb/packet.md) | understand one ranked name across momentum horizons |
| [`rank-river/`](rank-river/packet.md) | understand rank movement through time — **graduated, PR #6** |
| [`threshold-dial/`](threshold-dial/packet.md) | understand the robustness of correlation groups |

Concepts explored but not packeted are listed in `visual-concept-field.md`, which
is the wider field the five were chosen from. A concept gets a packet when it is
worth being able to rebuild in a year; the rest stay as sketches on purpose.

## Graduating a concept

A packet is a design reference, **not** a change to merge.

1. Start from the latest `main`, not from this branch.
2. Re-read the packet against the current product — the *What it communicates*
   and *Data required* sections are the parts most likely to have gone stale.
3. Adapt. If main has changed the underlying figure, the drawing may need to
   change with it; the packet records intent, not a specification.
4. Open a fresh implementation plan and branch for that one concept.
5. Bring over only what still helps. The prototype's code is a sketch, not a
   starting commit, and most of it should not survive contact with production.

Nothing in this directory is a proposal. Two concepts have been proposed
separately, in `visual-concepts-plan.md`.
