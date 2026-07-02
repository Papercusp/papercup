# Worker log — EI-6242 (auto-implement)

**Item:** EI-6242 — Background routine "hive-eval-battery" is failing (kind=bug)
**Outcome:** `improvements:resolve { outcome: 'needs-human' }` (protected-surface STOP condition)

## What I did
Read the item, traced the failing signal against live PG + the reaper/watchdog code, confirmed
the instance has self-healed, and confirmed the durable class fix lands entirely on
STOP-condition protected surfaces. No code change (auto-implement gate).

## Root cause (verified — identical class to EI-6061 / EI-6083)
- The error text ("DBOS routineFire produced no DBOS operation output; executor reaper cancelled
  the stuck fire and requeued the routine", `last_error_source='dbos-executor-reaper'`) is the
  reaper's **self-heal breadcrumb** stamped into `harness_shared.routines.metadata.last_error`
  when it cancels+requeues a stuck fire — NOT a genuine failure of `hive-eval-battery`.
- `collectRoutineFailureSignals` (`packages/operator-core/lib/harness/improvements/watchdog.ts`
  — the self-improvement loop's own code) alarms on ANY non-empty `metadata.last_error`
  regardless of source, so it minted this phantom "hive-eval-battery is failing" bug.
- `clearStaleReaperLastError` (`dbos-executor-reaper.ts`) only clears the marker on the routine's
  **next successful fire**. `hive-eval-battery` is a **MONTHLY** routine (`cron 0 50 6 1 * *`),
  so the marker — and the phantom — stand for up to a month until the next fire.

## Evidence (dev:pg_query on harness_shared.routines)
- `hive-eval-battery`: `active=true`, `next_fire_at=2026-08-01 06:50` (in the future → **not
  parked**), `last_fired_at=2026-07-01 07:22:01`, `last_error_at=2026-07-01 07:21:47`,
  `last_error_source=dbos-executor-reaper`. The routine was requeued and **re-scheduled to next
  month** — it self-recovered; it is not wedged.
- The reap is a **single isolated event** inside a window of fleet-wide bg-host instability:
  a cluster of **10 `loop-su-*` reaps at 06:13**, `bp-singleton-iq-battery-0` at 06:31, then
  `hive-eval-battery` at 07:21 — the classic bg-host event-loop-stall symptom
  (plan `bg-host-freeze-eventloop-stall-2026-06-30`), not a per-routine defect. The reap path
  is the ENQUEUED-orphan branch (fire never dequeued because the executor was stalled), i.e. the
  battery never even ran — so this is NOT a long-battery-never-checkpoints (green-checkpoint)
  bug either.
- The tick's own gates (`cadence-tick.ts`) refuse/skip/return-fast; the budget IS set
  (`payload.budgetUsd=100`), so a healthy fire records DBOS output and would not be reaped.
- EI-6242 is explicitly enumerated in EI-6061's evidence as a member of this same phantom class.

## Why needs-human (STOP condition)
The durable class fix must live in one of:
- `packages/operator-core/lib/harness/improvements/watchdog.ts` (`collectRoutineFailureSignals`)
  — the self-improvement loop's own code, or
- `packages/operator-core/lib/dbos/dbos-executor-reaper.ts` — the routines/DBOS scheduler.
Both are explicit protected surfaces in the auto-implement gate. A wrong change would silence
genuine routine wedges (e.g. the git-sync-stall signal) — exactly what the gate prevents. The
triage decision was already `gate → human`. A one-off manual clear of the marker via raw DB
write would be a band-aid that leaves the CLASS armed for every other low-cadence routine —
rejected per repo convention (no half-fixes).

## Proposed durable fix (for the human / next attempt) — carried from EI-6061 / EI-6083
- **(A, preferred, smaller):** in `collectRoutineFailureSignals`, skip rows where
  `metadata->>'last_error_source' = 'dbos-executor-reaper'` UNLESS `metadata->>'reaped_count'`
  exceeds a genuine-wedge threshold (e.g. `>= 3` consecutive reaps = never self-heals). Keeps
  the git-sync-stall-watchdog signal intact.
- **(B):** in the reaper, stamp the self-heal breadcrumb under a non-`last_error` key
  (e.g. `metadata.last_reap`) and only promote to `last_error` after N consecutive reaps.
- **(C, complementary):** a periodic sweep that clears a `dbos-executor-reaper`-sourced marker
  once the routine is demonstrably recovered (`active`, not parked, `last_fired_at >
  last_error_at`) — regardless of next-fire cadence — so low-cadence (weekly/monthly) routines
  don't carry a month-long phantom.
- **Regression test:** assert `routineFailureSignalsFromRows` drops a single-reap reaper marker,
  still fires on a `runner`-sourced error, and still fires on a high `reaped_count`.

Systemic root already tracked: `bg-host-freeze-eventloop-stall-2026-06-30` + WI-1416; the
watchdog over-eager phantom filing is EI-6172.

## For a validator to re-verify
- No code was changed (protected-surface route). Confirm the resolve landed (`needs-human`).
- This is a duplicate class of EI-6061 / EI-6083; the class fix is tracked there.
