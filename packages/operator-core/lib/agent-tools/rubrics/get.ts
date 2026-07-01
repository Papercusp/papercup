/**
 * rubrics:get — one OR many rubrics in full, including every criterion (model +
 * method + drift markers + rating scale). The Overwatch scorecard and a
 * structured observation grade against these criteria
 * (rubric-driven-observations-2026-06-20 P-002; bulk-standardized per
 * bulk-endpoint-standardization-2026-06-21).
 *
 * Bulk by default (the house keyed-array contract): pass `rubricId` for one or
 * `rubricIds` for several → { ok, results:[{ ok, rubricId, rubric? | error }],
 * counts } — each result self-describes its rubricId, so a not-found id never
 * poisons the rest and the agent correlates by id (not array position).
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { getRubric } from '../../rubrics';
import { mergeIds, runBulk, bulkContent } from '../_bulk';

export default defineTool({
  name: 'rubrics:get',
  profile: 'engineer',
  description:
    "Read one OR many rubrics in full — each rubric's criteria (key + model + method + drift markers + optional rating scale), default rating scale, and method_ref runbook. Pass `rubricId` for one or `rubricIds` for several. Grade against these: a structured observation's `ratings` is a Record keyed by criteria[].key here (ratings[criteriaKey] = { rating, evidence }). Returns { ok, results:[{ ok, rubricId, rubric? | error }], counts } — correlate by rubricId, not by position; a missing id never fails the rest.",
  guidance: {
    when: 'You have one or more rubric_ids (from rubrics:list/search) and need their full criteria to grade against — e.g. Overwatch emitting the hive-coordination-health scorecard, or filing a structured observation. Pass every id at once via `rubricIds`.',
    notWhen: 'Scanning many — rubrics:list (summary rows).',
    chaining: "rubrics:list → rubrics:get { rubricIds:[…] } → grade each criterion (observation `ratings` is a Record keyed by criteria[].key) in your observation. Bulk: single | rubricIds[] → { ok, results, counts }; correlate by rubricId not position; one failure never fails the rest.",
    seeAlso: [
      'rubrics:list (scan summary rows to find an id)',
      'rubrics:search (keyword lookup)',
      'rubrics:trend (how this rubric\'s criteria trend over time)',
    ],
  },
  capability: 'coord:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z
    .object({
      rubricId: z.string().min(1).optional().describe('a single rubric slug, e.g. "hive-coordination-health" (n=1 shorthand for rubricIds:[id])'),
      rubricIds: z.array(z.string().min(1)).min(1).max(100).optional().describe('rubric slugs to fetch (1–100)'),
    })
    .refine((a) => Boolean(a.rubricId) || (a.rubricIds?.length ?? 0) > 0, {
      message: 'pass `rubricId` (one) or `rubricIds` (many)',
    }),
  async handler(args, ctx) {
    resolveAgentIdentity(ctx);
    const ids = mergeIds(args.rubricId, args.rubricIds);
    const env = await runBulk(
      ids,
      async (rubricId) => {
        const rubric = await getRubric(rubricId);
        return rubric
          ? { ok: true as const, rubricId, rubric }
          : { ok: false as const, rubricId, error: 'rubric not found' };
      },
      { keyOf: (rubricId) => ({ rubricId }) },
    );
    return bulkContent(env);
  },
});
