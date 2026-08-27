# Reading pipeline state — position vs health vs nextAction (\"is my change live?\")
URL: /internal/docs/agent-insights/reading-pipeline-state-position-health-nextaction

dev:pipeline_position answers position, health, and nextAction; this guide also explains candidate identity, what the gate-candidate cell returns and its source.authoritative provenance, sweep exposure, and the path-scoped state-plane handle that links release:trace target.sha back to the gate candidate cell.

import { Aside } from '@astrojs/starlight/components';

## The one call

```
dev:pipeline_position { path: "packages/operator-core/lib/x.ts" }
```

Read `summary` first — it now LEADS with the answer, not with a row of ticks:

```
BLOCKED AT COMMITTED → git-sync:run (commit the working tree — the gate cannot see it)
  — ⚠ this sweeps ALL 3 dirty paths in the tree, not just yours; only fire it once the
  set is complete. packages/…/release-trace.test.ts @c3b961f32: committed ✓ · staging ✓
  · main ✓ · deployed ✓ (live — the serving process started after this code landed)
  ⚠ +uncommitted edits — SWEEP-EXPOSED: the next git-sync tick (~3 min) commits all 3
  dirty paths as ONE auto-commit, and the gate can cut its candidate there and judge
  that intermediate.
```

Everything after the lead clause is supporting evidence. If you only read one field,
read `nextAction`.

## The three dimensions, and why conflating them is the whole bug class

### 1. POSITION — where the change SITS

`positions.{committedLocal,onStaging,inMain,deployed}`, and per-stage
`stages[].position` (`past` | `pending` | `na`).

A position is a boolean, and a boolean cannot distinguish **"not yet, wait"** from
**"this leg is dead, waiting is futile."** That single missing dimension is behind most
filed pipeline confusion in this repo.

A path whose runtime does not go through the release pipeline (bg-host, gateway,
embed-sidecar) is never carried by staging→main→:3070 **at all**. Its gate/main/deployed
stages are `na`, not `pending` — reporting them as pending told an agent to wait for
something that could never happen to its file (EI-11120 cost a real deploy-and-wait
cycle to exactly that misreading).

### 2. HEALTH — whether the stage is MOVING

`stages[].health`: `advancing` | `stalled` | `disabled` | `broken` | `unknown`.

This is the dimension positions cannot express, and reading position without it is how
these got filed:

| what the position said  | what health would have said                                     | what it cost                                       |
| ----------------------- | --------------------------------------------------------------- | -------------------------------------------------- |
| `staging ✗` — "not yet" | push leg **broken**: git-sync faulting, origin frozen           | 2h52m freeze, 19 stranded commits, read as latency |
| `deployed ✓` — "live"   | serving **stalled**: the process started before the code landed | filed 4× independently as separate bugs            |
| `main ✗`, gate 0 reds   | gate **wedged** — not firing at all                             | an invisible \~2h stall reading as fully healthy   |

`gitSync` splits the two legs that `lastStatus` collapses: **`status: 'synced'` is
reachable with nothing pushed.** Read `gitSync.pushedRepos` — empty with status
`synced` is the trap.

### 3. NEXTACTION — the single lever

`blockedOn: StageName | null` + `nextAction: string | null`, derived from the stage
table by `deriveBlocker`. Three states that must never collapse into each other:

| `blockedOn` | `nextAction` | meaning                                                                      |
| ----------- | ------------ | ---------------------------------------------------------------------------- |
| `null`      | `null`       | it is live — nothing pending                                                 |
| set         | `null`       | blocked, and **waiting is genuinely correct** — this leg advances on its own |
| set         | set          | do this one thing                                                            |

`null` means "there is nothing to do but wait" — a positive verdict. It is deliberately
distinct from a missing field, because the failure this surface exists to prevent is an
agent inventing a lever (firing a run, escalating to `replaceStale`) when waiting was
right. The gate is a singleton: a second fire is *refused*, and the natural escalation
from a refusal is the replace-storm that starved the gate of every verdict for 2h
(EI-11667).

`blockedOn` says where the change **sits**; the action may belong to a LATER stage. When
they differ the summary says both — *"AT PUSHED (advancing on its own) — but GATE IS
BLOCKED → …"*. A self-advancing early leg must never mask an actionable stage behind it
(that produced a false all-clear while a red gate held `main` for the whole fleet).

## Two questions that come BEFORE "where is my change"

### `changeInCandidate` — is the judged commit even your code?

Before reading a gate verdict as a verdict *on your change*, check whether the commit
being judged contains your file's content:

* `judgingSha` / `judgingContainsPath` — the run **in flight**, i.e. the verdict about to land.
* `nextCandidateSha` / `nextContainsPath` — what a `release:checkpoint-run` fired **right
  now** would judge (post quiet-cut). Check this *before* firing.

Every verdict is three-valued: an unresolvable read is `null` (unknown), never `false`
and never a silent `true`. **A red from a run that does not carry your change is not
evidence your change failed.**

### What the candidate cell returns — and the one field to read FIRST

`state:read { cell: 'gate.greenCheckpoint.candidate', as: '<your repo-relative path>' }`
answers step 0 (*which sha is the run judging*) and step 1 (*is it judging MY change*) in
ONE call, before you write any SQL. It returns:

