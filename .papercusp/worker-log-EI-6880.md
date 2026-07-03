# Worker log — EI-6880 (auto-implement)

**Item:** EI-6880 — Background routine "gym-cycle" is failing (kind=bug)
**Outcome:** `improvements:resolve { outcome: 'needs-human' }` (protected-surface STOP condition)

## What I did
Read the item, verified the live routine state against PG, confirmed the reported "failure"
is a self-heal breadcrumb (not a genuine wedge), and confirmed the durable class fix lands
entirely on STOP-condition protected surfaces. Identical class to EI-6061 and EI-6083.

## Root cause (verified — identical class to EI-6061 / EI-6083)
- The error text ("DBOS routineFire produced no DBOS operation output; executor reaper
  cancelled the stuck fire and requeued the routine") is stamped by `dbos-executor-reaper`
  into `harness_shared.routines.metadata.last_error` as a **self-heal breadcrumb** when it
  requeues a stuck fire — i.e. "I recovered this routine", NOT a genuine failure.
- `collectRoutineFailureSignals` (`packages/operator-core/lib/harness/improvements/watchdog.ts`
  L1049 — the self-improvement loop's own code) fires on ANY non-empty `metadata.last_error`
  regardless of `metadata.last_error_source`, so it files a phantom "routine X is failing" bug.
- `routineFailureSignalsFromRows` (L1034) is unchanged since EI-6061/EI-6083 were investigated —
  the proposed class fix has NOT landed.

## Evidence (dev:pg_query, 2026-07-03 ~09:30 ET)
- `harness_shared.routines` name='gym-cycle', install='papercusp': `active=true`,
  `last_fired_at=2026-07-03 09:10:03`, `next_fire_at=2026-07-03 09:40:00`,
  `last_error=NULL`, `last_error_source=NULL`, `reaped_count=NULL`.
  → The routine is firing normally on schedule; the reported symptom no longer exists (self-healed).
- `collectRoutineFailureSignals` source query still selects on `COALESCE(metadata->>'last_error','') <> ''`
  with no `last_error_source` guard — the phantom-signal path is intact.
- **61 open** engineer_issues carry a `payload.watchdogKey LIKE 'routine-failure:%'` — the class
  is flooding the improvement queue.
- Prior tracking items EI-6061 and EI-6083 are BOTH still `state=open` (terminal_owner=NULL) —
  two prior `needs-human` routings on this exact class have not yet been actioned.

## Why needs-human (STOP condition)
The durable class fix must live in either:
- `packages/operator-core/lib/harness/improvements/watchdog.ts` — the self-improvement loop's own code, or
- `packages/operator-core/lib/dbos/dbos-executor-reaper.ts` — the routines/DBOS scheduler.
Both are explicit protected surfaces in the implement auto-fix gate (operator-core safety +
"the self-improvement loop's own code" + "the routines/DBOS scheduler"). An auto-fixer must not
retune the watchdog that decides what to auto-fix: a mis-scoped filter would silently swallow a
GENUINE routine wedge (e.g. a real git-sync-stall `runner`-sourced error), which is exactly the
failure mode this gate prevents. No code changed.

## Proposed durable fix (carried from EI-6061 / EI-6083 — for the human)
- **(A, preferred, smaller):** in `collectRoutineFailureSignals` / `routineFailureSignalsFromRows`,
  also SELECT `metadata->>'last_error_source'` + `metadata->>'reaped_count'`, and DROP rows where
  `last_error_source = 'dbos-executor-reaper'` UNLESS `reaped_count >= N` (e.g. 3 = never self-heals).
  This is safe: genuine failures are `runner`-sourced (git-sync stalls, real wedges) and stay untouched.
- **(B):** in `dbos-executor-reaper.ts`, write the self-heal breadcrumb under a non-`last_error`
  key (e.g. `metadata.last_reap`) and only promote to `last_error` after N consecutive reaps.
- **Regression test** (`watchdog.test.ts`): `routineFailureSignalsFromRows` drops a single-reap
  `dbos-executor-reaper` marker, STILL fires on a `runner`-sourced error, and STILL fires on a
  high `reaped_count` reaper marker.
- **Value:** clears the recurring class (61 open phantom EIs) that wastes the auto-implement loop's
  dispatch budget. Two prior needs-human routings (EI-6061, EI-6083) sat un-actioned — please
  prioritize the small watchdog change.

## For a validator to re-verify
- No code was changed (protected-surface route). Confirm the resolve landed.
- Duplicate class of EI-6061 / EI-6083; the class fix should be actioned once for all three (+ 58 others).
