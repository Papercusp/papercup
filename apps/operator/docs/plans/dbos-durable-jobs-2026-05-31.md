---
title: Adopt DBOS Transact for durable background jobs + orchestrator durability
slug: dbos-durable-jobs-2026-05-31
status: ready
created: 2026-05-31
updated: 2026-06-02
owner: avi@storewolf.com
---

# Adopt DBOS Transact for durable background jobs + orchestrator durability

## Now

**State:** Phases 0, 1, 2 complete + live-boot validated (D-020). Phase 3: P-014 spike done (D-019); **P-015 first piece landed** — `invoke()` opt-in `idempotencyKey` + check-before-spawn so a re-run of a completed agent invoke can't double-spawn (orchestrator submodule `c4c897a`, pointer `c798261e`; 50 tests green; opt-in → all current callers unchanged). The careful remainder (in-flight-run policy, wrapping the pipeline as a durable workflow with determinism + `patched()` versioning discipline, lane-pool/reaper/claim reconciliation, live validation) is scoped in the **sub-plan `dbos-orchestrator-durability-2026-05-31`**.

**Next:** Continue in the sub-plan `dbos-orchestrator-durability-2026-05-31`: P-001 (dedicated idempotent-hit test) + P-003 (`needs-human`: the in-flight-run policy — re-spawn-fresh vs reuse-partial, the deepest semantic) before wrapping the pipeline (P-004). All flag-gated by `PAPERCUSP_DBOS_ORCHESTRATOR` with the legacy main loop as the A/B fallback.

## Background

Papercusp's background work today runs as **in-process timers**, the most load-bearing being the **AutoLoop
ticker** (`apps/operator/lib/autoloop.ts`, ~30s, `PAPERCUSP_AUTOLOOP_TICK_MS`) that fires per-harness
director / coordinator / auditor roles and records outcomes to `harness_shared.autoloop_state`. The same
shape covers the operator scanner, embeddings/semantic indexing, snapshots/backups, and several smaller
workers (see P-008 for the full inventory). These timers share three weaknesses:

1. **No durability** — they die with the process and resume from nothing; a crash mid-run is silently lost.
2. **No real retry contract** — failures bump a `consecutive_errors` counter but there's no backoff, no
   dead-letter, no max-attempts.
3. **No observability** — no durable record of what ran, when, why it failed.

