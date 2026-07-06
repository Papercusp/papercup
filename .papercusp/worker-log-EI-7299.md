# worker-log — EI-7299 (implement / self-improvement auto-fix)

## Item
EI-7299 (bug): "CHRONIC autoloop failure: loop-su-cd477d93-e068-4b84-97d9-24f8554f8775@* red 6 consecutive fires". last_status verbatim: `loop-stuck-backstop`. (Dispatch attempt 2.)

## Diagnosis — stale pre-fix ticket (same class as EI-7220 / EI-7124 / EI-6702)
Reproduced from the live store (`dev:pg_query`):
- Owner su-session `su-cd477d93-…` is DEAD (`harness_shared.coord_presence` rows = 0) → every loop fire black-holed (`loop-stuck-backstop`), streak climbed to 6 (the chronic threshold).
- The loop:arm routine is RETIRED: `harness_shared.routines` row `active=false`, `next_fire_at=null`, `target_owner_id=su-cd477d93-…` (non-null → a `loop:arm` OWNER loop). It will never fire again.
- The `autoloop_state` row for `role='loop-su-cd477d93-…'` is GONE entirely (exact-match count=0) — the frozen red watermark is already cleared, so there is nothing left to breach the chronic-failure sweep, and nothing to `autoloop:control reset-errors` (unlike EI-6702).

## Root cause + why it cannot recur
The chronic-failure sweep (`selectChronicFailures`, packages/operator-core/lib/harness/routines/autoloop-chronic-failure.ts) prematurely escalated `loop:arm` OWNER loops in the window before the reconcile dead-owner guard paused the routine. Fixed at the root by the shipped **`isLoopArmOwnerRole` guard (EI-7220)**: `selectChronicFailures` now suppresses any `loop-`-prefixed role JOIN-INDEPENDENTLY, so even an ORPHANED `autoloop_state` row (routine GC'd → `routine_target_owner_id` NULL) no longer escalates. EI-7299 was filed 2026-07-04, BEFORE that guard landed 2026-07-05.

## Regression pin — ALREADY PRESENT (attempt-1 orphan)
Dispatch attempt 1 had already landed the EXACT regression pin in `autoloop-chronic-failure.test.ts` (lines 267-289):
`role='loop-su-cd477d93-e068-4b84-97d9-24f8554f8775'`, `consecutive_errors=6` (exactly the threshold), `last_status='loop-stuck-backstop'`, `routine_active=null`, `routine_target_owner_id=null` (orphaned — both JOIN markers null), `last_fired_at` 1min ago (not stale) → asserts `selectChronicFailures(rows, 6) === []` (suppressed by the role-name marker). Attempt 1 then DIED before calling `improvements:resolve` — the orphaned-worker pattern the implement playbook warns about. This attempt (2) verified the pin green and closed the loop.

No NEW code was written: the guard is shipped and the exact-shape pin is present.

## Tests
`node_modules/.bin/vitest run packages/operator-core/lib/harness/routines/autoloop-chronic-failure.test.ts` → **43 passed** (includes the EI-7299 exact-shape pin + strictly-dominating EI-6698@175 / EI-6694@220 / EI-7220 pins).

## Remediation
None required — the `autoloop_state` watermark row is already deleted (count=0) and the routine is `active=false`/`next_fire_at=null`. The bug cannot recur (loop retired AND the sweep suppresses this shape even if a row existed). Resolved `fixed` (root-cause guard shipped, regression pin green).

## Validator re-verify
- `autoloop_state` has NO row for `role='loop-su-cd477d93-…'` (count=0); the `routines` row stays `active=false`/`next_fire_at=null` → it will not fire or re-escalate.
- No new insight filed: this class is already documented (runbook `driving-the-autonomous-hive-loop`; prior logs EI-7220/7124/6702/6730/6698/6694). Root cause is self-explanatory in the `isLoopArmOwnerRole` guard.
