# Worker log — EI-6471 (loop-stalled auto-fix attempt)

## Item
EI-6471 (kind=bug, harness=*): "Engine loop loop-su-4327b254-5880-427a-9daf-d9ece2b47511
stalled (parked, no completion)". Watchdog `loop-stalled` signal.

## Investigation (read-only; no code changed)

Live PG reads (`dev:pg_query`):

- **routines row** `loop-su-4327b254-...`: `active=TRUE`, `reschedule_interval_sec=1200`,
  `next_fire_at='infinity'`, `last_fired_at=2026-07-02 17:31:31`. As of now
  (2026-07-02 22:22 EDT) it has been parked **4h51m** with no advance.
- **autoloop_state** (role=`loop-su-4327b254-...`): `last_status='loop-stuck-backstop'`,
  `consecutive_errors=20` (circuit OPEN, ≥8). So the reconcile stuck-park backstop HAS been
  feeding `recordFire('error')` — the P0b/P2b remediation is working.
- **adv_sessions** (coord_owner_id=`su-4327b254-...`): id 9129, native sessionId
  `262b8423-...`, **ended_at=2026-07-01 09:56:47, exit_code=0** — a CLEAN session end ~36h ago.
- **event_awaits** standing inbox-wake (id 3777, `coord:inbox-wake:su-4327b254-...`):
  **cancelled_at=2026-07-01 09:56:47** (correctly cancelled at session end), fired_at=null.

## Root cause (class)

An orphaned `loop:arm` loop whose owner session ended cleanly is NOT auto-terminated by any
of the existing guard layers, so it sits `active=true` parked forever and the watchdog
re-emits `loop-stalled`. Concretely, every auto-termination path fails to fire:

1. **P2c `no-session-now` auto-end** (`loop-fire.ts` fireLoopWake, lines 207–229) is gated
   BEHIND Guard 1, the failure-streak fire-gate (lines 141–148). Once the autoloop circuit
   opens (`consecutive_errors≥8`), `fireLoopWake` returns early at the fire-gate and NEVER
   reaches `wakeRecipients` → the "no wakeable session" detection can't run. P0b (open the
   circuit) thus defeats P2c (auto-end orphan).
2. **WI-1399 terminal guard** (`loop-unreachable-guard.ts` via `reconcile-loop-routines.ts`
   stuck-backstop) requires `parkedForMs ≥ terminalUnreachableMs` = max(2h, 8×interval) =
   **2.67h**, but the stuck-park backstop re-arms at `stuckParkMs` = max(30min, 4×interval)
   = **80min**, which RESETS `last_fired_at` (→ parkedForMs) before the 2.67h window can
   elapse. The terminal window can never be reached under normal re-arm cadence.
3. Observed end-state is even worse: the loop is now parked 4h51m WITHOUT reconcile
   re-arming OR terminating it — so the reconcile stuck-backstop is currently not driving
   this row at all (candidate: `completionSignal`/presence-quiescence or the DBOS claim path
   interacting with the open circuit's backoff). This last hop is in the DBOS routine
   tick/claim path.

All candidate fix sites — `loop-fire.ts`, `reconcile-loop-routines.ts`,
`loop-unreachable-guard.ts`, the DBOS routine claim/tick — are the **routines/DBOS
scheduler**, an explicit STOP surface for the implement role. Multi-file interaction bug +
guard-window/ordering design decisions + concurrency risk (a wrong change could terminate a
healthy in-flight loop or double-fire).

## Disposition
Resolved **needs-human** (no code changed). Proposed fixes + safe interim mitigation are in
the resolve summary.

## What a validator / human should re-verify
- Confirm the routines reconcile really is skipping this row (trace `reconcileLoopRoutines`
  against owner `su-4327b254-...`: is `presence_last_active_at > last_fired`, or is the DBOS
  claim declining because of the open-circuit backoff?).
- Decide the guard-relationship fix (see resolve summary): either move orphan-termination
  ahead of the fire-gate, or make `terminalUnreachableMs < stuckParkMs × N` so the window is
  reachable, or terminate directly in the stuck-backstop when the owner session row is
  `ended_at IS NOT NULL`.
- Interim: safe to `loop:end` / deactivate this one orphan routine row to clear EI-6471.

---
## 2026-07-02 22:32 EDT — interim mitigation applied (run 1783045688-worker)

Confirmed the orphan was STILL live (routine active=TRUE, next_fire_at=infinity, parked ~5h;
loop:status reachability=none/no-session-now, consecutiveErrors=20, lastDeliveryOutcome=loop-stuck-backstop;
owner adv_session ended cleanly exit_code=0 ~36h ago). It was re-firing the loop-stalled watchdog
and re-dispatching auto-implement workers (active fleet churn).

Action: `loop:end { ownerId: su-4327b254-5880-427a-9daf-d9ece2b47511 }` → VERIFIED routine now active=FALSE.
This is the safe/reversible interim mitigation the prior worker identified but left un-applied. It clears
the live symptom + stops the churn; it is NOT a protected-code change (sanctioned tool, data-level op).

The ROOT-CAUSE class fix (auto-terminate orphans whose owner adv_session.ended_at IS NOT NULL) still
touches the routines/DBOS scheduler (loop-fire.ts / reconcile-loop-routines.ts / loop-unreachable-guard.ts /
DBOS tick) — a STOP surface — so re-resolved needs-human (routedToHuman:true) with the mitigation recorded.
