---
title: DBOS orchestrator durability — Phase 3 integration (P-015→P-017)
slug: dbos-orchestrator-durability-2026-05-31
status: draft
created: 2026-05-31
updated: 2026-05-31
owner: avi@storewolf.com
---

# DBOS orchestrator durability — Phase 3 integration (P-015→P-017)

## Now

**State:** Sub-plan of `dbos-durable-jobs-2026-05-31` (Phase 3, gate-approved D-012). The first piece of
P-015 **landed**: `invoke()` now takes an opt-in `idempotencyKey` (→ deterministic `harness_run_output` run_id)
and **checks-before-spawn**, returning a prior completed run instead of re-spawning the agent (submodule
`c4c897a`, superproject pointer `c798261e`; 50 invoke+run-output tests green; opt-in, so every current caller
is unchanged). This sub-plan scopes the careful, higher-risk remainder — everything here edits the **live
agent-running core in the `libs/papercusp` submodule** (commit on submodule main + bump the superproject
pointer; **no push**).

**Next:** the dedicated idempotent-hit unit test (P-001), then the in-flight-run policy (P-003 — the deepest
semantic) before wrapping the pipeline as a durable workflow.

## Background

The parent plan's P-014 spike (D-019) proved a **dynamic** (LLM-dispatch loop) durable workflow resumes
mid-pipeline without re-running completed roles — and surfaced the crux: an **interrupted** step re-executes
fully, so wrapping `invoke()` means a crash mid-agent-run **re-spawns** that agent. Hence idempotency is the
prerequisite. The integration map (D-019) fixed the boundary: wrap **`invoke()`** as the step (not the raw
loop, which has mid-iteration non-determinism), keep `dispatchDecision()` deterministic, and move the
non-deterministic bits (`Date.now()`/`makeRunId`, `randomUUID()` spawn IDs, the distributed-claim fetch,
mutable PG reads) into checkpointed steps.

