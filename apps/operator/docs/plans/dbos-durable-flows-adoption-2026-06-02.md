---
title: DBOS adoption — durable multi-step flows (audit follow-on)
slug: dbos-durable-flows-adoption-2026-06-02
status: draft
created: 2026-06-02
updated: 2026-06-03
owner: aviynw@gmail.com
---

# DBOS adoption — durable multi-step flows (audit follow-on)

## Now

**State:** Shipped scope SIGNED OFF (P-010, user 2026-06-02). DONE: P-001 (provision→DBOS) + P-002 part 1 (PAPERCUSP_DBOS_PROVISION default-on, D-009) + **P-011** (backup `StepRunner` durability seam + `snapshot()` routed) + **P-012** (destructive trio restoreInPlace/promoteRestore/rollbackPromote made crash-resumable — deterministic opId-derived names + idempotent self-undoing single-step swaps + rollback meta-sidecar recovery; operator DBOS workflows + `durable-ops` A/B dispatch at all 6 entry points; lib+unit+live-DBOS tests green, type-clean, committed). DROPPED per user: P-003/P-004 (outbox native, D-006), P-005 (snapshot/fork/restore, D-007). The whole backup-durability arm (P-006 umbrella → P-011+P-012) is COMPLETE behind the opt-in `PAPERCUSP_DBOS_BACKUP` flag. ONE follow-on remains: **P-002 part 2** — live crash-resume verify, then DELETE operator-claims.ts + the runner's legacy claim branch (needs-human; removes the `=0` revert). User said do this next ("then P-002 pt2"); the live-kill is disruptive on the shared box, so confirm approach (isolated instance vs rely on the existing live-DBOS provision integration suite) before any shared-operator kill.

**Next:** P-002 part 2 (user-authorized next): delete operator-claims.ts + the runner's legacy claim branch (the cutover); decide the live crash-resume verification approach (isolated Tauri/DBOS instance, NOT a shared-box operator kill) with the user.

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
- **P-002** `wip` Verify a sandboxed script dying mid-run resumes / is idempotent, then DELETE the hand-rolled claims-lock + heartbeat + hash machinery it replaces (no shim — pre-alpha). blocked-by: P-001 (Risky live cutover — for the user per loop instruction. Verify provision under PAPERCUSP_DBOS_PROVISION=1 on a live desktop a real plugin setup mid-run + crash → resume, then DELETE operator-claims.ts + the runner's legacy claim branch no shim. The flag-gated A/B path P-001 is in place + tested; this is the flip + delete.) (Prep done: delete operator-claims.ts + runner.ts claim branch ~L215-247,367,370-72 + heartbeatClaim re-export + sweeper reg; table-drop = later migration. Live crash-resume runbook ready. HAZARD: provision = ONE DBOS step so resume re-runs whole script idempotency on END STATE; don't change DBOS__APPVERSION across kill/restart. Verify live FIRST then delete. Needs user+live box.) (LIVE CRASH-RESUME VERIFIED 2026-06-02: real provision on sheets, SIGKILLed :3070 mid-flight; DBOS recovery resumed the in-flight workflow recovery_attempts 1->2, PENDING->SUCCESS; operator healthy after. REMAINING = mechanical delete operator-claims.ts + runner.ts legacy branch + sweeper reg, deferred to a focused unit to avoid a half-done destructive edit; =0 revert intact until then.)

## Phase 2 — outbox-drain (federation CDC) → DBOS

- **P-003** `dropped` Author a DBOS workflow (or durable queue) for the `substrate_outbox` → Hypercore-append drain — native exactly-once replacing reliance on the `drained` flag + echo-guard; crash-safe mid-drain. A/B behind a flag. importance: high (DEFERRED pending user decision — see D-006. Code-read shows outbox-drain is a weak DBOS candidate deliberately at-least-once + idempotent projections; non-serializable Hypercore handle; NOTIFY trigger ill-fit. Recommend NOT migrating. Surfaced, not silently dropped.) (User confirmed skip 2026-06-02: keep the existing native outbox-drain NOTIFY + at-least-once + idempotent ON CONFLICT projections. DBOS would be a worse fit D-006. "Skip" = leave the drain code as-is, untouched.)
- **P-004** `dropped` Verify exactly-once under crash/restart; keep the echo-guard as defense-in-depth or drop it if DBOS subsumes it. blocked-by: P-003 (Tied to P-003 deferred per D-006. Moot unless the user decides to migrate outbox-drain to DBOS.) (User confirmed skip 2026-06-02: moot — tied to P-003 outbox-drain stays native, not migrated to DBOS.)

