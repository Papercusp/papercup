/**
 * rubrics:search — full-text search over rubric id / characteristic / title /
 * description (rubric-driven-observations-2026-06-20 P-002). The dedup check before
 * proposing a new rubric, and a keyword way to find an existing standard.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { searchRubrics } from '../../rubrics';

export default defineTool({
  name: 'rubrics:search',
  profile: 'engineer',
  description:
    'Full-text search rubrics by id / characteristic / title / description. Use before rubrics:propose to avoid a duplicate, or to locate an existing standard by keywords.',
  guidance: {
    when: 'Before proposing a rubric (dedup), or to find a standard covering a characteristic by keyword.',
    notWhen: 'You want a filtered list by status/characteristic — rubrics:list. You have the id — rubrics:get.',
    chaining: 'rubrics:search → rubrics:get (use the existing one) / rubrics:propose (if none fits).',
  },
  capability: 'coord:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({ query: z.string().min(1), limit: z.number().int().positive().max(200).optional() }),
  async handler(args, ctx) {
    resolveAgentIdentity(ctx);
    const rubrics = await searchRubrics(args.query, args.limit);
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            count: rubrics.length,
            rubrics: rubrics.map((r) => ({
              rubricId: r.rubricId,
              characteristic: r.characteristic,
              title: r.title,
              status: r.status,
              criteriaCount: r.criteria.length,
            })),
          }),
        },
      ],
    };
  },
});
