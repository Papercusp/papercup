/**
 * work_items:tag — Taggable (D-003). Add/remove a topic tag (coord_links rel='tagged')
 * so the work-item routes to that area's subscribers.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { tagWorkItem, untagWorkItem } from '../../work-items';

export default defineTool({
  name: 'work_items:tag',
  profile: 'engineer',
  description: 'Tag a work-item with a topic (or untag with remove:true). Routes the work-item to that topic\'s subscribers.',
  guidance: {
    when: 'You want a work-item visible to agents following an area (topics:list to see topics).',
    chaining: 'topics:list → work_items:tag { topic }.',
  },
  capability: 'work_items:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    id: z.string().min(1),
    topic: z.string().min(1).max(80),
    harness: z.string().max(80).optional(),
    remove: z.boolean().optional(),
  }),
  async handler(args, ctx) {
    const ident = resolveAgentIdentity(ctx);
    const res = args.remove ? await untagWorkItem(args.id, args.topic, { harness: args.harness }) : await tagWorkItem(args.id, args.topic, { harness: args.harness, by: ident.ownerId });
    return { content: [{ type: 'text' as const, text: JSON.stringify('error' in res ? { ok: false, error: res.error } : { ok: true, topic: args.topic }) }] };
  },
});
