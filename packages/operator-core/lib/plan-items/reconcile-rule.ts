/**
 * reconcile-rule.ts — EI-5925 / EI-6960: when a plan item transitions to `done`
 * via `plans:set-status`, fire the `plan-item.reconcileLinkedWorkItems` builtin
 * action so every OTHER work-item still linked to that plan item (via the
 * `implements` edge or the `payload.plan_item` stamp) gets auto-resolved instead
 * of sitting as a phantom-todo the scheduler re-hands. The reverse mirror of
 * reflect-rules.ts (work_item → plan item); registered the same way, on import.
 *
 * ─ EI-6960 ROOT CAUSE (why this rule silently NEVER fired) ────────────────────
 * The reaction engine FANS a bulk-envelope result into one synthetic event PER
 * ITEM and does NOT match the bulk-level carrier (engine.ts `fanOutBulkEvent` /
 * D-007). EVERY `plans:set-status` call returns a bulk envelope (it always runs
 * through `runBulk` + `bulkContent`, even for a single item), so this rule only
 * ever sees the PER-ITEM events — whose `result.data` is ONE FLAT item record
 * `{ ok, slug, itemId, oldStatus, newStatus }`, NOT the bulk `{ results:[…] }`
 * envelope. The original rule read `data.results[]` (the bulk shape), which is
 * ABSENT on a per-item event → its `when` was always false → linked work_items
 * were never reconciled and the scheduler kept re-handing already-done work
 * (WI-1734/1737/1738/1741/1743 on p2p-work-distribution-2026-07-02 sat todo+
 * unclaimed until hand-reconciled). The fix: read the PER-ITEM shape, exactly as
 * reflect-rules.ts reads `data.workItem` off the same fanned events.
 */
import { registerReactionRule } from '../events';
import { PLAN_ITEM_RECONCILE_ACTION } from '../events/builtin-actions';
import type { ToolInvocationEvent } from '../events/types';
import type { CompletedPlanItem } from './reconcile-linked-work-items';

/** One fanned per-item `plans:set-status` result — the flat record `setStatusOne`
 *  returns for a single item (engine.ts `fanOutBulkEvent` sets `result.data = ri`). */
interface SetStatusItemResult {
  ok?: boolean;
  slug?: string;
  itemId?: string;
  oldStatus?: string | null;
  newStatus?: string;
}

/**
 * The plan item this per-item `plans:set-status` event NEWLY transitioned into
 * `done` (transition-gated: a re-set of an already-done item does not re-fire),
 * or null. Reads the PER-ITEM event shape the reaction engine dispatches — see
 * the EI-6960 note in the module header for why the bulk `results[]` shape never
 * matched. Exported for the unit test.
 */
export function newlyDonePlanItem(e: ToolInvocationEvent): CompletedPlanItem | null {
  const r = e.result?.data as SetStatusItemResult | undefined;
  if (
    r?.ok === true &&
    r.newStatus === 'done' &&
    r.oldStatus !== 'done' &&
    typeof r.slug === 'string' &&
    typeof r.itemId === 'string'
  ) {
    return { planSlug: r.slug, itemId: r.itemId };
  }
  return null;
}

registerReactionRule({
  id: 'plan-item-reconcile:done',
  on: 'plans:set-status',
  when: (e) => newlyDonePlanItem(e) !== null,
  fire: PLAN_ITEM_RECONCILE_ACTION,
  args: (e) => ({ completedItems: [newlyDonePlanItem(e)!] }),
  onlyOnSuccess: true,
  source: 'plan-item-reconcile',
});
