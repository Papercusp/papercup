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
import { availableFleets, countRunningWorkspaceBees } from '../../fleet/fleet-roster';
import { json, resolveFleetCaller, ROUTING_LADDER } from './_shared';

export default defineTool({
  name: 'fleet:list',
  description:
    'List every persistent fleet in this workspace, each split as `memberCount` VISIBLE desktop su members / `beeCount` background autonomous-loop bees, plus an `available` flag (available = at least one live MEMBER — a desktop driver a plan can be handed to; a bee cannot). Durable fleets with zero live members are listed too. The result also carries `runningBees`: how many background bees are running in the whole workspace — a fleet showing 0 members while runningBees>0 is the tell that bee:spawn (bees) was used where fleet:launch-on-plan (desktop members) was meant. Use this to pick a fleet to join or hand a plan to.',
  guidance: {
    when: 'Choosing a fleet — to join (fleet:join), inspect (fleet:status), or hand a plan to (fleet:take-leadership). `available` fleets have a live desktop MEMBER (driver) right now — beeCount is background autonomous-loop workers, not a driver.',
    notWhen: 'For who is IN one fleet and what each is doing, use fleet:status { fleet }.',
    chaining: ROUTING_LADDER,
  },
  capability: 'fleet:list',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES, 'bee'],
  args: z.object({}),
  async handler(_args, ctx) {
    const { workspaceId } = resolveFleetCaller(ctx);
    // WI-1764 #4: split VISIBLE desktop members from BACKGROUND bees, and surface the
    // workspace-wide running-bee total so a "0 members / N bees" mismatch screams.
    const [fleets, runningBees] = await Promise.all([
      availableFleets(workspaceId),
      countRunningWorkspaceBees(workspaceId),
    ]);
    return json({
      ok: true,
      runningBees,
      fleets: fleets.map((f) => ({
        slug: f.fleetSlug,
        title: f.title,
        description: f.description,
        leader: f.leaderOwnerId,
        memberCount: f.liveMemberCount,
        beeCount: f.beeCount,
        // Back-compat alias — `liveMemberCount` was the pre-split field name.
        liveMemberCount: f.liveMemberCount,
        available: f.liveMemberCount > 0,
        createdAt: f.createdAt,
        updatedAt: f.updatedAt,
      })),
    });
  },
});
