/**
 * issues:claim — take ownership of an issue (Claimable, engineer-issues-2026-06-03).
 * The claimer is auto-subscribed; subscribers are notified.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { claimIssue } from '../../issues-engineer';

export default defineTool({
  name: 'issues:claim',
  profile: 'engineer',
  description: 'Claim an issue (assign it to yourself) before you start fixing it, so others know it is owned. Auto-subscribes you. Pass assignee to claim on behalf of another agent.',
  guidance: {
    when: 'You are about to start work on an issue — claim it first so two agents do not duplicate the fix.',
    notWhen: 'Just reading/triaging (no claim needed). To drop a claim, issues:release.',
    chaining: 'issues:list → issues:claim → (fix) → issues:close / issues:promote.',
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({ id: z.string().min(1), assignee: z.string().optional().describe('defaults to you') }),
  async handler(args, ctx) {
    const id = resolveAgentIdentity(ctx);
    const issue = await claimIssue(args.id, args.assignee ?? id.ownerId);
    if (!issue) return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: 'issue not found' }) }] };
    return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, issue: { id: issue.id, assignee: issue.assignee, state: issue.state } }) }] };
  },
});
