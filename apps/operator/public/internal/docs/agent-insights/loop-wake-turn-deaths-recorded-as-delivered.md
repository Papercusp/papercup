# Loop wakes record turn DEATHS as successful deliveries — the rate-limit robustness gap (+ remediation roadmap)
URL: /internal/docs/agent-insights/loop-wake-turn-deaths-recorded-as-delivered

The engine loop (loop:arm) re-wakes a warm session by spawning a DETACHED `claude --resume <uuid> -p` subprocess with stdio:'ignore', and records the wake `delivered` the instant the PID is assigned — on SPAWN success, not TURN success. If that turn then 429s mid-flight (account-wide rate-limit storm) it dies into /dev/null: the in-process RateLimitGovernor never sees it (the subprocess draws from Claude Code's OWN CLI transport bucket, not the operator's), the delivery-retry ladder only fires on spawn-time failure, the failure-streak fire-gate records the dead wake as `attempt` not `error` so the autoloop circuit never opens, and recovery falls to the stuck-park backstop (≥30min) which blind-retries into the same limit with no backoff. No max-iterations/dead-man guard; cost-cap is fail-open + can't see warm-session spend. loop:status shows `parked` — indistinguishable from a healthy long turn. This doc is the failure-mode analysis + a prioritized P0–P3 remediation roadmap. The loop system is currently FLAG-OFF (papercusp-loops=false, KNOWN_DARK 'incomplete') — these gaps are what 'incomplete' means; fix P0/P1 before flipping it on.

## The mistake this prevents

> "Our loop system doesn't seem robust enough when there are issues like a rate limit."

It isn't — and the reason is precise: **a loop's re-wake turn runs in a detached
subprocess whose later death the operator never observes, because the operator records the
wake as `delivered` the instant that subprocess *spawns*.** A rate-limit (429) that kills
the turn seconds-to-minutes later is invisible: it isn't retried with awareness, doesn't
open any circuit, and surfaces nowhere. The loop just goes quiet, then blind-retries into
the same wall \~30 minutes later.

This was corroborated live on 2026-06-23: during an account-wide 429 storm the fleet logged
**84 failed vs 19 done spawns in 8h** (dominant error `infra_loss: …/<role> returned HTTP
200 but the agent produced no turn (exitCode=1)` — the spawned agent's first model call
429'd and it exited having produced no turn), and the `su` LLM-eval's *own* in-process
`anthropic-direct` path retried 8× with clean exponential backoff (2→4→8→16→32→60→60s) and
*still* 429'd every attempt. That contrast is the whole point: **the in-process governor
backs off correctly; the loop's detached resume turn is on a transport the governor can't
see.**

## How the loop works (so the gap is legible)

A "loop" is the **third recurrence kind** of the routines engine: a row in
`harness_shared.routines` with `reschedule_interval_sec` set (no cron/rrule) bound to a
`target_owner_id` — the warm su session's coord ownerId. It does NOT spawn a role; it
delivers a **warm coord wake** to that same session so context continues across iterations
(engine-tracked Claude `/loop`).

* **Tools:** `loop:arm` (`agent-tools/loop/arm.ts`, flag-gated by `FLAGS.LOOPS` at arm
  time) · `loop:end` · `loop:status`. `materializeLoop` (`harness/routines/loop.ts`) upserts
  the row; `LOOP_INTERVAL_FLOOR_SEC = 60`.
* **Scheduling:** the DBOS 30s routine tick claims due loops; an in-flight loop parks
  `next_fire_at = 'infinity'` (the skip-if-in-flight sentinel). Dispatch routes a row with
  `reschedule_interval_sec != null && target_owner_id` to `fireLoopWake`
  (`dbos/routines-workflow.ts`). **Note the fire path does NOT re-check `FLAGS.LOOPS`** —
  only `loop:arm` does.
* **The fire** (`harness/routines/loop-fire.ts` `fireLoopWake`): Guard 1 = the failure-streak
  fire-gate (`autoloop.ts` `checkFireGate`, per-loop by routine name); Guard 2 = the cost-cap
  (`loop-cost-cap.ts`); then `wakeRecipients([targetOwnerId], …)`.
* **The wake → re-wake:** `wakeRecipients` fires `coord:inbox-wake:<ownerId>`; the await
  engine's pump (`events/await/engine.ts`) calls `executeWake` (`events/await/wake-executor.ts`),
  which runs the liveness ladder: live pty → inject; **process exited → detached
  `claude --resume <uuid> -p`**; alive-uninjectable → park; gone → drop.
* **Re-arm:** `reconcile-loop-routines.ts` (the completion-rebase) detects the woken turn's
  `Stop`-hook 'ended' marker and sets `next_fire_at = completed_at + interval`; a stuck-park
  backstop re-arms after `max(30min, 4×interval)` if no completion signal arrives.
* **State** is all PG: the `routines` row + `autoloop_state` (fire-state/backoff) +
  `event_wake_deliveries`.
* **Current status: FLAG-OFF.** `FLAGS.LOOPS` defaults `false` (`libs/flags/src/types.ts`)
  and is in `KNOWN_DARK_FLAGS` justified `'incomplete'`
  (`libs/flags/src/production-defaults.test.ts`). `loop:arm` returns `loops_disabled`.

## The failure path, step by step

1. **Delivered = spawned, not survived.** `executeWake`'s default `spawnDetached` runs
   `claude --resume <uuid> -p <wakeText>` with `detached: true, stdio: 'ignore'`
   (`wake-executor.ts` \~665–676), then returns `{ kind: 'delivered', channel:
   'resume-headless' }` **the instant `spawnDetached` returns a non-null PID** (\~688–689).
   A turn that 429s after that exits non-zero into `/dev/null`; the delivery is already
   `delivered`.

2. **The in-process `RateLimitGovernor` doesn't cover this turn.** The AIMD/429-pacing
   governor (`libs/papercusp-shared/src/resilience/governor.ts`) wraps in-process
   orchestrator spawns + anthropic-direct calls. A `claude --resume … -p` subprocess draws
   from Claude Code's OWN CLI client bucket — a separate transport the operator's governor
   never sees. See \[\[rate-limit-is-usually-account-routing-not-capacity]] and
   \[\[llm-429-check-the-transport-not-the-account]].

3. **The delivery-retry ladder doesn't engage.** `store.ts` `markDeliveryFailed` (8 attempts,
   exp backoff → 'dead') is only reached when `executeWake` returns `{ kind: 'error' }` — i.e.
   on *spawn-time* failure (`'headless resume spawn failed'`). A successful spawn whose turn
   later 429s is `delivered`, a terminal state, so the ladder never runs.

