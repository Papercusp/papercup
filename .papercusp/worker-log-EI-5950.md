# Worker log — EI-5950 (auto-implement)

**Item:** EI-5950 — Background routine "loop-su-99183d81-b053-4b34-8ad8-7891c257d6da" is failing (kind=bug)
**Outcome:** `improvements:resolve { outcome: 'fixed' }` — verified phantom, evidence it no longer exists / cannot recur.

## Diagnosis (verified against live PG)
EI-5950 is a **false-positive / phantom** watchdog signal, not a genuine routine failure:

1. **The routine is inactive.** `harness_shared.routines` for this loop-su:
   `active = false`, `next_fire_at = infinity`, `target_role = system:loop-wake`.
   `loop:status` confirms `active:false, parked:true, lastDeliveryOutcome:"errors-reset"` —
   the per-session self-wake loop was legitimately deactivated (session su-99183d81 gone /
   loop guardrails), not wedged.
2. **The `last_error` is a self-heal breadcrumb, not a failure.**
   `metadata.last_error_source = 'dbos-executor-reaper'`; text = *"DBOS routineFire produced no
   DBOS operation output; executor reaper cancelled the stuck fire and requeued the routine"*.
   Per `dbos-executor-reaper.ts` (L304-346) this marker means "I recovered this routine",
   NOT that it failed.
3. **It already self-healed.** `last_fired_at = 2026-07-01 06:10:20` is AFTER
   `last_error_at = 2026-06-29 05:10` — the routine fired successfully after the reaper marker,
   then the loop was deactivated.
4. **It cannot recur.** `collectRoutineFailureSignals` (watchdog.ts L1049) queries
   `WHERE active = true`. This routine is `active = false`, so the collector will never
   re-capture it. The EI key `routine-failure:routine:loop-su-99183d81-...` is per-routine-name,
   so no other row maps to it.

## Evidence (dev:pg_query, live)
- `this_routine_active = false`; `this_routine_error_source = 'dbos-executor-reaper'`.
- `last_fired_at (2026-07-01 06:10) > last_error_at (2026-06-29 05:10)` → self-healed.
- Guard confirmed green: `watchdog.test.ts -t "routine"` → 3 passed (routine-failure collector
  logic intact).

## Why `fixed` (not needs-human)
The contract's reproduce rule: "cannot reproduce + evidence it no longer exists = verified fix →
resolve fixed." THIS instance needs no code change — it is an already-self-healed, inactive routine
that the collector's `active=true` guard structurally prevents from re-filing. No protected-surface
fix is pending for THIS bug.

## Separate class issue (NOT this EI — already routed)
The broader class — an **ACTIVE** routine carrying a stale `dbos-executor-reaper` marker before its
next successful fire clears it — is real and live (**3 active routines** currently carry a reaper
marker; **43 inactive** loop-su rows carry stale ones, harmless under the active-filter). Its durable
fix lives in `watchdog.ts` `collectRoutineFailureSignals` / `dbos-executor-reaper.ts` — both explicit
STOP-condition protected surfaces — and is already routed to a human via **EI-6061** (proposed fix:
make the collector source-aware — skip `dbos-executor-reaper` markers unless `reaped_count >= N`).
Not duplicated here.

## For a validator to re-verify
- No code changed (this instance is a resolved phantom; the class fix is protected + tracked in EI-6061).
- Confirm `harness_shared.routines` for this name is still `active=false` and the collector filters
  `active=true`.
