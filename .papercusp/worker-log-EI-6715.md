# Worker log — EI-6715 (auto-implement, self-improvement loop)

**Bug:** CHRONIC autoloop failure: `loop-su-ee87c6c5-a1fc-428e-98b9-7238c8c7494c@*` red 46 (now 58) consecutive fires, `last_status: loop-terminal-unreachable`.

## Diagnosis

### The ticket's specific loop is ALREADY resolved by existing guards
`harness_shared.routines` row `rt___loop_su_ee87c6c5…`:
- `active = false` — WI-1399 dead-owner **terminal guard** already auto-paused it.
- `target_owner_id = su-ee87c6c5-…` (non-null), `target_role = system:loop-wake` — a `loop:arm` **owner loop** (ephemeral su session that died).
- `last_status = loop-terminal-unreachable`, `consecutive_errors = 58`, `last_fired_at = 2026-07-03 07:39`.

Sequence that already happened, correctly:
1. su session `su-ee87c6c5-…` died.
2. `reconcile-loop-routines.ts` terminal guard detected the unreachable owner → auto-paused the routine (`active=false`) → `recordFire('loop-terminal-unreachable','error')` → fired its own `escalateDeadLoop` (WI-2339 fix E).
3. `autoloop-chronic-failure.ts` sweep now **skips** this row THREE ways: `isLoopArmOwnerLoop` (target_owner_id non-null, EI-6727), `routine_active === false` (skipped-paused), and `isStaleWatermark` (last_fired > 6h, EI-6765).

EI-6715 was captured **2026-07-02 14:26**, *before* those sweep-skip guards landed. It is a leftover ticket for a now-guarded condition. There is **no loop-machinery code bug** for this instance — it worked as designed (detect → pause → escalate).

### The one genuine remaining defect (systemic, protected surface)
The class-2 hygiene prune `pruneStaleFireState` (autoloop.ts, EI-7009) — which DELETEs `autoloop_state` rows carrying `LOOP_TERMINAL_AUTO_PAUSE_STATUS` ('loop-terminal-unreachable') whose matching routine is `active=false` — is **ineffective in production**:
- **28** such rows piled up (16 on `*`, 12 on `papercusp`) over ~24h (oldest 2026-07-03 07:39, newest 2026-07-04 07:08). Every one is a valid class-2 candidate: `LEFT JOIN routines` shows all 28 have `active=false` matching routines (`no_routine=0`, `routine_active=0`).
- **Class-1** of the SAME `db.delete(at).where(or(class1, class2))` DOES work: **zero** zero-error rows older than 14d exist despite 293 total rows going back to 2026-05-01. So the DELETE statement runs (doesn't throw) and the prune executes — only its **class-2 branch matches zero production rows**.
- The class-2 predicate matches all 28 when queried directly as `harness_admin` (RLS-bypassing owner). Both tables have RLS (`workspace_id = current_setting('app.workspace_id')`) enabled-not-forced.
- The prune's only invoker is `recordFire → maybePruneStaleFireState` (fire-and-forget, 6h/process throttle), which runs inside a `runWithWorkspace(row.routine_workspace_id, …)` context. The most probable root cause: the fire-and-forget class-2 EXISTS-on-`routines` correlation evaluates under a workspace/RLS/connection context in production that class-1 (pure predicate on the outer table) survives but the cross-table EXISTS does not — i.e. a runtime-context bug, not a SQL-logic bug (logic is unit-green in `autoloop-state.integration.test.ts`).

## Why needs-human (STOP condition)
The correct durable fix — make dead-loop terminal watermark rows actually clear — requires changing a **protected surface**: the routines/autoloop scheduler + its fire-and-forget prune runtime/RLS-workspace context (autoloop.ts), OR `reconcile-loop-routines.ts` to delete the fire-state row at terminal time, OR the self-improvement chronic-failure sweep. All three are on the auto-implement STOP list (routines/DBOS scheduler / self-improvement loop's own code), and the class-2 branch's failure is a **production-runtime** effect I cannot reproduce or verify live from an isolated runner. The ticket-specific condition is already resolved by existing guards, so there is no verifiable code change to make + test for THIS loop.

### Proposed durable fix (for the human)
Make class-2 cleanup not depend on the fire-and-forget cross-table EXISTS under an ambient workspace context. Concretely, ONE of:
- At the terminal moment in `reconcile-loop-routines.ts` (right after auto-pausing the routine + `recordFire('loop-terminal-unreachable','error')`), also DELETE that exact `autoloop_state` row (same `runWithWorkspace` context already held, single targeted delete — no cross-table EXISTS, no throttle dependency); or
- Run `pruneStaleFireState` as a proper scheduled routine (not fire-and-forget) under a root/global context so the class-2 EXISTS on `routines` isn't RLS/workspace-scoped away; or
- Verify + fix the workspace/RLS context under which the detached prune's class-2 EXISTS evaluates.
Add a production-shaped regression: assert a paused-routine terminal row is cleared under the SAME connection/RLS context the operator uses (the current integration test uses a root connection with no RLS, which is exactly why the production gap is invisible to it).

## Outcome
Resolved `needs-human`. No code change made (fix is a protected-surface, unverifiable-from-runner scheduler change; ticket condition already guarded).
