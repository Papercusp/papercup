/**
 * lane-sync-rule.ts — EI-18732669095544832: `plans:set-item-blocked-by` changes an
 * item's `blocked-by:` edge, which can flip its EFFECTIVE lane status (blocked ↔
 * actionable) immediately — but nothing previously re-ran the plan-item ↔
 * work-item lane sync (EI-14699's `syncLinkedWorkItemsToPlanLane`) off that tool;
 * only the 15-minute `plan-item-orphan-reconcile` periodic sweep eventually caught
 * up (`reconcile-linked-work-items.ts`'s `reconcileOrphanedPlanItemWorkItems`).
 * Clearing a blocker therefore looked like a silent no-op for up to 15 minutes:
 * the tool reported `ok:true`, the plan file was rewritten, but the linked
 * work-item stayed parked (`state: 'blocked'`) until the next tick — a member
 * told to pick up the now-"unblocked" work found nothing claimable, and neither
 * side got an error.
 *
 * This rule closes the gap the SAME way `reconcile-rule.ts` closes the terminal
 * one (see that file's header for the full architecture rationale — a reaction
 * rule fired off the trigger tool, NOT a hardcoded call inside
 * `plans/set-item-blocked-by.ts`, so the whole plan-item <-> work-item lifecycle
 * interplay stays ONE mechanism, inspectable in `events:graph`): react to the
 * per-item `plans:set-item-blocked-by` event and fire the in-process builtin
 * action `plan-item.resyncLane`, which re-reads the plan item's CURRENT effective
 * lane and syncs it onto every linked work-item RIGHT NOW — inline, synchronous
 * with the caller's turn, no 15-minute wait. The periodic sweep remains the
 * fail-safe backstop for any OTHER path that can move an item's effective lane
 * (e.g. a dependency's own status changing).
 *
 * This is symmetric by construction: it fires whenever `blockedBy` is set to
 * anything (CLEARING a blocker un-parks; ADDING one parks), because
 * `resyncPlanItemLaneNow` re-classifies from scratch rather than special-casing
 * a direction — closing both the reported clear-doesn't-unblock case and the
 * suspected mirror add-doesn't-block case the bug report flagged as untested.
 *
 * ⚠ Per registry.ts's EI-6980 warning: `plans:set-item-blocked-by` is bulk-capable
 * (`runBulk`/`bulkContent`), so this rule sees the FANNED PER-ITEM event, never the
 * bulk `results[]` carrier — read the flat per-item shape `setBlockedByOne` returns
 * (`{ ok, slug, itemId, from, to }`), exactly like reconcile-rule.ts's EI-6960 fix.
 */
import { registerReactionRule } from '../events';
import { PLAN_ITEM_LANE_RESYNC_ACTION } from '../events/builtin-actions';
import type { ToolInvocationEvent } from '../events/types';

/** One fanned per-item `plans:set-item-blocked-by` result — the flat record
 *  `setBlockedByOne` returns for a single item. */
interface SetBlockedByItemResult {
  ok?: boolean;
  slug?: string;
  itemId?: string;
}

/** One fanned per-item `plans:set-status` result. A successful status flip can
 * change the effective lane in either direction: notably blocked -> wip must
 * lift the plan-lane blocker from the linked work-item in the same turn. */
interface SetStatusItemResult {
  ok?: boolean;
  slug?: string;
  itemId?: string;
  oldStatus?: string | null;
  newStatus?: string;
}

/**
 * The { planSlug, itemId, harnessSlug } this per-item event names, or null when
 * the call failed / the shape doesn't match (e.g. the bulk carrier itself, which
 * the engine never matches — see the EI-6980 note above). Exported for the unit
 * test.
 */
export function blockedByChangedItem(
  e: ToolInvocationEvent,
): { planSlug: string; itemId: string; harnessSlug: string | null } | null {
  const r = e.result?.data as SetBlockedByItemResult | undefined;
  if (r?.ok === true && typeof r.slug === 'string' && typeof r.itemId === 'string') {
    const harnessSlug = typeof e.ctx?.harnessSlug === 'string' ? e.ctx.harnessSlug : null;
    return { planSlug: r.slug, itemId: r.itemId, harnessSlug };
  }
  return null;
}

/** Extract a real status transition from the fanned per-item result. Re-sets
 * are excluded because they cannot change the effective lane. */
export function statusChangedItem(
  e: ToolInvocationEvent,
): { planSlug: string; itemId: string; harnessSlug: string | null } | null {
  const r = e.result?.data as SetStatusItemResult | undefined;
  if (
    r?.ok === true &&
    typeof r.slug === 'string' &&
    typeof r.itemId === 'string' &&
    typeof r.newStatus === 'string' &&
    r.oldStatus !== r.newStatus
  ) {
    const harnessSlug = typeof e.ctx?.harnessSlug === 'string' ? e.ctx.harnessSlug : null;
    return { planSlug: r.slug, itemId: r.itemId, harnessSlug };
  }
  return null;
}

registerReactionRule({
  id: 'plan-item-lane-sync:blocked-by-changed',
  on: 'plans:set-item-blocked-by',
  when: (e) => blockedByChangedItem(e) !== null,
  fire: PLAN_ITEM_LANE_RESYNC_ACTION,
  args: (e) => ({ items: [blockedByChangedItem(e)!] }),
  onlyOnSuccess: true,
  source: 'plan-item-lane-sync',
});

// EI-20961278100733275: `plans:set-status` previously had a partial bespoke
// state sync that deliberately skipped ->wip. A blocked -> wip flip therefore
// auto-claimed the plan item while its linked work-item remained `blocked` and
// retained the active `plan-lane:` blocker. Route every real status transition
// through the canonical lane reconciler, which atomically restores the stashed
// pre-park state/claim hold before clearing that provenance-tagged blocker.
registerReactionRule({
  id: 'plan-item-lane-sync:status-changed',
  on: 'plans:set-status',
  when: (e) => statusChangedItem(e) !== null,
  fire: PLAN_ITEM_LANE_RESYNC_ACTION,
  args: (e) => ({ items: [statusChangedItem(e)!] }),
  onlyOnSuccess: true,
  source: 'plan-item-lane-sync',
});
