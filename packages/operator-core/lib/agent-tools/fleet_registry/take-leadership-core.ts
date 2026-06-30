/**
 * take-leadership-core — the SHARED D-002 leadership-transfer effect (named-su-agent-
 * fleets-2026-06-29 / EI-5705 + EI-5704). The ONE code path that both fleet:take-leadership
 * and fleet:join { as:'leader' } call, so "become the leader" behaves identically however
 * it is reached.
 *
 * It (1) installs the caller as the registry leader (single-leader invariant — there is
 * exactly one agent_fleets.leader_owner_id), (2) labels the caller's presence this fleet's
 * `leader`, (3) demotes the PRIOR leader's presence to `member` (always, except when they
 * have since moved to a different fleet — see shouldDemotePriorLeader), and (4) NOTIFIES the
 * displaced leader via a durable coord inbox inject so they know they were replaced — and
 * returns `notified` so the new leader knows the displaced leader was already told and does
 * NOT redundantly message them (owner spec 2026-06-30).
 */
import { setFleetLeader, type AgentFleetRecord } from '../../agent-fleets-store';
import { heartbeatPresence, setPresenceFleet } from '../coordination/presence';
import { fetchPresenceFleet } from '../coordination/presence-fleet';
import { sendMessage } from '../coordination/messages';
import type { AgentIdentity } from '../coordination/identity';
import { shouldDemotePriorLeader } from './_shared';

export interface TakeLeadershipOutcome {
  slug: string;
  /** The new leader (the caller). */
  leader: string;
  /** Who led before the transfer (null when the fleet had no leader, or === caller). */
  previousLeader: string | null;
  /** The prior leader whose presence was actually demoted to `member` (null when there
   *  was none, the caller already led, or the prior leader had moved to another fleet). */
  demotedPriorLeader: string | null;
  /** Whether the displaced prior leader was sent the "you are now a member" notification.
   *  When true, the caller need NOT message them — they have already been told. */
  notified: boolean;
}

/**
 * Transfer fleet leadership to `ownerId`. Pure-ish orchestration over the store + presence +
 * coord seams; safe to call when the caller already leads (no-op demote/notify) or the fleet
 * had no leader (just installs the caller). Never throws on a notify miss — the transfer
 * itself always lands.
 */
export async function takeFleetLeadership(
  workspaceId: string,
  fleet: AgentFleetRecord,
  identity: AgentIdentity,
  ownerId: string,
): Promise<TakeLeadershipOutcome> {
  const slug = fleet.fleetSlug;
  const previousLeader = fleet.leaderOwnerId; // may be null, or already === caller

  // 1. Registry: the caller becomes the sole leader (single-leader invariant, D-002).
  await setFleetLeader(workspaceId, slug, ownerId);
  // 2. The caller's presence → this fleet's leader.
  await heartbeatPresence(identity); // guarantee a presence row to label
  await setPresenceFleet(workspaceId, ownerId, slug, 'leader');

  let demotedPriorLeader: string | null = null;
  let notified = false;
  if (previousLeader && previousLeader !== ownerId) {
    // 3. Demote the prior leader's presence → member (ONE leader per fleet). Demote when
    //    they are still labeled in THIS fleet OR carry no fleet label (leader-of-record only
    //    / ended — setPresenceFleet is UPDATE-only, so a gone agent is a harmless no-op);
    //    SKIP only when they have since moved to a DIFFERENT fleet.
    const priorFleet =
      (await fetchPresenceFleet([previousLeader])).get(previousLeader)?.fleetSlug ?? null;
    if (shouldDemotePriorLeader(previousLeader, ownerId, priorFleet, slug)) {
      await setPresenceFleet(workspaceId, previousLeader, slug, 'member');
      demotedPriorLeader = previousLeader;
    }
    // 4. Notify the displaced leader so they KNOW they were replaced — a durable inbox
    //    inject (persists even for an ended session). Best-effort: a notify miss must never
    //    fail the leadership transfer. `notified` lets the new leader skip a redundant message.
    try {
      await sendMessage(identity, {
        to: [previousLeader],
        summary: `${ownerId} took fleet leadership of '${slug}' — you are now a member.`,
        body:
          `Leadership of fleet '${slug}' was transferred to ${ownerId}; you have been demoted ` +
          `from leader to member. The new leader owns monitoring, coordination, and driving the ` +
          `plan to completion. No action needed unless you intend to reclaim the fleet.`,
      });
      notified = true;
    } catch {
      /* best-effort: a notify miss must never fail the (already-committed) transfer */
    }
  }

  return { slug, leader: ownerId, previousLeader: previousLeader ?? null, demotedPriorLeader, notified };
}