Parent decisions this inherits: **D-008** (pin `DBOS__APPVERSION` + a `patched()`-style versioning discipline —
the true cost of Tier B), **D-005** (idempotency at step boundaries), **D-012** (route the orchestrator through
DBOS — approved), **D-004** (DBOS wraps execution, does NOT replace the LLM's dynamic routing).

## Decisions

### D-001 — `invoke()` is the DBOS step boundary; the dispatch stays deterministic control flow
Date: 2026-05-31
Wrap `invoke()` (one agent run) as the durable step. The pipeline workflow runs `dispatchDecision()` around it
— deterministic given the invoke outcome + a per-iteration snapshot. Do **not** make the raw main loop the
workflow body (its mid-iteration network calls + mutable reads break replay). From the D-019 map.

### D-002 — Idempotency key = `harness:feature:role:attempt`
Date: 2026-05-31
The DBOS wrapper supplies `idempotencyKey`; `invoke()` uses it as the `run_id` and short-circuits to a prior
completed run (landed). The key is stable across a DBOS replay (no timestamp/UUID), so a re-run of a COMPLETED
invoke returns the recorded result. `attempt` is the feature's attempt counter at dispatch, so different
attempts don't collide.

### D-003 — Interrupted-run policy is the hard semantic (needs-human)
Date: 2026-05-31
`harness_run_output` is written at run END, so an **interrupted** run leaves no row → the current check
re-spawns on resume. That's correct-ish (the agent re-runs), but agent runs aren't naturally idempotent (git
commits, child spawns), so a re-spawn can double-work. Options: (a) re-spawn fresh and rely on the agent
re-reading git state (default; flag the double-commit risk); (b) write a `started` marker at spawn so an
interrupted run is detectable, then reuse-partial or resume-agent. **This is the riskiest decision** and gates
P-016 — settle it before wrapping the pipeline.

### D-004 — Move all non-determinism into checkpointed steps
Date: 2026-05-31
For replay to be deterministic, derive `makeRunId` + `spawnId` from the idempotency key when set, and move the
distributed-claim fetch (`distributed-claim-fetch.ts`), plan-context fetch, and mutable feature-status reads
into DBOS steps so their outcomes are checkpointed, not re-fetched on replay.

### D-005 — Pin the app version + adopt a `patched()` discipline
Date: 2026-05-31
Per parent D-008: pin `DBOS__APPVERSION` so in-flight pipelines recover across app updates, and adopt a
`patched()`-style strategy for any incompatible change to the pipeline step shape (reorder/rename). Every such
change owes a patch — a permanent maintenance tax that is the real cost of Tier B.

### D-006 — Flag-gated; the legacy main loop stays the A/B fallback
Date: 2026-05-31
`PAPERCUSP_DBOS_ORCHESTRATOR=1` gates the durable pipeline; the legacy main loop remains the default + instant
revert (mirrors parent D-011). Validate live before flipping the default; never delete the legacy path until
validated in production.

### D-007 — DBOS workflow status becomes the run-state truth
Date: 2026-05-31
The in-memory lane pool (`lanes.ts` / `lanes.json`) cannot survive a restart while a DBOS workflow does, so
"is this pipeline running" moves to the workflow status. `harness_lanes` + `spawned_agents` + the
`harness-status-sweep` reaper + the distributed claim all reconcile to the workflow (the workflow ID can be the
claim token). Parallel-lane handling (N workers/feature) is redesigned (child workflows or a concurrency
queue), preserving the `lanes.json` UI surface.

## Phase A — invoke() idempotency hardening (finish P-015)

- **P-001** `todo` Dedicated idempotent-hit unit test: mock `ctx.pg`'s `readRunOutputPg` to return a
  pre-seeded row; assert `invoke(role, extras, { idempotencyKey })` returns the prior result **and does not
  spawn**. (The landed commit leaned on the 50 existing invoke+run-output tests + type-soundness; this proves
  the new path directly.)
- **P-002** `todo` Determinism (D-004): when `idempotencyKey` is set, derive `makeRunId` + the `randomUUID`
  `spawnId` deterministically from it, so a DBOS replay produces identical IDs (no divergent run rows / MCP
  URLs).
- **P-003** `needs-human` In-flight-run policy (D-003 — the deepest semantic): write a `started` marker at
  spawn so an interrupted run is detectable; decide reuse-partial vs re-spawn-fresh vs resume-agent. Default
  re-spawn-fresh (agent re-reads git state) — confirm the double-commit risk is acceptable. **Gates P-004.**

## Phase B — wrap the pipeline as a durable workflow (P-016)

- **P-004** `todo` `featurePipeline` DBOS workflow: one workflow per feature running the dispatch loop, calling
  `invoke()` with `idempotencyKey = harness:feature:role:attempt` as the step; `dispatchDecision()` stays the
  deterministic state machine. blocked-by: P-003
- **P-005** `todo` Move the non-deterministic mid-loop reads (distributed-claim fetch, plan-context fetch,
  feature-status reads) into checkpointed steps (D-004) so replay is deterministic. blocked-by: P-004
- **P-006** `todo` Versioning discipline (D-005): pin `DBOS__APPVERSION`; document the `patched()` strategy for
  incompatible pipeline-shape changes; a test that an in-flight pipeline resumes across a benign code change.
  blocked-by: P-004
- **P-007** `todo` Flag-gate `PAPERCUSP_DBOS_ORCHESTRATOR=1` (D-006); the legacy main loop stays the default +
  A/B fallback. blocked-by: P-004

## Phase C — reconcile run-state (P-017)

- **P-008** `todo` DBOS workflow status = "is the pipeline running"; reconcile the `harness_lanes` +
  `spawned_agents` writes (invoke already writes them) so there's no double-ownership. blocked-by: P-004
- **P-009** `needs-human` Lane-pool redesign (D-007): the in-memory `lanes.ts` / `lanes.json` can't survive a
  restart — decide how N-workers-per-feature maps to DBOS (child workflows vs a concurrency queue), preserving
  the `lanes.json` UI surface. blocked-by: P-004
- **P-010** `todo` Reconcile the `harness-status-sweep` reaper: DBOS owns liveness; the PID-liveness sweep of
  `agent_runs.running` / `harness_lanes` must not fight the workflow. blocked-by: P-008
- **P-011** `todo` Distributed claim ↔ DBOS workflow ID: the workflow ID becomes the claim token; reconcile
  `/api/harness/<slug>/claim-feature`. blocked-by: P-008

## Phase D — live validation

- **P-012** `todo` End-to-end durable-pipeline spike in a dev harness with the REAL `invoke()`: run one
  feature's pipeline under DBOS, quit mid-`worker`, confirm resume at `worker` without re-running
  `scoper`/`architect`, plus cross-version (the gate5 isolated proof, now against real agent runs).
  blocked-by: P-004
- **P-013** `todo` Idempotency under real agent runs: force a mid-`invoke` crash and confirm no double-spawn +
  no double-commit. blocked-by: P-003

## Risks

- **Interrupted-run double-execution (P-003)** — the hardest. Agent runs aren't naturally idempotent (git
  commits, child spawns); a wrong reuse-vs-respawn choice double-runs agents on the live product.
- **Determinism (P-005)** — any missed non-deterministic mid-loop read breaks replay subtly; failures are
  silent (wrong checkpoint reattachment).
- **Lane-pool redesign (P-009)** — parallel lanes are in-memory today; DBOS changes the model, and the
  `lanes.json` UI surface must be preserved.
- **Submodule pin contention** — the `libs/papercusp` pin is actively managed by other plans; coordinate
  (commit on submodule main + bump pointer, no push).
- **Versioning-discipline tax (P-006)** — every incompatible pipeline change owes a `patched()` migration,
  forever. The permanent cost of Tier B (accepted in parent D-012).
- **Blast radius** — every item here touches the live `invoke()` / orchestrator. Keep each behind the
  `PAPERCUSP_DBOS_ORCHESTRATOR` flag (D-006) with the legacy main loop as the instant-revert fallback, and
  validate live before flipping any default.