4. **The failure-streak gate is blind to a dead turn.** `loop-fire.ts` (\~149–159) records a
   wake miss as `attempt`, not `error`; only a genuinely dead session (a wake-delivery DROP)
   or the cost-cap advances the streak. A loop whose wakes are *delivered* but whose turns
   *die on 429* keeps `consecutive_errors = 0`, so `autoloop.ts` `evaluateFireGate` never
   opens its circuit — **the loop keeps firing empty wakes into a rate-limited void.**

5. **Recovery is slow + blind.** A dead turn emits no `Stop`-hook 'ended' marker, so the loop
   sits parked at `'infinity'` until the `reconcile-loop-routines.ts` stuck-park backstop
   fires (≥`max(30min, 4×interval)`) and re-arms to retry the *same* wake — into the same
   rate limit, with no backoff awareness.

6. **No dead-man guard; cost-cap is toothless here.** There is no max-iterations / max-duration
   / dead-man's-switch — a loop armed by a session that then dies permanently is re-armed
   forever by the backstop. The one net-new guardrail, the cost-cap (`loop-cost-cap.ts`), is
   fail-open and attributes spend via owner→session→cost, a mapping usually absent for a warm
   interactive su session → `readLoopSpendCents` returns 0 → the cap never trips.

7. **Observability is near-zero.** `loop:status` returns `parked` — indistinguishable from a
   legitimately long in-flight turn until the backstop fires ≥30min later. `autoloop:status`
   shows `consecutive_errors` but (per #4) a 429'd turn never increments it. The 429 itself is
   in the discarded subprocess stderr — logged **nowhere**. `watchdog.ts` has no collector for
   "a loop is parked-stalled with dead turns."

(What IS robust, and should stay: concurrent-fire is well-guarded — the `'infinity'` park
means a loop is never re-claimed while its turn is in flight, and a live-but-uninjectable
session is parked, never concurrent-resumed.)

## Existing infrastructure to reuse (don't roll new retry)

* **Turn-error taxonomy:** `libs/papercusp-shared/src/agent/turn-error.ts` already classifies
  `usage_limit` vs `rate_limited`. Classify the captured stderr with this — don't pattern-match
  ad-hoc.
* **Autoloop backoff/circuit:** `autoloop.ts` `evaluateFireGate` already implements exp backoff
  (base 60s → cap 3600s) + a circuit at 8 errors, and is **already consulted by the loop** — it
  just never sees 429'd turns. Feeding it the error is most of the fix.
* **Delivery retry/backoff:** `store.ts` `markDeliveryFailed` (8 attempts) + `recoverStuckDeliveries`
  (stuck `delivering` → `pending` after 5min).
* **Backoff patterns:** `cross-hive-outbox-drain.ts`, `agent-tools/locks/contention-retry.ts`,
  `loopback-fetch.ts` (`isTransientNetworkError`). The repo rolls its own backoff helpers; there
  is no `p-retry`. Per \[\[rate-limit-governor-activation]], classify + let the governor pace —
  don't re-add ad-hoc retry at call sites.

## Remediation roadmap (prioritized)

> ⚠ The crux that makes P0 a real change, not a one-liner: **the turn outcome is not known
> synchronously.** `executeWake` returns to the pump immediately, but the resumed turn dies
> seconds-to-minutes later in a detached process. So any turn-outcome feedback is necessarily
> *asynchronous and durable* (PG), not a closure — and the delivery is already `delivered`
> (terminal) by the time the turn dies. Two viable shapes: (a) **don't mark `delivered` until
> the turn exits** — keep the row `delivering`, attach an exit listener that marks
> delivered-on-success / failed-on-429, and extend `recoverStuckDeliveries` to not reclaim a row
> whose turn PID is still alive (else a long real turn double-fires after 5min); or (b)
> **capture-and-watch** — mark delivered as today, but on a later non-zero/429 exit durably
> re-open the delivery for retry. (a) is cleaner; (b) is smaller-blast-radius. Decide this first.

* **P0a — observe the resume turn.** Stop `stdio:'ignore'`; capture exit code + a bounded
  stderr tail. Add a pure `classifyResumeTurnExit(code, stderrTail)` (reusing `turn-error.ts`).
  Files: `wake-executor.ts` (the `spawnDetached` default + a new injected outcome callback),
  `engine.ts` (wire the callback), `store.ts` (the re-open/fail transition).
* **P0b — open the circuit on dead turns.** Route a classified rate-limit/non-zero turn death
  to `recordFire(installSlug, routineName, reason, 'error')` so the EXISTING autoloop backoff
  engages. Requires the wake delivery to durably carry the loop's fire-gate key (installSlug +
  routineName) so the async exit handler can reconstruct it — today the wake only carries
  `source: 'loop:<routineId>'`. Files: `loop-fire.ts` (enrich the wake payload), the P0a outcome
  handler, `autoloop.ts` (no change — just fed correctly).
