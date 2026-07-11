/**
 * fleet:wind-down — flip a fleet's TYPED control state to winding-down
 * (coord-authority-hardening-2026-07-11 P-009 / H4). Guard + persist + typed
 * cue live in ./control-core; fleet:pause is an alias, fleet:resume the inverse.
 */
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { applyFleetControl } from './control-core';
import { json, ROUTING_LADDER } from './_shared';

export default defineTool({
  name: 'fleet:wind-down',
  description:
    "WIND DOWN a named fleet — a TYPED, BINDING control state (registry control_state=winding-down + reason/by/ts), not a free-text ask: live members get a fleet-scoped control cue (checkpoint → release claims/locks → loop:end → ack leader; pull no new work), and LATE JOINERS see the state at orient. Invokers: the owner (su session), THAT fleet's leader, or the queen — anyone else is refused (EI-9501 class). Reverse with fleet:resume; fleet:pause is an alias of this.",
  guidance: {
    when: "Standing a fleet down at end-of-mission, before a risky shared-tree change, or on the owner's stand-down order — anywhere 'stop pulling work' must bind members who haven't read chat.",
    notWhen:
      'To stop ONE member — coord:send them a yield / turn:interrupt. To pause a plan — plans:pause. To evict nursery cups — fleet:drain (the cup-fleet surface). A free-text "please pause" stays advisory by definition; this verb is the binding form.',
    chaining: ROUTING_LADDER,
    seeAlso: ['fleet:resume (lift it)', 'fleet:pause (alias of this verb)', 'fleet:status (shows controlState)'],
  },
  capability: 'fleet:control',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    fleet: z.string().min(1).max(120).describe('Fleet slug (or name — slugified like every registry surface).'),
    reason: z
      .string()
      .max(500)
      .optional()
      .describe('Why the fleet is winding down — travels on the registry row + the member cue.'),
  }),
  async handler(args, ctx) {
    const result = await applyFleetControl(ctx, args.fleet, 'wind-down', args.reason);
    return json(result as unknown as Record<string, unknown>, !result.ok);
  },
});
