# Worker log — EI-6256 (auto-implement, `implement` blueprint)

**Item:** EI-6256 (kind=bug) — "Engine loop loop-su-7e812a66-7d3d-4f41-a73d-9f523209f666 stalled (parked, no completion)"
**Outcome:** `needs-human` (correct fix touches STOP surfaces: routines/DBOS scheduler + self-improvement loop watchdog)

## What I did

Read the item + the referenced runbook `agent-insights/loop-wake-turn-deaths-recorded-as-delivered`, then queried live PG to reproduce.

## Findings (evidence)

1. **The specific loop's owner session is permanently dead.**
   `adv_sessions`: coord_owner_id `su-7e812a66-…` started 2026-07-01 06:22, **ended_at 2026-07-01 12:09:06** (no pid, ~25h dead).

2. **The loop routine never terminates despite that.**
   `harness_shared.routines`: `loop-su-7e812a66-…` still `active=true`, `next_fire_at='infinity'`, updated 2026-07-02 09:06.
   `harness_shared.autoloop_state`: `last_status='loop-stuck-backstop'`, **`consecutive_errors=33`** (circuit threshold is 8). The autoloop circuit THROTTLES (backoff) but never DEACTIVATES the routine, so it re-parks + backstops indefinitely.

3. **Root cause of the non-termination** (in `packages/operator-core/lib/harness/routines/loop-fire.ts:207`):
   `const reached = (fan.woken ?? 0) > 0 || (fan.staged ?? 0) > 0;` gates P2c's `no-session-now` auto-end. For a session that has `ended_at` set but whose coord-owner still resolves to a resumable native session id, `wakeRecipients` spawns a detached `claude --resume` that counts as `woken>0` (the runbook's "delivered = spawned, not survived"), so `reached=true` → the auto-end branch (loop-fire.ts:207–227) is SKIPPED. The doomed resume turn dies, the reconcile stuck-park backstop records error #N, and the loop re-parks — forever.

4. **Class-scale capture problem.** The `loop-stalled` watchdog collector (`harness/improvements/watchdog.ts`) mints ONE auto-implement-eligible `kind=bug` EI per *ephemeral* loop instance — each `watchdogKey` embeds the transient `loop-su-<uuid>`, so they never dedupe as a class. Dozens exist (EI-3473 … EI-6509). None is a reproducible code bug an auto-implement worker can regression-test; each names a long-gone runtime loop instance.

## Why needs-human (not fixed / could-not-fix)

- EI-6256 as scoped is a **per-instance operational watchdog alert**, not a reproducible code defect.
- Every durable fix hits an explicit STOP surface for this blueprint:
  - Auto-end a loop whose owner `adv_sessions.ended_at` is set (don't count a doomed detached-resume spawn as "reached"), and/or a hard `consecutive_errors` deactivation cap → `packages/operator-core/lib/harness/routines/loop-fire.ts`, `reconcile-loop-routines.ts`, `autoloop.ts` = **the routines/DBOS scheduler**.
  - Reclassify/dedupe transient `loop-stalled` signals so they aren't minted as auto-implement `kind=bug` → `harness/improvements/watchdog.ts` = **the self-improvement loop's own code**.

## Proposed durable fix (for the human/next agent)

1. **Terminate genuinely-orphaned loops.** In the loop fire path, when the pinned owner's `adv_sessions` row has `ended_at` set, treat it as `no-session-now` (deactivate the routine) rather than letting a detached-resume spawn count as `woken>0`. Add a hard cap: `consecutive_errors ≥ N` (e.g. 8, the circuit threshold) → `deactivateLoop` (mirror `autoPauseLoopRoutine`), not just throttle. Regression test alongside `loop-fire.test.ts` / `reconcile-loop-routines.integration.test.ts`.
2. **Fix the capture classification.** Make the `loop-stalled` watchdog collector emit an OPERATIONAL signal (or a single class-deduped EI), not a per-instance auto-implement-eligible `kind=bug`, so the improvement-runner isn't dispatched to "fix" un-fixable transient loop instances.
3. **Operational cleanup** (separate from the code fix): `loop:end` / deactivate the ~dozen still-`active` orphaned loop routines whose owner sessions have ended.

Verified: no schema/migration change was made; no code was edited.