* **P1a — rate-limit-aware re-arm.** Back off `next_fire_at` by the 429's `retry-after` instead
  of the blind interval. Files: `reconcile-loop-routines.ts`, `loop-fire.ts`.
* **P1b — watchdog visibility.** New `WatchdogSource` (e.g. `loop-stalled`): a loop `active` +
  parked at `'infinity'` for ≥`stuckParkMs` with no post-fire lifecycle marker → surface a signal.
  File: `harness/improvements/watchdog.ts`.
* **P2a — dead-man guard.** Optional `maxFires` / `maxDurationSec` on the routine row +
  `loop:arm`; auto-pause when exceeded (mirror `autoPauseLoopRoutine`). Files: `loop/arm.ts`,
  `loop.ts`, `loop-fire.ts`, a new migration.
* **P2b — `loop:status` stall state.** Distinguish "parked, healthy in-flight" from "parked,
  last fire produced no completion in N×interval"; add `stalledSinceMs` / `lastDeliveryOutcome`.
  File: `loop.ts`.
* **P3 — cost-cap attribution.** Land the direct owner→cost rollup so the cap actually bounds a
  warm-session loop. File: `loop-cost-cap.ts`.

## Gating note

The loop system is flag-OFF (`papercusp-loops`, `'incomplete'`). **P0/P1 are precisely what
'incomplete' means** — without turn-outcome tracking + 429-aware backoff + stall observability,
a rate-limit silently kills a loop with no signal and only a ≥30-minute blind retry. Do P0/P1
before flipping `FLAGS.LOOPS` on, and verify the turn-outcome path live (post-storm) before the
flip — a rate-limit storm is the exact condition that exercises it.
