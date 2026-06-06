/**
 * topics:subscribe — follow a topic; its updates get injected into your context.
 *
 * Delivery mode (D-006 — the noise control) is mandatory tiering:
 *   full    — every update (default; use for areas you're actively in)
 *   digest  — a coalesced count + one-line (use for high-churn areas)
 *   mention — only when @-addressed or on resolution (the quiet floor)
 * Optional ttl_sec auto-drops the subscription (a refactor you'll finish soon).
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../identity';
import { COORD_ROLES } from '../roles';
import { subscribeTopic } from '../topics';

export default defineTool({
  name: 'topics:subscribe',
  description:
    'Subscribe to a topic so its updates are injected into your inbox — the named sugar for watch(topic,{wake:false}). mode = full | digest | mention (D-006 noise tiering). Subscribe to the built-in `new_topic` to learn of new topics as they appear. Idempotent — re-subscribing updates the mode/TTL.',
  guidance: {
    when: 'A topic in topics:list is relevant to your current work and you want its updates pushed to you. Pick digest for high-churn areas, mention to stay quiet.',
    notWhen: 'You only need a one-time look — just topics:list. To follow a specific object (one thread/issue), that is the object’s own subscribe, not a topic.',
    chaining: 'topics:list → topics:subscribe; topics:unsubscribe to stop.',
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    topic: z.string().min(1),
    mode: z.enum(['full', 'digest', 'mention']).optional(),
    ttl_sec: z.number().int().positive().optional(),
  }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    const sub = await subscribeTopic(identity, args.topic, { mode: args.mode, ttl_sec: args.ttl_sec });
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            subscription: { topic: sub.target_ref, mode: sub.delivery_mode, expires_ts: sub.expires_ts },
          }),
        },
      ],
    };
  },
});
