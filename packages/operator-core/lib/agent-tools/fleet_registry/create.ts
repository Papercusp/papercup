/**
 * fleet:create — create (or get) a named, DURABLE fleet and make the caller its
 * leader (named-su-agent-fleets-2026-06-29 P-004 / D-002 / D-003).
 *
 * Writes the agent_fleets registry row (idempotent — an existing slug is returned
 * unchanged) with the caller as both owner AND leader, then AUTHORITATIVELY labels the
 * caller's own coord_presence as this fleet's `leader` (the per-agent soft membership
 * label, mig 407). The registry row survives all-members-killed (D-003), so the fleet
 * stays selectable in psu forever. ONE leader per fleet (D-002): if the slug already
 * existed with a DIFFERENT leader, "create" does not seize it — the caller is labeled a
 * `member` and is pointed at fleet:take-leadership.
 */
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { createFleetIfAbsent, fleetSlugFromName } from '../../agent-fleets-store';
import { heartbeatPresence, setPresenceFleet } from '../coordination/presence';
import { fleetRoleFor, json, recolorCallerTerminal, resolveFleetCaller, ROUTING_LADDER } from './_shared';

export default defineTool({
  name: 'fleet:create',
  description:
    'Create a NEW named, persistent fleet (or get an existing one by name) and become its leader. The fleet is a durable registry row that survives all members being killed, so it stays selectable in psu. You are recorded as owner + leader and your presence is labeled this fleet\'s leader. Use this to stand up a fresh fleet before launching member terminals (capability:terminal).',
  guidance: {
    when: 'Standing up a NEW named fleet — e.g. routing option (3), a new desktop fleet: fleet:create then capability:terminal { terminals: [...] } to launch the member windows.',
    notWhen:
      'Joining a fleet that already has members → fleet:join. Taking over an existing fleet to drive a plan → fleet:take-leadership (create does NOT seize an existing fleet from its leader).',
    chaining: ROUTING_LADDER,
  },
  capability: 'fleet:create',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES, 'bee'],
  args: z.object({
    name: z
      .string()
      .min(1)
      .describe('Human name for the fleet (kept as the title; slugified to the durable handle).'),
    description: z
      .string()
      .optional()
      .describe('Optional one-line description of what this fleet is for.'),
  }),
  async handler(args, ctx) {
    const { identity, ownerId, workspaceId } = resolveFleetCaller(ctx);
    const fleetSlug = fleetSlugFromName(args.name);

    const { record, created } = await createFleetIfAbsent({
      workspaceId,
      fleetSlug,
      title: args.name,
      description: args.description ?? null,
      owner: ownerId,
      leaderOwnerId: ownerId,
    });

    // Mirror the AUTHORITATIVE registry leader onto the caller's presence label. On a
    // fresh create that's `leader` (record.leaderOwnerId === caller). If the slug already
    // existed under a different leader, the registry is unchanged (idempotent) so the
    // caller is only a `member` — ONE leader per fleet (D-002).
    const role = fleetRoleFor(record.leaderOwnerId, ownerId);
    await heartbeatPresence(identity); // guarantee a presence row to label
    await setPresenceFleet(workspaceId, ownerId, fleetSlug, role);
    // Recolor the caller's live window to the new fleet's bound scheme — no second
    // call (fleet-color-schemes). Best-effort: a no-op for non-psu-hosted callers.
    await recolorCallerTerminal(ownerId, record);

    return json({
      ok: true,
      slug: fleetSlug,
      created,
      title: record.title,
      leader: record.leaderOwnerId,
      role,
      scheme: record.colorScheme,
      ...(role === 'member'
        ? { note: 'fleet already existed under another leader — call fleet:take-leadership to drive it' }
        : {}),
    });
  },
});
