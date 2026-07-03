# Worker log — EI-6855 (auto-implement / self-improvement loop)

**Item:** EI-6855 — Background routine "coord-probe-canary" is failing (kind=bug)
**Outcome:** `improvements:resolve { outcome: 'fixed' }` — self-healed reaper phantom, symptom verified gone.

## What I did
Read the item, matched its error string to the known reaper-self-heal-phantom class
(agent-insight `routine-failure-ei-is-usually-a-reaper-self-heal-phantom`), traced the
collector against the live routine code, and confirmed against LIVE PG that the marker has
already cleared and the routine is healthy.

## Root cause (verified — the reaper self-heal phantom class)
- The EI's error text — *"DBOS routineFire produced no DBOS operation output; executor reaper
  cancelled the stuck fire and requeued the routine"*, source `dbos-executor-reaper` — is a
  **self-heal breadcrumb** `dbos-executor-reaper.ts` stamps into
  `harness_shared.routines.metadata.last_error` when it recovers a stuck fire. It means *"I
  recovered this routine"*, **NOT** that the routine action failed.
- `collectRoutineFailureSignals` (`packages/operator-core/lib/harness/improvements/watchdog.ts`)
  alarms on ANY non-empty `metadata.last_error` regardless of `last_error_source`, so the
  breadcrumb was misread as a failure and minted this "coord-probe-canary is failing" bug.
- `clearStaleReaperLastError` wipes the marker on the routine's next successful fire.
- The routine ACTION (`system:coord-probe-canary`, `coord-invariant-actions.ts`) itself is fine —
  it ran, filed nothing, and swept its own rows; the failure was never in the action.

## Evidence — symptom is GONE (live psql on harness_shared.routines, name='coord-probe-canary')
DB time `2026-07-03 07:29:02 EDT`:
- `active = true`
- `last_error = ''` (empty — marker cleared by a successful fire)
- `last_error_source = ''`, `last_error_at = null`, `reaped_count = null`
- `last_fired_at = 2026-07-03 07:12:53`, `next_fire_at = 2026-07-03 07:22:00`
- Scheduler is healthy: EVERY active routine (git-sync, cross-hive-outbox-drain,
  coord-probe-canary) shows the same uniform ~7-9 min batch-tick lag — normal tick cadence, not
  a wedge. coord-probe-canary is `has_err=false` while other routines still carry markers.

Triage per the runbook: a phantom is resolved `fixed` when `last_fired_at > last_error_at` (the
routine already fired successfully after the marker). Here `last_error` is null entirely — the
condition is met and the symptom no longer exists. Not reproducible.

## Why fixed (not needs-human)
The authoritative runbook (`agent-insights/routine-failure-ei-is-usually-a-reaper-self-heal-phantom`,
2026-07-02) is explicit: **"resolve the individual phantom instances `fixed` with the query
evidence"**, while the durable **class** fix (make `collectRoutineFailureSignals` source-aware —
skip `dbos-executor-reaper` markers unless `reaped_count >= N`) is a STOP-surface (watchdog.ts /
dbos-executor-reaper.ts) tracked separately to a human on **EI-6061** (confirmed still `open`).
Re-routing this instance to needs-human would just re-flood the human queue with a duplicate of an
already-tracked class — the exact anti-pattern the runbook was written to stop. No code change is
warranted for the instance: it is genuinely gone.

## For a validator to re-verify
- No code changed. Confirm the resolve landed and EI-6855 left the open queue.
- Re-run the triage query if desired; `metadata.last_error` for `coord-probe-canary` should be
  empty and the routine active + firing.
- The durable class fix remains tracked on EI-6061 (needs-human).
