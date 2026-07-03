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
import {
  listFleetRoster,
  splitFleetRosterCounts,
  countRunningFleetBees,
  countRunningWorkspaceBees,
} from '../../fleet/fleet-roster';
import { getCompletionIntegrityStats } from '../../work-items';
import { json, resolveFleetCaller, ROUTING_LADDER } from './_shared';

export default defineTool({
  name: 'fleet:status',
  description:
    'Show one fleet\'s identity (title, description, current leader) plus its live roster — who is in the fleet and what each member is doing right now — with the roster split as `memberCount` VISIBLE desktop su members / `beeCount` background autonomous-loop bees (WI-1764). Also reports `runningBees`: background bees running in the whole workspace — a fleet with 0 members while runningBees>0 means bee:spawn (bees) was used where fleet:launch-on-plan (desktop members) was meant. Optionally include harness-scoped completion integrity stats so progress reads can separate genuine completions from dedup churn. The per-fleet analog of coord:presence.',
  guidance: {
    when: 'Inspecting a specific fleet — its leader and live members — before joining it or handing it a plan.',
    notWhen: 'For the catalog of ALL fleets with availability, use fleet:list.',
    chaining: ROUTING_LADDER,
    // Result-aware (D-003): fill the CONCRETE `@fleet:<slug>` history selector from
    // the result — the "coord:catch-up @fleet:X for who-was-ever-here" pointer WI-1348
    // asks for — carrying the real ended-member count when the fleet has dead sessions.
    // The adjacent-lens pointers are always relevant, so they stay static.
    seeAlso: (result) => {
      const j = readJsonResult<{
        ok?: boolean;
        slug?: string;
        members?: Array<{ sessionState?: string }>;
      }>(result);
      const out: SeeAlsoEntry[] = [
        'fleet:list (the catalog of ALL fleets with availability)',
        'fleet:assignments (what this fleet\'s members are working on)',
        'coord:roster { view:"members" } (membership across hive + fleet)',
      ];
      if (j?.ok && j.slug) {
        const ended = (j.members ?? []).filter((m) => m.sessionState === 'ended').length;
        out.push({
          tool: 'coord:catch-up',
          selector: `@fleet:${j.slug}`,
          reason: ended > 0 ? `${ended} ended — who-was-ever-here` : 'who-was-ever-here',
        });
      }
      return out;
    },
  },
  capability: 'fleet:status',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES, 'bee'],
  args: z.object({
    fleet: z.string().min(1).describe('The fleet slug (from fleet:list).'),
    harness: z
      .string()
      .min(1)
      .max(80)
      .optional()
      .describe(
        'Optional harness slug for progress reporting. When provided, the result includes `completionStats` so genuine completions are separated from dedup/unverified terminal rows.',
      ),
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
    const [roster, completionStats, runningBees, beeCount] = await Promise.all([
      listFleetRoster({ fleetSlug: args.fleet, workspaceId }),
      args.harness ? getCompletionIntegrityStats(args.harness) : Promise.resolve(null),
      countRunningWorkspaceBees(workspaceId),
      countRunningFleetBees(args.fleet, workspaceId),
    ]);
    // WI-1764 #4 / WI-1813: `memberCount` = VISIBLE desktop su members from the roster
    // (presence — members-only, was roster.length). `beeCount` = BACKGROUND bees spawned
    // INTO this fleet, from the nursery (countRunningFleetBees — reliable + presence-
    // independent) rather than the roster's presence-labeled split, which under-counted a
    // bee that had not yet written its presence fleet label.
    const { members: memberCount } = splitFleetRosterCounts(roster);
    return json({
      ok: true,
      slug: fleet.fleetSlug,
      title: fleet.title,
      description: fleet.description,
      leader: fleet.leaderOwnerId,
      memberCount,
      beeCount,
      runningBees,
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
      ...(completionStats ? { completionStats } : {}),
    });
  },
});
