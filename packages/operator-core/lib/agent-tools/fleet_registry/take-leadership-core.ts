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
import { heartbeatPresence, setPresenceFleet, setCompactionLimit, getPresence } from '../coordination/presence';
import { fetchPresenceFleet } from '../coordination/presence-fleet';
import { sendMessage } from '../coordination/messages';
import type { AgentIdentity } from '../coordination/identity';
import { shouldDemotePriorLeader } from './_shared';

/** P-009: the outcome of the become-a-leader compaction-cap re-seed (below). */
export interface LeaderReseedOutcome {
  /** The soft compaction limit now stored for the new leader (tokens). */
  applied: number;
  /** What it was before (null = none stored, or unreadable). */
  from: number | null;
  /** Why the (non-)change happened. */
  reason:
    | 'explicit-limit' // caller passed compactionLimit → applied it (clamped to the leader ceiling)
    | 'explicit-context-size' // caller passed contextSize → left the limit alone
    | 'member-cap-lifted' // THE P-009 fix: a 300k member seed → the leader default (400k on [1m])
    | 'already-leader-grade' // current limit is not the member-cap seed → left untouched
    | 'non-1m-no-cap-gap'; // model caps member==leader (non-[1m]); nothing to lift
}

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
  /** P-009: the compaction-cap re-seed applied to the new leader (null = re-seed skipped/failed). */
  reseed: LeaderReseedOutcome | null;
}

/**
 * P-009 (owner directive 2026-07-19): when a session ACQUIRES fleet leadership, re-seed its
 * soft compaction limit to the LEADER default (COMPACTION_LIMIT_DEFAULT_1M_CAP, 400k on a
 * [1m] session) — fixing a member launched at the leaner 300k member cap that, once promoted,
 * stayed stuck below the leader ceiling (long-lived supervision state is expensive to
 * re-derive after compaction, which is exactly why leaders get the bigger window).
 *
 * Precise + non-clobbering: the auto-lift fires ONLY when the stored limit is EXACTLY the
 * member-cap seed (COMPACTION_LIMIT_DEFAULT_1M_FLEET_MEMBER_CAP) — a deliberately-tuned limit,
 * an already-leader-grade limit, or a null (read-time-derived, already role-aware) is left
 * untouched. An explicit `compactionLimit` on the make-leader call wins (clamped to the leader
 * ceiling); an explicit `contextSize` signals the caller is shaping the session, so the
 * auto-lift is suppressed. Best-effort: a resolve/write failure NEVER fails the (already
 * committed) leadership transfer. Exported so the launch-into-leadership path reuses it.
 */
export async function reseedLeaderCompactionLimit(
  ownerId: string,
  opts?: { compactionLimit?: number; contextSize?: 'full' | 'trimmed' },
): Promise<LeaderReseedOutcome | null> {
  try {
    const { resolveModelSpecForOwner } = await import('../../compaction-usage');
    const { clampCompactionLimit, defaultCompactionLimitForSpec, COMPACTION_LIMIT_DEFAULT_1M_FLEET_MEMBER_CAP } =
      await import('../../agent-config-constants');
    const spec = await resolveModelSpecForOwner(ownerId).catch(() => null);
    const leaderCap = defaultCompactionLimitForSpec(spec, { fleetMember: false });
    const current = (await getPresence(ownerId).catch(() => null))?.compactionLimit ?? null;

    if (opts?.compactionLimit != null) {
      const applied = clampCompactionLimit(opts.compactionLimit, spec, { fleetMember: false });
      await setCompactionLimit(ownerId, applied);
      return { applied, from: current, reason: 'explicit-limit' };
    }
    if (opts?.contextSize) {
      return { applied: current ?? leaderCap, from: current, reason: 'explicit-context-size' };
    }
    // The member/leader cap gap only exists for [1m] sessions; otherwise there is nothing to lift.
    if (leaderCap <= COMPACTION_LIMIT_DEFAULT_1M_FLEET_MEMBER_CAP) {
      return { applied: current ?? leaderCap, from: current, reason: 'non-1m-no-cap-gap' };
    }
    if (current === COMPACTION_LIMIT_DEFAULT_1M_FLEET_MEMBER_CAP) {
      await setCompactionLimit(ownerId, leaderCap);
      return { applied: leaderCap, from: current, reason: 'member-cap-lifted' };
    }
    return { applied: current ?? leaderCap, from: current, reason: 'already-leader-grade' };
  } catch {
    return null; // never fail the leadership transfer on a re-seed miss
  }
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
  opts?: { compactionLimit?: number; contextSize?: 'full' | 'trimmed' },
): Promise<TakeLeadershipOutcome> {
  const slug = fleet.fleetSlug;
  const previousLeader = fleet.leaderOwnerId; // may be null, or already === caller

  // 1. Registry: the caller becomes the sole leader (single-leader invariant, D-002).
  const installed = await setFleetLeader(workspaceId, slug, ownerId, undefined, previousLeader);
  if (!installed) {
    throw new Error(`fleet_leadership_superseded: '${slug}' leader changed after authorization; re-orient before retrying`);
  }
  // 2. The caller's presence → this fleet's leader.
  await heartbeatPresence(identity); // guarantee a presence row to label
  await setPresenceFleet(workspaceId, ownerId, slug, 'leader');

  // P-009: now that the caller IS the leader, lift a stuck 300k member-cap seed to the leader
  // ceiling (400k on [1m]) — unless the make-leader call passed an explicit contextSize/limit.
  // AFTER the presence-role flip so a spec/role read here sees the new leader role.
  const reseed = await reseedLeaderCompactionLimit(ownerId, opts);

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

  return { slug, leader: ownerId, previousLeader: previousLeader ?? null, demotedPriorLeader, notified, reseed };
}
