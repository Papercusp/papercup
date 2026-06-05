/**
 * work_items:subscribe — Subscribable (D-003). Follow a work-item to receive its
 * change fan-out (full | digest | mention).
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { subscribeWorkItem } from '../../work-items';

export default defineTool({
  name: 'work_items:subscribe',
  profile: 'engineer',
  description: 'Subscribe to a work-item so its updates fan out to your inbox (mode: full | digest | mention).',
  guidance: {
    when: 'You want to follow a work-item you do not own (e.g. one that blocks yours).',
    chaining: 'work_items:get → work_items:subscribe.',
  },
  capability: 'work_items:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    id: z.string().min(1),
    mode: z.enum(['full', 'digest', 'mention']).optional(),
    harness: z.string().max(80).optional(),
  }),
  async handler(args, ctx) {
    const ident = resolveAgentIdentity(ctx);
    const res = await subscribeWorkItem(ident.ownerId, args.id, args.mode ?? 'full', { harness: args.harness });
    return { content: [{ type: 'text' as const, text: JSON.stringify('error' in res ? { ok: false, error: res.error } : { ok: true }) }] };
  },
});
