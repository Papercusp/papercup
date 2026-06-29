/**
 * fleet:leave — drop the caller's fleet membership (named-su-agent-fleets-2026-06-29
 * P-004 / D-002).
 *
 * Clears the caller's coord_presence fleet_slug/fleet_role to NULL. If the caller WAS the
 * fleet's recorded leader, the fleet is left leaderless too (setFleetLeader(null)) — so a
 * leader leaving doesn't strand a phantom leader_owner_id pointing at a gone agent. The
 * registry row itself persists (D-003).
 */
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { getFleet, setFleetLeader } from '../../agent-fleets-store';
import { setPresenceFleet } from '../coordination/presence';
import { fetchPresenceFleet } from '../coordination/presence-fleet';
import { json, resolveFleetCaller, ROUTING_LADDER } from './_shared';

export default defineTool({
  name: 'fleet:leave',
  description:
    'Leave your current fleet — clears your fleet membership label. If you were the fleet\'s leader, the fleet is left leaderless (its durable registry row persists, but it no longer has a recorded driver).',
  guidance: {
    when: 'Stepping out of a fleet you are a member or leader of.',
    notWhen: 'Switching to a different fleet → just fleet:join the other one (it re-labels you).',
    chaining: ROUTING_LADDER,
  },
  capability: 'fleet:leave',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES, 'bee'],
  args: z.object({}),
  async handler(_args, ctx) {
    const { ownerId, workspaceId } = resolveFleetCaller(ctx);
    // Which fleet was the caller in? The soft label lives on the presence row.
    const membership = (await fetchPresenceFleet([ownerId])).get(ownerId);
    const currentFleet = membership?.fleetSlug ?? null;

    await setPresenceFleet(workspaceId, ownerId, null, null);

    let clearedLeadershipOf: string | null = null;
    if (currentFleet) {
      const fleet = await getFleet(workspaceId, currentFleet);
      if (fleet && fleet.leaderOwnerId === ownerId) {
        await setFleetLeader(workspaceId, currentFleet, null);
        clearedLeadershipOf = currentFleet;
      }
    }
    return json({ ok: true, leftFleet: currentFleet, clearedLeadershipOf });
  },
});
