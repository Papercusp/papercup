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
 *   set_state needs-human                        → needs-human (feature-family native state)
 *   set_state blocked                            → blocked, or needs-human when the item
 *                                                    carries payload.needsHuman:true (the
 *                                                    issue-family needs-human ALIAS dialect,
 *                                                    which collapses onto `state:'blocked'` +
 *                                                    a payload flag instead of a distinct state)
 *   release (drop the claim, state non-terminal) → todo   (back to the pool)
 *   validating / failing / wip / …               → no flip (still being worked)
 *
 * EI-6569: `blocked`/`needs-human` were MISSING from this mapping entirely (fell to
 * the `default: no flip` case) — so a work-item parked at either state (the self-select
 * exclusion dialects: the WI-2797 claim hold, or an owner-acceptance-only item no bee
 * can ever complete) left its linked plan item's CACHED status stuck at whatever it was
 * before parking (usually `todo`) forever. The Mug's plan survey counts a plan item's
 * OWN stored status toward `openItems` (survey.ts `planToCandidate`) — never the linked
 * work-item's real state — so a plan with a parked-but-never-reflected item kept reading
 * as "has open placeable work" indefinitely, driving repeated Queen-wake false positives
 * (survey re-surfacing an item no bee can ever actually place; live case: WI-1439 / plan
 * `voice-unified-sentinel-pipeline-2026-07-01`#P-016, parked `blocked` on 2026-07-03 with
 * its plan item stuck at `todo` for over two weeks).
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
  payload?: { plan_item?: PlanItemStamp; needsHuman?: boolean } | null;
}

interface FinishReceipt {
  planItem?: string;
  claimRelease?: string;
}

function finishOf(e: ToolInvocationEvent): FinishReceipt | null {
  return ((e.result?.data as { finish?: FinishReceipt } | undefined)?.finish ?? null);
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

/** set_state's work-item state (+ its `payload.needsHuman` flag, for the issue-family
 *  alias dialect that collapses `needs-human` onto `state:'blocked'`) → the plan-item
 *  status to reflect (null = no flip, still being worked). EI-6569: `blocked` and
 *  `needs-human` are deliberately reflected too — a parked work-item's plan item must
 *  stop reading as open/placeable (see the module header for the full rationale). */
export function reflectedStatus(
  state: string | undefined,
  needsHuman?: boolean,
): 'done' | 'dropped' | 'todo' | 'blocked' | 'needs-human' | null {
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
    // Feature-family carries `needs-human` as its own distinct native status (unlike
    // the issue-family 3-state vocabulary, which has no room for it and instead aliases
    // onto `blocked` + payload.needsHuman — see the `blocked` case below).
    case 'needs-human':
      return 'needs-human';
    case 'blocked':
      return needsHuman ? 'needs-human' : 'blocked';
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
    item: stamp.item_id,
    status,
    note: `← ${wi.id ?? 'work_item'} ${why}`,
    // EI-19972048649686949 + WI-38908: an AUTOMATED cascade to EITHER terminal status
    // must not de-queue a plan item another non-terminal work-item still covers — the
    // original case was dropping a hand-filed duplicate of an already-claimed
    // implementer; the `done` half is the 1:N lane, where completing the FIRST of many
    // stamped siblings marked the whole item finished (live: 3x in ~1h on
    // sidestage-public-release-testing-2026-08-14#P-009, with 8+ open stamped bugs).
    // Reopen/park flips are still unaffected — set-status.ts's guard is a no-op unless
    // the status is terminal. `onlyIfNotCompleted` stays drop-only: it exists purely to
    // stop a `done` → `dropped` DOWNGRADE, which a → `done` flip cannot be.
    //
    // EI-20129670928216719: `onlyIfNotCompleted` covers the case the line above CANNOT —
    // the sibling that completed the plan item is itself `done`, i.e. terminal, so it is
    // filtered out of the coverage scan and the item reads as uncovered. Without it,
    // dropping a merely `relates`-linked follow-on silently downgraded an already-`done`
    // plan item (live: fix-0014-platform-defects-2026-08-10#P-005, downgraded 67ms after
    // WI-37872 was dropped, while its real completer WI-37735 sat `done`). The two guards
    // are complementary, not redundant: open coverage vs. finished coverage.
    ...(status === 'dropped' || status === 'done' ? { onlyIfNoOtherOpenCoverage: true } : {}),
    ...(status === 'dropped' ? { onlyIfNotCompleted: true } : {}),
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
    !['done', 'dropped'].includes(finishOf(e)?.planItem ?? '') &&
    COMPLETE_REFLECTABLE.has(reflectedStatus(workItemOf(e).state) ?? ''),
  fire: 'plans:set-status',
  args: (e) => {
    const wi = workItemOf(e);
    return setStatusArgs(e, reflectedStatus(wi.state)!, wi.state ? `completed (${wi.state})` : 'completed');
  },
  // A synchronous finish leg may fail AFTER the work-item closed, yielding
  // ok:false. Fire as a durable convergence fallback in that case.
  onlyOnSuccess: false,
  source: 'plan-item-reflect',
});

