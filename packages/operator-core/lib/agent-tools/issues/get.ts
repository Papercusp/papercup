/**
 * issues:get — one issue in full: fields + topics + comment thread + outgoing
 * links (engineer-issues-2026-06-03, Phase 1).
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { getIssueDetail } from '../../issues-engineer';

export default defineTool({
  name: 'issues:get',
  profile: 'engineer',
  description: 'Read one engineer issue in full — fields, topic tags, the comment thread, and its links (e.g. what it blocks).',
  guidance: {
    when: 'You have an issue id (from issues:list/search) and want its detail before claiming, commenting, or fixing.',
    notWhen: 'Scanning many — use issues:list.',
    chaining: 'issues:list → issues:get → issues:claim / issues:comment / issues:close.',
  },
  capability: 'coord:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({ id: z.string().min(1) }),
  async handler(args, ctx) {
    resolveAgentIdentity(ctx);
    const issue = await getIssueDetail(args.id);
    if (!issue) return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: 'issue not found' }) }] };
    return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, issue }) }] };
  },
});
