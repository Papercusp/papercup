---
title: DBOS adoption — durable multi-step flows (audit follow-on)
slug: dbos-durable-flows-adoption-2026-06-02
status: draft
created: 2026-06-02
updated: 2026-06-02
owner: aviynw@gmail.com
---

# DBOS adoption — durable multi-step flows (audit follow-on)

## Now

**State:** P-001 shipped (provision→DBOS durable workflow). P-002 PARTIALLY done (2026-06-02): per the user's call, PAPERCUSP_DBOS_PROVISION flipped default OFF→ON — now `!== '0'` like the orchestrator/autoloop/timers (commit 3bd5e1e1c; comments + test updated). Verified: 14 flag-unit + 8 provision-workflow-unit + 4 live-DBOS integration tests green, AND live end-to-end on the running :3070 against the real `sheets` harness (default workspace): provision queue registered at boot by default, route routed through startProvisionWorkflow, dbos.workflow_status row `provision:default:sheets:...:setup` → SUCCESS, sandboxed setup script ran (exit 0). Test plugin + all its PG/FS artifacts cleaned up. The legacy operator-claims machinery now survives ONLY as the `=0` revert path. See D-009.

**Next:** P-002 remaining (user decision): (a) live crash-resume check — kill the operator mid-provision and confirm DBOS resume/idempotency (integration tests prove dedup+resume against real DBOS; a live mid-run kill wasn't run as it's disruptive); then (b) DELETE operator-claims.ts + the runner's legacy claim branch (no shim — removes the =0 revert). Also still open: P-003/5/6 confirm-skip-or-pair, P-010 ship gate.

## Background — the audit

DBOS (`@dbos-inc/dbos-sdk`) is this app's durable-execution layer (Postgres-backed; no Redis — BullMQ is **not** installed). Already on DBOS: the harness orchestrator pipeline (`lib/dbos/orchestrator-*`), AutoLoop, and the periodic-timer migration (`periodic-workflows.ts` — telemetry-flush, scratch-gc, memory-cleanup, completion-ref-verifier, embed-backfill, with "classify the rest" open).

The audit swept `setInterval`/`setTimeout` workers + multi-step async flows for where DBOS's value is highest — flows that **reinvent** what DBOS provides:

| Flow | What it hand-rolls today → DBOS replaces | Value |
|---|---|---|
| `provision/runner` (plugin setup/teardown/verify) | operator-claims lock + heartbeat + configHash/scriptHash idempotency + sandbox, across 48 await/retry lines | **high** |
| `sync/hyperbee/outbox-drain` (feature/issue federation CDC) | exactly-once via a `drained` flag + echo-guard; crash mid-drain risks re-append/loss | **high** |
| snapshot / fork / restore (`snapshot-discovery`→`-config-redact`→`-shape`→upload→import) | a long multi-step share/restore with no resume — partial failure half-shares/corrupts | med-high |
| `backup` ops (create/restore/promote/rollback) | multi-step + destructive, no atomic resume | med |
| spawn provisioning (`plugin-spawn-impl`/`spawn-config`) | partial spawn → silent empty-config-stub corruption (fleet-coord P-012) | med |

Timer-class candidates (`pr-host/poll-daemon`, `harness/wave-advance-sweep-live`, `harness-status-sweep`, `expert-dispatcher`, `device-push-credentials` refresh) are NOT new work here — they belong to the existing arc's "classify the rest" (Phase 6 hands them off).

## Phase 1 — provision/runner → DBOS workflow

