# Worker log — EI-6083 (auto-implement)

**Item:** EI-6083 — Background routine "overwatch-wake" is failing (kind=bug)
**Outcome:** `improvements:resolve { outcome: 'needs-human' }` (protected-surface STOP condition)

## What I did
Read the item, traced the failing signal against live PG, confirmed the instance has
self-healed and the durable class fix lands entirely on STOP-condition protected surfaces.

## Root cause (verified — identical class to EI-6061)
- The error text ("DBOS routineFire produced no DBOS operation output; executor reaper
  cancelled the stuck fire and requeued the routine", source `dbos-executor-reaper`) is a
  **self-heal breadcrumb** the reaper stamps into `harness_shared.routines.metadata.last_error`
  when it requeues a routine — NOT a genuine routine failure.
- `collectRoutineFailureSignals` (`packages/operator-core/lib/harness/improvements/watchdog.ts`
  — the self-improvement loop's own code) fires on ANY non-empty `metadata.last_error`
  regardless of `last_error_source`, so it filed this phantom "overwatch-wake is failing" bug.
- `clearStaleReaperLastError` only clears the marker on the routine's next successful fire.

## Evidence (dev:pg_query on harness_shared.routines, name='overwatch-wake')
- Active install `papercusp-workspace`: `active=true`, `last_fired_at=2026-07-02 05:26:37`,
  `next_fire_at=2026-07-02 05:33:48`, `last_error=NULL`, `last_error_source=NULL`,
  `reaped_count=NULL`. The routine is firing normally on schedule — healthy, not wedged.
- The two other rows (`*`, `papercup`) are `active=false` legacy installs, also `last_error=NULL`.
- The instance is transient and already gone; the reported symptom no longer exists.

## Why needs-human (STOP condition)
The durable class fix must live in either:
- `packages/operator-core/lib/harness/improvements/watchdog.ts` — the self-improvement loop's own code, or
- `packages/operator-core/lib/dbos/dbos-executor-reaper.ts` — the routines/DBOS scheduler.
Both are explicit protected surfaces in the implement gate. A wrong change here would silence
genuine routine wedges (e.g. the git-sync-stall signal), which is exactly what the gate prevents.
The triage decision for this item was also already `gate → human`.

## Proposed durable fix (for the human / next attempt) — carried from EI-6061
- **(A, preferred, smaller):** in `collectRoutineFailureSignals`, skip rows where
  `metadata->>'last_error_source' = 'dbos-executor-reaper'` UNLESS `metadata->>'reaped_count'`
  exceeds a genuine-wedge threshold (e.g. `>= 3` consecutive reaps = never self-heals).
- **(B):** in the reaper, write the self-heal breadcrumb under a non-`last_error` key
  (e.g. `metadata.last_reap`) and only promote to `last_error` after N consecutive reaps.
- **Regression test:** assert `routineFailureSignalsFromRows` drops a single-reap reaper marker,
  still fires on a `runner`-sourced error, and still fires on a high `reaped_count`.

## For a validator to re-verify
- No code was changed (protected-surface route). Confirm the resolve landed.
- This is a duplicate class of EI-6061; the class fix is already tracked there.
