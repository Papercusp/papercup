/**
 * rubrics:list — the rubrics store read surface (rubric-driven-observations-2026-06-20
 * P-002). Active first, then proposed. Returns summary rows (criteriaCount, not the full
 * criteria) — use rubrics:get for the full criteria.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { listRubrics } from '../../rubrics';

export default defineTool({
  name: 'rubrics:list',
  profile: 'engineer',
  description:
    'List rubrics (shared standards for a system characteristic) — active first, then proposed. Filter by status / characteristic. A rubric carries the model (how it should work), method, rating scale + drift markers, and per-characteristic criteria that agents grade STRUCTURED OBSERVATIONS against. Returns summary rows; use rubrics:get for full criteria.',
  guidance: {
    when: 'Before filing an observation — check whether an ACTIVE rubric fits the characteristic you are assessing, so you can file a structured (rated) observation instead of free-text. Overwatch/Scout: discover the rubric set to grade against.',
    notWhen: 'You already have the rubric_id and want the full criteria — rubrics:get. Free-text keyword lookup — rubrics:search.',
    chaining: 'rubrics:list { status: "active" } → rubrics:get { rubricId } → file a structured observation.',
    seeAlso: [
      'rubrics:get (full criteria for an id)',
      'rubrics:search (free-text keyword lookup)',
      'rubrics:propose (author one when none fits)',
    ],
  },
  capability: 'coord:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    status: z.enum(['proposed', 'active', 'retired']).optional().describe('filter by lifecycle status; omit for all'),
    characteristic: z.string().optional().describe('filter to one umbrella domain (e.g. "hive-coordination")'),
    limit: z.number().int().positive().max(500).optional(),
  }),
  async handler(args, ctx) {
    resolveAgentIdentity(ctx);
    const rubrics = await listRubrics({ status: args.status, characteristic: args.characteristic, limit: args.limit });
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
              ratingScale: r.ratingScale,
              methodRef: r.methodRef,
              updatedAt: r.updatedAt,
            })),
          }),
        },
      ],
    };
  },
});
