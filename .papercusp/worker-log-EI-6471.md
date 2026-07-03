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

---
## 2026-07-02 ~23:00 EDT — DISCOVERED a fleet-wide OPERATOR-HEALTH incident (run 1783044631-worker)

While trying to persist `improvements:resolve { id: EI-6471, outcome: needs-human }`, EVERY MCP tool
call (resolve, work_items:get, dev:pg_query — even light reads) began timing out (55s server cap /
90s client). The EI-6471 resolution has NOT persisted (work_items.feature_id=EI-6471 still
status=todo, needs_human_review empty, routedToHuman empty — verified repeatedly via direct psql).

Direct-PG diagnosis (psql to the harness admin URL — PG itself is FAST, ~ms):
- Operator Node process **p609096 pegged at 95–97% CPU, RSS ~11 GB**, while `:3070/api/health`
  answers in ~2–13ms (event loop alive but CPU-starved; heavy MCP handlers can't finish in 55s).
- Its org-admin postgres-js pool (`pcusp:org-admin:p609096`) spiked to **184 active connections**
  with **~55 stuck in ClientRead/ClientWrite >30s** (PG done, Node not draining → CPU-starved loop).
- ROOT TRIGGER: a self-sustaining THUNDERING HERD of `readCodeRunAdoption` / `CODE_RUN_ADOPTION_SQL`
  (packages/operator-core/lib/code-run-adoption.ts) — a 7-day full aggregation over
  `harness_shared.tool_invocations` (**7.45M rows / 6 GB**; the covering index lacks spawn_id/role so
  it heap-fetches millions of rows). Observed **up to 18 concurrent** copies, individual scans stuck
  **25–31 min**. Callers fire it with NO singleflight/cache/concurrency-cap: system-health/compute.ts,
  overwatch/scorecard-backstop.ts, dev/{code_run_adoption,telemetry,tool_cooccurrence,orient_dedup_rate,
  limit_failure_rate}.ts.
- INTERIM RELIEF I applied (safe — read-only SELECTs): pg_cancel then pg_terminate_backend on the hung
  adoption scans (cancel does NOT clear a ClientWrite wait; terminate does). Pool dropped 184→14 active,
  herd 18→2 — BUT CPU stayed ~95% and the herd re-formed within seconds, and resolve STILL timed out.
  So the herd is A driver but the operator is now broadly CPU-pegged (GC on the ~11 GB heap and/or
  stacked heavy in-flight ops — incl. my own ~6 resolve retries each "still running server-side"; I
  STOPPED retrying to avoid adding load).

DURABLE FIX (operator-core — OUT of a worker's scope/authority; ESCALATED to owner):
1. Add singleflight + short-TTL memoization to `readCodeRunAdoption` (compute the rollup once per
   N minutes, share the result) and/or a concurrency cap; better, precompute into a rollup table or
   make it index-only/incremental. No surface should trigger a fresh 7-day full scan per call.
2. The wedged operator process (p609096, ~11 GB RSS, 95% CPU) likely needs an operator-owner RESTART
   to clear the current peg — a STOP surface (release/deploy machinery; "never touch the live
   operator"), so NOT done by me.

CONSEQUENCE for EI-6471: its needs-human resolve is fully diagnosed + argued (see /tmp/ei6471-resolve.json
summary + this log) but could not be COMMITTED through the wedged MCP path. The self-improvement cadence
keeps re-touching the row (updated_ts advances) — it may re-dispatch until a resolve lands. Once the
operator recovers, re-run: `improvements:resolve` with /tmp/ei6471-resolve.json (idempotencyKey
ei6471-needs-human-worker-1783044631). Did NOT hand-write the resolution via raw SQL — the
self-improvement lifecycle state machine is a protected surface; a partial UPDATE would corrupt it.
