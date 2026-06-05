/**
 * work_items:comment — Threadable (D-003). Append a comment to a work-item's thread
 * (creates the thread on first post) and fan out to its subscribers. Dispatches by
 * kind: issue-family rides issues-engineer.commentIssue; feature-family threads on
 * the feature ObjectRef.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { commentWorkItem } from '../../work-items';

export default defineTool({
  name: 'work_items:comment',
  profile: 'engineer',
  description: 'Comment on a work-item (any kind). Appends to its thread and notifies subscribers. The thread is created on the first comment.',
  guidance: {
    when: 'You have an update, a finding, or a question on a work-item that its followers should see.',
    chaining: 'work_items:get → work_items:comment; work_items:subscribe to follow the thread.',
  },
  capability: 'work_items:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    id: z.string().min(1),
    body: z.string().min(1).max(8000),
    harness: z.string().max(80).optional(),
  }),
  async handler(args, ctx) {
    const ident = resolveAgentIdentity(ctx);
    const post = await commentWorkItem(args.id, args.body, ident.ownerId, { harness: args.harness });
    return { content: [{ type: 'text' as const, text: JSON.stringify(post ? { ok: true, post } : { ok: false, error: `work_item '${args.id}' not found` }) }] };
  },
});
