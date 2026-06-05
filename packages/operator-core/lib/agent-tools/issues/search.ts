/**
 * issues:search — full-text search over engineer issues (engineer-issues-2026-06-03).
 * The dedup check before filing a new one.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { searchIssues } from '../../issues-engineer';

export default defineTool({
  name: 'issues:search',
  profile: 'engineer',
  description: 'Full-text search engineer issues by title/body. Use before issues:create to avoid filing a duplicate, or to find a known problem.',
  guidance: {
    when: 'Before filing an issue (dedup), or to locate an existing one by keywords.',
    notWhen: 'You want a filtered list by state/topic/assignee — issues:list.',
    chaining: 'issues:search → issues:get / issues:comment (add to the existing one instead of a dup).',
  },
  capability: 'coord:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({ query: z.string().min(1), limit: z.number().int().positive().max(200).optional() }),
  async handler(args, ctx) {
    resolveAgentIdentity(ctx);
    const issues = await searchIssues(args.query, args.limit);
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            count: issues.length,
            issues: issues.map((i) => ({ id: i.id, title: i.title, severity: i.severity, state: i.state })),
          }),
        },
      ],
    };
  },
});
