/**
 * operator-sentinel-handoff — the Sentinel/Herald's file-and-nudge placement seam
 * (sentinel-herald Phase 4: P-014 / P-015 / P-016).
 *
 * The Sentinel is the Herald: it SUGGESTS and HANDS OFF, it never places work
 * itself. Its capability envelope denies cup:spawn/placement by design (the whole
 * point of the role), so where the OPERATOR turn dispatches `<spawn>` directly into
 * the nursery, the SENTINEL turn dispatches `<handoff_to_queen>` THROUGH HERE:
 *
 *   1. (P-015) Resolve the action's TIER through the EXISTING standing-approval /
 *      tier system — the Sentinel is the user-facing approval tier.
 *        - low                    → just file + nudge (the common case).
 *        - medium/high, NOT yet a → surface for approval (record a standing-approval
 *          standing approval         candidate + escalate to the human) and DO NOT
 *                                    place yet. The Queen acts once the user approves.
 *        - medium/high, ALREADY   → file + nudge (the user has a standing approval
 *          standing-approved          for this (capability, harness) — treat like low).
 *   2. (P-014) File a HIGH-PRIORITY `work_item` describing what the user wants,
 *      tagged `user-requested` — the durable record the Queen triages. Filed
 *      UNASSIGNED so the Queen's default `work_items:create` demand subscription
 *      wakes her, and `urgent` when flagged so the hive urgent-wake fires NOW.
 *   3. (P-014) Nudge the Queen (a coord notify; an escalation when urgent) so she
 *      picks it up promptly — a wake, not just an inject.
 *   4. (P-016) Subscribe the operator-owner to the work_item thread and, when the
 *      item later lands, report it back through the hindsight "[While you were
 *      away]" channel (notifyOperatorHindsight) — the same push the delegate path
 *      uses. The landing watch itself is fired by the work_item lifecycle fan-out
 *      (subscribe→inject); this module records the subscription + seeds the
 *      pending-handoff registry the lifecycle observer drains.
 *
 * The Sentinel NEVER calls cup:spawn — the converse dispatch (converse.ts) only
 * reads `<handoff_to_queen>` for role==='sentinel' and only reads `<spawn>` for the
 * operator, so the two paths can't cross.
 *
 * Dependency-injected (the `deps` arg) so the dispatch unit-tests without PG: the
 * work_item create, the Queen wake/nudge, the preferences/tier reads, and the
 * subscribe are all seams. The default deps wire the real substrate.
 */

import type { HandoffRequest } from './operator-converse-tags';
import { resolveActualTier } from './operator-suggestion-schema';
import type { CapabilityTier } from '@papercusp/plugin-sdk';

/** The label the Sentinel tags onto every handoff work_item (P-014). The Queen's
 *  survey + the user's filters key on it to spot "the user explicitly asked for
 *  this". */
export const USER_REQUESTED_LABEL = 'user-requested';

/** The capability the Sentinel's handoff is recorded under for the standing-approval
 *  tier resolution / candidate. The Sentinel itself can't place — the handoff
 *  exercises the QUEEN's placement capability, so that's what the user approves a
 *  standing grant for. */
export const HANDOFF_CAPABILITY = 'cup:spawn';

export interface SentinelHandoffDeps {
  /** Create the work_item. Returns the minted id (WI-NNN) or null on failure. */
  createWorkItem: (input: {
    title: string;
    summary: string;
    harness: string | null;
    label: string;
    urgent: boolean;
    workspaceId: string;
  }) => Promise<{ id: string } | null>;
  /** Bump the new item to high priority (the user-asked default). Best-effort. */
  setPriority: (id: string, priority: 'high', harness: string | null) => Promise<void>;
  /** Nudge the Queen — a coord notify (escalation when urgent) carrying a wake.
   *  `kind:'escalate'` for urgent, `kind:'send'` otherwise. */
  nudgeQueen: (n: {
    workItemId: string;
    summary: string;
    urgent: boolean;
    harness: string | null;
  }) => Promise<void>;
  /** Subscribe the operator-owner to the work_item thread so its landing fans back
   *  via hindsight (P-016). */
  subscribeOperator: (workItemId: string, harness: string | null) => Promise<void>;
  /** Surface a medium/high handoff for the user's approval (P-015): record a
   *  standing-approval candidate + escalate. Returns nothing — the placement is
   *  deferred to the Queen, post-approval. */
  surfaceForApproval: (s: {
    summary: string;
    tier: CapabilityTier;
    capability: string;
    harness: string | null;
  }) => Promise<void>;
  /** The (capability, harness) pairs the user has already granted a STANDING
   *  approval for — a medium/high handoff matching one of these is auto-filed
   *  (treated like low) instead of re-surfaced. */
  standingApprovals: () => Promise<Array<{ capability: string; targetHarness: string }>>;
}

