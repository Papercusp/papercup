# Worker log — EI-6081 (auto-implement)

**Item:** EI-6081 — Background routine "loop-su-aa97ae2c-47c1-45d1-8ff6-8b3b89774cad" is failing (kind=bug)
**Outcome:** `improvements:resolve { outcome: 'needs-human' }` (protected-surface STOP condition)

## What I did
Read the item, verified the root cause against the LIVE watchdog code (not just the prior
sibling comments), checked this specific routine's current PG state, then consolidated the
recurrence onto the class tracker and routed to a human.

## Root cause (verified against live code — 3rd instance of the same class)
- Error text ("DBOS routineFire produced no DBOS operation output; executor reaper cancelled
  the stuck fire and requeued the routine", source `dbos-executor-reaper`) is a **self-heal
  breadcrumb** the reaper stamps into `harness_shared.routines.metadata.last_error` when it
  requeues a stuck fire — NOT a genuine routine failure.
- Confirmed in code: `collectRoutineFailureSignals`
  (`packages/operator-core/lib/harness/improvements/watchdog.ts:1049`) selects
  `WHERE active = true AND COALESCE(metadata->>'last_error','') <> ''` and
  `routineFailureSignalsFromRows` (:1034) filters only on non-empty `last_error` —
  **neither filters on `last_error_source`**, so a reaper breadcrumb produces a routine-failure
  signal → the phantom "loop-su-… is failing" bug.

## Evidence (dev:pg_query on harness_shared.routines)
- `name='loop-su-aa97ae2c-47c1-45d1-8ff6-8b3b89774cad'`, `install_slug='*'`:
  `active=false`, `last_error=NULL`, `last_error_source=NULL`, `reaped_count=NULL`,
  `last_fired_at=2026-07-01 17:24:10`, `updated_at=2026-07-01 17:33:02`.
- The routine is a `loop:arm` loop tied to su session `aa97ae2c-…`; it has since been
  DEACTIVATED (loop ended) and its breadcrumb cleared. The collector requires `active=true`,
  so this instance no longer even matches. **Not reproducible — the reported symptom is gone.**

## Why needs-human (STOP condition)
The durable class fix must live in:
- `packages/operator-core/lib/harness/improvements/watchdog.ts` — the self-improvement loop's own code, or
- `packages/operator-core/lib/dbos/dbos-executor-reaper.ts` — the routines/DBOS scheduler.
Both are explicit STOP surfaces for the implement gate. A wrong change here would silence
GENUINE routine wedges (e.g. a real git-sync stall), which is exactly what the gate protects.
The item's own triage was already `gate → human`.

## Consolidation done this run
- Linked EI-6081 `duplicates` EI-6061 (the canonical class tracker: "improvement-watchdog",
  open, `needsHuman:true`).
- Posted a recurrence note on EI-6061 (now the 3rd instance after EI-6083) with the
  verified root cause + proposed fix, so a human can prioritize the class fix once.

## Proposed durable fix (for the human) — same as EI-6061/EI-6083
- **(A, preferred):** in `routineFailureSignalsFromRows` / `collectRoutineFailureSignals`, drop
  rows where `metadata->>'last_error_source' = 'dbos-executor-reaper'` UNLESS
  `metadata->>'reaped_count' >= 3` (never self-heals = a genuine wedge). Requires also selecting
  `last_error_source` + `reaped_count` in the SQL.
- **(B):** in the reaper, write the self-heal breadcrumb under a non-`last_error` key and only
  promote to `last_error` after N consecutive reaps.
- **Regression test** (`watchdog.ts` sibling `.test.ts`): assert `routineFailureSignalsFromRows`
  drops a single-reap reaper-sourced marker, still fires on a `runner`-sourced error, and still
  fires on a high `reaped_count`.

## For a validator to re-verify
- No code was changed (protected-surface route). Confirm the resolve landed and the EI-6061 link.
- Duplicate class of EI-6061; the class fix is tracked there.
