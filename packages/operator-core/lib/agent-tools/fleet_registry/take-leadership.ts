/**
 * fleet:take-leadership — THE D-002 handoff (named-su-agent-fleets-2026-06-29 P-004 /
 * P-007). "Hand a plan to an existing fleet" = the handoff agent BECOMES the leader.
 *
 * Delegates to the shared takeFleetLeadership effect (take-leadership-core) so this and
 * fleet:join { as:'leader' } behave identically: (1) registry leader := caller, (2) the
 * caller's presence is labeled this fleet's `leader`, (3) the PRIOR leader is demoted to
 * `member`, and (4) the displaced leader is NOTIFIED (with `notified` returned so the new
 * leader does NOT redundantly message them). ONE leader per fleet; the leader is the
 * per-fleet analog of the Queen — owns monitoring + coordination + driving the plan to
 * completion. This is routing option (2): there is NO separate routing engine.
 */
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { getFleet } from '../../agent-fleets-store';
import { json, recolorCallerTerminal, resolveFleetCaller, ROUTING_LADDER } from './_shared';
import { takeFleetLeadership } from './take-leadership-core';

export default defineTool({
  name: 'fleet:take-leadership',
  description:
    'Take over an existing fleet: you become its leader (the per-fleet analog of the Queen — you own monitoring, coordination, and driving the plan to completion). Sets the registry leader to you, labels your presence the fleet\'s leader, demotes the prior leader to a member, and NOTIFIES the displaced leader — the returned { previousLeader, notified } tells you whom you displaced and that they were already told, so you don\'t double-message them. This IS how you "hand a plan to a fleet" — there is no separate routing tool. (Also the FIRST act when the owner designates you a fleet\'s leader: claim it, don\'t just assume it.)',
  guidance: {
    when: 'Routing option (2): handing a plan to an existing named fleet. Taking the leader role makes you its driver (D-002). Also the FIRST act when the owner designates you a fleet\'s leader — claim it (this is identity-establishing, not a confirm-gated write).',
    notWhen:
      'Just becoming a worker in a fleet → fleet:join. Creating a fresh fleet → fleet:create (you are already its leader). Joining-as-leader in one call → fleet:join { as:\'leader\' }.',
    chaining: ROUTING_LADDER,
  },
  capability: 'fleet:take-leadership',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES, 'cup'],
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
    const out = await takeFleetLeadership(workspaceId, fleet, identity, ownerId);
    // Recolor the caller's live window to the fleet's bound scheme — becoming a
    // leader must look like it (parity with fleet:create / fleet:join, which all
    // recolor after fleet-tagging presence). Best-effort: a no-op for non-psu-hosted
    // callers, and never throws, so a recolor miss can't fail the leadership transfer.
    await recolorCallerTerminal(ownerId, fleet);
    return json({ ok: true, scheme: fleet.colorScheme, ...out });
  },
});
