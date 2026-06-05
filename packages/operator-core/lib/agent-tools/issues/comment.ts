/**
 * issues:comment — append a note to an issue's comment thread (Threadable,
 * engineer-issues-2026-06-03). Notifies the issue's subscribers.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { commentIssue } from '../../issues-engineer';

export default defineTool({
  name: 'issues:comment',
  profile: 'engineer',
  description: "Add a note to an issue's comment thread. Subscribers are notified. Use for investigation findings, repro details, or a status update on an issue you are working.",
  guidance: {
    when: 'You have something to add to an existing issue — a repro, a root-cause finding, a decision, or progress.',
    notWhen: 'Editing the issue itself (issues:update) or resolving it (issues:close).',
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({ id: z.string().min(1), body: z.string().min(1).max(8000) }),
  async handler(args, ctx) {
    const id = resolveAgentIdentity(ctx);
    const post = await commentIssue(args.id, args.body, id.ownerId);
    if (!post) return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: 'issue not found' }) }] };
    return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, post: { id: post.id, created_ts: post.created_ts } }) }] };
  },
});
