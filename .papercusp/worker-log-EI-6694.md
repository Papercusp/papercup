# Worker log — EI-6694 (CHRONIC autoloop failure auto-fix)

## Item
EI-6694 (kind=bug, harness=*): "CHRONIC autoloop failure:
loop-su-9e3ca906-101d-4933-a3e1-3ab4034a4fce@* red 220 consecutive fires".
Filed by the `autoloop-chronic-failure` watchdog sweep, 2026-07-02.

## Investigation (live PG reads; read-only)

Read the recorded `last_status` VERBATIM first (per runbook driving-the-autonomous-hive-loop):
- **autoloop_state** (role=`loop-su-9e3ca906-...`, harness=`*`): `last_status='loop-stuck-backstop'`,
  `consecutive_errors=220`, `last_fired_at=2026-07-01 06:09:54` (~3 days stale).
- **routines** (`rt___loop_su_9e3ca906_...`): `active=FALSE`, `next_fire_at=infinity`,
  `target_owner_id='su-9e3ca906-...'`, `target_role='system:loop-wake'`, last fired 2026-07-01.
- **adv_sessions** (coord_owner_id=`su-9e3ca906-...`): id 6121, `ended_at=2026-06-21 20:47:29,
  exit_code=0` — a CLEAN session end ~13 days ago. Genuine orphan.
- **loop:status**: `active:false, parked:true, stalled:true, consecutiveErrors:220,
  lastDeliveryOutcome:loop-stuck-backstop`.

So this is a DEAD `loop:arm` owner loop: its su session ended cleanly, the routine is already
`active=false`, and it froze at a 220-error watermark on 2026-07-01.

## Root cause (already fixed in code)

Same class as EI-6471/6698/6718/6727/6730/6753/6760-62/6765/6769 — a chronically-red
`autoloop_state` row for a dead loop:arm loop that the sweep escalated in the pre-guard window.
The `autoloop-chronic-failure` watchdog now carries THREE independent guards
(`packages/operator-core/lib/harness/routines/autoloop-chronic-failure.ts`), each of which
excludes this exact row:
1. `routine_active === false` (EI-6760/61/62) — the routine is auto-paused.
2. `isLoopArmOwnerLoop` (EI-6727) — `target_owner_id` non-null ⇒ owner-witnessed loop:arm loop,
   managed by the reconcile dead-owner guard's own `escalateDeadLoop` escalation.
3. `isStaleWatermark` (EI-6765) — `last_fired_at` >6h ago ⇒ frozen watermark.

EI-6694 was filed 2026-07-02, before all three guards fully landed. The CURRENT code no longer
re-escalates this shape — verified by adding its exact real shape as a pinned test (returns []).

## Change (self/inline-sized; no scheduler code touched)

1. `autoloop-chronic-failure.test.ts` — added the EI-6694 real-shape regression pin (streak 220,
   all three axes), following the file's one-pin-per-EI convention. 220 is the HIGHEST real streak
   pinned (prior max EI-6698 @175), so it guards against a future change gating any guard below a
   streak ceiling. Pure-function test; not a protected-surface change.
2. `autoloop:control reset-errors {harness:'papercusp', role:'loop-su-9e3ca906-...'}` — cleared the
   residual 220-error watermark on the dead row (the remediation the watchdog itself prescribes).
   Sanctioned data-level tool; does NOT touch `routines.active` so the dead loop cannot re-fire.

## Verification
- `npx vitest run autoloop-chronic-failure` → **31/31 passed** (incl. the new EI-6694 pin ⇒ the
  row is suppressed by the current decider).
- PG re-read: `consecutive_errors=0` (was 220), `last_status=errors-reset`, `routine_active=false`,
  `next_fire_at=infinity`. Row is now doubly suppressed (0 < threshold 6, AND all 3 guards match).

## Disposition
Resolved **fixed**. The concrete chronic-red row is cleaned (0 errors), the class is code-guarded
+ regression-pinned, the routine is inactive and its owner session ended cleanly — it will not
recur. (The broader orphan-loop lifecycle is owned by the reconcile dead-owner guard;
scheduler-level changes remain out of the implement role's scope, tracked historically under
EI-6471.)
