# worker-log — EI-7124 (implement / self-improvement auto-fix)

## Item
EI-7124 (bug): "CHRONIC autoloop failure: loop-su-e6e57d42-3d48-4366-a5aa-8764b47ff4fa@* red 6 consecutive fires". last_status verbatim: `loop-stuck-backstop`.

## Diagnosis — stale pre-fix ticket (same class as EI-6702 / EI-6730)
Reproduced from the live store:
- The owner su-session `su-e6e57d42-…` is DEAD (`coord_presence` rows = 0) → every loop fire black-holed (`loop-stuck-backstop`), streak climbed to 6 (the chronic threshold).
- The routine engine already resolved the LIVE condition: `harness_shared.routines` row `active=false`, `next_fire_at=null`, `target_owner_id=su-e6e57d42-…` (non-null → a `loop:arm` OWNER loop). The loop will never fire again.
- The `autoloop_state` row for `role='loop-su-e6e57d42-…'` is GONE entirely (exact-match count = 0) — the frozen red watermark is already cleared, so there is nothing left to breach the chronic-failure sweep (and nothing to `reset-errors`, unlike EI-6702 where a reset was needed).
- The shipped `selectChronicFailures` (packages/operator-core/lib/harness/routines/autoloop-chronic-failure.ts) suppresses this exact shape THREE independent ways:
  1. `isLoopArmOwnerLoop` — `routine_target_owner_id` non-null (owner-witnessed; the reconcile dead-owner guard fires its OWN `escalateDeadLoop`) — EI-6727.
  2. `routine_active === false` (auto-paused — resolved, not live) — EI-6760/6761/6762.
  3. `isStaleWatermark` (last fire > 6h — frozen watermark) — EI-6765.
- Timeline confirms stale-pre-fix: EI-7124 filed 2026-07-03 18:23; the `isLoopArmOwnerLoop` guard (EI-6727) landed 2026-07-04 08:28 (`git log -S isLoopArmOwnerLoop`). The escalation fired in the ~14h window before the guard deployed.

## Why NO new code / regression pin (avoiding dead weight)
`selectChronicFailures` already returns `[]` for EI-7124's exact shape. `autoloop-chronic-failure.test.ts` already pins the IDENTICAL all-three-axes shape (loop:arm-owner + `active:false` + `loop-stuck-backstop`) at streaks **175 (EI-6698)** and **220 (EI-6694)** — both HIGHER than 6. A streak-6 pin is strictly-dominated dead weight (repo discourages near-duplicate pins), so none was added. The existing suite is the regression evidence.

## Tests
`node_modules/.bin/vitest run packages/operator-core/lib/harness/routines/autoloop-chronic-failure.test.ts` → **34 passed**. Proves the code suppresses EI-7124's exact shape (via the strictly-dominating EI-6698@175 + EI-6694@220 pins + the `active:false` / stale-watermark pins).

## Remediation
None required — the `autoloop_state` watermark row is already deleted (count=0) and the routine is `active=false`/`next_fire_at=null`. The bug cannot recur (the loop is retired AND the sweep would suppress it even if a row existed). Verified `fixed` (no-longer-reproduces).

## Validator re-verify
- `autoloop_state` has NO row for `role='loop-su-e6e57d42-…'` (count=0) and the `routines` row stays `active=false`/`next_fire_at=null` → it will not fire or re-escalate.
- Class-generator residue (premature-escalation timing) is tracked under the pre-existing OPEN item EI-7016 (per EI-6702/EI-6730) — not re-filed here.
