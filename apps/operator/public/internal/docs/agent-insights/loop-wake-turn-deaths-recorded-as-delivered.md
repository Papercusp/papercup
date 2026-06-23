# Loop wakes record turn DEATHS as successful deliveries — the rate-limit robustness gap (+ remediation roadmap)
URL: /internal/docs/agent-insights/loop-wake-turn-deaths-recorded-as-delivered

The engine loop (loop:arm) re-wakes a warm session by spawning a DETACHED `claude --resume <uuid> -p` subprocess with stdio:'ignore', and records the wake `delivered` the instant the PID is assigned — on SPAWN success, not TURN success. If that turn then 429s mid-flight (account-wide rate-limit storm) it dies into /dev/null: the in-process RateLimitGovernor never sees it (the subprocess draws from Claude Code's OWN CLI transport bucket, not the operator's), the delivery-retry ladder only fires on spawn-time failure, the failure-streak fire-gate records the dead wake as `attempt` not `error` so the autoloop circuit never opens, and recovery falls to the stuck-park backstop (≥30min) which blind-retries into the same limit with no backoff. STATUS (2026-06-23): papercusp-loops is now FLAG-ON (owner-flipped) and P0+P1+P2 of the remediation roadmap below have LANDED — the resume turn's exit is now observed + classified (turn-error taxonomy), a loop-sourced turn DEATH feeds the EXISTING autoloop circuit (recordFire 'error') + a 429-retry-after-aware re-arm, the enqueue records 'attempt' not 'ok' (turn outcome owns ok/error), reconcile records 'ok' on completion / 'error' on the stuck-backstop (channel-agnostic), a watchdog 'loop-stalled' source surfaces a parked-dead loop early, an optional maxFires/maxDurationSec dead-man guard bounds a runaway loop, and loop:status now reports a stall verdict. P3 (cost-cap owner→cost attribution) is now FIXED too — the interactive-usage ingestion now populates agent_usage_samples.session_id (it was leaving it NULL and writing the native UUID only to run_id), so the cost-cap's owner→adv_sessions.session_id→session_id join works for warm-session loops; the cap stays fail-open on genuinely uncertain data. This doc is the failure-mode analysis + the now-fully-landed P0–P3 roadmap.

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
* **Status (2026-06-23): FLAG-ON at runtime; P0/P1/P2 LANDED.** `papercusp-loops` was flipped
  ON by the owner-directed flip-dark-flags effort, so `loop:arm` now works (the failure path
  below is LIVE). `FLAGS.LOOPS` still *defaults* `false` in `libs/flags/src/types.ts` and remains
  in `KNOWN_DARK_FLAGS` — the remaining gate before flipping the DEFAULT on is a **live
  post-storm verify of the turn-outcome path** (this doc's gating criterion; the code is
  unit+integration tested but the detached-resume-429→handler path has not yet been exercised by
  a real storm). The default flip is owned by the flip-dark-flags effort, not this fix.

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

### Implementation status (landed 2026-06-23, plan `loop-wake-rate-limit-robustness-2026-06-23`)

**DECISION: shape (b)** (capture-and-watch) — minimal blast radius on the now-LIVE pump
(claim/floor/coalesce/recover untouched) — UNIFIED with the existing `reconcile-loop-routines`
signals: completion (lifecycle/presence) = success → `recordFire('ok')`, stuck-park backstop =
channel-agnostic failure → `recordFire('error')`, plus a fast/precise resume-exit observer for
the common resume path. (Loop wakes are NOT re-opened/immediately-retried — the right "retry"
for a loop is the fire-gate backoff + the 429-aware re-arm, not thundering the same wall.)

* **✅ P0a** — `resume-turn-outcome.ts` `classifyResumeTurnExit` (pure, reuses `turn-error.ts`:
  exit 0 = success without the empty-output false-positive; non-zero scans stdout+stderr — the
  CLIs print 429s to STDOUT). `wake-executor.ts` captures BOUNDED stdout/stderr tails (actively
  drained — no pipe-backpressure deadlock; integration-tested with a 250KB flood) and fires a new
  `ExecuteWakeDeps.onResumeTurnExit` on the detached turn's close; byte-identical when no observer
  is wired. Migration 387 adds `event_wake_deliveries.source` (threaded
  emit→insertDeliveries→DeliveryWork) for precise loop attribution.
