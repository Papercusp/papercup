/**
 * fleet:list — every persisted fleet in the workspace, each annotated with its LIVE
 * member count + an `available` flag (named-su-agent-fleets-2026-06-29 P-004 / D-003).
 *
 * The registry rows are durable (they survive all-members-killed, D-003), so this lists
 * fleets with ZERO live members too — `available` (>=1 live member, heartbeat within
 * PRESENCE_STALE_MS) is the routing/psu predicate layered on top.
 */
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { availableFleets } from '../../fleet/fleet-roster';
import { json, resolveFleetCaller, ROUTING_LADDER } from './_shared';

export default defineTool({
  name: 'fleet:list',
  description:
    'List every persistent fleet in this workspace, each with its live-member count and an `available` flag (available = at least one live member). Durable fleets with zero live members are listed too. Use this to pick a fleet to join or hand a plan to.',
  guidance: {
    when: 'Choosing a fleet — to join (fleet:join), inspect (fleet:status), or hand a plan to (fleet:take-leadership). `available` fleets have a live driver right now.',
    notWhen: 'For who is IN one fleet and what each is doing, use fleet:status { fleet }.',
    chaining: ROUTING_LADDER,
  },
  capability: 'fleet:list',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES, 'bee'],
  args: z.object({}),
  async handler(_args, ctx) {
    const { workspaceId } = resolveFleetCaller(ctx);
    const fleets = await availableFleets(workspaceId);
    return json({
      ok: true,
      fleets: fleets.map((f) => ({
        slug: f.fleetSlug,
        title: f.title,
        description: f.description,
        leader: f.leaderOwnerId,
        liveMemberCount: f.liveMemberCount,
        available: f.liveMemberCount > 0,
        createdAt: f.createdAt,
        updatedAt: f.updatedAt,
      })),
    });
  },
});
