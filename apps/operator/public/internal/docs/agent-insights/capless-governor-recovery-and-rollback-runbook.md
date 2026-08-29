# Runbook — capless governor recovery and rollback
URL: /internal/docs/agent-insights/capless-governor-recovery-and-rollback-runbook

Runbook: what survives a restart or failover, the ordered rollback procedure and its contract, and the exact commands that verify a recovery actually held.

## What survives, and what is supposed not to

| thing                         | survives a restart / failover?                     | why                                               |
| ----------------------------- | -------------------------------------------------- | ------------------------------------------------- |
| queued rows + receipt ids     | **yes** — canonical `harness_shared.work_items`    | the durable substrate is the queue (D-006)        |
| receipt identity under replay | **yes** — same `idempotencyKey` → same `receiptId` | partial unique index                              |
| execution leases              | expire and are re-leasable                         | a dead holder must not pin work forever           |
| controller windows / feedback | restored from a snapshot, then **re-evaluated**    | it is transient feedback, never a ceiling (D-014) |
| health baselines              | re-warmed                                          | a stale baseline would mis-judge a fresh host     |

A restored controller snapshot is a **resume point, not a limit**: invalid rows are dropped class-by-class, and the next `step` expires stale feedback before exposing a decision, so a damaged or old snapshot can never become an admission ceiling.

## Recovery after a crash or failover

1. **Do nothing to the queue.** No `DELETE`, no truncate, no "clear the backlog". Every row is a receipt somebody holds.
2. Let expired leases lapse. `leaseNext` re-opens rows whose lease expired; that path is the failover, and it is exercised on real Postgres by the drain test.
3. **Replay the identical requests** if a caller lost its handle. Same key → same receipt, no duplicate row.
4. Read `governor.queue` and `governor.recovery`. `recovering` is the expected state; `stalled` means probing is not resuming — see the alert-response runbook before touching the controller.
5. Confirm the health writers came back. A governor whose cells read `unknown` is blind, and a blind governor holds its window rather than probing.

## Rollback

The contract is D-017, stated exactly: rollback **preserves queue, receipts, state history and telemetry**; it may **temporarily** restore prior admission behavior; it may **not** establish a second permanent cap architecture.

Ordered procedure:

1. **Announce and record.** A rollback that nobody can find later is indistinguishable from a regression.
2. **Restore prior admission behavior only** — swap the admission driver, do not touch the durable store. New starts are admitted immediately; the queue is left exactly as it is.
3. **Cancel, never delete**, anything that must not run. Cancellation is a state on a preserved, auditable row.
4. **Keep telemetry armed.** The five `governor.*` cells stay registered through a rollback; they are the only way to judge whether rolling forward is safe.
5. **Roll forward** by re-attaching the governed driver. Every receipt still resolves; replay is safe.
6. **Never** leave a numeric cap behind as the "safe" resting state. A temporary control that outlives the incident is the failure mode this plan exists to remove.

## Verify a recovery actually held

```bash
# the rollback contract, clause by clause, against real Postgres
npm run test:file -- packages/operator-core/lib/resource-governor/p018-rollback-drill.integration.test.ts

# restart/failover, drain pacing and the queue-always property across every
# emulated machine profile and the 1/10/30/100/300/600 load ladder
npm run test:file -- packages/operator-core/lib/resource-governor/p017-profile-matrix.integration.test.ts

# no lane has silently regrown a cap, and every active lane still carries writer evidence
npm run lint:resource-governor-enforcement

# no bespoke reader has appeared beside the registered governor cells
npm run lint:no-bespoke-state-read
```

All four are the recurrence guards for this runbook: if a change makes a rollback lose a receipt, forget the queue, drop controller history, blind the telemetry, or reintroduce a ceiling, one of them goes red.

## Escalate when

* a receipt exists in SQL but `status()` answers `unknown` (namespace or schema-version drift);
* a contraction never expires, or `governor.recovery` reads `stalled` with healthy writers;
* any lane's `enforcement` row has moved back off `active` — a lane that is not `active` is **skipped entirely** by the scan, so a green lint over it scanned nothing (D-028).
