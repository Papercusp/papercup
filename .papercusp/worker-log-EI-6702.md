# worker-log — EI-6702 (implement / self-improvement auto-fix)

## Item
EI-6702 (bug): "CHRONIC autoloop failure: loop-su-a7e376bd-70d0-4f01-b77e-afe8699f8fd9@* red 97 consecutive fires". last_status verbatim: `loop-stuck-backstop`.

## Diagnosis — stale pre-fix ticket (same class as EI-6730)
- The owner su-session `su-a7e376bd-…` DIED (coord_presence rows = 0) → every loop fire black-holed (last_status `loop-stuck-backstop`), streak climbed to 97.
- The routine engine already resolved the LIVE condition: `harness_shared.routines` row `active=false`, `next_fire_at=infinity` → the loop no longer fires. `target_owner_id=su-a7e376bd-…` (non-null → a loop:arm OWNER loop).
- The `autoloop_state` row was a FROZEN red watermark: 97 errors, `last_fired_at=2026-07-01 06:09`, ~3.5 days stale at diagnosis (2026-07-04).
- ALL THREE shipped chronic-failure guards independently suppress this exact shape (`selectChronicFailures` → []):
  1. `routine_active === false` (auto-paused — resolved, not live) — EI-6760/6761/6762.
  2. `isLoopArmOwnerLoop` (`target_owner_id` non-null — owner-witnessed, has its own dead-owner escalation) — EI-6727.
  3. `isStaleWatermark` (last fire > 6h → frozen watermark, streak can never reset) — EI-6765.
  So the generator will NOT re-escalate this row. EI-6702 was filed 2026-07-02 (createdAt), before these guards landed → a stale pre-fix ticket.

## Why NO new code / regression pin (avoiding dead weight)
`selectChronicFailures` already returns `[]` for EI-6702's exact shape. `autoloop-chronic-failure.test.ts` already pins the IDENTICAL all-three-axes shape (loop:arm-owner + `active:false` + stale + `loop-stuck-backstop`) at streaks **175 (EI-6698)** and **220 (EI-6694)** — both HIGHER than 97. A 97-streak pin is strictly-dominated dead weight (repo discourages near-duplicate pins), so none was added. The existing suite is the regression evidence.

## Remediation (matches EI-6730 precedent)
- `autoloop:control reset-errors { harness:'papercusp', role:'loop-su-a7e376bd-…' }` → cleared the `*`-scope frozen watermark (rowsReset:1). Verified: `consecutive_errors=0`, `last_status=errors-reset`.

## Tests
`cd packages/operator-core && npx vitest run lib/harness/routines/autoloop-chronic-failure.test.ts` → 31 passed. Proves the code suppresses EI-6702's exact shape (via the identical-shape EI-6698@175 + EI-6694@220 pins).

## Validator re-verify
- Confirm `autoloop_state` row for `loop-su-a7e376bd-…` stays at 0 errors / `errors-reset` and does NOT re-escalate (routine is `active=false`/`infinity`, so it will not fire again).
- Class generator residue (escalation-timing) remains tracked under the pre-existing OPEN item EI-7016 (per EI-6730) — not re-filed here.
