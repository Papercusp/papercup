/**
 * reconcile-rule.ts — EI-5925: when one or more plan items transition to
 * `done` via `plans:set-status` (single OR bulk), fire the
 * `plan-item.reconcileLinkedWorkItems` builtin action so every OTHER
 * work-item still linked to those plan items (via the `implements` edge or
 * the `payload.plan_item` stamp) gets auto-resolved instead of sitting as a
 * phantom-todo. The reverse mirror of reflect-rules.ts (work_item → plan
 * item); registered the same way, on import.
 */
import { registerReactionRule } from '../events';
import { PLAN_ITEM_RECONCILE_ACTION } from '../events/builtin-actions';
import type { ToolInvocationEvent } from '../events/types';
import type { CompletedPlanItem } from './reconcile-linked-work-items';

interface SetStatusBulkResult {
  ok?: boolean;
  slug?: string;
  itemId?: string;
  oldStatus?: string | null;
  newStatus?: string;
}

interface SetStatusBulkData {
  ok?: boolean;
  results?: SetStatusBulkResult[];
}

/** Every (slug, itemId) that just NEWLY transitioned into `done` this call
 *  (transition-gated: a re-set of an already-done item does not re-fire). */
export function newlyDonePlanItems(e: ToolInvocationEvent): CompletedPlanItem[] {
  const data = e.result?.data as SetStatusBulkData | undefined;
  const results = data?.results;
  if (!Array.isArray(results)) return [];
  const out: CompletedPlanItem[] = [];
  for (const r of results) {
    if (
      r?.ok &&
      r.newStatus === 'done' &&
      r.oldStatus !== 'done' &&
      typeof r.slug === 'string' &&
      typeof r.itemId === 'string'
    ) {
      out.push({ planSlug: r.slug, itemId: r.itemId });
    }
  }
  return out;
}

registerReactionRule({
  id: 'plan-item-reconcile:done',
  on: 'plans:set-status',
  when: (e) => newlyDonePlanItems(e).length > 0,
  fire: PLAN_ITEM_RECONCILE_ACTION,
  args: (e) => ({ completedItems: newlyDonePlanItems(e) }),
  onlyOnSuccess: true,
  source: 'plan-item-reconcile',
});
