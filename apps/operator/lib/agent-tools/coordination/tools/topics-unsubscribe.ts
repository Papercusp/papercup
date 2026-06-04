/**
 * topics:unsubscribe — stop following a topic (soft-cancel; idempotent).
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../identity';
import { COORD_ROLES } from '../roles';
import { unsubscribeTopic } from '../topics';

export default defineTool({
  name: 'topics:unsubscribe',
  description: 'Unsubscribe from a topic. Idempotent — unsubscribing from a topic you do not follow is a no-op.',
  guidance: {
    when: 'A topic you followed is no longer relevant and its updates are noise.',
    notWhen: 'You want to mute briefly — set the subscription to mention mode via topics:subscribe instead of dropping it.',
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    topic: z.string().min(1),
  }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    await unsubscribeTopic(identity, args.topic);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, topic: args.topic }) }],
    };
  },
});
