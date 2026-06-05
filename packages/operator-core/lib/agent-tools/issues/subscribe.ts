/**
 * issues:subscribe — follow one issue (object subscription, Subscribable,
 * engineer-issues-2026-06-03). Its updates inject into your inbox. To follow a
 * whole AREA, subscribe the topic (topics:subscribe) instead.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { getIssue, subscribeIssue, unsubscribeIssue } from '../../issues-engineer';

export default defineTool({
  name: 'issues:subscribe',
  profile: 'engineer',
  description: 'Follow a specific issue so its comments/updates/resolution inject into your inbox. mode = full | digest | mention. Pass unsubscribe:true to stop. (To follow an area, use topics:subscribe.)',
  guidance: {
    when: 'You care about one specific issue (you reported it, depend on it, or can contribute) and want its updates pushed to you.',
    notWhen: 'You want everything in an area — topics:subscribe is the scalable unit.',
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    id: z.string().min(1),
    mode: z.enum(['full', 'digest', 'mention']).optional(),
    unsubscribe: z.boolean().optional(),
  }),
  async handler(args, ctx) {
    const id = resolveAgentIdentity(ctx);
    const issue = await getIssue(args.id);
    if (!issue) return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: 'issue not found' }) }] };
    if (args.unsubscribe) await unsubscribeIssue(id.ownerId, args.id);
    else await subscribeIssue(id.ownerId, args.id, args.mode ?? 'full');
    return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, id: args.id, subscribed: !args.unsubscribe }) }] };
  },
});
