# Worker log — EI-7293 (implement / self-improvement auto-fix)

**Bug:** CHRONIC autoloop failure: `loop-su-c267121c-9987-4abd-a5af-d1193b355713@*` red 6 consecutive fires (`last_status: loop-stuck-backstop`). Dispatch attempt 2.

## Diagnosis
- The failing "loop" is an **ephemeral `loop:arm` OWNER loop** (role `loop-su-<uuid>`, `target_role = system:loop-wake`) — a dead su session's loop, not a fixed system role. Its `autoloop_state` row lingered stale-red at exactly the chronic threshold (6).
- The chronic-failure escalator (`packages/operator-core/lib/harness/routines/autoloop-chronic-failure.ts`) is designed to escalate ONLY witness-less fixed system roles. Loop:arm owner loops are owner-witnessed and auto-terminated by the reconcile dead-owner guard (its own `escalateDeadLoop`), so escalating them is a premature duplicate.
- **Root cause was already fixed** by EI-7220's `isLoopArmOwnerRole` guard (any `autoloop_state.role` starting with `loop-` is a loop:arm loop → suppressed, join-independent so it survives the routine being GC'd). That fix landed **2026-07-05 12:10 (commit 34ab1dc348)**. EI-7293 was filed **2026-07-04 03:47**, over a day BEFORE the fix — same batch as EI-7294/7297/7299/7312, all already pinned.

## Verification the live condition is gone (dev:pg_query)
- `autoloop_state` row for `loop-su-c267121c-...`: **0 rows** (GC'd).
- Its `routines` row: exists but **active=false** (auto-paused), `target_role=system:loop-wake`, `target_owner_id` non-null.
- So it is suppressed three ways over: role-name marker, `routine_active=false`, and GC'd row.

## Fix (this change)
- Added a byte-identical **boundary-pin regression test** `EI-7293 real shape` to `packages/operator-core/lib/harness/routines/autoloop-chronic-failure.test.ts`, matching the established sibling pins. Models the worst case (routine GC'd → `routine_active` null + `routine_target_owner_id` null, fired 1min ago) so ONLY the `isLoopArmOwnerRole` role-name marker can suppress it — directly guarding the actual fix against a `> threshold` slip re-opening the flood.
- **Test-only change.** No production / operator-core-safety / deploy-machinery / migration surface touched.

## Tests
`node_modules/.bin/vitest run --config packages/operator-core/vitest.config.ts packages/operator-core/lib/harness/routines/autoloop-chronic-failure.test.ts` → **46 passed (46)** (was 45), including the new EI-7293 pin.

## Validator re-verify
- Confirm the new `it("EI-7293 real shape ...")` block asserts `selectChronicFailures([...loop-su-c267121c...], 6, ...) === []`.
- Optional: re-confirm the `loop-su-c267121c-...` autoloop_state row stays GC'd and its routine stays paused.

## Outcome
`improvements:resolve { outcome: 'fixed' }` — done.