/** SET_STATE → the mapped plan status (terminal-success → done, terminal-drop → dropped,
 *  reopen → todo, park → blocked/needs-human — EI-6569). */
registerReactionRule({
  id: 'plan-item-reflect:set-state',
  on: 'work_items:set_state',
  when: (e) => {
    const wi = workItemOf(e);
    return stampOf(e) !== null && reflectedStatus(wi.state, wi.payload?.needsHuman === true) !== null;
  },
  fire: 'plans:set-status',
  args: (e) => {
    const wi = workItemOf(e);
    const status = reflectedStatus(wi.state, wi.payload?.needsHuman === true)!;
    return setStatusArgs(e, status, wi.state ?? 'state-changed');
  },
  onlyOnSuccess: true,
  source: 'plan-item-reflect',
});

/**
 * RELEASE of a non-terminal converted item → the plan item returns to todo (the pool).
 *
 * ⚠ `onlyIfNotTerminal` is load-bearing, not defensive decoration. A release is an
 * OWNERSHIP event: it says "I am no longer holding this", and carries NO information
 * about whether the work is finished. The `when` below can only see the WORK-ITEM's
 * state — the rules matcher is pure/sync (see the module header), so it cannot read the
 * PLAN ITEM's status — and a plan item can reach `done` by paths this work-item knows
 * nothing about: flipped directly on the plan, or completed by a SIBLING work-item.
 * (reconcile-linked-work-items.ts documents that same asymmetry in the other direction.)
 *
 * Without the guard, releasing a stale non-terminal work-item silently DE-COMPLETED an
 * already-`done` plan item: it re-entered the claimable pool where an agent could redo
 * finished work, and every item `blocked-by` it flipped to a false `blocked`. Observed
 * live on memory-write-latency-2026-07-26#P-007 — code deployed and serving, plan item
 * reverted to `todo` by the release of its linked WI-6211.
 *
 * The guard makes the flip non-destructive: terminal items are left alone and reported
 * `skipped:'terminal_guard'`. A human deliberately reopening an item is unaffected —
 * they call plans:set-status without the flag.
 */
registerReactionRule({
  id: 'plan-item-reflect:release',
  on: 'work_items:release',
  when: (e) => {
    if (stampOf(e) === null) return false;
    const state = workItemOf(e).state;
    return !state || !TERMINAL_STATES.has(state);
  },
  fire: 'plans:set-status',
  args: (e) => ({ ...setStatusArgs(e, 'todo', 'released'), onlyIfNotTerminal: true }),
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
    Boolean((e.result?.data as { completion?: unknown } | undefined)?.completion) &&
    stampOf(e) !== null &&
    TERMINAL_STATES.has(workItemOf(e).state ?? '') &&
    finishOf(e)?.claimRelease !== 'released-or-absent',
  fire: 'plan_items:release',
  args: leaseReleaseArgs,
  onlyOnSuccess: false,
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
