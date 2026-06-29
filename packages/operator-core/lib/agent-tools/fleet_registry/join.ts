/**
 * fleet:join — label the caller a MEMBER of an existing fleet (named-su-agent-fleets-
 * 2026-06-29 P-004 / D-002).
 *
 * Requires the fleet registry row to exist. Sets the caller's coord_presence to
 * (fleet_slug=fleet, fleet_role='member') — UNLESS the caller is already this fleet's
 * recorded leader, in which case re-joining must NOT demote them (D-002: ONE leader).
 */
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { getFleet } from '../../agent-fleets-store';
import { heartbeatPresence, setPresenceFleet } from '../coordination/presence';
import { fleetRoleFor, json, resolveFleetCaller, ROUTING_LADDER } from './_shared';

export default defineTool({
  name: 'fleet:join',
  description:
    'Join an existing fleet as a member — labels your presence with the fleet so you show up in its roster and count toward its availability. If you are already the fleet\'s leader, joining does not demote you.',
  guidance: {
    when: 'Becoming a member of an existing fleet (pick one from fleet:list).',
    notWhen:
      'Creating a brand-new fleet → fleet:create. Taking over a fleet to drive its plan → fleet:take-leadership.',
    chaining: ROUTING_LADDER,
  },
  capability: 'fleet:join',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES, 'bee'],
  args: z.object({
    fleet: z.string().min(1).describe('The fleet slug to join (from fleet:list).'),
  }),
  async handler(args, ctx) {
    const { identity, ownerId, workspaceId } = resolveFleetCaller(ctx);
    const fleet = await getFleet(workspaceId, args.fleet);
    if (!fleet) {
      return json(
        {
          ok: false,
          error: `no fleet '${args.fleet}' in this workspace — create it with fleet:create or pick one from fleet:list`,
        },
        true,
      );
    }
    // Don't demote a leader who re-joins their own fleet (D-002).
    const role = fleetRoleFor(fleet.leaderOwnerId, ownerId);
    await heartbeatPresence(identity); // guarantee a presence row to label
    await setPresenceFleet(workspaceId, ownerId, args.fleet, role);
    return json({ ok: true, slug: args.fleet, role });
  },
});