export type HandoffOutcome =
  | { status: 'filed'; workItemId: string; tier: CapabilityTier; nudged: boolean }
  | { status: 'surfaced_for_approval'; tier: CapabilityTier }
  | { status: 'error'; error: string };

/**
 * Resolve the AUTHORITATIVE tier for a handoff (P-015). When the brain named a
 * `capability`, the substrate tier-table is the source of truth
 * (resolveActualTier) — the brain's `tier` hint is only the fallback for a
 * capability-less generic handoff. An unknown capability fails SAFE to 'high'.
 */
export function resolveHandoffTier(h: HandoffRequest): CapabilityTier {
  if (h.capability) {
    const { tier } = resolveActualTier(
      {
        action: 'send_directive',
        capability: h.capability as 'messages:write',
      } as Parameters<typeof resolveActualTier>[0],
    );
    return tier;
  }
  // No capability named — trust the brain's self-classification (already
  // constrained to low|medium|high by the tag parser, default 'high').
  return h.tier;
}

/**
 * Dispatch ONE `<handoff_to_queen>` request. Tier-gated (P-015), then file +
 * nudge (P-014) + subscribe-for-hindsight (P-016). Never throws — a failure is
 * returned as `{ status: 'error' }` so a bad handoff can't crash the user-visible
 * turn (same contract as the operator's `<spawn>` dispatch).
 */
export async function dispatchSentinelHandoff(
  h: HandoffRequest,
  workspaceId: string,
  deps: SentinelHandoffDeps,
): Promise<HandoffOutcome> {
  try {
    const tier = resolveHandoffTier(h);

    // P-015: the Sentinel is the user-facing approval tier. A medium/high action
    // the user has NOT standing-approved for this (capability, harness) is
    // surfaced for approval rather than placed — the Queen acts post-approval.
    if (tier !== 'low') {
      const approvals = await deps.standingApprovals().catch(() => []);
      const already = approvals.some(
        (a) =>
          a.capability === HANDOFF_CAPABILITY &&
          (a.targetHarness === (h.harness ?? '') || a.targetHarness === '*'),
      );
      if (!already) {
        await deps.surfaceForApproval({
          summary: h.summary,
          tier,
          capability: HANDOFF_CAPABILITY,
          harness: h.harness,
        });
        return { status: 'surfaced_for_approval', tier };
      }
    }

    // P-014: file the high-priority, user-requested work_item (unassigned →
    // wakes the Queen via her default create-demand subscription; urgent →
    // fires the hive urgent-wake NOW).
    const title = h.summary.slice(0, 200);
    const created = await deps.createWorkItem({
      title,
      summary: h.summary,
      harness: h.harness,
      label: USER_REQUESTED_LABEL,
      urgent: h.urgent,
      workspaceId,
    });
    if (!created) return { status: 'error', error: 'work_item create failed' };

    // High priority for user-asked work (the persona contract). Best-effort.
    await deps.setPriority(created.id, 'high', h.harness).catch(() => {});

    // P-016: subscribe the operator-owner so the item's landing fans back via
    // hindsight ("[While you were away]").
    await deps.subscribeOperator(created.id, h.harness).catch(() => {});

    // P-014: nudge the Queen with a wake (escalate when urgent).
    let nudged = false;
    try {
      await deps.nudgeQueen({
        workItemId: created.id,
        summary: h.summary,
        urgent: h.urgent,
        harness: h.harness,
      });
      nudged = true;
    } catch {
      /* the create-event already wakes her; a failed explicit nudge is non-fatal */
    }

    return { status: 'filed', workItemId: created.id, tier, nudged };
  } catch (err) {
    return { status: 'error', error: err instanceof Error ? err.message : String(err) };
  }
}
