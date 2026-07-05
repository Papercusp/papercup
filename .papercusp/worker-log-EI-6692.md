# Worker log — EI-6692 (CHRONIC autoloop failure auto-fix)

## Item
EI-6692 (kind=bug, harness=*): "CHRONIC autoloop failure:
loop-su-34db408d-fe89-4c3b-b6aa-c3e4651a5e0a@* red 221 consecutive fires".
Filed by the `autoloop-chronic-failure` watchdog sweep, 2026-07-02 14:26.

## Investigation (live PG reads; read-only)

Read the recorded `last_status` VERBATIM first (per runbook driving-the-autonomous-hive-loop):
- **autoloop_state** (role=`loop-su-34db408d-...`): TWO rows —
  `*` scope: `last_status='loop-stuck-backstop'`, `consecutive_errors=221`,
  `last_fired_at=2026-07-01 06:09:47` (~3 days stale); `papercusp` scope already 0/errors-reset.
- **routines** (`rt___loop_su_34db408d_...` @`*` and `rt_papercusp_loop_su_34db408d_...`): BOTH
  `active=FALSE`, `next_fire_at=infinity`, `target_owner_id='su-34db408d-...'`, last fired 2026-07-01.
- **adv_sessions** (coord_owner_id=`su-34db408d-...`): id 6767, started 2026-06-24, `ended_at=NULL`,
  `exit_code=NULL` — a stale-active orphan (died without a clean end marker; the dbos-executor-reaper
  non-terminal path, cf. EI-6698), which is why last_status stayed the non-terminal 'loop-stuck-backstop'.
- **hive_watchdog_fires**: exactly ONE `autoloop-chronic` fire for `*::loop-su-34db408d-...`
  (2026-07-02 14:26 — the fire that filed EI-6692) and **none since**, despite the row still carrying
  221 errors → live proof the guards below already suppress this shape.

So this is a DEAD `loop:arm` owner loop: its su session died (reaper path), both routines are already
`active=false`, and it froze at a 221-error watermark on 2026-07-01.

## Root cause (already fixed in code)

Same class as EI-6471/6694/6698/6718/6727/6730/6753/6760-62/6765/6769 — a chronically-red
`autoloop_state` row for a dead loop:arm loop that the sweep escalated in the pre-guard window.
The `autoloop-chronic-failure` watchdog now carries THREE independent guards
(`packages/operator-core/lib/harness/routines/autoloop-chronic-failure.ts` `selectChronicFailures`),
each of which independently excludes this exact row:
1. `isLoopArmOwnerLoop` (EI-6727) — `target_owner_id` non-null ⇒ owner-witnessed loop:arm loop,
   managed by the reconcile dead-owner guard's own `escalateDeadLoop` escalation.
2. `routine_active === false` (EI-6760/61/62) — both routines are auto-paused.
3. `isStaleWatermark` (EI-6765) — `last_fired_at` >6h ago ⇒ frozen watermark.

The collector reads only `autoloop_state` LEFT JOIN `routines` (never `adv_sessions`), so the NULL
`ended_at` on the orphaned session is irrelevant to suppression. EI-6692 was filed 2026-07-02, before
these guards fully landed; the CURRENT code no longer re-escalates this shape — confirmed by the empty
hive_watchdog_fires history since, AND by adding EI-6692's exact real shape as a pinned test (returns []).

## Change (self/inline-sized; no scheduler code touched)

1. `autoloop-chronic-failure.test.ts` — added the EI-6692 real-shape regression pin (streak 221,
   all three axes, orphaned-session NULL-ended nuance), following the file's one-pin-per-EI convention.
   221 is now the HIGHEST real streak pinned (prior max EI-6694 @220), guarding against a future change
   that gated any guard below a streak ceiling. Pure-function test; not a protected-surface change.
2. `autoloop:control reset-errors {harness:'papercusp', role:'loop-su-34db408d-...'}` — cleared the
   residual 221-error watermark on the dead row (the remediation the watchdog itself prescribes; the
   role-scoped reset clears BOTH the `papercusp` and workspace-wide `*` scopes, EI-6753). Sanctioned
   data-level tool; does NOT touch `routines.active`, so the dead loop cannot re-fire.

## Verification
- `node_modules/.bin/vitest run .../autoloop-chronic-failure.test.ts` → **32/32 passed** (incl. the new
  EI-6692 pin ⇒ the row is suppressed by the current decider).
- PG re-read: both scopes `consecutive_errors=0` (was 221 on `*`), `last_status=errors-reset`, routines
  still `active=false`, `next_fire_at=infinity`. Row is now doubly suppressed (0 < threshold 6 AND all
  three guards match).

## What the validator should re-verify
- The vitest run stays green (`autoloop-chronic-failure.test.ts`, 32 tests).
- No new `autoloop-chronic` watchdog fire appears for `*::loop-su-34db408d-...` (the guards hold live).
- `routines.active` for both `rt*loop_su_34db408d*` rows remains `false` (unchanged by this fix).

## Disposition
Resolved **fixed**. The concrete chronic-red row is cleaned (0 errors), the class is code-guarded +
regression-pinned, both routines are inactive and the owner session is dead — it will not recur.
(The broader orphan-loop lifecycle / stale-active adv_sessions cleanup is owned by the reconcile
dead-owner guard + session reaper; scheduler-level changes remain out of the implement role's scope.)
