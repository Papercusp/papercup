# worker-log — EI-7220 (implement / self-improvement auto-fix)

## Item
EI-7220 (bug): "CHRONIC autoloop failure: loop-su-c2b2ece8-d18f-4246-9ce2-d5bc0fdb4050@* red 7 consecutive fires". last_status verbatim: `loop-stuck-backstop`. Dispatch attempt 3.

## Diagnosis — STALE PRE-FIX ticket (same class as EI-6702 / EI-7294 / EI-7297 / EI-7299 / EI-7312)
- Root cause: the dead su-session `su-c2b2ece8-…` loop had its `harness_shared.routines` row GC'd, so the chronic-failure sweep's `target_owner_id` JOIN marker went NULL → the stale-red `autoloop_state` row failed OPEN and re-escalated as if a witness-less fixed system role (the exact `loop-su-<uuid>@*` flood EI-6727 tried to kill, resurrected by a routine reaped out from under a stale-red row).
- The join-independent FIX already SHIPPED 2026-07-05: `isLoopArmOwnerRole(role)` → `role.startsWith('loop-')` in `packages/operator-core/lib/harness/routines/autoloop-chronic-failure.ts` (lines 49-55, 164-194). `isLoopArmOwnerLoop` now returns true on either the owner-id JOIN marker OR the `loop-` role-name marker, so `selectChronicFailures` suppresses an ORPHANED loop row whose routine was GC'd. EI-7220 was filed 2026-07-03 → filed BEFORE its own fix landed → stale pre-fix ticket.

## Why NO new code / regression pin (avoiding dead weight)
The IDENTICAL shape is already regression-pinned in `autoloop-chronic-failure.test.ts`:
- line 229 — "EI-7220 root shape: an ORPHANED loop:arm row … is NOT escalated by its ROLE NAME" (uses `role: 'loop-su-c2b2ece8-d18f-4246-9ce2-d5bc0fdb4050'` verbatim).
- line 562/577 — `isLoopArmOwnerLoop` / `isLoopArmOwnerRole` unit pins for the null-owner-id + `loop-` prefix case.
Adding another pin for the same shape is strictly-dominated dead weight (repo discourages near-duplicate pins).

## Remediation (matches EI-6702 / EI-6730 precedent)
- `autoloop:control reset-errors { harness:'papercusp', role:'loop-su-c2b2ece8-…' }` → `rowsReset: 0` across all 3 scopes (papercusp-workspace / papercusp / `*`) — the frozen watermark was ALREADY clean.
- `dev:pg_query` on `harness_shared.autoloop_state WHERE role='loop-su-c2b2ece8-…'` → `rowCount 0`: the autoloop_state row is now GONE entirely (routine reaped), so there is nothing left to escalate even absent the code guard.

## Tests
`cd packages/operator-core && vitest run lib/harness/routines/autoloop-chronic-failure.test.ts` → **45 passed**. Proves the code suppresses EI-7220's exact orphaned-loop-by-role-name shape.

## Resolution
`improvements:resolve { id:'EI-7220', outcome:'fixed', ... }` → state `resolved`. Insight skipped: the fix is self-explanatory in the code header + the existing `driving-the-autonomous-hive-loop.mdx` runbook.

## Validator re-verify
- Confirm no `autoloop_state` row for `loop-su-c2b2ece8-…` re-appears with a red streak (routine GC'd; even if it did, `isLoopArmOwnerRole` suppresses it).
- Meta-pattern (NOT re-filed): these post-fix chronic-autoloop tickets keep re-dispatching (EI-6702/7294/7297/7299/7312/7220 all same class). That is a queue-DRAIN concern (old tickets filed pre-fix), not a code gap — the code already suppresses NEW ones. Tracked-adjacent under EI-7016 (escalation-timing residue) per EI-6730.