- **P-001** `done` Author a DBOS workflow for the `(harness, plugin)` setup/teardown/verify flow — steps = the existing runner stages, with DBOS's native exactly-once + durable resume REPLACING the hand-rolled operator-claims lock + heartbeat + configHash/scriptHash idempotency. A/B + revertible behind a flag (mirror the arc's `PAPERCUSP_DBOS_*`, skip-missed), reusing the existing single-run fn as the step body. importance: high (Shipped flag-gated PAPERCUSP_DBOS_PROVISION=1, default OFF e7918962e. dedupID=per-target mutex replaces operator_claims lock+TTL+heartbeat+runtime DDL, workflowID=resume key, route awaits getResult. 22 unit + 4 live-DBOS integration tests; 177 DBOS unit + provision/route suites green; legacy path unchanged when off.)
- **P-002** `needs-human` Verify a sandboxed script dying mid-run resumes / is idempotent, then DELETE the hand-rolled claims-lock + heartbeat + hash machinery it replaces (no shim — pre-alpha). blocked-by: P-001 (Risky live cutover — for the user per loop instruction. Verify provision under PAPERCUSP_DBOS_PROVISION=1 on a live desktop a real plugin setup mid-run + crash → resume, then DELETE operator-claims.ts + the runner's legacy claim branch no shim. The flag-gated A/B path P-001 is in place + tested; this is the flip + delete.)

## Phase 2 — outbox-drain (federation CDC) → DBOS

- **P-003** `needs-human` Author a DBOS workflow (or durable queue) for the `substrate_outbox` → Hypercore-append drain — native exactly-once replacing reliance on the `drained` flag + echo-guard; crash-safe mid-drain. A/B behind a flag. importance: high (DEFERRED pending user decision — see D-006. Code-read shows outbox-drain is a weak DBOS candidate deliberately at-least-once + idempotent projections; non-serializable Hypercore handle; NOTIFY trigger ill-fit. Recommend NOT migrating. Surfaced, not silently dropped.)
- **P-004** `needs-human` Verify exactly-once under crash/restart; keep the echo-guard as defense-in-depth or drop it if DBOS subsumes it. blocked-by: P-003 (Tied to P-003 deferred per D-006. Moot unless the user decides to migrate outbox-drain to DBOS.)

## Phase 3 — snapshot / fork / restore → DBOS workflow

- **P-005** `needs-human` Author a DBOS workflow over discover → redact → shape → upload → import (+ restore) so a partial fork RESUMES from its last step instead of half-sharing, and a re-fork is idempotent. Subsumes the project-sharing spec's advisory-lock-for-concurrent-restore. (See D-007. Source-verified: capture/restore take non-serializable onProgress/signal/runForwardMigrations abort threaded through internals; fork is non-idempotent random slug so a minimal single-step wrap creates duplicate forks on retry. Real fix is invasive on live fork logic. Do interactively with user.)

## Phase 4 — backup operations → DBOS workflow

- **P-006** `needs-human` Wrap backup create / restore / promote / rollback as DBOS workflows (multi-step + destructive → atomic-ish resume + exactly-once). The backup *scheduler tick* stays with the timers arc. (See D-008. Source-verified: @papercusp/backup is a borrowable lib "zero deps" so DBOS coupling is barred; high-value destructive ops restoreInPlace/promote/rollback are non-idempotent renames needing in-lib step decomposition; the cleanly-wrappable create op has only modest marginal value over existing inFlight+orphan-cleanup+kopia. Harden destructive trio with user.)

## Phase 5 — spawn provisioning → DBOS workflow

- **P-007** `done` Make agent spawn-provisioning a DBOS workflow so a partial spawn is a recoverable *incomplete workflow* rather than silent empty-config-stub corruption. Decide whether this lives here or folds into the fleet-coord spawn-bug investigation (P-012 there). importance: high (resolved D-005: folded into fleet-coord spawn-bug investigation P-012; DBOS-ify only if it's the right fix)

## Phase 6 — timer-class candidates → hand to the existing arc

- **P-008** `done` Route the remaining `setInterval` sweeps (`pr-host/poll-daemon`, `harness/wave-advance-sweep-live`, `harness-status-sweep`, `expert-dispatcher`, `device-push-credentials` refresh) into `dbos-durable-jobs-2026-05-31`'s "classify the rest" — tracked there as scheduled-workflow conversions, not duplicated here. (Handed off: added P-018 to dbos-durable-jobs-2026-05-31 Phase 2 listing the 4 sweeps poll-daemon, wave-advance-sweep-live, expert-triggers, attention-notify for migrate/stay classification there. Source-verified they exist.)

## Phase 7 — Tests & ship gate

- **P-009** `done` Per-flow tests: crash/restart resume + exactly-once + idempotent re-run (DBOS's whole point). blocked-by: P-001, P-003 (Done for the built scope: provision has 22 unit + 4 live-DBOS integration tests dedup/exactly-once/sequential-rerun. Outbox/snapshot/backup are needs-human not built so no per-flow tests owed there.)
- **P-010** `needs-human` Human sign-off before shipping. importance: urgent

## Decisions

### D-001 — Separate from the existing DBOS arc, sibling to the monitoring plan
Date: 2026-06-02
`dbos-durable-jobs-2026-05-31` = orchestrator pipeline + periodic timers (in flight). This plan = the audit's durable MULTI-STEP flows (the arc's open "define the rest"). `fleet-coordination-painpoints-2026-06-02` = the monitoring improvements (its health monitors are DBOS scheduled workflows per that plan's D-007). All three cross-reference; this one is the "convert existing hand-rolled flows to DBOS" track.

### D-002 — A/B + instantly revertible per flow
Date: 2026-06-02
Mirror the arc's proven shape: keep the EXISTING single-run function as the DBOS step body, flag-gate the new path, skip-missed, so each migration A/Bs and reverts by un-setting the flag — never a risky big-bang cutover of a load-bearing flow.

### D-003 — The DBOS workflow REPLACES the hand-rolled machinery (no shim)
Date: 2026-06-02
The win is deleting the reinvented lock/heartbeat/idempotency/exactly-once once the DBOS path is verified — not running both. Pre-alpha (no users): cut over fully rather than keep a compatibility layer. (Verify first, then delete — P-002/P-004.)

### D-004 — Priority by hand-rolled-machinery-replaced
Date: 2026-06-02
Lead with `provision/runner` (most hand-rolled duplication — claims-lock + heartbeat + hash) and `outbox-drain` (federation *correctness* — a crash there loses or duplicates federated content). Snapshot/backup/spawn follow.


### D-005 — Open questions resolved (user delegated)
Date: 2026-06-02
(1) Spawn-provisioning (P-007) folds into the fleet-coord spawn-bug investigation (P-012 there): root-cause the empty-config-stub bug FIRST, then DBOS-ify only if a durable workflow is the right fix. (2) outbox-drain = a DBOS WORKFLOW, not a durable queue — the drain is a sequential append per booted harness, no fan-out. (3) Implementation order: provision/runner + outbox-drain first (most hand-rolled machinery replaced + federation correctness), then snapshot/backup.
Related: P-003, P-007


### D-006 — Outbox-drain (P-003/P-004) is a WEAK DBOS candidate — defer pending user decision
Date: 2026-06-02
Date: 2026-06-02 (autonomous-loop finding, after reading the actual source `apps/operator/lib/sync/hyperbee/outbox-drain.ts`). The audit-level premise of P-003 ("exactly-once via a `drained` flag + echo-guard; crash mid-drain risks re-append/loss") is **contradicted by the code**: (1) delivery is DELIBERATELY at-least-once (header D-4) with idempotent projections (LWW + `INSERT … ON CONFLICT`), so a re-append is BY DESIGN harmless — exactly-once is not even the goal; (2) loss is already prevented — `drained_at` is set ONLY after `append` resolves, so a crash mid-drain re-drains the row. The only gap DBOS would close is a double-append when a crash lands between `append` resolving and the `drained_at` UPDATE committing — which the design already declares harmless. Against that marginal benefit, DBOS adds real cost: `drainOutboxOnce` takes a non-serializable live Hypercore `handle` (would need an injected handle-registry seam), and the trigger is reactive NOTIFY+poll per-process (a poor fit for DBOS's scheduled/explicitly-triggered, serializable-input model — a workflow-per-NOTIFY is heavy). RECOMMENDATION: do NOT migrate outbox-drain to DBOS; its current at-least-once + idempotent-projection design is correct and simpler. P-003/P-004 set to `deferred` pending user confirmation. Provision/runner (P-001) — which has genuine hand-rolled machinery (operator_claims table + advisory lock + 30s heartbeat + TTL + runtime DDL) — proceeds.
Related: P-003, P-004, P-001


### D-007 — Snapshot/fork/restore (P-005) — needs-human; clean A/B not viable autonomously
Date: 2026-06-02
Date: 2026-06-02 (autonomous-loop finding, source-verified in libs/papercusp-export-state/src/{capture,restore}.ts + alter-schema.ts). Medium DBOS value but two real barriers to a clean flag-gated A/B: (1) NON-SERIALIZABLE inputs — `capture()`/`restore()` take `onProgress` callbacks, a `signal: AbortSignal` threaded through internals (scanForSecrets, drain — abort is load-bearing for autonomous drainMode), and a `runForwardMigrations` callback. DBOS workflow inputs must be serializable, so this needs the progress/abort/migration paths re-architected through seams. (2) The fork is NON-IDEMPOTENT (random `_fork_<suffix>` slug + half-copied FS files), so a minimal single-step wrap (like provision) would create DUPLICATE forks on crash-retry — strictly WORSE — while the real value (resume) needs multi-step idempotent checkpointing of the live fork logic (alter-schema + file copy + grants + registry). It already has DB-side resume (pg_advisory_lock on the original slug + a `_restoring` schema). RECOMMENDATION: do this WITH the user, interactively — it touches the live snapshot/fork UX + needs seam refactors; not an autonomous-loop fit. Set needs-human.
Related: P-005


### D-008 — Backup ops (P-006) — needs-human; borrowable-lib + non-idempotent barriers
Date: 2026-06-02
Date: 2026-06-02 (autonomous-loop finding, source-verified in packages/backup/src/workspace-backup.ts + BORROWABLE.md). All 5 ops (snapshot/restoreToClone/restoreInPlace/promoteRestore/rollbackPromote) have SERIALIZABLE inputs + are discrete request/response — good shape. BUT: (1) `@papercusp/backup` is a BORROWABLE lib with an explicit "Zero @papercusp/@restart runtime deps" contract — coupling it to DBOS is barred; DBOS must live operator-side (as the scheduler tick already does, host-injected). (2) The HIGH-value ops are the destructive trio (restoreInPlace/promoteRestore/rollbackPromote) = non-idempotent FS renames; a single-step operator-side wrap gives no resume value (re-running rename fails) and the real fix (step-level forward-resume) needs idempotent-rename decomposition INSIDE the borrowable lib. (3) The cleanly single-step-wrappable op (create `snapshot()`, ~idempotent + kopia content-addressed) has only MODEST marginal value — existing scheduler inFlight-Map + orphan-cleanup sweep + kopia dedup already cover the practical cases; DBOS would add durable cross-restart in-flight dedup (a non-destructive nicety). RECOMMENDATION: harden the destructive trio WITH the user (destructive + rare + touches a borrowable lib's API); not an autonomous-loop fit. Set needs-human.
Related: P-006


### D-009 — PAPERCUSP_DBOS_PROVISION flipped to default-ON (P-002 part 1) + live-verified on sheets
Date: 2026-06-02
Date: 2026-06-02 (user-directed). The DBOS provision workflow is now the DEFAULT path. `dbosProvisionActive()` changed from `=== '1'` (opt-in) to `!== '0'` (default-on, revert with PAPERCUSP_DBOS_PROVISION=0), matching the orchestrator/autoloop/timers flags; still gated by the master PAPERCUSP_DBOS_ORCHESTRATOR=0 revert. Commit 3bd5e1e1c (dbos-flags.ts + its test + the bootstrap.ts/provision-workflow.ts comments).

Verification: 14 flag-unit + 8 provision-workflow-unit + 4 live-DBOS integration tests (dedup mutex / sequential re-run / concurrent-distinct / durable result) green. LIVE end-to-end on the running :3070 host: restarted the dev-api service (default-on engages at boot — DBOS launched, provision queue registered with NO env override), then POST /api/provision/run for a throwaway harmless plugin on the real `sheets` harness (default workspace) → result runId `dbos-*` (runner's DBOS branch: claim+heartbeat stood down) + dbos.workflow_status row `provision:default:sheets:papercusp-dbos-provision-test:setup:<nonce>` SUCCESS on queue `provision`, sandboxed setup script exit 0, resource recorded via the FIFO/WAL bridge, dedup slot freed on completion. All test artifacts (global-plugins dir, FS scratch, provision_state/provision_audit_log rows, the dbos workflow row) cleaned up.

REMAINING for full P-002 (still needs-human — irreversible, gates on a verify): (1) a LIVE crash-resume — kill the operator mid-provision, confirm DBOS resumes the in-flight workflow and the re-run is idempotent (the integration suite proves this against real DBOS, but a live mid-run kill on the shared box was not performed); (2) DELETE operator-claims.ts + the runner's legacy claim/heartbeat branch (no shim, pre-alpha per D-003) — this removes the `=0` revert path, so it should follow (1).
Related: P-002

## Open questions
- Spawn-provisioning (Phase 5): own phase here, or fold into the fleet-coord spawn-bug investigation (P-012)?
- Order — confirm provision/runner + outbox-drain first.
- outbox-drain: DBOS workflow vs DBOS durable queue for the drain?