* **`changeInCandidate.judgingSha`** — the judged sha, marker-preferred since WI-36259.
* **`source.authoritative`** — ⚠ **check this before acting on the sha.** `'retriage-marker'`
  is authoritative: it is the run's OWN published `inFlightRetriage` marker, an *observation*
  of what it is judging. `'run-probe'` is NOT: on a MANUAL run it reads that run's `/tmp` unit
  log, but on a CRON run it degrades to the checkpoint checkout's live HEAD — an *inference*
  that changes between two reads. A non-authoritative reading is also hoisted into the reply's
  `summary`, so you cannot miss it. **Do not fire a manual re-run off an inferred candidate.**
* **`changeInCandidate.judgingContainsPath`** — the containment falsifier (*is the gate judging
  MY change*), with its own prose attached.
* **`verdictUnknown`** — a hoist naming anything the cell could NOT determine.
* **`resolver`** — what produced them.

The cells and the doors read the SAME resolver (`gitPipelinePosition()`), so this is a re-read
of the authority, never a second source of truth.

**Everything else — the marker SQL, the log greps, the ancestry and blob archaeology — is the
FALLBACK.** Reach for it when the cell answers `unknown`, when `source.authoritative` is false
and the distinction matters, or when you need a field the cell does not carry (the refire
budget, a run's failing-file set). Raw `harness_shared.routines` SQL is the LAST resort.

## Follow the candidate cell to the exact release trace

The candidate cell is also discoverable from the composite release read. `gate.greenCheckpoint.candidate` declares a `doorProjections` mapping for `release:trace` at `target.sha`, so a trace result carries a state-plane handle back to the same path-scoped cell:

```jsonc
{
  "target": { "sha": "..." },
  "plane": {
    "cells": [{
      "path": "target.sha",
      "cell": "gate.greenCheckpoint.candidate",
      "reread": {
        "tool": "state:read",
        "args": {
          "cell": "gate.greenCheckpoint.candidate",
          "as": "packages/operator-core/lib/agent-tools/release/trace.ts"
        }
      }
    }]
  }
}
```

Use the `reread` handle when the candidate SHA is about to drive a decision. `as` preserves the path subject from the original `release:trace { path: ... }` call; do not drop it or substitute an unqualified `state:read`, because this cell is caller-relative and an unqualified read can answer a different path. The handle re-reads the volatile value; it is not a second copy of `target.sha`.

This closes the lookup loop:

1. `state:read { cell: "gate.greenCheckpoint.candidate", as: "<path>" }` answers which candidate the gate is judging and whether it contains the path.
2. `release:trace { path: "<path>" }` composes candidate, gate, deploy, await, and stale-wake evidence.
3. `plane.cells[].reread` on that trace points back to the same cell when the candidate must be rechecked before acting.

If the payload does not include `target.sha`, or the caller did not provide the path subject, no misleading handle is emitted. Treat that absence as an inability to build a path-scoped re-read, not as evidence that the candidate is absent.

### `sweepExposure` — what the next tick will commit out of your tree

You do not commit here; git-sync does, on a fixed interval, sweeping whatever is on disk
into one `chore(git-sync): auto-commit`. So a multi-file change has a window in which a
partial, often non-compiling intermediate becomes a real commit — and the gate can cut
its candidate inside it. That produced 29 failures against a 14:09 candidate for work
whose dependent fix landed at 14:36; every one was already green at tip, and a peer
spent a wake triaging code that was never broken (EI-18735166063643844).

```jsonc
"sweepExposure": {
  "exposed": true,
  "dirtyPathCount": 3,          // the BLAST RADIUS — git-sync commits the whole tree
  "dirtyPathSample": ["…"],
  "nextSweepInMs": 163095,      // when the commit actually happens
  "detail": "⚠ SWEEP-EXPOSED: …"
}
```

Note what it does **not** carry: a lever. Nothing you can call makes the commit atomic.
Either finish the set before the tick, or read a red landing in that window against the
candidate sha before believing it.

The `committed` stage's lever is still `git-sync:run` — but it commits *every* dirty path
in the tree, including other agents' in-flight edits, not just yours. When the sweep would
take more than your file the lever says so and tells you to fire it only once your set is
complete. Firing it mid-refactor is committing the broken intermediate **on purpose**.

## Practical routing

| you want to know                                          | read                                                                     |
| --------------------------------------------------------- | ------------------------------------------------------------------------ |
| is my change live, and if not what is the ONE thing to do | `summary` lead clause, or `blockedOn` + `nextAction`                     |
| is this leg stuck or just slow                            | `stages[].health` (never a position boolean alone)                       |
| did my work actually reach origin                         | `gitSync.pushedRepos` (not `status`)                                     |
| is the running process actually executing my code         | `serving.startedSinceCodeChange` (a git `deployed ✓` cannot answer this) |
| is the gate judging my code                               | `changeInCandidate.judgingContainsPath`                                  |
| will the next tick commit my half-finished refactor       | `sweepExposure`                                                          |

## Anti-patterns

* **Do not** hand-diff shas, `merge-base`, and `git log` to answer "is my edit live" —
  that is the 11-tool-call path this surface replaced, and it went wrong twice on the day
  it was measured.
* **Do not** read `deployed ✓` as "live". It is a git fact stating a process conclusion.
* **Do not** treat a `null` `nextAction` as "the tool didn't know".
* **Do not** poll for git-sync to push. If your next step genuinely needs the code live on
  `:3070`, force the deploy (see the repo `CLAUDE.md` § commit discipline); otherwise keep
  working.
