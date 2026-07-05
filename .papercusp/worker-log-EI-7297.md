# worker-log EI-7297 — CHRONIC autoloop failure: loop-su-91ee2629-…@* red 6 consecutive fires

## Verdict: FIXED (root cause already landed; added a regression pin)

## Diagnosis
EI-7297 (`loop-su-91ee2629-23c8-46f6-89ad-ada8b13bf44c@*`, "red 6 consecutive fires",
filed **2026-07-04**) is a duplicate of an already-fixed class:
- It is the **orphaned `loop:arm` autoloop_state row** shape: a dead su session whose
  materialized routine was GC'd, so the chronic-failure sweep's LEFT JOIN yields
  `routine_active = NULL` and `target_owner_id = NULL`, and it fired recently so the
  staleness guard doesn't catch it either. The old EI-6727 owner-id JOIN marker failed
  OPEN and the sweep escalated it as if a witness-less fixed system role.
- The **`isLoopArmOwnerRole` role-name guard (EI-7220)** landed **2026-07-05** — one day
  AFTER EI-7297 was filed — in
  `packages/operator-core/lib/harness/routines/autoloop-chronic-failure.ts`. It suppresses
  any `loop-`-prefixed role join-independently, so `loop-su-91ee2629-…` can no longer
  re-escalate. Identical class to the already-pinned EI-7299 / EI-7220 tests.

## Change (self/inline, test-only)
- Added a dedicated **EI-7297 regression pin** to
  `packages/operator-core/lib/harness/routines/autoloop-chronic-failure.test.ts`
  (orphaned `loop-su-*` @* at the exact chronic threshold 6, routine GC'd → owner-id null,
  recent fire), matching the file's one-pin-per-EI convention.
- No source change — the guard was already present. Confirmed the source `isLoopArmOwnerLoop`
  guard was intact (temporarily neutered its role-name leg to prove fails-before, then
  restored).

## Verification
- `npx vitest run lib/harness/routines/autoloop-chronic-failure.test.ts` (packages/operator-core)
  → **43 passed**.
- Fails-before proven: neutering the `isLoopArmOwnerRole` guard leg reds the new EI-7297 pin
  (plus EI-7299/EI-7220); restoring it greens all 43.

## Notes for the validator
- Test-only diff; lands via the release gate.
- Early in the run my first test edit was discarded by a concurrent tree op / git-sync race
  (working tree returned clean at a git-sync auto-commit HEAD); re-applied and it persisted.
  Re-verify the EI-7297 `it(...)` block is present in the test file.
- The stale live `autoloop_state` row for this dead session is harmless now (guard suppresses
  re-escalation; the session is permanently dead so `autoloop:control reset-errors` is moot).
