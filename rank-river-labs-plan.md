# Rank River, and a Labs area to put it in

**Status: proposal. Nothing here is built.** Assessment first, then the smallest
reversible version if it is wanted.

## Context

Rank River is one of five concepts in the design library on PR #5. It draws the
top 20 names as thin trails across recent sessions, converging on today's
ranking at the right edge, so you can see whether the leaders arrived last week
or have been there all along — the one question the product cannot answer at
all today.

Its own packet is the most sceptical document in that library:

> **The honest counter-argument:** it is the only concept here that cannot be
> built at all today, and the storage it needs is something the product removed
> on purpose. It should stay a sketch until someone wants the history for a
> second reason.

That verdict rests on one assumption, and the assumption is wrong. This plan
exists because checking it changed the answer.

---

## The finding

**Cali keeps no rank history.** Confirmed: four commits have ever touched
`web/data/snapshot.json`, all dated 2026-08-30, all carrying the same `asOf`.
The dated archive was deliberately dropped in the ranker reshape at 387 KB/day
for no consumer. There is no history to recover and nothing accumulating.

**But history does not have to be accumulated. It can be derived.** The
pipeline already fetches 540 calendar days per name — 371 trading sessions.
Recomputing the ranking as of 30 sessions ago needs 281 of them. There are
**89 sessions of headroom**, already fetched, already aligned, already in
memory during every run.

So the choice is not "store rank history from now on and wait six weeks". It is
"recompute the ranking 30 times at the end of a run, from data we already have".
That is a materially different proposition:

| | accumulate forward | **derive per run** |
|---|---|---|
| Usable | in ~6 weeks | immediately |
| Repo state | grows every day, forever | none — overwritten each run |
| If it is wrong | wrong history is now permanent | fixed on the next run |
| Removal | leaves an archive behind | delete one file |
| New API calls | none | none |

The packet costed the wrong thing, because when it was written the only path it
could see was storage. It priced 20–120 sessions of *stored* history at 23–141 KB
for ~600 names. Derived, v1 is ~8 KB gzipped and stores nothing.

---

## Does the drawing actually work?

The packet's prototype ran on invented data and flagged that plainly. The open
question it left was whether a braid is legible at all, and its authors could
not test the `>100` clamp because they had no real ranks.

Backfilled 30 sessions of real ranks from committed data (6−1 view, the horizon
the charted span supports locally) for all 2,572 names:

| | |
|---|---|
| Trails inside the top 100 for most of the window | **16 of 20** |
| Trails outside the top 100 for the entire window | **0 of 20** |
| Mean day-over-day movement | 17.7 places |
| The two stories | NSP #1987 → #15, FBRX #2501 → #17 |

So the clamp works as intended: a mostly-stable braid with two or three
arrivals sweeping up from the floor. It is not a row of trails pinned to the
bottom edge, which was the plausible failure and the reason to check.

One caveat carried forward honestly: these figures are from the 6−1 view,
because the committed chart series holds 253 sessions and a 30-session 12−1
backfill needs 281. The 12−1 numbers get measured during implementation, inside
the run where the full history exists. If 12−1 turns out to be mud, that is a
finding and the feature stops there.

---

## Assessment

**Does Rank River belong in the product?** Not in core. It is an analytical
picture rather than a ranking tool, it only works at twenty names, and core is
deliberately "a few steps above a nice spreadsheet". **Yes as a Labs
experiment**, where it can be judged in use without any of it becoming load
bearing.

**Is a Labs area appropriate?** Yes, at minimal cost — one route branch, one
lazily imported view, one sidecar file. Not a bottom tab: a small secondary
link in the list footer, which is what signals "optional and experimental"
without spending primary navigation on it.

**Is the sidecar safe?** In the derived form, yes. It is regenerated every run,
so it adds no growing state; core never reads it; and if it is missing or
malformed Labs says so and every other screen is unaffected.

---

## Architecture

The rule, in one line: **experiments may depend on stable Cali; stable Cali may
never depend on experiments.** A test asserts the second half rather than
trusting it.

```
src/pipeline/rankHistory.ts     new — backfills ranks, emits the sidecar
web/data/labs/rank-history.json new — the sidecar, ~8 KB gzipped
web/views/labs/index.js         new — the Labs menu
web/views/labs/rankRiver.js     new — the drawing
web/app.js                      +1 route branch, lazily imported
web/views/list.js               +1 footer link
web/styles.css                  Labs styles, scoped under .labs
```

Isolation properties, each one testable:

- **Core imports nothing from `views/labs/`.** Asserted by a test that greps
  the core modules, so the boundary cannot rot silently.
- **The sidecar is fetched only on the Labs route.** The existing request-count
  checks in `verify:ui` already assert the home screen downloads nothing extra;
  this adds the same assertion for `rank-history.json`.
- **A backfill failure cannot break the daily run.** The pipeline wraps it in a
  try/catch, logs, and writes the snapshot regardless. The snapshot's own
  `dataHash` does not cover the sidecar.
- **Labs degrades to a sentence** when the sidecar is absent — which is also
  what every checkout of an older commit will see.

## The sidecar