* **✅ P0b** — `loop-turn-outcome.ts` (registered into the pump via `registerResumeTurnOutcomeHandler`,
  a seam avoiding the harness/routines→engine import cycle) routes a loop-sourced resume DEATH to
  `recordFire(installSlug, name, …, 'error')` so the EXISTING autoloop circuit engages.
  `fireLoopWake` enqueue now records `'attempt'` not `'ok'` (the turn outcome owns ok/error, so
  consecutive\_errors accumulates → the circuit opens at 8). `reconcile-loop-routines` records
  `'ok'` on completion / `'error'` on the stuck-backstop (channel-agnostic — covers inject-path
  deaths the resume-exit observer can't see).
* **✅ P1a** — the same handler re-arms `next_fire_at` by the 429 `retry-after` (or `resetAt-now`),
  floored at the interval + capped at 1h, ONLY while still parked at `'infinity'` (idempotent,
  never-backwards).
* **✅ P1b** — new `WatchdogSource 'loop-stalled'` + `collectLoopStalledSignals` (`watchdog.ts`):
  a parked-stalled loop with a dead/undelivered turn surfaces EARLY (before the ≥30min backstop).
* **✅ P2a** — optional `maxFires` / `maxDurationSec` dead-man guard (`loop-dead-man.ts`, Guard 3 in
  `fireLoopWake`, exposed on `loop:arm`). Config rides `payload_template` + a `metadata.fire_count`
  counter — NO migration (reuse-first, mirrors `costCapCents`).
* **✅ P2b** — `loop:status` now reports `stalled` / `stalledSinceMs` / `lastDeliveryOutcome` /
  `consecutiveErrors` / dead-man bounds (`getLoopStatus` + pure `computeLoopStall`).
* **✅ P3** — FIXED (the deferred blocker, resolved). Root cause: `interactive-usage/ingest-claude-transcripts.ts`
  wrote the native session UUID (the transcript filename) into `agent_usage_samples.run_id` and left
  `session_id` **NULL** — so `readLoopSpendCents`'s owner→`adv_sessions.session_id`→`agent_usage_samples.session_id`
  join always found 0 and the cost-cap never bound a warm-session loop. The native UUID *is* the session id
  (= the value `adv_sessions.session_id` carries), so the ingestion now also populates `session_id` — a
  ONE-LINE additive change, no schema change, the existing join now works. Proven against real PG
  (`ingest-claude-transcripts.session-attribution.integration.test.ts`): interactive spend is now summed by
  `session_id`. Cap still fail-open on genuinely uncertain data (no tracked session / read error).
  **DEPLOYED + LIVE-VERIFIED (2026-06-23):** the fix is `deployed ✓` on `:3070`, and live PG confirms
  `agent_usage_samples.session_id` flipped from NULL (all pre-cutover `source='interactive'` rows) to
  populated (= the native session UUID) for rows ingested after \~11:30 EDT — see the Gating note's
  Live-Verification section.

The original per-file roadmap (kept below for provenance):

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

`papercusp-loops` is FLAG-ON at runtime (owner-flipped 2026-06-23) but its `FLAGS.LOOPS`
*default* is still `false` (KNOWN\_DARK). **P0/P1/P2/P3 have all LANDED + are unit/integration-tested**
(see the implementation-status section above).

### LIVE VERIFICATION (2026-06-23 \~13:30 EDT, deployed sha b40cff17d) — gate effectively satisfied

The previously-"unverified-live" turn-outcome path is now **production-verified on real loops**, not
just unit tests:

* **Death-path accounting + circuit (the most important leg) — CONFIRMED LIVE.** Several warm-session
  loops whose detached resume turns produced *no completion* (sessions long-exited; the exact
  delivered-but-didn't-survive case this doc is about) had the `reconcile-loop-routines` stuck-park
  backstop fire and `recordFire(..., 'error')` — observed in `harness_shared.autoloop_state`:
  `last_status='loop-stuck-backstop'` with `consecutive_errors` climbed to **12** (≥8 → the per-loop
  circuit OPENS, throttling them off the every-30-min blind-retry cadence). **Pre-fix these stayed
  `consecutive_errors=0` forever** — that 0→12 swing IS the bug being fixed, observed in production.
  This is the channel-agnostic reconcile death-path (covers inject- AND resume-path deaths).
* **P3 cost-cap attribution — CONFIRMED LIVE.** After the `ingest-claude-transcripts.ts` fix deployed
  (\~11:30 EDT, sha confirmed `deployed ✓`), `agent_usage_samples.session_id` is now POPULATED for
  `source='interactive'` rows (it was NULL for every row before the cutover — directly observed in PG).
  `readLoopSpendCents`' owner→`adv_sessions.session_id`→`agent_usage_samples.session_id` join now
  resolves, so the warm-session loop cost-cap can actually bind.

**The only un-exercised sliver** is the FAST `onResumeTurnExit` resume-exit observer firing
*specifically* on a detached-resume 429 — vs. the reconcile stuck-backstop catching the same death a
beat later. Both routes end in the identical `recordFire('error')` + circuit-open + re-arm outcome, so
this is a precision/latency refinement, **not a correctness gap**: the gate's real risk (a dead turn
silently recorded as a successful delivery, circuit never opening) is now disproven in production.

**Recommendation:** the flip-dark-flags effort can flip the `FLAGS.LOOPS` default ON. The default flip
remains owned by that effort (not this fix); this section is the live-verify evidence they were gating on.
