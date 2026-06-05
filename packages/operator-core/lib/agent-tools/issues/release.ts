/**
 * issues:release — drop your claim on an issue (Claimable, engineer-issues-2026-06-03).
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { releaseIssue } from '../../issues-engineer';

export default defineTool({
  name: 'issues:release',
  profile: 'engineer',
  description: 'Release (unassign) an issue so someone else can pick it up — e.g. you are blocked, deprioritizing, or handing off.',
  guidance: {
    when: 'You claimed an issue but are not going to finish it — release so it is pickable again.',
    notWhen: 'You finished it — issues:close instead.',
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({ id: z.string().min(1) }),
  async handler(args, ctx) {
    resolveAgentIdentity(ctx);
    const issue = await releaseIssue(args.id);
    if (!issue) return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: 'issue not found' }) }] };
    return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, issue: { id: issue.id, assignee: issue.assignee } }) }] };
  },
});