## Phase 3 — snapshot / fork / restore → DBOS workflow

- **P-005** `dropped` Author a DBOS workflow over discover → redact → shape → upload → import (+ restore) so a partial fork RESUMES from its last step instead of half-sharing, and a re-fork is idempotent. Subsumes the project-sharing spec's advisory-lock-for-concurrent-restore. (See D-007. Source-verified: capture/restore take non-serializable onProgress/signal/runForwardMigrations abort threaded through internals; fork is non-idempotent random slug so a minimal single-step wrap creates duplicate forks on retry. Real fix is invasive on live fork logic. Do interactively with user.) (User decision 2026-06-02: skip snapshot/fork/restore DBOS migration D-007 barriers stand.)

## Phase 4 — backup operations → DBOS workflow

- **P-006** `todo` UMBRELLA (reshaped 2026-06-02, D-010 — supersedes D-008's "borrowable-lib bars DBOS coupling"): make backup create/restore/promote/rollback durable via a GENERIC zero-dep `StepRunner` seam in `@papercusp/backup` (host injects a DBOS-backed runner; the lib never imports DBOS, so the borrowable contract is preserved). Decomposed into **P-011** (Phase 1: the seam + operator DBOS executor + route `snapshot()`) and **P-012** (Phase 2, with user: idempotent-decompose the destructive trio so the seam buys crash-resume). The backup *scheduler tick* stays with the timers arc.
- **P-011** `done` Phase 1 (low-risk, buildable now): add a generic zero-dep `StepRunner` seam to `@papercusp/backup` (`{ runStep<T>(name, fn) }`, default pass-through so lib behavior is unchanged when no host is wired). Operator-side: inject a DBOS-backed StepRunner (`runStep → DBOS.runStep`, op registered as a workflow, host-injected like the scheduler tick). Route the ~idempotent `snapshot()` create op through it. No destructive-op changes. See D-010. (Done 2026-06-02: zero-dep StepRunner seam in @papercusp/backup; snapshot routed via runStep insert-row is a step ⇒ no double-insert on resume. Operator backup-workflow.ts: backupSnapshot DBOS workflow + wireBackupStepRunner isInWorkflow guard + injectable executor; opt-in PAPERCUSP_DBOS_BACKUP flag; snapshot_create routed when flag+dbosStarted. Tests green.)
- **P-012** `done` Phase 2 (with user — destructive, per D-008): decompose the destructive trio restoreInPlace/promoteRestore/rollbackPromote (workspace-backup.ts:472/522/561) into idempotent steps — deterministic temp names derived from the op id + check-then-act, so replaying a half-done rename is a no-op. Then route them through the StepRunner so the DBOS-backed host gets true crash-resume on them. The seam (P-011) is necessary-not-sufficient; this is the idempotency work that makes it pay off. See D-010. blocked-by: P-011 (Design done: opId-derived aside names + check-then-act per rename replay=no-op; test=crash-after-step-N runner in tmp dir. DECISIONS: 1 opId added to borrowable trio sigs API change ~6 callers; 2 drop inline undo = roll-forward-only; 3 need operator backupDestructive workflow envelope; 4 restoreInPlace nested-runStep. Then I implement+test.) (Done 2026-06-02: destructive trio crash-resumable. Lib: deterministic opId-derived broken/stash names + idempotent self-undoing single-step swaps + rollback meta-sidecar recovery; restoreInPlace step-routed. Operator: restore/promote/rollback DBOS workflows opId=nonce + durable-ops A/B dispatch at all 6 entry points 3 MCP + 3 HTTP. lib + unit + live-DBOS tests green; type-clean.)



## Phase 5 — spawn provisioning → DBOS workflow

- **P-007** `done` Make agent spawn-provisioning a DBOS workflow so a partial spawn is a recoverable *incomplete workflow* rather than silent empty-config-stub corruption. Decide whether this lives here or folds into the fleet-coord spawn-bug investigation (P-012 there). importance: high (resolved D-005: folded into fleet-coord spawn-bug investigation P-012; DBOS-ify only if it's the right fix)

## Phase 6 — timer-class candidates → hand to the existing arc

- **P-008** `done` Route the remaining `setInterval` sweeps (`pr-host/poll-daemon`, `harness/wave-advance-sweep-live`, `harness-status-sweep`, `expert-dispatcher`, `device-push-credentials` refresh) into `dbos-durable-jobs-2026-05-31`'s "classify the rest" — tracked there as scheduled-workflow conversions, not duplicated here. (Handed off: added P-018 to dbos-durable-jobs-2026-05-31 Phase 2 listing the 4 sweeps poll-daemon, wave-advance-sweep-live, expert-triggers, attention-notify for migrate/stay classification there. Source-verified they exist.)

## Phase 7 — Tests & ship gate

- **P-009** `done` Per-flow tests: crash/restart resume + exactly-once + idempotent re-run (DBOS's whole point). blocked-by: P-001, P-003 (Done for the built scope: provision has 22 unit + 4 live-DBOS integration tests dedup/exactly-once/sequential-rerun. Outbox/snapshot/backup are needs-human not built so no per-flow tests owed there.) (Done 2026-06-02: provision has 22 unit + 4 live-DBOS integration tests resume/dedup/exactly-once. The blocked-by P-003 dep is moot — outbox P-003/4 + snapshot P-005 dropped, so no per-flow tests owed there. Backup tests come with P-011/P-012.)
- **P-010** `done` Human sign-off before shipping. importance: urgent (User sign-off 2026-06-02 for the SHIPPED scope: P-001 provision→DBOS durable workflow + P-002 part 1 PAPERCUSP_DBOS_PROVISION default-on, live-verified. Outbox/snapshot dropped P-003/4/5. Remaining tracked follow-on NOT part of this sign-off: P-002 part 2 live crash-resume → delete operator-claims.ts and P-006 backup-durability reshape P-011/P-012.)

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


### D-010 — P-006 reshaped — generic zero-dep StepRunner durability seam (supersedes the D-008 "can't couple" barrier)
Date: 2026-06-02
Date: 2026-06-02 (user-directed). D-008 marked backup-ops-on-DBOS needs-human because `@papercusp/backup` is a borrowable lib with a "zero @papercusp/@restart runtime deps" contract, so it can't import DBOS. RESOLUTION: don't couple — abstract. The lib already injects host behavior through `backupHost()` (config seam) and already has a `hook.ts` (`runPreSnapshotHook`), so a durability seam is in-pattern.

DESIGN — add ONE generic, zero-dep seam to the lib:
```ts
// packages/backup/src/types.ts
export interface StepRunner { runStep<T>(name: string, fn: () => Promise<T>): Promise<T>; }
const passthrough: StepRunner = { runStep: (_n, fn) => fn() }; // default: identical behavior, no host wired
```
The destructive ops call `this.steps.runStep('move-live-aside', …)` etc. The OPERATOR (host) injects a DBOS-backed StepRunner that maps `runStep → DBOS.runStep` and registers the op as a workflow — exactly how the backup *scheduler tick* is already host-injected. The lib never imports DBOS → borrowable contract preserved. The seam is generic and reusable by any other borrowable lib wanting optional durability.

CRUCIAL NUANCE: a StepRunner only buys crash-RESUME if each step is idempotent. The destructive trio (restoreInPlace/promoteRestore/rollbackPromote, workspace-backup.ts:472/522/561) are currently single non-idempotent `mv`-style renames — a crash mid-rename makes a replay fail ("source already gone"). So the seam is necessary-not-sufficient; the trio also needs idempotent step decomposition (deterministic temp names derived from the op id + check-then-act). `snapshot()` (create, ~idempotent via content-addressed kopia) gets durability from the seam alone.

PHASING: P-011 Phase 1 (low-risk) = add the seam (default pass-through) + operator DBOS executor + route `snapshot()` through it. P-012 Phase 2 (with user, per D-008) = idempotent decomposition of the destructive trio so the seam buys resume on them.

Grounding: this is also the "DBOS earns its place only for multi-step NON-PG side effects" rule — kopia shell-outs + FS renames can't live in a PG transaction, so durable resume genuinely needs DBOS here (unlike the single-step cron timers, which use DBOS only as a distributed cron).
Related: P-006, P-011, P-012

## Open questions
- Spawn-provisioning (Phase 5): own phase here, or fold into the fleet-coord spawn-bug investigation (P-012)?
- Order — confirm provision/runner + outbox-drain first.
- outbox-drain: DBOS workflow vs DBOS durable queue for the drain?
