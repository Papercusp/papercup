/**
 * fleet:status — one fleet's registry identity + its live roster (named-su-agent-fleets-
 * 2026-06-29 P-004).
 *
 * Combines the durable agent_fleets row (title/description/leader) with the unified
 * fleet roster (listFleetRoster, keyed on the fleet_slug presence label) — "who's in this
 * fleet and exactly what each is doing", the per-fleet analog of coord:presence.
 */
import { z } from 'zod';
import { defineTool, SU_ROLES, readJsonResult, type SeeAlsoEntry } from '@papercusp/agent-mcp';
import { getFleet } from '../../agent-fleets-store';
import { listFleetRoster } from '../../fleet/fleet-roster';
import { json, resolveFleetCaller, ROUTING_LADDER } from './_shared';

export default defineTool({
  name: 'fleet:status',
  description:
    'Show one fleet\'s identity (title, description, current leader) plus its live roster — who is in the fleet and what each member is doing right now. The per-fleet analog of coord:presence.',
  guidance: {
    when: 'Inspecting a specific fleet — its leader and live members — before joining it or handing it a plan.',
    notWhen: 'For the catalog of ALL fleets with availability, use fleet:list.',
    chaining: ROUTING_LADDER,
    seeAlso: [
      'fleet:list (the catalog of ALL fleets with availability)',
      'fleet:assignments (what this fleet\'s members are working on)',
      'coord:roster { view:"members" } (membership across hive + fleet)',
    ],
  },
  capability: 'fleet:status',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES, 'bee'],
  args: z.object({
    fleet: z.string().min(1).describe('The fleet slug (from fleet:list).'),
  }),
  async handler(args, ctx) {
    const { workspaceId } = resolveFleetCaller(ctx);
    const fleet = await getFleet(workspaceId, args.fleet);
    if (!fleet) {
      return json(
        { ok: false, error: `no fleet '${args.fleet}' in this workspace — see fleet:list` },
        true,
      );
    }
    const roster = await listFleetRoster({ fleetSlug: args.fleet, workspaceId });
    return json({
      ok: true,
      slug: fleet.fleetSlug,
      title: fleet.title,
      description: fleet.description,
      leader: fleet.leaderOwnerId,
      memberCount: roster.length,
      members: roster.map((m) => ({
        agentId: m.agentId,
        label: m.ownerLabel ?? m.label,
        fleetRole: m.fleetRole,
        intent: m.intent,
        // EI-5858: `alive` is now gated on wakeability (an `ended` session no longer
        // reads alive:true off a still-warm heartbeat); `sessionState` surfaces the
        // full live | parked | ended truth so a leader isn't fooled by a warm-but-idle
        // or dead session. Read sessionState, not a bare `alive`, for "is X working".
        alive: m.alive,
        sessionState: m.sessionState,
        lastActiveSecAgo: m.lastActiveSecAgo,
        doing: m.doing,
        load: m.load,
      })),
    });
  },
});
