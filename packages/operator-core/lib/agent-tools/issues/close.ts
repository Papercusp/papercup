/**
 * issues:close — set an issue's lifecycle to resolved/closed, or reopen it
 * (Lifecycle, engineer-issues-2026-06-03). A resolution notifies even
 * mention-mode subscribers (D-006).
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { setIssueState } from '../../issues-engineer';

export default defineTool({
  name: 'issues:close',
  profile: 'engineer',
  description: "Set an issue's lifecycle state: resolved (fixed/answered), closed (won't-fix / no longer relevant), or open (reopen). Resolving notifies all subscribers, including mention-mode.",
  guidance: {
    when: 'An issue is fixed (resolved) or is being dropped without a fix (closed). Reopen with state=open if it recurs.',
    notWhen: 'Promoting it to a tracked fix feature — issues:promote (which keeps it open/fixing until the feature lands).',
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({ id: z.string().min(1), state: z.enum(['resolved', 'closed', 'open']).optional().describe('default resolved') }),
  async handler(args, ctx) {
    const id = resolveAgentIdentity(ctx);
    const issue = await setIssueState(args.id, args.state ?? 'resolved', id.ownerId);
    if (!issue) return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: 'issue not found' }) }] };
    return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, issue: { id: issue.id, state: issue.state } }) }] };
  },
});
