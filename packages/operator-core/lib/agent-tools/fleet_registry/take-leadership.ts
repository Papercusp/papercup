/**
 * fleet:take-leadership — THE D-002 handoff (named-su-agent-fleets-2026-06-29 P-004 /
 * P-007). "Hand a plan to an existing fleet" = the handoff agent BECOMES the leader.
 *
 * (1) registry: agent_fleets.leader_owner_id := caller, (2) the caller's coord_presence
 * is labeled this fleet's `leader`, and (3) the PRIOR leader (if distinct and still
 * present in this fleet) is demoted to `member`. ONE leader per fleet; the leader is the
 * per-fleet analog of the Queen — owns monitoring + coordination + driving the plan to
 * completion. This is routing option (2): there is NO separate routing engine.
 */
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { getFleet, setFleetLeader } from '../../agent-fleets-store';
import { heartbeatPresence, setPresenceFleet } from '../coordination/presence';
import { fetchPresenceFleet } from '../coordination/presence-fleet';
import { json, resolveFleetCaller, ROUTING_LADDER, shouldDemotePriorLeader } from './_shared';

export default defineTool({
  name: 'fleet:take-leadership',
  description:
    'Take over an existing fleet: you become its leader (the per-fleet analog of the Queen — you own monitoring, coordination, and driving the plan to completion). Sets the registry leader to you, labels your presence the fleet\'s leader, and demotes the prior leader to a member. This IS how you "hand a plan to a fleet" — there is no separate routing tool.',
  guidance: {
    when: 'Routing option (2): handing a plan to an existing named fleet. Taking the leader role makes you its driver (D-002).',
    notWhen:
      'Just becoming a worker in a fleet → fleet:join. Creating a fresh fleet → fleet:create (you are already its leader).',
    chaining: ROUTING_LADDER,
  },
  capability: 'fleet:take-leadership',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES, 'bee'],
  args: z.object({
    fleet: z.string().min(1).describe('The fleet slug to take leadership of (from fleet:list).'),
  }),
  async handler(args, ctx) {
    const { identity, ownerId, workspaceId } = resolveFleetCaller(ctx);
    const fleet = await getFleet(workspaceId, args.fleet);
    if (!fleet) {
      return json(
        { ok: false, error: `no fleet '${args.fleet}' in this workspace — see fleet:list` },
        true,
      );
    }
    const previousLeader = fleet.leaderOwnerId; // may be null, or already === caller

    // 1. Registry: the handoff agent becomes the leader (D-002).
    await setFleetLeader(workspaceId, args.fleet, ownerId);
    // 2. The caller's presence → this fleet's leader.
    await heartbeatPresence(identity); // guarantee a presence row to label
    await setPresenceFleet(workspaceId, ownerId, args.fleet, 'leader');

    // 3. Demote the prior leader's presence to `member` — but only a distinct leader whose
    //    presence STILL labels them in THIS fleet (don't yank a gone/moved agent).
    let demotedPriorLeader: string | null = null;
    if (previousLeader && previousLeader !== ownerId) {
      const priorMembership = (await fetchPresenceFleet([previousLeader])).get(previousLeader);
      if (
        shouldDemotePriorLeader(previousLeader, ownerId, priorMembership?.fleetSlug ?? null, args.fleet)
      ) {
        await setPresenceFleet(workspaceId, previousLeader, args.fleet, 'member');
        demotedPriorLeader = previousLeader;
      }
    }

    return json({
      ok: true,
      slug: args.fleet,
      leader: ownerId,
      previousLeader: previousLeader ?? null,
      demotedPriorLeader,
    });
  },
});
