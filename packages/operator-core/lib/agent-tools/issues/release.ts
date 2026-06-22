/**
 * issues:release — drop your claim on an issue (Claimable, engineer-issues-2026-06-03).
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { releaseIssue } from '../../issues-engineer';
import { bulkContent, mergeIds, runBulk } from '../_bulk';

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
  args: z
    .object({
      id: z.string().min(1).optional().describe('single issue id to release'),
      ids: z.array(z.string().min(1)).min(1).max(100).optional().describe('issue ids to release in one call'),
    })
    .refine((a) => Boolean(a.id) || (a.ids?.length ?? 0) > 0, {
      message: 'pass `id` or `ids`',
    }),
  async handler(args, ctx) {
    resolveAgentIdentity(ctx);
    const ids = mergeIds(args.id, args.ids);
    const env = await runBulk(
      ids,
      async (id) => {
        const issue = await releaseIssue(id);
        if (!issue) return { ok: false as const, id, error: 'issue not found' };
        return { ok: true as const, id, issue: { id: issue.id, assignee: issue.assignee } };
      },
      { keyOf: (id) => ({ id }) },
    );
    return bulkContent(env);
  },
});
