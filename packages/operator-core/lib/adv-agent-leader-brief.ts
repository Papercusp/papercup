/**
 * adv-agent-leader-brief.ts — the LEADER-BRIEF half of the session popup's
 * fleet-peers rail (popup-agent-state-coverage-2026-08-18 P-002).
 *
 * ## Why this exists
 *
 * The audit behind that plan found that **no UI anywhere reads
 * `fleet:leader-brief`** — a grep across `apps/operator` and `apps/operator-vite`
 * returned exactly one hit, and it was a comment. The popup's peers rail derives
 * from `advRoster.list → toHudSession → deriveColumn`: the same generic board
 * scoring every session gets, carrying eleven presentational fields.
 *
 * So opening a fleet LEADER's popup showed none of what that leader itself
 * reads. Six per-member signals whose entire purpose is "intervene now" —
 * `dormant` (no self-wake at all; nothing will bring it back), `spinning`
 * (alive, taking turns, healthy on every other liveness surface, but its last
 * PRODUCTIVE call is stale), `throttled` (silenced by a provider wall until
 * `until`, where `nextFireAt` alone reads as a normal cadence tick),
 * `coordHook` (coord-deaf — a `coord:send` will not be seen),
 * `verifiedWaitTakeovers`, `benchSuggestion` — were on no screen, and a member
 * in every one of those states renders on the board as a perfectly ordinary
 * "working" or "parked" row.
 *
 * ## Why it calls the real brief
 *
 * `buildLeaderBrief` is the READ half of the `fleet:leader-brief` tool itself,
 * not a reimplementation of it. That is deliberate and is the whole value: a
 * second derivation would drift from what the agent is actually told, which
 * would make this surface worse than useless — it would be confidently wrong
 * about a fleet in trouble.
 *
 * ## What is deliberately different from the agent path
 *
 * A viewer is not the leader. Two of the tool handler's behaviours are correct
 * for an agent and wrong here, and both are turned off through the caller bag
 * rather than by copying code (see `LeaderBriefCaller`'s docblock for the full
 * argument):
 *
 *  - **No leadership writes.** The tool CLAIMS a vacant leader seat and
 *    refreshes the leader's control row. Opening a popup must never install the
 *    viewer as leader of the fleet it is looking at.
 *  - **No ambient fleet resolution.** The tool falls back to the caller's own
 *    presence membership. In the operator process that resolves to whatever
 *    fleet the operator was launched into — a real answer to the wrong question.
 *
 * The brief is computed AS THE VIEWED LEADER (`ownerId: owner`), which is what
 * makes `directives` — the ledger's verdict on whether YOUR directives to each
 * member were carried out — mean what the pane claims it means.
 *
 * ## Cost
 *
 * The brief is an expensive fan-out (roster, ~9 decorations, unowned criticals,
 * lane health, capacity, spec preview, invariants). It is therefore gated: a
 * non-leader returns a `skipped` verdict after two cheap reads and no brief at
 * all, so an ordinary session's popup pays nothing.
 */

import { activeWorkspaceId } from './workspace-registry';
import { buildLeaderBrief } from './agent-tools/fleet/leader-brief';

/** The brief payload, taken from the producer so it cannot drift from it. */
export type LeaderBriefData = Awaited<ReturnType<typeof buildLeaderBrief>>['data'];

/**
 * Why no brief was computed. NEVER collapse these into a null brief: "this
 * agent leads nothing" and "we could not read the fleet" look identical on
 * screen unless the pane is told which it is, and the second one is the case
 * where a leader is flying blind and does not know it.
 */
export type LeaderBriefSkipReason =
  /** The agent is in no fleet. The overwhelmingly common case. */
  | 'no-fleet'
  /** In a fleet, but not its leader — an ordinary member's popup. */
  | 'not-leader'
  /** No concrete workspace to scope the fleet read by (the `*` sentinel). */
  | 'no-workspace'
  /** The read itself threw. Distinct from every case above ON PURPOSE. */
  | 'read-failed';

