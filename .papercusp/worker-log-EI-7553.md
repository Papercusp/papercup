# Worker log — EI-7553 (auto-implement)

**Item:** EI-7553 — Background routine "green-checkpoint" is failing (kind=bug)
**Outcome:** `improvements:resolve { outcome: 'needs-human' }` (protected-surface STOP condition)
**No code changed.**

## What I did
Read the item, verified the live routine state against PG, confirmed the reported "failure"
is a self-heal breadcrumb (routine already healthy), and traced the exact reason green-checkpoint
still slips past the (now-improved) watchdog filter. Same CLASS as EI-6061 / EI-6083 / EI-6172 /
EI-6880 — but with a SHARPER diagnosis: the EI-6172 fix landed and works for most routines, and
green-checkpoint leaks for a specific, identifiable reason (below).

## Root cause (verified — advances the prior EIs)
- The error text ("DBOS routineFire produced no DBOS operation output; executor reaper cancelled
  the stuck fire and requeued the routine") is stamped by `dbos-executor-reaper` into
  `harness_shared.routines.metadata.last_error` (source `dbos-executor-reaper`) as a **self-heal
  breadcrumb** when it requeues a stuck fire — "I recovered this", NOT a genuine wedge.
- The EI-6172 fix DID land: `routineFailureSignalsFromRows`
  (`packages/operator-core/lib/harness/improvements/watchdog.ts` ~L1075) now suppresses a
  reaper-sourced `last_error` when the routine is a loop, OR (non-loop) when `next_fire_at` is a
  concrete FUTURE timestamp. That dropped the phantom flood from ~61/67 (prior EIs) to **5 open**.
- **Why green-checkpoint STILL leaks:** the reaper's own requeue UPDATE
  (`packages/operator-core/lib/dbos/dbos-executor-reaper.ts` ~L270) sets
  `next_fire_at = LEAST(COALESCE(next_fire_at, now()), now())` — i.e. it forces next_fire_at to
  **now() or earlier** so the routine re-fires ASAP. So immediately after a reap, next_fire_at is
  NOT a concrete future, and the watchdog's future-check does NOT suppress. There is a window —
  reaper requeues (next_fire_at ≤ now, self-heal error stamped) → watchdog tick runs BEFORE
  `claimDueRoutine` re-fires-and-reschedules → phantom "green-checkpoint is failing" is filed.
- green-checkpoint is especially prone to this: it is a non-loop cron routine (`0 15 * * * *`)
  whose fire runs the **full gate suite (~55 min)**, producing no DBOS operation output for long
  stretches, so the reaper's "no operation output ⇒ stuck" heuristic reaps a legitimately-long
  fire (a false positive), landing it in the leak window regularly.

## Evidence (dev:pg_query, 2026-07-05 ~13:30 ET)
- `harness_shared.routines` name='green-checkpoint' (all 4 installs incl. papercusp):
  `active=true`, `last_fired_at=2026-07-05 09:15:03`, `next_fire_at=2026-07-05 10:15:00`,
  `last_error=NULL`, `last_error_source=NULL`, `reaped_count=NULL`, `reschedule_interval_sec=NULL`
  (is_loop=false), `trigger_config.cron='0 15 * * * *'`.
  → Firing normally on schedule; the reported symptom no longer exists (self-healed).
- Watchdog filter body confirmed: non-loop reaper self-heal is suppressed ONLY when next_fire_at
  is a concrete future — it does NOT consult `reaped_count`.
- Reaper requeue UPDATE confirmed to force `next_fire_at ≤ now()` and increment `reaped_count`.
- **5 open** engineer_issues carry `payload.watchdogKey LIKE 'routine-failure:%'` (down from
  ~61/67 pre-EI-6172 — the class is largely fixed; green-checkpoint is the residual leak).
- Prior tracking EIs EI-6061, EI-6083, EI-6172, EI-6880 are all now `state=resolved`.

## Why needs-human (STOP condition — triple-protected)
The durable fix lands entirely on protected surfaces:
- `packages/operator-core/lib/harness/improvements/watchdog.ts` — the **self-improvement loop's
  own code** (the watchdog that decides what to auto-fix), and/or
- `packages/operator-core/lib/dbos/dbos-executor-reaper.ts` — the **routines/DBOS scheduler**.
- The routine itself is `green-checkpoint` — **release/deploy machinery**.
An auto-fixer must not retune the watchdog that decides its own inputs: a mis-scoped suppression
could silently swallow a GENUINE green-gate wedge, freezing every agent's deploys with no signal —
exactly the failure mode this gate prevents. No code changed.

## Proposed durable fix (for the human — small, well-scoped)
The `next_fire_at`-future heuristic is defeated by the reaper forcing `next_fire_at ≤ now()` on
requeue. Switch the non-loop suppression to the `reaped_count` signal the reaper already maintains
(it increments on each CONSECUTIVE reap and is cleared on a successful completion by
`clearStaleReaperError`):
- In `routineFailureSignalsFromRows` / `collectRoutineFailureSignals`
  (`watchdog.ts`), also SELECT `metadata->>'reaped_count'`, and for a reaper-sourced non-loop row
  SUPPRESS when `reaped_count < N` (e.g. N=3 — a transient self-heal), keeping the existing
  concrete-future suppression as an OR. Only surface a genuine wedge (`reaped_count >= N`, i.e.
  the routine has been reaped repeatedly without ever completing).
- This correctly handles green-checkpoint: a single transient reap of a legitimately-long gate
  fire (reaped_count=1) is suppressed; a routine reaped repeatedly with no completion still surfaces.
- **Regression test** (`packages/operator-core/lib/harness/improvements/watchdog.test.ts`):
  `routineFailureSignalsFromRows` (a) DROPS a non-loop `dbos-executor-reaper` row with
  `reaped_count=1` and `next_fire_at ≤ now` (the green-checkpoint leak), (b) STILL fires on a
  `runner`-sourced error (git-sync stall), and (c) STILL fires on a reaper row with a HIGH
  `reaped_count` (a genuine never-self-healing wedge).
- **Value:** closes the residual routine-failure phantom leak (5 open now, recurs on every
  green-checkpoint reap) that wastes the auto-implement loop's dispatch budget.

## For a validator to re-verify
- No code was changed (protected-surface route). Confirm the resolve landed.
- The diagnosis is grounded in current PG state (2026-07-05); the reaped_count fix is the delta
  the prior next_fire_at fix (EI-6172) left open specifically for reaper-forced-past-next_fire_at
  routines like green-checkpoint.
