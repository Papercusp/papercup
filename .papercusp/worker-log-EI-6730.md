# worker-log — EI-6730 (implement / self-improvement auto-fix)

## Item
EI-6730 (bug): "CHRONIC autoloop failure: loop-su-1a5c2d41-...@* red 36 consecutive fires".

## Diagnosis
- The owner su-session (su-1a5c2d41-...) died → every loop fire black-holed (last_status loop-stuck-backstop).
- The routine engine already resolved the LIVE condition: routines row active=false (paused), next_fire_at=infinity → no longer fires.
- The autoloop_state row was a FROZEN red watermark (36 errors, last fired 2026-07-01, ~3 days stale).
- The chronic-failure sweep's two guards BOTH suppress it: routine_active:false AND stale-watermark (>6h). Verified via harness_shared.hive_watchdog_fires — no autoloop-chronic fire for this row since 2026-07-02 14:26. EI-6730 was a stale pre-fix ticket.

## Changes
1. Regression pin: packages/operator-core/lib/harness/routines/autoloop-chronic-failure.test.ts — pins EI-6730's exact shape (streak 36 + routine_active:false + loop-stuck-backstop + ~3-day-stale) → selectChronicFailures returns []. Highest-streak pin in the file (prior pins ≤19).
2. Reset the frozen watermark via autoloop:control reset-errors → autoloop_state consecutive_errors=0, last_status=errors-reset.

## Class bug (distinct root cause) — deduped
The GENERATOR (chronic escalator firing at streak 6 / ~3h, before the WI-1399 terminal guard's ~4h window) is a pre-existing OPEN item EI-7016. I initially filed EI-7396 (dup), then linked it duplicates→EI-7016 and closed it, and added fresh evidence to EI-7016 (the 7218-7314 batch; the NEW finding that loop-su-1a5c2d41 reached streak 36 without the terminal guard ever terminating it → the chronic sweep must stay a backstop; recommend threshold-coupling not exclusion).

## Tests
cd packages/operator-core && npx vitest run lib/harness/routines/autoloop-chronic-failure.test.ts lib/harness/routines/reconcile-loop-routines.test.ts → 40 passed (22 chronic-failure incl. new pin + 18 reconcile-loop).

## Validator re-verify
- Confirm the new pin test passes and the reset watermark row (loop-su-1a5c2d41) stays at 0 errors / does not re-escalate.
