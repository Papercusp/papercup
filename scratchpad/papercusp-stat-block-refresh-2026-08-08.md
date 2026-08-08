# Papercusp stat block — reconciled, refreshed, and now reproducible

*Measured 8 August 2026. Supersedes the late-July figures in the deck.*
*Everything below is now emitted by **`npm run stats:proof`** — run it rather than
trusting this file, which is a snapshot and will go stale.*

---

## 1. The one figure to fix before anyone checks it

**Slide 11 says `113,527 — COORDINATION EVENTS / ALL TIME`. Re-measured today: 108,086.**

`harness_shared.coord_event_log` is retention-swept, so a cumulative count over it
goes **down** over time. Confirmed at the source, not inferred: three separate GCs
sweep that table on **four different horizons** — notify 3 days, federated messages
7, escalations 14, operator messages 30 (`agent-tools/coordination/{notify,
message-log,escalation-log}-gc.ts`).

So the tile is worse than mislabelled. A single total across four sweep horizons
isn't a badly-named quantity — it isn't a coherent quantity at all.

Why this one matters more than its size: the deck promises every figure is
*"reproducible on request."* An engineer who takes you up on it gets a **smaller**
number than the slide, under a label ("all time") implying it can only grow. The two
readings available to them are "he inflated it" or "he doesn't understand his own
instrumentation." The truth is neither.

**Replace it with a floor:**

> `≥ 25,752 — COORDINATION EVENTS / LAST 7 DAYS`

A floor cannot be contradicted downward by any later re-measurement, which is exactly
the failure being designed out. The `≥` is load-bearing and honest: a 7-day window
over a table whose shortest sweep is 3 days genuinely omits already-swept rows, so
the true figure is higher than stated.

---

## 2. Correction to what I told you last turn: my own basis was wrong

I reported 2.41M lines / 11,495 files. **That undercounts, and so did every earlier
measurement in this thread — including the reconciliation I gave you.**

`git ls-files` lists a submodule as a *single gitlink entry* and silently omits every
file inside it. This repo has **39 submodules**, holding all of `libs/generic/*` and
all of `libs/papercusp/*` — a large share of the codebase. Measuring without
`--recurse-submodules` also reported **0 migrations** and **0 blueprints**, because
both live in submodules. That is the failure mode worth internalising: not a wrong
number, but a *confident* wrong number, with no symptom.

| Basis | Files | Lines |
| --- | --- | --- |
| Superproject only (plain `git ls-files` — what the earlier 2.37M measured) | 11,502 | 2,407,965 |
| **Superproject + all 39 submodules, excl. retired + vendored** ← publish this | **12,731** | **2,663,000** |

Both are honestly measured; the second is the true total of authored code. The
difference is a **corrected denominator, not growth** — and the script now prints
that sentence in its own basis footnote, so the correction travels with the number
and can't be misread as a sudden jump.

---

## 3. The refreshed block

| Metric | Deck (late July) | Now (8 Aug) |
| --- | --- | --- |
| Lines TS/TSX | 2.37M / 12,099 files | **2.66M / 12,731 files** |
| Lines of tests | 993K / 5,349 files | **1.23M / 6,170 files** |
| Test-to-source ratio | 0.72:1 | **0.86:1** |
| Lines Rust | — | **70,968** |
| Agent tool calls / 7d | 482,645 | **579,886** |
| Distinct agents / 7d | *(not published)* | **233** |
| Work items | 29,005 | **33,803** |
| Work items driven to done | *(not published)* | **15,554** |
| Coordination events | 113,527 "all time" | **≥ 25,752 / 7d** |
| Schema migrations | 572 | **630** |
| Tools / groups | 691 / 139 | 691 / 139 |
| Blueprints | 48 | 48 |
| Elapsed | "sixteen weeks" | **17 weeks (123 days)** |

