---
title: DBOS orchestrator durability — Phase 3 integration (P-015→P-017)
slug: dbos-orchestrator-durability-2026-05-31
status: implemented
created: 2026-05-31
updated: 2026-05-31
owner: avi@storewolf.com
---

# DBOS orchestrator durability — Phase 3 integration (P-015→P-017)

## Now

**State:** Phase 3 integration BUILT + end-to-end VALIDATED against real DBOS (D-014). The three pieces are committed + unit-tested (14 tests): the carve-out filter `durableOwnedFeatureIdsPg`/`readFeaturesPg` (submodule c2e120f → superproject e4209d0, D-012/D-013), the ownership-respecting start-side `decidePipelineStart`/`ensureFeaturePipeline` + `POST /api/admin/dbos/pipeline/start` (commit 7bb0bd48), on top of the prior mechanism (workflow + runner + idempotency, D-011 epoch fix 83d9eeed). gate7 (throwaway isolated `dbos_gate7` DB + stub runner, 9/9) proved against REAL DBOS: ownership (reuse-live / no-double-start), the carve-out SQL (includes live-owned, excludes completed, per-feature scoped), a full director→worker→validator→DONE run to SUCCESS, and epoch progression — with the live operator's `papercusp.dbos` verified untouched (0 workflows). Everything stays flag-gated default-off (`PAPERCUSP_DBOS_ORCHESTRATOR`); the live orchestrator is unchanged until the flag flips. Findings in the agent-insight `dbos-durable-execution-gotchas`.

Then (D-015): the **AUTO-dispatcher** is built (scheduled scan → `ensureFeaturePipeline` for `PAPERCUSP_DBOS_DISPATCH_HARNESSES`, double-gated, 5 tests), the **per-feature director gap** was found + filled (`director.md` — the global orchestrator can't be reused because the carve-out hides the pipeline's own feature), and the director prompt is **real-LLM validated** (pending→NEXT_WORKER, in-progress→NEXT_VALIDATOR, passed→DONE, failed×6→ESCALATE). Phase 3 is now validated **piecewise** end-to-end (gate7 workflow + proven-code runner + director-vs-LLM).

