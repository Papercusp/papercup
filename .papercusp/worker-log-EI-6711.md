# Worker log — EI-6711 (auto-implement)

**Bug:** CHRONIC autoloop failure: `loop-su-45001f87-6b30-43f6-b37f-1899adad537f@*` red 46 consecutive fires, `last_status: loop-stuck-backstop`.

## Verbatim last_status (per runbook)
`loop-stuck-backstop` — the reconcile stuck-park backstop re-arming a loop whose warm su session died, so wakes fire into a void and never complete.

## Investigation / evidence
- **Specific instance is RESOLVED.** `harness_shared.autoloop_state` has **0 rows** for `45001f87` (GC'd). Its `harness_shared.routines` row is `active:false` with `next_fire_at:null` (auto-paused by the reconcile dead-owner guard, updated 2026-07-03 07:39). The loop no longer fires — the root cause (dead su session firing into a void) is handled by the reconcile dead-owner guard (WI-2339 `escalateDeadLoop`).
- **Class fix is landed on staging + tested.** The chronic-failure sweep (`packages/operator-core/lib/harness/routines/autoloop-chronic-failure.ts`) gained `isLoopArmOwnerLoop` (EI-6727) which drops any `loop:arm` owner loop (routine `target_owner_id` non-null) from re-escalation — because such loops are owner-witnessed and auto-terminated with their own escalation. `autoloop-chronic-failure.test.ts` pins `loop-su-45001f87` as an exact regression case (EI-6727 block). Guard introduced on `origin/staging` at 2026-07-04 08:28 (commit 39f65552e7); NOT yet on `origin/main`.
- **Continued sibling EIs are deploy-lag, not an unfixed bug.** New chronic EIs (EI-7314/7300/…) were all filed BEFORE the guard landed (03:47–05:47 today) or by the deployed `main`, which lacks `isLoopArmOwnerLoop` (grep count 0 on `origin/main` vs 5 on `origin/staging`). `dev:pipeline_position` shows the guard file: committed ✓ · staging ✓ · main ✗ · **green gate STALLED (3 reds)**. The stalled gate is a release-machinery/infra condition (a STOP surface, outside a dedicated implement-runner's scope) — the release-fixer/gate owner handles it; it is not part of EI-6711's code fix.

## Considered but rejected
Role-name fallback for `isLoopArmOwnerLoop` (match `^loop-(su|role)-` so suppression survives a reap-order window where the routine row is absent and the JOIN yields null `target_owner_id`). Rejected: (a) the dangerous reap order is NOT observed — the safe order (autoloop_state GC'd while the routine persists paused) is what actually happens, and there are 0 orphaned breaching rows; (b) it would contradict the deliberate EI-6727 design (keys on the JOINed `target_owner_id`, not the role name) and break green tests whose `row()` helper uses `loop-su-x` as a generic placeholder role expecting escalation. No net-positive change.

## Verification
`cd packages/operator-core && npx vitest run lib/harness/routines/autoloop-chronic-failure.test.ts` → **29 passed (29)**, including the `loop-su-45001f87` EI-6727 pin.

## Outcome
`fixed` — the specific instance no longer exists (routine auto-paused, autoloop_state GC'd) and the root-cause class fix (reconcile dead-owner guard + EI-6727 sweep suppression) is landed on staging and green. No code change required (fix + regression test already in place). `autoloop:control reset-errors` is moot — the row is already GC'd. Residual production noise is deploy-lag behind a stalled green gate, out of scope for this bug.