Emitted at the end of a run, after the snapshot is built:

1. For each of the 8 views, take the current top 20.
2. For k = 1…29, recompute momentum, volatility, winsorised z-scores and the
   blend as of session L−k, over **today's eligible universe**, and rank.
3. Write each name's 30 ranks, clamped for display at >100 by the browser, not
   in the file — the file keeps the true rank so the clamp can change without
   a pipeline run.

Roughly 4,800 integers plus 160 symbols. ~8 KB gzipped.

**The honest caveat, which the panel must state on screen:** these are ranks
against *today's* eligible universe, not the universe as it stood that day.
Market cap comes from the live screener and only today's is available. This is
"where these names would have ranked, measured the same way, against the same
field" — not "what the screen showed that morning". For trails it is arguably
the better definition, since the alternative has names appearing and vanishing
as the universe churns. It is not, however, the same claim, and the difference
belongs on the screen rather than in this file.

---

## What is deferred, simplified or rejected

**Rejected — the accumulating rank store.** Unnecessary given backfill, and it
would put permanent growing state back into a repo that deliberately removed
its dated archive.

**Rejected — the packet's log rank axis.** It exists to stop #400 consuming
half the frame. With a `>100` clamp there is no #400, so the log axis stops
earning its complexity. Linear 1–100 with a band at the bottom for everything
beyond.

**Deferred** — the scrubber, the "since" control, sector colour, bézier
smoothing, label decluttering, and every analytic the brief already excludes:
no badges, no persistence scores, no embellishment. v1 is thin trails, time
across, rank up, today at the right edge, tap to emphasise.

**Revised** — "use real ranking history" becomes "use real *backfilled*
history, and say so on screen".

---

## Risks

| risk | severity | mitigation |
|---|---|---|
| A second ranking code path disagrees with the shipped one | **high** | k=0 identity check, below |
| Backfilled ranks read as observed ranks | medium | stated on the panel, not only in docs |
| Backfill breaks the daily snapshot run | medium | try/catch; snapshot written regardless |
| 12−1 trails turn out to be mud | medium | measured before the view is built; stop if so |
| Labs becomes load bearing by accident | medium | import-boundary test |
| Run time grows | low | ~30 recomputes on data in memory; measured and reported |
| Repo growth | low | overwritten, not appended |

**The check that retires the top risk.** The backfill at k=0 must reproduce the
live ranking exactly — every name, all 8 views, no tolerance. If a second
implementation of the ranking agrees with the shipped one on the session they
share, the same code at k=1…29 is trustworthy. If it does not, the feature does
not ship and we have found something worth knowing about the ranking itself.

---

## Validation

- **Unit** — k=0 identity against `scoresFor`/`ranksFor` for all 8 views;
  sidecar shape and length; clamping is display-only; a missing sidecar renders
  the empty state.
- **Boundary** — no core module imports from `views/labs/`; the home screen
  issues no request for `rank-history.json`.
- **UI** (`verify:ui`, Chromium at 390×844) — trails render, today is the right
  edge, tapping emphasises one and fades the rest, ranks beyond 100 sit in the
  band, no horizontal scroll, every control ≥44px, and the existing 120 checks
  still pass unchanged.
- **Pipeline** — a full run with the backfill enabled produces a snapshot
  byte-identical to one without it, except `generatedAt` and `dataHash`.
- **Performance** — added run time reported; Labs route measured cold.

## Removal

One revert. Delete `web/views/labs/`, `web/data/labs/`,
`src/pipeline/rankHistory.ts`, the route branch and the footer link. Nothing in
core references any of them, which is the point of the boundary test. The
snapshot is unaffected either way.

## Rollback, in order of severity

1. **The drawing is wrong or unloved** — delete the footer link. One line; Labs
   is then URL-only.
2. **The sidecar is wrong** — delete the file. Labs shows its empty state; core
   untouched.
3. **The backfill is wrong** — revert the pipeline module. The next run writes
   the same snapshot it would have written anyway.
4. **The whole thing goes** — revert the commit.

---

## Order

1. `rankHistory.ts` plus the k=0 identity test. **Stop here if it does not pass.**
2. Measure the 12−1 spread over 30 sessions. **Stop here if it is mud.**
3. Emit the sidecar; assert the snapshot is unchanged.
4. Labs route, lazily imported, plus the boundary test.
5. The drawing.
6. The footer link.
7. Full verification, then a PR.

Steps 1 and 2 are gates, not tasks. Each can end the feature, and ending it
there costs one deleted file.

## Open questions

1. **Is the Labs link visible on the main list at all for v1**, or URL-only
   until the drawing has been used a few times?
2. **Is "ranked against today's universe" an acceptable caveat**, or does the
   feature need true point-in-time universes — which would be a much larger
   change and, in my view, not worth it here?
3. **Which view does Rank River follow** — always the default 12−1, or whatever
   view the list is on? The sidecar carries all 8 either way; this is only a
   question about the control.

## Not doing

Position sizing, forecasts, "momentum persistence" scores, or any claim that a
trail's shape predicts anything. The drawing describes what the ranking did.
It does not suggest what to do about it.
