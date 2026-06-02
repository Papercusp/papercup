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

**State:** Captured from an app-wide DBOS-adoption audit (2026-06-02). The existing `dbos-durable-jobs-2026-05-31` arc already covers the **orchestrator pipeline** + the **periodic timers**. This plan captures the gap it explicitly left open ("first define the rest"): durable **multi-step flows** that currently hand-roll the exactly-once / idempotency / lock+heartbeat / resume-mid-flow guarantees DBOS gives natively. Sibling plan `fleet-coordination-painpoints-2026-06-02` owns the monitoring improvements (whose health monitors are themselves DBOS scheduled workflows). No code written.

**Next:** human confirms scope + order (lead with provision/runner + outbox-drain) and resolves the one open question (does spawn-provisioning live here or fold into the fleet-coord spawn-bug investigation?), then implement.

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

- **P-001** `todo` Author a DBOS workflow for the `(harness, plugin)` setup/teardown/verify flow — steps = the existing runner stages, with DBOS's native exactly-once + durable resume REPLACING the hand-rolled operator-claims lock + heartbeat + configHash/scriptHash idempotency. A/B + revertible behind a flag (mirror the arc's `PAPERCUSP_DBOS_*`, skip-missed), reusing the existing single-run fn as the step body. importance: high
- **P-002** `todo` Verify a sandboxed script dying mid-run resumes / is idempotent, then DELETE the hand-rolled claims-lock + heartbeat + hash machinery it replaces (no shim — pre-alpha). blocked-by: P-001

## Phase 2 — outbox-drain (federation CDC) → DBOS

- **P-003** `todo` Author a DBOS workflow (or durable queue) for the `substrate_outbox` → Hypercore-append drain — native exactly-once replacing reliance on the `drained` flag + echo-guard; crash-safe mid-drain. A/B behind a flag. importance: high
- **P-004** `todo` Verify exactly-once under crash/restart; keep the echo-guard as defense-in-depth or drop it if DBOS subsumes it. blocked-by: P-003

## Phase 3 — snapshot / fork / restore → DBOS workflow

- **P-005** `todo` Author a DBOS workflow over discover → redact → shape → upload → import (+ restore) so a partial fork RESUMES from its last step instead of half-sharing, and a re-fork is idempotent. Subsumes the project-sharing spec's advisory-lock-for-concurrent-restore.

## Phase 4 — backup operations → DBOS workflow

- **P-006** `todo` Wrap backup create / restore / promote / rollback as DBOS workflows (multi-step + destructive → atomic-ish resume + exactly-once). The backup *scheduler tick* stays with the timers arc.

## Phase 5 — spawn provisioning → DBOS workflow

- **P-007** `needs-human` Make agent spawn-provisioning a DBOS workflow so a partial spawn is a recoverable *incomplete workflow* rather than silent empty-config-stub corruption. Decide whether this lives here or folds into the fleet-coord spawn-bug investigation (P-012 there). importance: high

## Phase 6 — timer-class candidates → hand to the existing arc

- **P-008** `todo` Route the remaining `setInterval` sweeps (`pr-host/poll-daemon`, `harness/wave-advance-sweep-live`, `harness-status-sweep`, `expert-dispatcher`, `device-push-credentials` refresh) into `dbos-durable-jobs-2026-05-31`'s "classify the rest" — tracked there as scheduled-workflow conversions, not duplicated here.

## Phase 7 — Tests & ship gate

- **P-009** `todo` Per-flow tests: crash/restart resume + exactly-once + idempotent re-run (DBOS's whole point). blocked-by: P-001, P-003
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

## Open questions
- Spawn-provisioning (Phase 5): own phase here, or fold into the fleet-coord spawn-bug investigation (P-012)?
- Order — confirm provision/runner + outbox-drain first.
- outbox-drain: DBOS workflow vs DBOS durable queue for the drain?
