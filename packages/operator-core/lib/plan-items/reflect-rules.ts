/**
 * reflect-rules.ts — work_item lifecycle → plan-item status reflection
 * (project-centric-harness-rethink D-015: convert-at-pickup, the read-back half).
 *
 * A plan item converted to a work_item (convert.ts) carries
 * `payload.plan_item = { plan_slug, item_id, harness_slug }`. These rules read
 * that stamp STRAIGHT OFF the work_items:* tool events (the rules matcher is
 * pure/sync — no I/O — which is exactly why convert stamps the payload in
 * addition to the `implements` edge) and mirror the work_item's lifecycle onto
 * the plan item by firing the real `plans:set-status` tool — so the flip gets
 * the plan lock, revision capture, plan-event emit, and needs-human push gating
 * for free, and the whole interplay is inspectable in events:graph.
 *
 * Mapping (work_item state → plan item status):
 *   complete (a completion record landed)        → done
 *   set_state passed | resolved | done           → done
 *   set_state deprecated | closed | dropped      → dropped
 *   set_state todo | open                        → todo   (reopened)
 *   release (drop the claim, state non-terminal) → todo   (back to the pool)
 *   validating / failing / wip / …               → no flip (still being worked)
 *
 * Registered on import (the plan_items tool barrel imports this module), same
 * pattern as coord-lifecycle/lifecycle-rules.ts.
 */
import { registerReactionRule } from '../events';
import type { ToolInvocationEvent } from '../events/types';
import type { PlanItemStamp } from './convert';

interface StampedWorkItem {
  id?: string;
  state?: string;
  payload?: { plan_item?: PlanItemStamp } | null;
}

/** plans:set-status only accepts P-NNN ids — guard so a rule never fires a doomed flip. */
const PLAN_ITEM_ID = /^P-\d{3,}$/;

/** The plan-item stamp off a work_items:* event's returned workItem, or null. */
export function stampOf(e: ToolInvocationEvent): PlanItemStamp | null {
  const data = e.result?.data as { ok?: boolean; workItem?: StampedWorkItem } | undefined;
  const stamp = data?.workItem?.payload?.plan_item;
  if (!stamp || typeof stamp !== 'object') return null;
  const { plan_slug, item_id, harness_slug } = stamp;
  if (!plan_slug || !item_id || !harness_slug) return null;
  if (!PLAN_ITEM_ID.test(item_id)) return null;
  return { plan_slug, item_id, harness_slug };
}

function workItemOf(e: ToolInvocationEvent): StampedWorkItem {
  return ((e.result?.data as { workItem?: StampedWorkItem } | undefined)?.workItem ?? {}) as StampedWorkItem;
}

const TERMINAL_STATES = new Set(['passed', 'resolved', 'closed', 'done', 'deprecated', 'dropped']);

/** set_state's work-item state → the plan-item status to reflect (null = no flip). */
export function reflectedStatus(state: string | undefined): 'done' | 'dropped' | 'todo' | null {
  switch (state) {
    case 'passed':
    case 'resolved':
    case 'done':
      return 'done';
    case 'deprecated':
    case 'closed':
    case 'dropped':
      return 'dropped';
    case 'todo':
    case 'open':
      return 'todo';
    default:
      return null;
  }
}

function setStatusArgs(e: ToolInvocationEvent, status: string, why: string): Record<string, unknown> {
  const stamp = stampOf(e)!;
  const wi = workItemOf(e);
  return {
    harness: stamp.harness_slug,
    slug: stamp.plan_slug,
    itemId: stamp.item_id,
    status,
    note: `← ${wi.id ?? 'work_item'} ${why}`,
  };
}

/** COMPLETE → the MAPPED terminal status (done or dropped), same mapping as set_state —
 *  NEVER a hardcoded 'done'. EI-8353: work_items:complete { state: 'closed', ... } (an
 *  owner-gated/deferred close) was previously always reflected as plan-item `done`,
 *  because this rule ignored the resulting work-item state entirely. A completion that
 *  closes/deprecates/drops the item must reflect `dropped` (still terminal — held by no
 *  one — but distinct from a genuinely finished `done`); a completion that leaves the
 *  item non-terminal (no `state` passed, or a state reflectedStatus doesn't map to a
 *  terminal outcome) must NOT flip the plan item at all. */
const COMPLETE_REFLECTABLE = new Set(['done', 'dropped']);

registerReactionRule({
  id: 'plan-item-reflect:complete',
  on: 'work_items:complete',
  when: (e) =>
    Boolean((e.result?.data as { completion?: unknown } | undefined)?.completion) &&
    stampOf(e) !== null &&
    COMPLETE_REFLECTABLE.has(reflectedStatus(workItemOf(e).state) ?? ''),
  fire: 'plans:set-status',
  args: (e) => {
    const wi = workItemOf(e);
    return setStatusArgs(e, reflectedStatus(wi.state)!, wi.state ? `completed (${wi.state})` : 'completed');
  },
  onlyOnSuccess: true,
  source: 'plan-item-reflect',
});

/** SET_STATE → the mapped plan status (terminal-success → done, terminal-drop → dropped, reopen → todo). */
registerReactionRule({
  id: 'plan-item-reflect:set-state',
  on: 'work_items:set_state',
  when: (e) => stampOf(e) !== null && reflectedStatus(workItemOf(e).state) !== null,
  fire: 'plans:set-status',
  args: (e) => {
    const wi = workItemOf(e);
    return setStatusArgs(e, reflectedStatus(wi.state)!, wi.state ?? 'state-changed');
  },
  onlyOnSuccess: true,
  source: 'plan-item-reflect',
});

/** RELEASE of a non-terminal converted item → the plan item returns to todo (the pool). */
registerReactionRule({
  id: 'plan-item-reflect:release',
  on: 'work_items:release',
  when: (e) => {
    if (stampOf(e) === null) return false;
    const state = workItemOf(e).state;
    return !state || !TERMINAL_STATES.has(state);
  },
  fire: 'plans:set-status',
  args: (e) => setStatusArgs(e, 'todo', 'released'),
  onlyOnSuccess: true,
  source: 'plan-item-reflect',
});

/** Finishing or dropping the execution record also DROPS THE LEASE — the pickup's
 *  mirror. plan_items:release resolves the caller's own claim (the reaction
 *  inherits the completer's identity), so when the completer holds the lease it
 *  is freed immediately instead of dangling until TTL; when someone else
 *  completes it (a supervisor), the release is a polite no-op and the holder's
 *  lease simply lapses. */
function leaseReleaseArgs(e: ToolInvocationEvent): Record<string, unknown> {
  const stamp = stampOf(e)!;
  return { harness: stamp.harness_slug, plan: stamp.plan_slug, item: stamp.item_id };
}

registerReactionRule({
  id: 'plan-item-reflect:complete-releases-lease',
  on: 'work_items:complete',
  when: (e) =>
    Boolean((e.result?.data as { completion?: unknown } | undefined)?.completion) && stampOf(e) !== null,
  fire: 'plan_items:release',
  args: leaseReleaseArgs,
  onlyOnSuccess: true,
  source: 'plan-item-reflect',
});

registerReactionRule({
  id: 'plan-item-reflect:release-releases-lease',
  on: 'work_items:release',
  when: (e) => stampOf(e) !== null,
  fire: 'plan_items:release',
  args: leaseReleaseArgs,
  onlyOnSuccess: true,
  source: 'plan-item-reflect',
});
