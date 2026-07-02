# Worker log — EI-6509 (auto-implement)

**Bug:** Engine loop `loop-su-45001f87-6b30-43f6-b37f-1899adad537f` stalled (parked, no completion).
**Outcome:** `needs-human` — the durable fix touches the routines/DBOS scheduler + circuit-breaker semantics (protected surface per the implement-role STOP gate).

## Reproduced (live, in PG)
- Routine row: `active=true`, `reschedule_interval_sec=300`, `next_fire_at='infinity'`, `last_fired_at=2026-07-02 17:08:35`.
- `autoloop_state` (role=`loop-su-45001f87…`): `consecutive_errors=52`, `last_status=loop-stuck-backstop`.
- Owner session `su-45001f87…` (`adv_sessions`): single session `a892a6fa…`, **ended_at 2026-07-01 10:10:17, exit_code 0** (clean end), no live `coord:presence`.
- So: the pinned warm session died cleanly a full day before the loop's last fire; the loop can never make progress, yet the routine stays `active` forever and re-fires the `loop-stalled` watchdog.

## Root cause
`packages/operator-core/lib/harness/routines/loop-fire.ts` `fireLoopWake`:
1. **Guard 1 — `checkFireGate`** (~line 141): when the autoloop circuit is OPEN (`consecutive_errors ≥ 8`) it returns early (`reason:'fire-gate'`) — **`wakeRecipients` is never called.**
2. The **P2c orphan auto-end** (lines ~207–229) only triggers on `wake()` returning `woken=0 && staged=0`.

An orphaned loop accumulates errors from its dead resume turns (that is *how* the doc's P0b circuit is meant to engage) → the circuit opens → and from then on Guard 1 blocks every fire *before* the "no wakeable session → auto-end" cleanup can run. The cleanup is **permanently shadowed by the very circuit the dead turns opened.** Net: `active=true`, parked at `infinity`, forever.

## Class scope (not a one-off)
10+ loops are identically stuck (circuit open + parked `infinity` + `active`): `45001f87`, `ee87c6c5`, `24eedd86`, `f561ab33`, `dad90f05`, `7e812a66`, `4327b254`, `358bcbb3`, `30633068`, `c25e5372`, … Each will keep re-firing its own `loop-stalled` watchdog.

## Proposed durable fix (for the human — protected surface)
Make orphan-session detection **independent of the circuit gate**. Preferred:
- In `reconcile-loop-routines.ts` stuck-park backstop: when it would re-arm a loop parked at `infinity`, first check whether the target owner session has ended (`adv_sessions.ended_at IS NOT NULL` / no live presence). If gone → **deactivate the routine** (`active=false`) instead of re-arming. This is channel-agnostic and runs regardless of the circuit.
- Alternatively/additionally: hoist a cheap "is the target session still resumable?" check ahead of Guard 1 in `fireLoopWake` and auto-end there.
- Backfill: deactivate the ~10 already-stuck orphaned routine rows (`UPDATE harness_shared.routines SET active=false WHERE … active AND next_fire_at='infinity' AND owner session ended`).

Design caution the human must weigh: don't simply move the orphan check to *bypass* the circuit for all reasons — the circuit exists to stop thundering into a rate limit. The orphan check must key specifically on "target session ended/gone", not on "circuit is open".

## No manual mutation performed
Left scheduler state untouched — `dev:pg_query` is read-only and there is no sanctioned worker write-path to deactivate another owner's routine; the durable fix will clean up all orphans correctly. Diagnosis handed to a human via `improvements:resolve { outcome:'needs-human' }`.
