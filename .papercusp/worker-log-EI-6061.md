# Worker log — EI-6061 (auto-implement)

**Item:** EI-6061 — Background routine "improvement-watchdog" is failing (kind=bug)
**Outcome:** `improvements:resolve { outcome: 'needs-human' }` → `routedToHuman: true`

## What I did
Read the item, traced the failing signal end-to-end, verified the root cause against live PG, and routed to a human because the durable fix is entirely within STOP-condition protected surfaces.

## Root cause (verified)
- `dbos-executor-reaper.ts` (DBOS/routines scheduler) stamps `harness_shared.routines.metadata.last_error` = *"DBOS routineFire produced no DBOS operation output; executor reaper cancelled the stuck fire and requeued the routine"* with `last_error_source='dbos-executor-reaper'` as a **self-heal breadcrumb** ("I recovered this routine"), not a genuine failure.
- `collectRoutineFailureSignals` (`watchdog.ts` ~L1049 — the self-improvement loop's own code) fires on **any** non-empty `metadata.last_error` regardless of source → files a phantom "Background routine X is failing" bug.
- `clearStaleReaperLastError` only clears the marker on the routine's **next successful fire**, so low-cadence routines (weekly/monthly batteries) carry it for weeks and keep the phantom standing.

## Evidence
- `dev:pg_query` on `harness_shared.routines`: all **7** active routines currently carrying `last_error` have source `dbos-executor-reaper`; **0** genuine `runner`/git-sync errors.
- `harness_shared.engineer_issues`: **40+** "routine is failing" EIs (EI-6061/6083/6081/6242/5995/… loop-su-*, bp-singleton-*, hive-eval-battery, coord-invariant-monitor).
- EI-6061's own routine `improvement-watchdog` already self-healed: `last_error` is now `NULL`. The instance is transient; the **class recurs**.

## Why needs-human (STOP condition)
The fix must live in `collectRoutineFailureSignals` (self-improvement loop's own code) or `dbos-executor-reaper.ts` (routines/DBOS scheduler) — both explicit protected surfaces. A wrong change would silence genuine routine wedges, exactly what the gate prevents.

## Proposed durable fix (for the human / next attempt)
- **(A, preferred, smaller):** in `collectRoutineFailureSignals`, exclude rows where `metadata->>'last_error_source' = 'dbos-executor-reaper'` **unless** `metadata->>'reaped_count'` exceeds a genuine-wedge threshold (e.g. `>=3` consecutive reaps = never self-heals). Keeps the git-sync-stall-watchdog signal intact.
- **(B):** in the reaper, write the self-heal breadcrumb under a non-`last_error` key (e.g. `metadata.last_reap`) and only promote to `last_error` after N consecutive reaps.
- **Regression test:** assert `routineFailureSignalsFromRows` drops a single-reap reaper marker, still fires on a `runner`-sourced error, and still fires on a high `reaped_count`.

## For a validator to re-verify
- No code was changed (protected-surface route). Confirm the resolve landed (`routedToHuman: true`, verified).
- If picking up the fix: touching either file requires human sign-off per the auto-implement gate.
