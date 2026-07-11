/**
 * coord:watermark-set — advance the caller's last-read pointers.
 *
 * agent-coordination-architecture-v2 §7.2. Called by the OMP
 * coordination extension at TURN END (conservative — an aborted turn
 * never advances the watermark, so the next turn re-sees the same
 * notifications). Partial update: omitted fields keep their value.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../identity';
import { COORD_ROLES } from '../roles';
import { writeWatermark } from '../watermarks';
import { settleCaughtUpInboxWakeDeliveries } from '../../../events/await/store';

export default defineTool({
  name: 'coord:watermark-set',
  description:
    'Advance your coordination watermark. Call at TURN END with the newest ISO timestamp you have seen on each surface. Partial update — omitted fields keep their current value. `subscriptions_fired` is replaced wholesale when supplied.',
  guidance: {
    when: 'Turn end — the OMP coordination extension records how far you read this turn.',
    notWhen: 'Mid-turn — advancing early would hide notifications that arrive before the turn finishes.',
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    messages_since_ts: z.string().optional(),
    escalations_since_ts: z.string().optional(),
    plan_events_since_ts: z.string().optional(),
    subscriptions_fired: z.array(z.string()).optional(),
  }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    const wm = await writeWatermark(identity.ownerId, {
      messages_since_ts: args.messages_since_ts,
      escalations_since_ts: args.escalations_since_ts,
      plan_events_since_ts: args.plan_events_since_ts,
      subscriptions_fired: args.subscriptions_fired,
    });
    // EI-9389: a bulk coord:inbox read already showed every message up to
    // messages_since_ts, but any coord:send{wake:true} delivery queued for
    // those SAME messages while this agent was busy still sits pending/parked
    // on its own standing inbox-wake key — settle those now so they don't
    // burn a whole extra resume turn re-delivering traffic already read.
    // Best-effort: never let a settle hiccup fail the watermark write itself.
    if (args.messages_since_ts) {
      try {
        await settleCaughtUpInboxWakeDeliveries({
          subscriberId: identity.ownerId,
          cutoffTs: args.messages_since_ts,
        });
      } catch {
        /* advisory cleanup only — the watermark write above already succeeded */
      }
    }
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ ok: true, owner_id: identity.ownerId, watermark: wm }),
        },
      ],
    };
  },
});