export interface AgentLeaderBrief {
  ownerId: string;
  /** The fleet this agent's presence row places it in; null when it is in none. */
  fleetSlug: string | null;
  /** The fleet's role as PRESENCE records it ('leader' | 'member' | null). */
  presenceFleetRole: string | null;
  /** The fleet registry's `leader_owner_id` — the authority on who leads. */
  registeredLeader: string | null;
  /** True when this agent resolves as the fleet's leader by either source. */
  isLeader: boolean;
  /** Set iff `brief` is null; see LeaderBriefSkipReason. */
  skipped: LeaderBriefSkipReason | null;
  brief: LeaderBriefData | null;
}

function empty(
  owner: string,
  skipped: LeaderBriefSkipReason,
  over: Partial<AgentLeaderBrief> = {},
): AgentLeaderBrief {
  return {
    ownerId: owner,
    fleetSlug: null,
    presenceFleetRole: null,
    registeredLeader: null,
    isLeader: false,
    skipped,
    brief: null,
    ...over,
  };
}

/**
 * Read the leader-brief for ONE agent, or say why there is none.
 *
 * Leadership is decided from BOTH sources on purpose. The registry
 * (`agent_fleets.leader_owner_id`) is the authority, but presence carries its
 * own `fleet_role`, and the two CAN disagree — that disagreement is exactly the
 * `presenceDrift` condition `coord:orient` warns a leader about. Gating on the
 * registry alone would blank the pane for an agent whose own orient is telling
 * it that it leads; gating on presence alone would let a stale row conjure a
 * brief for a fleet somebody else now leads. Accepting EITHER and letting the
 * brief's own `notLeader` notice carry the truth surfaces the drift instead of
 * hiding it behind an empty pane.
 */
export async function getAgentLeaderBrief(owner: string): Promise<AgentLeaderBrief> {
  try {
    const workspaceId = activeWorkspaceId();
    if (!workspaceId || workspaceId === '*') return empty(owner, 'no-workspace');

    const { fetchPresenceFleet } = await import('./agent-tools/coordination/presence-fleet');
    const membership = (await fetchPresenceFleet([owner])).get(owner) ?? null;
    const fleetSlug = membership?.fleetSlug ?? null;
    const presenceFleetRole = membership?.fleetRole ?? null;
    if (!fleetSlug) return empty(owner, 'no-fleet');

    const { getFleet } = await import('./agent-fleets-store');
    const record = await getFleet(workspaceId, fleetSlug);
    const registeredLeader = record?.leaderOwnerId ?? null;
    const isLeader = registeredLeader === owner || presenceFleetRole === 'leader';
    if (!isLeader) {
      return empty(owner, 'not-leader', { fleetSlug, presenceFleetRole, registeredLeader });
    }

    const result = await buildLeaderBrief(
      { fleet: fleetSlug, workspace: workspaceId },
      {
        // Computed AS the viewed leader: this is what scopes `directives` to
        // ITS directives rather than to nobody's.
        ownerId: owner,
        actorWorkspace: workspaceId,
        // No `agentIdentity` and no `self`: the viewer holds neither, and both
        // are only consumed by paths a viewer must not take (the leadership
        // claim; the isSelf marker).
        allowLeadershipWrites: false,
        resolveCallerMembership: false,
      },
    );
    return {
      ownerId: owner,
      fleetSlug,
      presenceFleetRole,
      registeredLeader,
      isLeader: true,
      skipped: null,
      brief: result.data,
    };
  } catch (err) {
    // Surfaced, never swallowed into a look-alike empty: a pane that says "this
    // agent leads nothing" when the truth is "we could not read its fleet" is
    // the same false-clean the brief's own alerts exist to prevent.
    console.warn(`[adv-agent-leader-brief] getAgentLeaderBrief(${owner}) failed:`, err);
    return empty(owner, 'read-failed');
  }
}