**On the ratio:** 0.86:1 is the full-tree figure. On the deck's original
superproject-only basis it is **0.90:1**, up from 0.72:1 — so the *trend* is real and
strong, but state which basis you're trending on. Mixing them is how a genuine
improvement ends up looking like a moved goalpost.

**On elapsed time:** it is **17** whole weeks, not sixteen (deck) and not eighteen
(what I told you last turn — I was also wrong). 6 April → 8 August is 123 days. The
script derives this from the root commit so it can never be stale again; prefer
"since 6 April 2026" in copy.

**On the date itself:** the root commit is `2026-04-06T21:58:03-04:00` — late evening
local, already 7 April in UTC. **Your deck's "6 April" is correct**; a naive UTC
render says 7 April. The script pins the author-local date, and there's a regression
test for it.

---

## 4. Three figures you have and aren't using

**233 distinct agents in the last 7 days** — the best unused stat you own. Slide 11
currently proves *volume*, and 580K calls could in principle be one agent in a loop.
233 distinct identities on one codebase cannot be anything except the coordination
claim being true. Swap it in for the coordination-event tile: same real estate,
upgrades the slide from a volume claim to a concurrency claim, which is what the whole
deck argues.

**15,554 work items driven to a terminal state** — throughput, not accumulation.
Answers the obvious skeptical question about whether a 33.8K-item ledger means work
shipped or backlog piled up.

**~82,800 tool calls per day, sustained** — the same figure as 579,886/7d, but a daily
rate lands harder in conversation and survives the reader forgetting your window.

---

## 5. Recommended slide 11

```
2.66 M          1.23 M          0.86:1
LINES TS/TSX    LINES OF TESTS  TEST-TO-SOURCE RATIO
12,731 FILES    6,170 TEST FILES

579,886         233             33,803
AGENT TOOL      DISTINCT AGENTS WORK ITEMS
CALLS / 7 DAYS  / 7 DAYS        15,554 DONE
```

Footnote: *Measured 8 August 2026 by `npm run stats:proof`. Lines are git-tracked
TypeScript across the superproject and all 39 submodules, excluding retired and
vendored code. Rates are trailing seven-day. Reproducible on request.*

---

## 6. `npm run stats:proof` — the promise now has an artifact

**WI-35490, landed.** One command prints the block above with its basis footnote,
measured live from `git ls-files --recurse-submodules` and read-only SQL.
`--json` emits the same data for a slide generator.

The point is not convenience — it's that **the class of error that produced the bad
tile is now unrepresentable**:

1. **There is no `all-time` variant in the type.** A cumulative ledger total cannot
   be constructed, so it cannot be rendered. Type-level, not a lint.
2. **A total over a swept table is refused at runtime**, and the refusal names the
   remedy. That is the exact shape of the published error, and it fails the *command*
   rather than reaching a slide.
3. **A window wider than the shortest sweep horizon renders as a floor** (`≥ N`) —
   automatically, from horizons *imported from the GC modules that enforce them*. If
   anyone retunes retention, the output follows instead of quietly going stale.

20 unit tests, the load-bearing one being `refuses the exact shape of the published
error`. Delete the guard and that test fails.

Also fixed at the source: `NOTIFY_GC_RETENTION_DAYS` was a bare default parameter with
no exported constant, so any external reader had to hardcode `3` and drift. It's now
exported, with a comment explaining why callers outside the GC need it.

**Deferred, deliberately:** a persisted baseline that flags any figure decreasing
between runs. It would have *detected* the original error, but the guard above
*prevents* it, and prevention makes the detector redundant for this class. Not worth
the state file.

---

## 7. What I'd still change in the deck

- Slide 11: swap the coordination-event tile for **233 distinct agents**; refresh the
  rest from §5.
- Slide 11: "sixteen weeks" → "since 6 April 2026".
- Slide 12 footnote: keep "reproducible on request" — it's now true, so name the
  command. *"Reproducible on request: `npm run stats:proof`."* Being able to run it in
  front of someone is worth more than any single number on the slide.