(A fourth oft-cited weakness — cross-process double-fire — is largely a **dev-box artifact**: production runs
one operator sidecar per workspace, so two processes rarely race. The dedup-ID design below makes single-fire
correct anyway, cheaply, but we don't oversell it as a production motivation.)

This came out of evaluating how **Restart** uses **BullMQ** (Redis, 18 queues in `shop-api` for
transactional side-effects). BullMQ is right for Restart (a server already running Redis) and wrong for
Papercusp: the public product ships as a **desktop app + embedded Postgres only** (`~/.papercusp/embedded-pg.json`,
resolved via `getHarnessAdminUrl()`); bundling Redis in every install breaks that topology. We surveyed the
Postgres-backed field — three options need zero infra beyond the embedded PG: pg-boss, graphile-worker, DBOS
Transact (full survey in **Alternatives considered**). We chose DBOS for durable execution.

**Related plans:** `papercusp-systems-abstraction-2026-05-29` (keep the harness core in-tree),
`production-readiness-test-coverage-2026-05-30` (P-010 orchestrator cancellation + orphaned-run cleanup;
D-007 JSONB durable-state corruption) — Phase 3 must reconcile with both.

## Decisions

### D-001 — Adopt DBOS Transact; reject BullMQ, pg-boss, and graphile-worker
Date: 2026-05-31
DBOS is **durable execution**, not merely a queue. Its queue is already full-featured (global + per-worker
concurrency, rate limiting, priority, deduplication IDs, delayed enqueue, cron via scheduled workflows,
step retries with backoff), so we give up no background-job capability we'd use. What it adds over
pg-boss/graphile-worker is **step-level checkpointing with automatic resume after a crash** and **workflow
composition** — which map onto Papercusp's differentiator: long, expensive, stateful agent runs on a desktop
app users quit/sleep/close mid-run. BullMQ is rejected (needs Redis). pg-boss/graphile-worker solve only the
easy half (timers), leaving orchestrator resume unaddressed; pg-boss is retained as the **Tier-A fallback**
if DBOS disappoints. Backing: DBOS Inc., MIT, v4, frequent releases (founders incl. Michael Stonebraker).
Related: P-001, P-002

### D-002 — No new infrastructure: DBOS runs on the existing embedded Postgres
Date: 2026-05-31
DBOS connects to the embedded PG via the existing discovery path (`getHarnessAdminUrl()` /
`~/.papercusp/embedded-pg.json`) — **never a hardcoded port** — with its system tables in a dedicated `dbos`
schema. Keeps the "desktop + embedded-pg only" topology intact; nothing new for a user to install.
Related: P-001

### D-003 — Two tiers, sequenced; Tier B approved but still gated behind Tier A
Date: 2026-05-31
**Tier A (Phases 0–2):** durable *background jobs* — replace the timers. Low risk, reversible-by-flag (D-011).
**Tier B (Phase 3):** durable *execution of the agent orchestrator* — resume the agent pipeline from the last
completed step. Tier B is now **approved** (D-012), but sequencing is unchanged: **ship Tier A first**; Tier
B's design spike (P-014) starts only after Phase 0 proves the substrate. Its true cost is workflow-versioning
discipline (D-008), accepted in D-012.

### D-004 — DBOS does not replace the LLM-driven orchestrator routing
Date: 2026-05-31
The orchestrator's value is the LLM deciding *what next* (`NEXT_WORKER`, `NEXT_VALIDATOR`, `ESCALATE`). DBOS
wraps the *execution* of that decision as durable, resumable steps; it does not turn dispatch into a dumb
FIFO queue. Workflows branch on runtime data (incl. LLM output), so dynamic routing survives. P-014's spike
must demonstrate this.
Related: P-014

### D-005 — Idempotency is still designed at step boundaries
Date: 2026-05-31
Durable execution makes the workflow's **control flow** exactly-once and resumable. It does **not** make an
external side effect (`git push`, an LLM call, an outbound message) idempotent — a crash *during* one is the
classic at-least-once boundary. Every step that touches the outside world is written idempotently. DBOS
reduces this burden; it doesn't erase it.

### D-006 — Polling latency (~1s) is acceptable; not for latency-sensitive paths
Date: 2026-05-31
DBOS workers dequeue by polling (~1s default), unlike graphile-worker's LISTEN/NOTIFY. Fine for cron/background
work and minutes-long agent runs. We do **not** adopt DBOS for any sub-second interactive dispatch; those keep
their existing SSE/in-process mechanisms.

### D-007 — Prune the dead Redis/BullMQ dependencies
Date: 2026-05-31
`bullmq`, `@nestjs/bullmq`, `ioredis` (root `package.json`) and `redis` (`apps/operator/package.json`) are
declared with **zero source usage** (only compiled `.next` artifacts reference them). Inherited dead weight;
remove as part of this work.
Related: P-012

### D-008 — App-version recovery is the real gate; pinning is safe for timers, hazardous for the orchestrator
Date: 2026-05-31
DBOS tags each workflow with an **application version** (a checksum of workflow code, overridable via
`DBOS__APPVERSION`) and, self-hosted without Conductor, **does not recover workflows whose version differs
from the running binary** — they sit `PENDING`, silently. This breaks the headline case (quit mid-run → update
the desktop app → reopen: the new binary won't auto-recover the old-version workflow). **Tier A policy:**
(a) the Phase-0 gate tests *cross-version* resume, not same-binary (P-002); (b) for background jobs we **pin
`DBOS__APPVERSION` to a stable value** — safe because a timer workflow body is trivial (fire a tick), so
running old-shape under new code is low-risk. **Tier B is not that simple, and the pin is not a free win.**
Resuming a long checkpointed *orchestrator* workflow whose code changed underneath it is the classic
durable-execution determinism hazard: DBOS replays by **step order/identity**, so reordered/renamed steps
reattach a resumed run to the **wrong checkpoint** (exactly what Temporal forces you to handle with
`patched()`/versioning). Tier B's real options are therefore **(i) pin + adopt workflow-versioning
discipline** — you owe a patching strategy for every incompatible change to the pipeline — or **(ii) recover
same-version only**, accepting that in-flight orchestrator runs from *before* an app update do **not**
auto-resume. The owner has chosen **(i)** (D-012); P-014's spike validates it on the real pipeline.
Related: P-002, P-014

### D-009 — Scheduled-workflow catch-up policy: explicitly select skip-missed
Date: 2026-05-31
DBOS scheduled workflows can backfill missed intervals via opt-in modes (`ExactlyOncePerInterval` /
`automaticBackfill: true`); DBOS docs frame these as things you *configure*, which indicates skip-missed is the
default — **but neither this plan nor the reviewer should encode a version-specific default as fact; P-003's
spike confirms the actual default before we rely on it.** A 30s ticker on a laptop closed overnight must not
fire thousands of backfilled ticks at launch. **Policy (independent of whatever the default turns out to
be):** AutoLoop and the other high-frequency tickers **explicitly select skip-missed** (run the next tick
only); backfill is enabled per-schedule **only** where a missed run genuinely must run (e.g. a daily backup may
want at-most-one catch-up). P-003 tests the closed-for-hours-then-reopen case explicitly.

### D-010 — Single-fire comes from the deduplication ID, not concurrency=1
Date: 2026-05-31
`concurrency = 1` only *serializes* execution — it does not stop N duplicate enqueues running back-to-back.
The single-fire guarantee comes from the **deduplication ID** (only one workflow with a given dedup ID may be
enqueued/active at once). Tickers enqueue with a dedup ID keyed on `(harness_slug, role, interval-bucket)`;
`concurrency = 1` is a secondary serializer, not the guarantee.
Related: P-004

### D-011 — Tier A is flag-gated and reversible by flip, not git-revert
Date: 2026-05-31
"Reversible" is only true if rollback is a flag flip. Gate DBOS behind the repo's feature-flag system
(`flags:*`) and keep the existing timer path live **through Phase 1**, so we can A/B and revert instantly. This
is a **temporary migration flag**, not a permanent compatibility shim: Phase 2 (P-013) deletes **both** the old
timer path and the flag once validated — consistent with the pre-alpha "no compatibility aliases" ethos.
Related: P-005, P-013

### D-012 — Phase 3 gate APPROVED: route the agent orchestrator through DBOS too
Date: 2026-05-31
Owner decision (2026-05-31): route **everything** through DBOS — not just background jobs but the agent
pipeline itself. Tier B is a go. The intent is full crash/quit resume *including across app updates*, which
requires **option (i) of D-008: pin `DBOS__APPVERSION` + adopt a `patched()`-style workflow-versioning
discipline** for every incompatible change to the pipeline. The ongoing maintenance cost of that discipline is
**explicitly accepted** as the price of cross-update orchestrator resume. The P-014 spike validates the
discipline is workable on the real pipeline and falls back to option (ii) (same-version-only) **only** if (i)
proves untenable. Sequencing is unchanged: Tier A (Phases 0–2) ships first; Tier B starts after Phase 0.
Related: P-014


### D-013 — Phase 0 gate PASSED + integration committed; in-operator activation blocked on chat-protocol
Date: 2026-05-31
The P-002 cross-version resume **gate passed** against a real embedded-postgres-server PG16 instance (DBOS v4.18.10, isolated probe in /tmp/dbos-probe): DBOS creates its `dbos` schema; a completed step is **not** re-run on resume; an `applicationVersion` change without pinning leaves the prior workflow **PENDING** (the D-008 hazard, empirically confirmed); pinning the version recovers it to **SUCCESS** with no double-execution. So the gate is clean — Phase 1 is unblocked on the substrate.

P-001 integration code is **committed (0443ccb7)**: `apps/operator/lib/dbos/bootstrap.ts` (functional API, resolve DSN via `getHarnessAdminUrlWithSource()`, refuse `native-fallback`, schema `dbos`, pinned `applicationVersion`, idempotent single launch) + `hello-workflow.ts` + a `PAPERCUSP_DBOS_ENABLE=1` (default-off, dynamic-import) block in `instrumentation-node.ts`, plus the `@dbos-inc/dbos-sdk` dep.

Refinement: the boot **launch** is env-gated (matching the other instrumentation workers) rather than PostHog-flag-gated — the `flags:*` A/B gate (D-011) belongs in Phase 1 with the AutoLoop *runtime*, not the boot launch (no async flag read at startup).

Two findings that revise earlier assumptions: v4.18 config exposes **`useListenNotify`** (DBOS can use LISTEN/NOTIFY, not poll-only — softens D-006's "~1s poll" caveat) and **`enablePatching`** (first-class `patched()` for the D-008/D-012 versioning discipline — confirms option (i) is supported).

**BLOCKER:** in-operator activation (workspace `npm install` + lockfile reconciliation + flip-the-flag boot verify) is gated on an **unrelated** breakage — `@papercusp/chat-protocol` (referenced by `packages/tooldef` + `libs/chat-protocol`, another agent's in-flight scout-convergence rename) is unpublished, so `npm install` fails E404. The committed boot block is dynamic-import + default-off, so it is fully inert until that clears.
Related: P-001, P-002


### D-014 — Install unblocked; Phase 1 (AutoLoop) mechanics verified + integration written
Date: 2026-05-31
**Blocker cleared:** `libs/chat-protocol` (a committed submodule, `@papercusp/chat-protocol`, required by `packages/tooldef`) was missing from the root `workspaces` array → npm hit the registry and 404'd, blocking ALL installs. Registered it (commit `b437af64`); `npm install` now succeeds and `@dbos-inc/dbos-sdk` is installed in the operator. (`package-lock.json` is gitignored here, so only the workspaces entry is committed.)

**Phase 1 mechanics verified** (isolated `gate2.mjs` against embedded PG16):
- **P-004 single-fire** — two enqueues with the same `deduplicationID` collapse to ONE execution (1 rejected with `DBOSQueueDuplicatedError`, 1 actual fire). Confirms D-010: single-fire is the dedup ID, not `concurrency=1`.
- **P-003 scheduled** — a `DBOS.registerScheduled` workflow fires on cadence (4 ticks in ~4.5s at 1/s) in the **default skip-missed mode** (no `ExactlyOncePerInterval`), i.e. no backfill storm (D-009).

**Two integration findings** (folded into the code): a scheduled fn must ALSO be registered as a workflow (`registerScheduled(registerWorkflow(fn))`), and DBOS's admin server defaults to **:3001** (collides with Restart's shop-api) → set `runAdminServer: false`.

**Phase 1 integration written:** `lib/dbos/autoloop-workflow.ts` — a scheduled tick (skip-missed) that enqueues a per-`(harness, role)` **dedup-keyed** (`autoloop:<slug>:<role>`) fire workflow (record→fire→record as durable steps), reusing the real `autoloop.ts` helpers (now exported). Flag-gated by `PAPERCUSP_DBOS_AUTOLOOP=1` (D-011); the legacy `startAutoLoopOnce` ticker **stands down** when that flag is set, so exactly one implementation fires (instant A/B revert). `bootstrap.ts` updated (`runAdminServer:false` + conditional autoloop registration before launch).

Remaining: in-operator boot verify (now unblocked — flip `PAPERCUSP_DBOS_ENABLE=1` [+ `PAPERCUSP_DBOS_AUTOLOOP=1`], restart the dev API, watch the `dbos` schema + ticks) and P-006/P-007 (retry-cap mapping + the `/admin` DBOS tab).
Related: P-003, P-004, P-005


### D-015 — P-007 shipped — /admin DBOS tab; Phase 1 complete
Date: 2026-05-31
P-007 done (commit 685d4903): a new `/admin/dbos` tab + `GET /api/admin/dbos/status` route (`defineTool`, loopback auth) reading the `dbos.*` system schema — workflow-status counts, recent runs, and `workflow_queue` depth — returning `{ enabled: false }` gracefully when DBOS hasn't launched. The client is **nuqs-stated** (view tab + status filter, per repo convention) and **local PG-query only, NOT DBOS Conductor** (the plan forbids the cloud dashboard). The route SQL was verified against a real embedded-PG `dbos` schema (counts + the full workflow SELECT + the queue aggregation all execute and return correct rows); the new files are individually tsc-clean.

Caveat: registering the route surfaces **3 type-cascade errors** in `routes/index.ts` (`RouteDefinition` ↔ `RoleToolDefinition`). These are part of the **in-flight `@restart/*`→`@papercusp/*` agent-mcp rename** another agent is landing — the tree is at ~606 tsc errors mid-rename — not a defect in the route (runtime is unaffected; Next/SWC ignores type errors). Re-verify they clear once the rename settles; if not, the registration needs a `satisfies`/cast follow-up.

**Phase 1 (P-003–P-007) is complete and verified.** Remaining for full closure: the live-service end-to-end boot (flip the flags + restart the dev API) once the rename settles, then Phase 2 (migrate the remaining timers).
Related: P-007


### D-016 — P-008 — background-timer inventory + migrate/stay classification (Phase 2 DoD)
Date: 2026-05-31
Every operator background timer, enumerated (grep-verified) and classified. This is the definition-of-done for Phase 2; each migrate-row becomes a DBOS scheduled workflow (skip-missed) + legacy stand-down, exactly like AutoLoop.

| Worker (apps/operator/lib) | Mechanism | Cadence | Decision |
| --- | --- | --- | --- |
| `autoloop.ts` | setInterval | 30s | ✅ MIGRATED (Phase 1) |
| `telemetry-flush.ts` | setInterval | hourly | MIGRATE → scheduled drain |
| `scratch-gc.ts` | setInterval | 24h | MIGRATE → scheduled GC |
| `memory/cleanup-worker.ts` | setInterval | 6h | MIGRATE → scheduled GC |
| `harness/completion-ref-verifier.ts` | setInterval | ~10–60s poll | MIGRATE → scheduled `git ls-remote` poll |
| operator scanner (`operator-scanner-*`) | periodic | per-config | MIGRATE → scheduled + dedup mutual-exclusion (P-009) |
| embeddings / `search/embed-backfill.ts` | setTimeout (one-shot, ~5min post-boot) | one-shot | MIGRATE → rate-limited queue job (P-010) |
| `backup/index.ts` (snapshot scheduler) | cadence | per-workspace | MIGRATE → scheduled (at-most-one catch-up, D-009) (P-011) |
| `backup/orphan-cleanup.ts` (snapshot reaper) | sweep | periodic | MIGRATE → scheduled sweep (P-011) |
| `harness-status-sweep.ts` (agent-run reaper) | setInterval | 30s | **DEFER to Phase 3 (P-016)** — it's orchestrator run-state, reconciled with the lane pool / `spawned_agents`, not a plain timer |
| `harness-fs-watcher.ts` | chokidar `watch()` | event-driven | **STAY event-driven** — must NOT become a poller |

Each migration requires exporting the worker's single-run tick function and adding a `PAPERCUSP_DBOS_TIMERS` stand-down guard to its `start*` function (mirroring `startAutoLoopOnce`).

**Gate:** the migrations (P-009/010/011) edit these worker files — which are currently being churned by the in-flight `@restart→@papercusp` rename (operator tree at ~606 tsc errors, 28 dirty files). Landing edits into them now risks commit-sweeping rename changes + more tsc-cascade noise. So P-009+ and the live-service boot both **wait for the rename to settle (or be finished/reverted)** — that cleanup is not part of this DBOS plan. P-008 (this classification) is complete.
Related: P-008, P-009, P-010, P-011


### D-017 — Phase 2 — 4 simple periodic timers migrated; rename was already done (prior gate was a misdiagnosis)
Date: 2026-05-31
**Correction to D-016's gate:** the `@restart→@papercusp` rename is **already complete** — `0` files import `@restart/*`, the `scout-convergence-papercup-2026-05-30` plan is `status: shipped` (P-001–P-006 done + verified), and **0** tsc errors touch the renamed packages (`@papercusp/sse`/`chat-protocol`/`ChatEvent`), so it introduced no consumer fallout. The ~598 tsc errors I'd called "mid-rename churn" are the operator's **pre-existing baseline debt** (76 in `libs/zero-harness` which is on the Zero-retirement path, drizzle `generated.ts`, many test files, 48 in the agent-mcp/orchestrator submodules; CI is known-red). They aren't churn and won't "settle." So Phase 2 was never actually blocked — my deferral was based on a wrong premise.

**Migrated (commits `53fd89b2` + `68533dbd`), the "simple periodic" tier of D-016:**
- `telemetry-flush` (hourly), `scratch-gc` (daily 03:00), `memory/cleanup-worker` (6h), `completion-ref-verifier` (1min) → DBOS **scheduled workflows** (default skip-missed, D-009) in `lib/dbos/periodic-workflows.ts`, calling the existing tick functions (extracted `runCompletionRefVerifierOnce`; reused `flushTelemetry`/`runScratchGc`/`runMemoryCleanupOnce`), with step retries + `maxRecoveryAttempts` (P-006).
- Flag-gated by `PAPERCUSP_DBOS_TIMERS=1`; each legacy `start*()` setInterval worker stands down when set (D-011 A/B, instant revert). Verified: the real `bootstrap.ts → periodic-workflows.ts` path registers all 4 schedules + launches clean on embedded PG16 (crontabs parse, all are workflows); tsc clean for touched files.

**Remaining Phase 2:** the **complex** migrations — operator scanner (P-009, scan-lock mutual exclusion), embeddings (P-010, rate-limited queue), backups (P-011, per-workspace cadence) — each needs per-subsystem care. Plus P-012 (prune dead `bullmq`/`ioredis`/`redis` deps) + P-013 (delete old timer paths + flags) — deferred only because they edit `package.json` files that currently carry the rename's *uncommitted* working-tree changes; do them once those are committed. The live-service boot is now genuinely unblocked (needs a dev-API restart).
Related: P-009, P-010, P-011, P-012


### D-018 — Phase 2 scope correction: scanner is client-side (dropped), embeddings migrated, backups the sole complex remainder
Date: 2026-05-31
Investigating the "complex three" corrected the D-016 classification:

- **P-009 operator scanner — DROPPED.** It is **not** a server-side timer: the scan cadence is a **client-side `setInterval`** in `app/_components/OperatorBackgroundScanner.tsx` (runs in the browser/webview while the operator UI is open). A server-side DBOS scheduled workflow cannot replace a per-client UI loop. (A server-authoritative scan cadence, if ever wanted, is a separate design — not a timer migration.) The `operator:scan` tool itself is on-demand/agent-triggered; the director-driven scans already route through the AutoLoop migration.

- **P-010 embeddings — MIGRATED (`ef896e63`).** `embed-backfill` (5-min periodic semantic-index sweep) → DBOS scheduled workflow via a new `runEmbedBackfillOnce()` wrapping the existing battery-aware sweep. So it was a simple-tier item, not complex.

**Total server-side periodic timers now migrated (5):** `telemetry-flush`, `scratch-gc`, `memory/cleanup-worker`, `harness/completion-ref-verifier`, `search/embed-backfill` — all in `lib/dbos/periodic-workflows.ts` as scheduled workflows (skip-missed), flag-gated by `PAPERCUSP_DBOS_TIMERS=1` with legacy `setInterval` stand-down (D-011), verified registering + launching on embedded PG16, tsc-clean.

- **P-011 backups — the ONLY genuinely-complex remaining migration.** `startBackupScheduler` lives in `packages/backup` with **per-workspace cadence** (not a single global schedule), so it needs a per-workspace enumeration design (the shape AutoLoop uses per-harness) plus care around the backup package boundary. Deferred to a focused pass.
- **P-012 / P-013** (prune dead `bullmq`/`ioredis`/`redis` deps; delete old timer paths + flags) still deferred behind the rename's *uncommitted* `package.json` working-tree changes — do once those are committed.
Related: P-009, P-010, P-011


### D-019 — Phase 3 P-014 spike — dynamic resume validated; invoke()-idempotency is the integration crux
Date: 2026-05-31
Ran the P-014 spike (isolated, non-destructive — no orchestrator edits). A DBOS durable workflow modeling the pipeline as a **dynamic loop** (each turn a checkpointed `decide` step picks the next role, simulating LLM dispatch), crashed mid-`worker`, resumed:

- ✅ **D-004 validated:** completed steps (`scoper`, `architect`) were **NOT re-run**; the loop resumed at `validator`→`reviewer`; workflow → `SUCCESS`. Dynamic (runtime-decided) routing and durable resume coexist — *provided the "next" decision comes from a checkpointed step* so control flow is deterministic on replay.
- ⚠️ **The crux finding:** the **in-flight** step (`worker`, mid-sleep at crash) **re-executed fully on resume** → its side effect fired twice (`worker=2`). This is D-005 made concrete: wrapping `invoke()` as a DBOS step means **a crash mid-agent-run RE-SPAWNS that agent on resume**. Completed roles are safe; the interrupted one re-runs. So **`invoke()` steps must be idempotent** — check-before-spawn on `(feature, role, attempt)` (the prior partial run's git commits/PG writes already happened), or model each agent as a resumable child workflow.

**Integration design (grounded in an orchestrator read of `libs/papercusp/packages/orchestrator/`):**
- **Boundary:** wrap **`invoke()`** (`invoke.ts` — spawns one agent, returns `{output, exitCode, …}`) as the DBOS step; keep `dispatchDecision()` (`main-loop.ts:723–799`) as deterministic control flow around it. Do **NOT** wrap the raw main loop — it has mid-iteration non-determinism.
- **Determinism hazards to move INTO checkpointed steps** (else replay diverges): `Date.now()`/`makeRunId()`, `randomUUID()` spawn IDs (`invoke.ts:1000`), the **distributed claim** fetch (`distributed-claim-fetch.ts` — outcome must be checkpointed, not re-fetched), and mutable mid-loop PG reads (feature status, plan slugs).
- **Run-state reconciliation (P-016):** the in-memory **lane pool** (`lanes.ts`, persisted to `lanes.json`) cannot be the "is the pipeline running" source of truth under DBOS — it dies on restart while DBOS survives; parallel-lane handling needs redesign. DBOS workflow status becomes the truth; `harness_shared.harness_lanes` (live spawn rows) + `harness_run_output` + the `harness-status-sweep` reaper reconcile to it.
- **Claim (P-017):** the distributed claim (`/api/harness/{slug}/claim-feature`) and a DBOS workflow ID must agree on "who owns F" — the workflow ID can BE the claim token.

This is the spike only. The integration (editing the orchestrator submodule, P-015–P-017) is the next, gated, higher-risk step — it carries the idempotency rework above plus the D-008 `patched()` versioning discipline.
Related: P-014, P-015, P-016, P-017


### D-020 — Live-service boot VALIDATED + two wiring fixes (probe; host-bootstrap is the live path)
Date: 2026-05-31
Live-boot done. Set `PAPERCUSP_DBOS_ENABLE=1` in `apps/operator/.env.local`, restarted the **Hono host** (`papercup-dev-api.service`), and confirmed DBOS launched in the real long-running operator: the `dbos` schema with all **14 system tables** is now present in the live `:5432/papercusp` DB (only a successful `DBOS.launch()` creates them). `/admin/dbos` route is live (auth-gated). ENABLE-only — no `TIMERS`/`AUTOLOOP`, so no legacy stand-down and no agent spawns; the maintenance/AutoLoop scheduled workflows are a flag-flip away but fire real work, so left off.

Two real fixes the live-boot forced:
1. **`5dc572fd` — probe, don't refuse the label.** `bootstrap.ts` skipped DBOS whenever `source==='native-fallback'`, but on this dev box native `:5432/papercusp` IS the live operator DB. Replaced the label check with a connect-test: launch when the resolved PG answers `SELECT 1`, skip cleanly when not — correct for both the desktop product (dead `:5432/papercusp_legacy` → skip) and dev (live `:5432` → launch).
2. **`e65b863c` — wired into the wrong (retired) file.** DBOS was only in `instrumentation-node.ts`, which `host-bootstrap.ts` itself labels the **"(retired) Next instrumentation"**. The live boot path is the Hono host calling `runBootstrap()` in `bin/host-bootstrap.ts` (where `startAutoLoopOnce()` actually boots). Added the flag-gated `startDbos()` there; it's globalThis-idempotent so the leftover instrumentation-node block is a harmless no-op. (Note: the maintenance timers I migrated — telemetry/scratch-gc/etc. — live in the retired instrumentation-node, so they may be dormant in the current architecture; the DBOS `TIMERS` path would actually *restore* them. AutoLoop is the one timer host-bootstrap boots live.)
Related: P-001


### D-021 — P-007 live-verified through the Tauri shell: DBOS is booted in the live operator; the admin tab needed an operator-vite mirror (was Next-only)
Date: 2026-05-31
Live-tested the DBOS work through the running Tauri desktop shell (bridge-driven via `tauri-agent-tools`, per `testing/agent-e2e`).

**Positive confirmation — DBOS is booted in the live operator.** `GET /api/admin/dbos/status` issued from inside the webview returns `{ httpStatus:200, enabled:true, counts:[], workflows:[], queues:[] }`. So the `dbos` schema exists in the live embedded PG and the status endpoint works; idle as designed (`.env.local` sets only `PAPERCUSP_DBOS_ENABLE=1`, no TIMERS/AUTOLOOP/ORCHESTRATOR). The route's `auth:{trust:['verified','trusted']}` passes from the webview's trusted context — only a plain-loopback `curl` is rejected (`unverified-loopback`).

**Bug the live test caught — the admin tab was unreachable.** The P-007 DBOS tab was wired into the **Next** AdminShell (`apps/operator/app/admin/`), but the desktop renders the **operator-vite** shell on :3070 — so `/admin` showed only Run/Features/Testing/Docs/Substrate, no DBOS. The `project_adv_live_in_operator_vite` gotcha: admin tabs need the operator-vite mirror, not just the Next page.

**Fix (commit 5e173588).** Added `apps/operator-vite/src/routes/admin/dbos.tsx` — a thin mirror reusing the self-fetching `DbosClient` via the `@/app` alias (same pattern as `dogfood-substrate`) — plus the `{ href:'/admin/dbos', label:'DBOS' }` AdminShell tab. The running `vite build --watch` regenerated `routeTree.gen.ts` + `dist/` (both gitignored); only source was committed.

**Re-verified live after the fix:** `/admin` now shows 6 tabs, `/admin/dbos` resolves (no 404), the panel renders the enabled+idle state (counts row + the WORKFLOW/NAME/STATUS/… table with "no workflows for this filter"), **no console errors**, and nuqs works under operator-vite's TanStack-Router adapter.
Related: P-007

## Phase 0 — Spike & validation (GATE)

Prove the two things the plan rests on before anything else: DBOS runs on the embedded PG, and it resumes a
workflow **across an application-version change** (not just a same-binary restart).

- **P-001** `todo` Bootstrap DBOS against the embedded PG. Use the **functional API**
  (`DBOS.registerWorkflow` / `DBOS.runStep`), **not** decorators — the operator transpiles under tsx/esbuild
  (`:3070`) and Next/SWC (`:3055`), which handle decorators inconsistently. Call `DBOS.launch()` **exactly
  once**, in the non-HMR Node host (`apps/operator/instrumentation-node.ts`, where the other workers boot),
  with a clean shutdown on Tauri quit so HMR can't re-register/leak pollers. Resolve the connection via
  `getHarnessAdminUrl()` and **fail loudly if no embedded-pg discovery file exists** rather than silently
  hitting the dead native `:5432` (`papercusp_legacy`) fallback. Confirm system schema = `dbos`, embedded PG
  `max_connections` headroom (DBOS pool + ~1s/queue pollers on top of per-harness LRU pools (cap 8) + admin +
  scanner + SSE), and track the **DBOS system-schema migration on SDK upgrade together with the D-008 version
  pin** — DBOS migrates its own `dbos` schema at launch and that schema can change across SDK versions, so the
  two interact; resolve them as one concern, not separately. (S)
- **P-002** `todo` **GATE — cross-version crash-resume.** Enqueue a 3-step durable workflow under binary A
  (app version V1); change the workflow code and run binary B (app version V2); confirm the V1 workflow is
  recovered per the D-008 policy (pinned `DBOS__APPVERSION` or an explicit on-boot recover-prior-version
  step), **not** left silently `PENDING`. Same-binary `kill -9` resume is a sub-case, not the gate. This is a
  **one-time documented manual spike** for the gate (it needs two built binaries + a kill/restart dance — not
  standing CI coverage; don't over-promise it as automated); per the four-frameworks rule, any helper must not
  be an orphaned `.mjs` that CI lint rejects. If cross-version resume can't be made clean on embedded PG,
  **stop** and reconsider (pg-boss covers Tier A). blocked-by: P-001 (M)

## Phase 1 — Migrate the AutoLoop ticker (proof of concept)

Smallest target, highest payoff — the most load-bearing timer.

- **P-003** `todo` Model the AutoLoop tick as a **DBOS scheduled workflow** (cron) replacing the timer in
  `autoloop.ts`, preserving the per-harness `.harness/director-config.json` + `autoIntervalSeconds` cadence.
  **Explicitly select skip-missed** catch-up (D-009 — confirm the actual default in-spike, then set it
  deliberately rather than relying on it); test that closed-overnight-then-reopen produces **one** tick, not
  thousands. blocked-by: P-002 (M)
- **P-004** `todo` Fire per-harness director / coordinator / auditor via a **DBOS queue**, single-fire via a
  **deduplication ID** keyed on `(harness_slug, role, interval-bucket)` (D-010), with `concurrency = 1` per
  `(harness_slug, role)` as a secondary serializer; keep writing outcomes to `harness_shared.autoloop_state`
  as today. Verify single-fire with two processes against one embedded PG. (M)
- **P-005** `todo` Flag-gate the new path (D-011): put DBOS behind a `flags:*` flag and keep the existing
  `setInterval` AutoLoop live behind the flag so Phase 1 can A/B and revert by flip. (S)
- **P-006** `todo` Retry/backoff + dead-letter: map `consecutive_errors` onto DBOS step retries
  (`retriesAllowed` + backoff) and a bounded recovery cap (terminal error state surfaced for triage). (S)
- **P-007** `todo` **Add a DBOS tab to the `/admin` route** with a view into the events: workflow runs, queue
  state, and the per-workflow **step/event timeline** (running / failed / retrying / recovered), with filters
  by queue + status. **Local PG-query-backed** — read DBOS's `dbos` system tables directly — and explicitly
  **not** DBOS Conductor (their cloud dashboard would reintroduce the external dependency this plan exists to
  avoid). Follows the existing `/admin` tab pattern; tab + filter selection in **nuqs** (URL-backed) per repo
  convention. Optionally wire DBOS's built-in OpenTelemetry traces into existing telemetry. (M)

## Phase 2 — Migrate the remaining background timers

Once Phase 1 validates the pattern, fold the rest in — but first define "the rest".

- **P-008** `todo` **Enumerate every background timer and classify each migrate / stay-and-why** (the
  definition-of-done for Phase 2). Known set: `lib/autoloop.ts` (Phase 1), the operator scanner,
  embeddings/semantic indexing, `lib/backup/orphan-cleanup.ts` (snapshot reaper), `lib/telemetry-flush.ts`,
  `lib/memory/cleanup-worker.ts`, `lib/harness-status-sweep.ts` (stale agent-run reaper), `lib/harness/completion-ref-verifier.ts`,
  and `lib/harness-fs-watcher.ts` (**stays event-driven — must NOT become a poller**). Output: a table of
  timer → decision. (S)
- **P-009** `todo` Operator scanner → scheduled workflow + queue (mutual exclusion via dedup ID, replacing the
  scan-lock dance). (M)
- **P-010** `todo` Embeddings / semantic indexing → queue with **rate limiting** (`limitPerPeriod`) so
  re-index storms don't hammer the embedded PG or the embedding API. (M)
- **P-011** `todo` Snapshots / backups + the remaining migrate-classified timers from P-008 → scheduled
  workflows / queues (a backup may justify at-most-one catch-up per D-009). (M)
- **P-012** `todo` Remove the dead `bullmq` / `@nestjs/bullmq` / `ioredis` / `redis` deps (D-007); reconcile
  the lockfile so `npm ci` stays green. (S)
- **P-013** `todo` Once Phase 1 + 2 are validated in production, **delete the old timer paths and the
  migration flag** (completes D-011). (S)

> **Excluded — not a background timer:** "doc-build" is `npm run build` from `apps/operator-docs`, run manually
> / at operator build, not a `setInterval`/cron job. Verified; nothing to migrate.
- **P-018** `todo` Classify 4 more timer-class sweeps surfaced by the dbos-durable-flows audit (its P-008 hand-off): `pr-host/poll-daemon.ts` (setInterval — PR poll), `harness/wave-advance-sweep-live.ts` (setInterval — wave advance), `expert-triggers.ts` (expert-dispatcher), `attention-notify.ts` (device-push-credentials refresh). For each: migrate→scheduled-workflow (skip-missed) vs stay-and-why, same as the other P-008 timers. Source-verified they exist 2026-06-02.


## Phase 3 — Orchestrator durability (gate APPROVED, D-012)

The high-value tier. The gate is passed (D-012 — route the orchestrator through DBOS); it stays sequenced
after Phase 0 proves the substrate, and it touches the live orchestrator + its run-state machinery, so land it
carefully.

- **P-014** `todo` **Design spike (gate approved, D-012):** wrap the
  scoper→architect→worker→validator→reviewer pipeline as a DBOS durable workflow, each `invoke()` a checkpointed
  step. Spike one feature's pipeline; quit the operator mid-`worker`; confirm restart resumes at `worker`
  without re-running `scoper`/`architect`. **Implement option (i) of D-008** — pin + a `patched()`-style
  versioning discipline for incompatible pipeline changes — to get true cross-update resume; fall back to (ii)
  same-version-only **only** if the discipline proves untenable. Demonstrate a resumed run never reattaches to
  the **wrong checkpoint**, and that dynamic LLM routing survives (D-004). blocked-by: P-002 (L)
- **P-015** `todo` Reconcile run-state ownership so the DBOS workflow is the single source of truth for "is
  this pipeline running": re-scope the in-memory **lane pool** (`lanes.ts`, persisted to `lanes.json` — the UI
  reads that file, so the replacement must preserve that surface), the **agent-run reaper**
  (`lib/harness-status-sweep.ts` — stale `agent_runs.running` + `harness_lanes`, PID-liveness), and the
  `harness_shared.spawned_agents` status transitions, to avoid double-ownership (cross-ref
  `production-readiness-test-coverage-2026-05-30` P-010). Note: `backup/orphan-cleanup.ts` is the *snapshot*
  reaper and is out of scope here. blocked-by: P-014 (L)
- **P-016** `todo` Reconcile with the distributed **orchestrator-claim** arbitration in the dogfood plans
  (Autobase merge-order / Hypercore claim): decide how a DBOS workflow ID relates to a feature claim so the two
  don't fight over "who owns F-NNN". blocked-by: P-014 (L)
- **P-017** `todo` **Extend the `/admin` DBOS tab (P-007) to surface orchestrator pipeline workflows:**
  per-feature pipeline run, current / last-completed step, and resume status after a restart — so a recovered
  (or stuck-`PENDING`, version-mismatched) agent run is visible, not silent. blocked-by: P-014 (M)

## Risks & open questions

- **App-version recovery across upgrades (resolved into D-008 + D-012 + P-002).** The single sharpest risk;
  Phase-0 gate proves cross-version resume, D-012 commits to option (i)'s versioning discipline, P-014 proves
  it on the real pipeline. If the discipline turns out untenable, Tier B falls back to same-version-only.
- **Embedded-PG migrations on app upgrade.** DBOS migrates its own `dbos` system schema at launch and that
  schema can change across SDK versions, so this **interacts with D-008 version pinning** — resolve the two
  together in P-001, not separately.
- **Throughput ceiling.** Step checkpointing amplifies PG writes, capping throughput below graphile-worker — a
  non-issue at our volume (handful of jobs/min), noted so nobody points DBOS at a firehose.
- **Ecosystem maturity.** DBOS is younger (~53k weekly npm DL vs pg-boss ~637k). Mitigation: Tier A is small,
  flag-gated, and reversible — pg-boss is a drop-in for the background-job half if DBOS disappoints.
- **Connection budget.** DBOS's pool + per-queue pollers on top of the existing pools — *confirm headroom in
  P-001.*

## Alternatives considered

| Option | Why not (for Papercusp) |
| --- | --- |
| **BullMQ** (Restart's choice) | Needs Redis — a new bundled process per desktop install; breaks "embedded-pg only". |
| **pg-boss** | Excellent, mature, zero-infra — but a pure queue. Solves Tier A only; nothing for orchestrator resume. The fallback if DBOS disappoints. |
| **graphile-worker** | Same as pg-boss, plus sub-ms LISTEN/NOTIFY we don't need. Still no durable execution. |
| **pgmq** | A Postgres *extension* — shipping/compiling it into the embedded PG is the bundling friction we avoided by skipping Redis. |
| **pg-workflows / pgflow** | Durable workflows on PG, but immature/single-maintainer or Supabase-coupled. |
| **Hatchet / Windmill / Trigger.dev / Temporal** | Separate servers (often +RabbitMQ / +Redis / +S3). Heavy to bundle in a local-first desktop app. |
| **Inngest / Agenda / Faktory** | Cloud-first, or reintroduce Mongo / a standalone daemon. |

**Chosen: DBOS Transact** — the only zero-extra-infra option covering *both* tiers (background jobs now,
orchestrator durability later) on the Postgres we already ship.
