# What rank history would cost, and why nothing here uses it

> **Superseded by PR #6.** This note costed *accumulating* history and never
> asked how far back a single run already reaches. It reaches 371 aligned
> sessions per name, so a 30-session backfill is **derived from prices already
> fetched** — 15 KB raw, 5.4 KB gzipped, overwritten each run, no growing repo
> state. The table below is left as the record of a question framed the wrong
> way: *"the product threw its history away"* made accumulation look like the
> only route, and it was not the cheapest one available.

A large share of the visual ideas worth having for a ranked list are about
**movement**: rank trails, bump charts, new-entrant badges, persistence dots,
"time in the top 20", churn meters, ghosted yesterday-behind-today, "what
changed since Friday". None of them are prototyped in `lab/`, because none of
them can be built today.

## The product has exactly one snapshot

`.github/workflows/screen.yml` runs `0 23 * * 1-5` and overwrites
`web/data/snapshot.json`. There is no archive — the dated
`web/data/archive/YYYY-MM-DD.json` was dropped in the ranker reshape as 387 KB/day
for no consumer. Git holds three commits touching the snapshot, and all three are
schema changes rather than daily runs, so there is no recoverable history either.

The browser therefore has today, and no yesterday. This is a storage decision,
not a rendering problem, and no amount of design gets around it.

## What the smallest useful version costs

Ranks are small integers. A 64-character alphabet at two characters per day
addresses 4,096 values, which covers a 2,572-name universe with room to spare, so
one name-day is **exactly two bytes**. Raw sizes, computed rather than guessed:

| window | every eligible name | names that touched the top 200 (~600) |
|---|---|---|
| 20 sessions | 100 KB | 23 KB |
| 60 sessions | 301 KB | 70 KB |
| 120 sessions | 603 KB | 141 KB |

For scale, `snapshot.json` is 381 KB raw / 136 KB gzipped today.

**The compressed figures are deliberately absent.** Rank history compresses
according to how much the ranking churns day to day, and that cannot be measured
from a single snapshot. The ranker plan already recorded what happens when
someone estimates this class of number with synthetic data — random content gave
an answer 25× too pessimistic, because random data cannot be delta-compressed —
so putting a made-up gzip figure here would be worse than leaving the column out.
The honest statement is: raw cost is known exactly, compressed cost needs two
weeks of real runs to measure.

## The recommendation

Store **the top-200 union over a rolling 60 sessions**, not the whole universe.
70 KB raw is affordable, and it is also the only part anyone can read: a trail
for a name at #1,900 is noise, and a bump chart of 2,572 lines is a grey
rectangle. Restricting the set is not a compromise forced by size, it is the
same editorial judgement the product already makes when it ranks the universe
and then shows a list.

It needs a pipeline change and two weeks of runs before the first trail can be
drawn, which is why it is a note rather than a proposal. Until that exists, every
movement concept stays out of the lab, and the three prototypes there deliberately
extract movement from the data that **is** present: three nested lookback windows,
which are a time axis the product already ships and does not yet draw.