Finally (D-016): the reconciliation items were assessed against the real code and **closed** — P-010 (reaper) is cosmetic (24h cutoff never sweeps a live run; the carve-out owns dispatch; double-spawn is D-003's accepted re-spawn-fresh), and P-011 (claim) is moot-as-framed (the distributed claim is *cross-engineer* coordination, a different axis from the *intra-operator* pipeline ownership the carve-out handles). `buildPrompt`'s feature-scoping was code-confirmed. **Phase 3 is functionally COMPLETE + validated piecewise, flag-gated default-off.**

**Next (all optional / human-owned):** (1) the OPTIONAL gold-standard — one FULL simultaneous real-agent pipeline run on a throwaway repo (a supervised confidence step; every link is already proven separately); (2) production rollout when ready — flip `PAPERCUSP_DBOS_ORCHESTRATOR=1` + opt a harness in via `PAPERCUSP_DBOS_DISPATCH_HARNESSES`, watch `/admin/dbos`; (3) refine `director.md` (solid first cut). Nothing blocks; the live orchestrator is unchanged until the flag flips.

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


### D-008 — Phase A resolved — P-001 done, P-002 moot, P-003 = re-spawn-fresh
Date: 2026-05-31
**P-001 done** — extracted `findPriorRunForIdempotency` (testable helper, primitives only) + 2 unit tests (reconstructs prior result on hit, null on miss); 52 invoke+run-output tests green (submodule `4b7f459`, pointer `f1beecc2`).

**P-002 moot** — determinism *inside* `invoke()` doesn't matter: `invoke()` is wrapped as a DBOS **step**, so only its RESULT is checkpointed; its internal `Date.now()`/`randomUUID()` spawnId don't affect workflow replay. The only invoke-side determinism that matters is `runId = idempotencyKey` (already landed), so the run row is keyed stably. The determinism that DOES matter is in the **workflow body** (the dispatch loop) — that's D-004 / P-005 in Phase B.

**P-003 decided — re-spawn-fresh.** An interrupted run leaves no `harness_run_output` completion row, so on resume `invoke()` re-spawns. The re-spawned agent re-reads **git state**, which already reflects any partial commits from the interrupted run — so **git is the dedup**; no double-commit in practice and no new "started" marker is needed for correctness. (A started-marker for *observability* — surfacing "this is a re-run of an interrupted invoke" — is a possible future refinement, not a blocker.) This unblocks P-004.
Related: P-001, P-002, P-003


### D-009 — Phase 3 core built + verified; live-wiring/validation is the remaining boundary
Date: 2026-05-31
Autonomous build complete for the **verifiable** scope:
- **P-004 done + VERIFIED** — `lib/dbos/orchestrator-workflow.ts` (commit 317c0cb2): the agent pipeline as a DBOS durable workflow (dynamic `parseDecision`-driven dispatch, each agent run a checkpointed step keyed `harness:feature:role:turn`). Proven: crash mid-`worker` → `SUCCESS`, deterministic dispatch intact (step ledger `decide-0 → invoke-worker-0 → decide-1 → invoke-validator-1 → decide-2`), completed step not re-run.
- **P-005 done by construction** — the durable dispatch is a NEW clean loop (NOT wrapping the legacy 800-line main-loop), deterministic (`parseDecision` is pure on checkpointed step outputs); all non-determinism is inside steps. The legacy main-loop's determinism hazards don't apply because we don't wrap it.
- **P-006 partial** — `DBOS__APPVERSION` is pinned (parent D-008); the `patched()` discipline applies when the pipeline step-shape changes (documented); a resume-across-version test rides with live validation.
- **P-007 done** — flag-gated `PAPERCUSP_DBOS_ORCHESTRATOR=1` (bootstrap 01b82f22), legacy main loop is the default + A/B fallback.
- **Idempotency-key path COMPLETE end-to-end** — `invoke()` check-before-spawn (P-015) + `invoke-once` `IDEMPOTENCY_KEY` plumbing (de50c8e0), so the durable pipeline's runner spawns `invoke-once` with the key and a re-run reuses a completed agent run.

**Remaining = live-wiring + validation (needs the live env + REAL agents) + one design fork — where autonomous work responsibly stops:**
- **Real invoke-runner adapter** + **dispatch-routing**: wire `setPipelineInvokeRunner` to spawn `invoke-once` (`PROJECT_DIR`/`ROLE`/`FEATURE_ID`/`IDEMPOTENCY_KEY`/`RESULT_PATH`) and route eligible features to `startFeaturePipeline` instead of the legacy loop. Buildable, but only VALIDATABLE with real agent runs — so build+validate together, not blind.
- **P-009 (needs-human)** — lane-pool redesign (parallel N-workers/feature under DBOS).
- **Phase C (P-008/P-010/P-011)** — reconcile `harness_lanes`/`spawned_agents`/reaper/claim once the live path runs.
- **Phase D (P-012/P-013)** — live validation: a real feature's pipeline under the flag; crash/resume + no double-spawn/double-commit with REAL agents.

I (autonomous) stopped here deliberately: the rest requires **real agent runs** (LLM cost + irreversible git side effects — not run unprompted) and the **P-009 design call**. Everything built is flag-gated default-off; the live orchestrator is untouched.
Related: P-004, P-005, P-006, P-007


### D-010 — Durable-pipeline MECHANISM complete + wired; live-integration (routing/ownership + validation) is the remainder
Date: 2026-05-31
The full durable-pipeline **mechanism** is built, wired, and verified-in-isolation:
- **Workflow** (`orchestrator-workflow.ts`, P-004, 317c0cb2) — verified resume mid-pipeline (crash mid-worker → SUCCESS, deterministic dispatch).
- **Real runner** (`orchestrator-runner.ts`, 03289ce6) — headless copy of the proven `/harness/:slug/invoke` route: `resolveProject(slug)` → `buildInvokeOnce(role, FEATURE_ID, IDEMPOTENCY_KEY)` → spawn → strip log lines. tsc-clean, regex-verified.
- **Idempotency end-to-end** — `invoke()` check-before-spawn (P-001) + `invoke-once` `IDEMPOTENCY_KEY` (de50c8e0).
- **Flag-gated** `PAPERCUSP_DBOS_ORCHESTRATOR`; bootstrap registers the workflow + wires the runner; legacy main loop is the default + fallback.
- **P-009 decided** — sequential-only; parallel `NEXT_WORKER N=k` → legacy (the workflow breaks on `parsed.n != null`), so no lane-pool redesign now.

**Remaining = live-integration (needs the live path against a real harness; not buildable-blind safely):**
- **Routing / feature-ownership (P-016/P-017)** — the deep one: a feature must be worked by EITHER the legacy main loop OR a durable pipeline, never both. A naive "call `startFeaturePipeline`" hook would **double-dispatch**. So the trigger needs the ownership design: the workflow ID as the claim/ownership token, gating the legacy loop off a feature the durable pipeline owns (and vice-versa). This is design + live work, entangled with the distributed claim.
- **Reconciliation (P-008/P-010/P-011)** — `harness_lanes` / `spawned_agents` / the `harness-status-sweep` reaper / the claim, once the live path runs.
- **Live validation (P-012/P-013)** — run a real feature's pipeline under the flag in a dev harness: a **fake agent** (`AGENT_CMD` → a stub emitting structured decisions) validates the full wiring cost-free; a **real agent** validates true behavior. Confirm crash/resume + no double-spawn/double-commit.

The mechanism build is complete. The remainder is the ownership/routing **design** + **live validation** — which I'm not doing blind (a wrong routing hook double-runs agents on the live product) or with unprompted real-agent runs. Everything built is flag-gated default-off; the live orchestrator is untouched.
Related: P-004, P-009


### D-011 — Feature-ownership = main loop delegates to a durable pipeline; the live workflow is the claim; the workflow ID needs an epoch
Date: 2026-05-31
**Problem (P-004/P-008/P-011, the "routing/ownership" the Now flagged):** under `PAPERCUSP_DBOS_ORCHESTRATOR=1` a feature must be worked by EITHER the legacy main loop OR a durable pipeline, never both — double-dispatch = two agents on one feature = duplicate commits.

**Two models considered:**
- **Option A (CHOSEN) — main loop delegates the inner dispatch.** The main loop stays the feature *picker/scheduler* (its battle-tested feature-selection logic is untouched); when it decides feature F needs work, instead of inline `invoke(nextRole)` it calls `startFeaturePipeline({slug, featureId: F, epoch})`. The durable workflow then owns F's whole role-sequence until DONE/UNSUPPORTED. Lowest-risk, cleanest A/B: flip the flag and the loop either inline-dispatches (legacy) or starts-a-pipeline (durable), per feature.
- **Option B (REJECTED for now) — a durable scanner replaces the main loop.** One scheduled DBOS workflow scans for features needing work + starts pipelines; the legacy loop stands down when the flag is on. Conceptually cleaner (all-durable) but it ports the feature-picking logic into a durable scanner = a bigger rewrite + bigger blast radius. Defer; Option A can graduate to it later.

**Claim/ownership mechanism (Option A):** the live DBOS workflow IS the claim. Before the loop starts a pipeline for F it checks `DBOS.retrieveWorkflow(<id>).getStatus()`:
- PENDING/ENQUEUED → the pipeline owns F; the loop SKIPS F (no inline dispatch, no second pipeline).
- SUCCESS/ERROR/absent → no live owner; if F still needs work, `startFeaturePipeline` (the `deduplicationID` collapses a concurrent double-start).

**The wrinkle designing-on-paper surfaced (now FIXED in code, commit 83d9eeed):** the ID `pipeline:<slug>:<feature>` is feature-forever, but DBOS will not re-enqueue a *completed* workflow ID — so a feature-forever ID lets F run exactly ONE pipeline lifetime, ever; after the first SUCCESS, F can never be re-pipelined (reopen, failed-validation retry, a later edit). Fix shipped: `pipeline:<slug>:<feature>:e<epoch>`, epoch = a monotonic per-feature counter the live caller sources from PG. `deduplicationID` still guards concurrent starts *within* an epoch; the epoch enables re-pipelining across lifetimes. `PipelineInput.epoch` (default 0) is in place — P-004's live caller just supplies the real epoch.

**Reconciliation implications (P-008/P-010/P-011):** the pipeline spawns the SAME `invoke-once`, so `harness_lanes`/`spawned_agents` keep being written by the existing invoke path — no new writer, no double-ownership of those rows. P-011's `/claim-feature` becomes "is there a live `pipeline:<slug>:<feature>:e*` workflow?" — the workflow status replaces the ad-hoc claim row. P-010's `harness-status-sweep` reaper must treat a live DBOS workflow as authoritative: it must NOT reap an `agent_runs.running`/lane row whose owning workflow is PENDING, or it kills a legitimately-resuming pipeline. The reaper gains an "owned by a live workflow?" guard.

**Live-only remainder:** wiring this into the actual main-loop dispatch + validating no double-dispatch with fake-then-real agents (P-012/P-013) is the live step; this decision is the design it implements.
Related: P-004, P-008, P-010, P-011


### D-012 — Correcting D-011: the main loop is global one-decision-per-iteration, not per-feature — durable ownership = carving a feature OUT of the global orchestrator, not swapping an inner dispatch
Date: 2026-05-31
Reading the real `main-loop.ts` (libs/papercusp/packages/orchestrator) corrects a glib assumption in D-011. The production loop is NOT structured per-feature: each iteration invokes the **primary/orchestrator role ONCE** (`invoke(ctx, primaryRole, …)`, ~line 569), which sees the whole feature list and emits one decision (or a NEXT_WORKER batch) advancing ONE step across ALL features; `dispatchDecision` runs that single role; repeat. There is **no per-feature inner dispatch to "delegate"** — the loop's unit of work is a single, globally-chosen role invocation.

**Consequence for D-011 Option A:** "the main loop delegates each feature's role-sequence to a durable pipeline" is achievable but is NOT a simple flag-gated branch in `handleNextWorker`. The durable `featurePipeline` runs its OWN director loop for one feature; if the global orchestrator ALSO keeps deciding for that feature, two orchestrators double-dispatch. So durable per-feature ownership requires **carving the owned feature out of the global orchestrator's view**: (1) filter durable-owned features out of `readFeaturesPg` (state-pg.ts — the same seam P-008 noted, where the started-plan/ACTIVE_PLANS filter already lives) so the primary role never emits decisions for them; (2) start/resume the per-feature pipeline, whose director privately decides worker/validator for F; (3) the main loop keeps handling all non-durable features. The workflow-ID-as-claim (D-011) + epoch (commit 83d9eeed) still apply — this just relocates the integration point from "swap the inner dispatch" to "filter the orchestrator's feature set + run a private pipeline."

**The wholesale-durablize alternative (Option C — make `runMainLoop` itself the DBOS workflow, each `invoke()` a step) is BLOCKED by process-local state:** the loop holds an in-memory `LanePool` (`createLanePool`), a singleton `FileLockQueue`, git worktrees, and a cost-cap `process.kill(process.pid, 'SIGSTOP')` auto-pause (~line 681) — none survive a DBOS replay/recovery. Durablizing the whole loop would require lifting all of that into checkpointed steps or external state first; out of scope for Phase 3.

**Net:** Phase 3's durable pipeline is best positioned as a per-feature orchestrator you OPT specific features into (the carve-out model above), not a wrapper around — nor a drop-in replacement for — the existing global loop. Live wiring = the `readFeaturesPg` carve-out filter + the claim check + start/resume, then fake-then-real agent validation. This is genuine architecture work touching the live orchestrator's feature-selection seam, not a mechanical hook — which is exactly why it is the supervised live step, not a blind build.
Related: P-004, P-008


### D-013 — Carve-out ownership read: the orchestrator subprocess queries dbos.workflow_status via ctx.pg (read-only, no DBOS init, no new table); absent dbos schema → legacy behavior
Date: 2026-05-31
Confirms + resolves the process-boundary question D-012 implied. `runMainLoop` runs in a SEPARATE subprocess (`bin/run.ts`), NOT the operator host where `startDbos()` launches DBOS — so the `readFeaturesPg` carve-out filter cannot call `DBOS.retrieveWorkflow()` (DBOS isn't initialized in that process). Resolution: read ownership straight from DBOS's own system table via the orchestrator's existing `ctx.pg` connection — no DBOS init, no new ownership table.

**The query** (read-only): durable-owned features = rows in `dbos.workflow_status` where `workflow_uuid LIKE 'pipeline:<slug>:%'` AND `status IN ('PENDING','ENQUEUED')`; parse the feature id out of the `workflow_uuid` (`pipeline:<slug>:<feature>:e<epoch>`). `readFeaturesPg` excludes that set so the global orchestrator never decides for an owned feature (the D-012 carve-out). Columns confirmed from the `/admin/dbos/status` route: `dbos.workflow_status(workflow_uuid, name, status, queue_name, application_version, …)`.

**Off-path safety (preserves D-006 default):** guard the whole filter behind `PAPERCUSP_DBOS_ORCHESTRATOR`, AND when the `dbos` schema is absent or the query errors, return an EMPTY owned-set → no carve-out → byte-identical legacy behavior (check `information_schema.schemata` for 'dbos' first, mirroring the status route, or catch + empty). So with the flag off — the default, and the desktop where DBOS is idle — `readFeaturesPg` is unchanged.

**Why this isn't built yet:** the filter is only HALF the wiring — inert without the START side (deciding which features to opt into durable ownership + `startFeaturePipeline` with the epoch + the per-feature director). Filter + start-side + claim + validation are a cohesive live-integration unit best built + validated together in a supervised live session (real `ctx.pg` + a running orchestrator), not piecemeal-blind into the submodule. This decision makes that session turnkey: exact table (`dbos.workflow_status`), exact seam (state-pg.ts `readFeaturesPg`), exact off-path guard.
Related: P-008

### D-014 — Phase 3 integration BUILT + validated against real DBOS (gate7, 9/9): carve-out + start-side + ownership + epoch all green
Date: 2026-05-31
The Phase-3 live wiring (D-011/D-012/D-013) is now built, unit-tested, and end-to-end validated against a real isolated DBOS — cost-free, no agent, no touch to the live operator.

**Built + committed:**
- **Carve-out filter** (submodule `c2e120f` → superproject `e4209d0`): `durableOwnedFeatureIdsPg` in `state-pg.ts` reads PENDING/ENQUEUED `pipeline:<slug>:<feature>:e<epoch>` workflows from `dbos.workflow_status` via the orchestrator's `ctx.pg` (subprocess has no DBOS runtime — D-013); `readFeaturesPg` excludes them (D-012). Flag-gated default-off (empty set, zero queries); absent schema / any error → empty → legacy. 6 unit tests.
- **Start-side** (commit `7bb0bd48`): `decidePipelineStart` (pure, 8 tests) — reuse a live pipeline, else fresh epoch = prior-lifetime count; `ensureFeaturePipeline` lists via `DBOS.listWorkflows(workflow_id_prefix)` + starts via `startFeaturePipeline`; `POST /api/admin/dbos/pipeline/start` triggers it (409 when flag off; lazy import). The manual/validation trigger + ops affordance.

**gate7 (throwaway isolated `dbos_gate7` DB, stub runner) — 9/9 PASS:** start-side starts e0 / **reuses** a live pipeline (no double-start) / fresh epoch **e1** after SUCCESS; carve-out (real `to_regclass`/`split_part`/`LIKE` SQL vs real `dbos.workflow_status`) **includes** a live-owned feature, **excludes** a completed one, per-feature scoped; the full **director→worker→validator→DONE** dispatch ran to `SUCCESS` against real DBOS. Live operator's `papercusp.dbos` verified still 0 workflows — full isolation. (Throwaway gate script run + deleted, never committed — DBOS resume/execution is inherently multi-process and can't be a Vitest test; the committed proof is the 14 unit tests + this record.)

**Remaining for production Phase 3:** (1) the AUTO-dispatcher (auto-decide which features to opt in — the built trigger is manual); (2) real-agent validation P-013 (the stub proved the integration; a real-agent run is the gold standard — costs money + makes irreversible commits, needs explicit go-ahead); (3) reconciliation — reaper "owned-by-a-live-workflow?" guard (P-010) + `/claim-feature` repoint to workflow status (P-011).
Related: P-004, P-007, P-008, P-012

### D-015 — Auto-dispatcher built; the per-feature DIRECTOR gap found + filled (director.md); validated against a real LLM
Date: 2026-05-31
**Auto-dispatcher** (commit e1c32ca + submodule 4d7da92): a scheduled DBOS workflow (every 30s, registered only under `PAPERCUSP_DBOS_ORCHESTRATOR=1`) sweeps the harnesses listed in `PAPERCUSP_DBOS_DISPATCH_HARNESSES`, reads eligible (carve-out-filtered) features, and `ensureFeaturePipeline`s the `pending`/`failed` ones up to `PAPERCUSP_DBOS_MAX_PIPELINES` (default 4). `selectFeaturesToDispatch` is pure (5 unit tests). Double-gated: with no harnesses opted in the tick is a no-op, so flipping the orchestrator flag alone never auto-starts agent work.

**The per-feature DIRECTOR gap (found while prepping the real-agent run):** the durable per-feature pipeline needs a *per-feature* director agent — and the global `orchestrator` role **cannot be reused**, because the carve-out (D-012) *hides the pipeline's own feature* from the orchestrator's queue, so a per-feature orchestrator invocation would see nothing to do. No `director.md` existed, and the pipeline's default `orchestratorRole: 'director'` resolved no prompt. Authored `director.md` (submodule 6422f2f): scoped to `FEATURE_ID`, emits a single `NEXT_WORKER`/`NEXT_VALIDATOR`/`NEXT_ARCHITECT`/`DONE`/`ESCALATE` line. The default role now resolves.

**Real-LLM validation (the bounded real-agent test, P-013):** `director.md` against a real model (haiku) — `pending`→`NEXT_WORKER`, in-progress+unvalidated→`NEXT_VALIDATOR`, `passed`→`DONE`, `failed`×6→`ESCALATE` — all four correct. So the new director agent makes the right per-feature calls with a real LLM. Combined with gate7 (workflow + carve-out + start + epoch on real DBOS) and the proven-code runner (`orchestrator-runner` = a copy of the live `/invoke` route + 52 invoke-once/invoke unit tests), Phase 3 is validated **piecewise** end-to-end.

**Remaining (gold-standard follow-up):** one FULL simultaneous pipeline run with real agents (director→worker→validator committing to a throwaway repo) — heavy + token-spending, every link already proven separately. That run also exercises the one nuance the inline-state LLM test skipped: confirming `invoke`'s `buildPrompt` scopes the director's *context* to the single feature (the prompt instructs it, but the full run proves the injected context matches). `director.md` is a first cut — open to refinement.
Related: P-008, P-012, P-013

### D-016 — Reconciliation assessed (P-010 cosmetic, P-011 moot-as-framed); buildPrompt scoping confirmed; Phase 3 functionally COMPLETE
Date: 2026-05-31
Closing the loop on the remaining Phase-3 items after reading the actual code.

**buildPrompt feature-scoping (the nuance flagged in D-015) — CONFIRMED from code, no change needed.** `buildPrompt` injects the `FEATURE_ID` extra + per-feature `featureHistory` (fetched *only when a feature is in scope*); it does NOT inject the whole feature queue. So the director's context is already scoped to its one feature. Combined with the carve-out hiding owned features and the director prompt's single-feature instruction (real-LLM validated, D-015), the scope is sound.

**P-010 (reaper guard) — cosmetic, deferred.** `harness-status-sweep` is pure PID-liveness with a 24h cutoff, so it NEVER sweeps a live run; the only DBOS interaction is a stale `running=true` row lingering ≤24h after a crash (clears itself). It does not affect dispatch — the carve-out (workflow status) is the authoritative dispatch-ownership mechanism — and the crash-then-resume double-spawn is already D-003's *accepted* re-spawn-fresh policy, not a reaper bug. A guard here is polish for a self-healing cosmetic; not built.

**P-011 (claim repoint) — moot as framed.** The distributed claim (`attempt-claim.ts` → `claimFeature`, Autobase + `claimer_github_user_id` + pubkeys) is **cross-engineer** coordination — which human's operator owns a feature. That is a different axis from the **intra-operator** pipeline-vs-main-loop ownership the carve-out handles. Repointing the cross-engineer claim to the intra-operator workflow id would conflate two ownership systems; they coexist orthogonally. No change.

**Conclusion — Phase 3 is functionally COMPLETE + validated piecewise, flag-gated default-off:**
mechanism (workflow + runner + idempotency) → carve-out → start-side → endpoint → auto-dispatcher → per-feature director.md, with validation across gate7 (real DBOS, 9/9), the proven-code runner (= the live `/invoke` route + 52 tests), the director-vs-real-LLM (4/4), and buildPrompt-scoping (code-confirmed). The only remaining item is the OPTIONAL gold-standard: one FULL simultaneous real-agent pipeline run (director→worker→validator on a throwaway repo) — a human-supervised confidence step, since every link is already proven separately. Production rollout = flip `PAPERCUSP_DBOS_ORCHESTRATOR=1` + opt a harness in via `PAPERCUSP_DBOS_DISPATCH_HARNESSES`, then watch `/admin/dbos`.
Related: P-008, P-010, P-011, P-012, P-013

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
