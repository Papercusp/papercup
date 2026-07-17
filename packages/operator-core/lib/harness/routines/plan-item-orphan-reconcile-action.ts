/**
 * `system:plan-item-orphan-reconcile` — the periodic data-heal for EI-14693's
 * transition-gap. The reverse reconciler (`reconcileLinkedWorkItemsForPlanItem`)
 * only ever fires on a plan item's done *transition* (plan-items/reconcile-rule.ts),
 * so a work-item that reaches a NON-terminal state AFTER its plan item is already
 * terminal — a reset (EI-13337), a complete-without-state (D-004: EI-13318/13346/
 * 14676), or a late create — is never re-healed. It then pollutes every surface
 * that reads raw work-item `state`: the claim path (now separately guarded by
 * scheduler/plan-item-lane-guard.ts), pot:survey placement (spurious Mug wakes),
 * backlog counts, and drain-fleet re-work of already-done plan-lane items.
 *
 * This action is the thin registration seam: call the existing, terminal-aware,
 * fail-closed, idempotent `reconcileOrphanedPlanItemWorkItems` sweep on a cadence.
 * No new heal logic — it reuses the exact per-item reconciler (and its safety
 * rails: skip already-terminal, skip independent in-flight `lastProgressAt`
 * progress, never throw) and extends coverage to `dropped` plan items too.
 *
 * Config (routine `trigger_config`, optional):
 *   - `candidate_cap` — override DEFAULT_ORPHAN_SWEEP_CAP (500), the per-tick bound
 *     on distinct candidate plan-items enumerated.
 *
 * Homed as a bespoke periodic routine (NOT a bare setInterval — lint:no-raw-setinterval)
 * seeded by seed-plan-item-orphan-reconcile-routine.ts, mirroring system:gc-plan-runs.
 */
import { registerSystemAction, type SystemActionCtx } from './system-actions';
import { reconcileOrphanedPlanItemWorkItems } from '../../plan-items/reconcile-linked-work-items';

registerSystemAction('plan-item-orphan-reconcile', async (ctx: SystemActionCtx) => {
  const cfg = ctx.triggerConfig ?? {};
  const candidateCap = Number(cfg.candidate_cap);
  const result = await reconcileOrphanedPlanItemWorkItems(
    Number.isFinite(candidateCap) && candidateCap > 0 ? { candidateCap } : {},
  );
  // Quiet on a clean no-op tick (the common steady state); log only when the sweep
  // actually found terminal plan-items or healed something.
  if (result.terminalPlanItems > 0 || result.reconciled.length > 0) {
    console.log(
      `[plan-item-orphan-reconcile] ${ctx.installSlug}: ${result.candidatePlanItems} candidate plan-item(s), ` +
        `${result.terminalPlanItems} terminal — reconciled ${result.reconciled.length} work-item(s) ` +
        `(${result.skippedInFlight.length} in-flight, ${result.skippedAlreadyTerminal.length} already-terminal skipped)` +
        (result.reconciled.length ? `: ${result.reconciled.join(', ')}` : ''),
    );
  }
});
