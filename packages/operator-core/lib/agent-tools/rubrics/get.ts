/**
 * rubrics:get — one OR many rubrics in full, including every criterion (model +
 * method + drift markers + rating scale). The Overwatch scorecard and a
 * structured observation grade against these criteria
 * (rubric-driven-observations-2026-06-20 P-002; bulk-standardized per
 * bulk-endpoint-standardization-2026-06-21).
 *
 * Bulk by default (the house keyed-array contract): pass `rubricRef` for one or
 * `rubricRefs` for several → { ok, results:[{ ok, rubricId, rubric? | error }],
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
    "Read one OR many rubrics in full — each rubric's criteria (key + model + method + drift markers + optional rating scale), default rating scale, and method_ref runbook. Pass canonical `rubricRef` for one or `rubricRefs` for several. Grade against these: a structured observation's `ratings` is a Record keyed by criteria[].key here (ratings[criteriaKey] = { rating, evidence }). Returns { ok, results:[{ ok, rubricId, rubric? | error }], counts } — correlate by rubricId, not by position; a missing ref never fails the rest.",
  guidance: {
    when: 'You have one or more rubric refs (from rubrics:list/search) and need their full criteria to grade against — e.g. Kettle emitting the pot-coordination-health scorecard, or filing a structured observation. Pass every ref at once via `rubricRefs`.',
    notWhen: 'Scanning many — rubrics:list (summary rows).',
    chaining: "rubrics:list → rubrics:get { rubricRefs:[…] } → grade each criterion (observation `ratings` is a Record keyed by criteria[].key) in your observation. Bulk: single | rubricRefs[] → { ok, results, counts }; correlate by rubricId not position; one failure never fails the rest.",
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
      rubricRef: z.string().min(1).optional().describe('a single rubric ref/slug, e.g. "pot-coordination-health" (n=1 shorthand for rubricRefs:[ref])'),
      rubricRefs: z.array(z.string().min(1)).min(1).max(100).optional().describe('rubric refs/slugs to fetch (1–100)'),
      // EI-11400: a rubric is identified by its ref/slug; `rubricId`/`rubricIds` are ACCEPTED
      // ALIASES for `rubricRef`/`rubricRefs` — the id an agent reaches for after rubrics:list,
      // and the vocabulary rubrics:get itself required before it was bulk-standardized. Accept
      // the obvious spelling instead of rejecting it into a schema-probe retry (same remedy as
      // the body↔summary alias, WI-4492).
      rubricId: z.string().min(1).optional().describe('alias for `rubricRef` (EI-11400)'),
      rubricIds: z.array(z.string().min(1)).min(1).max(100).optional().describe('alias for `rubricRefs` (EI-11400)'),
    })
    .refine(
      (a) => Boolean(a.rubricRef || a.rubricId) || (a.rubricRefs?.length ?? 0) > 0 || (a.rubricIds?.length ?? 0) > 0,
      { message: 'pass `rubricRef`/`rubricRefs` (or their aliases `rubricId`/`rubricIds`)' },
    )
    .superRefine((a, ctx) => {
      // The one case aliasing can't resolve: the same field under both names, DIFFERENT values.
      if (a.rubricRef !== undefined && a.rubricId !== undefined && a.rubricRef !== a.rubricId) {
        ctx.addIssue({
          code: 'custom',
          path: ['rubricId'],
          message: '`rubricRef` and `rubricId` are the SAME field — pass one (which did you mean?).',
        });
      }
    }),
  async handler(args, ctx) {
    resolveAgentIdentity(ctx);
    // EI-11400: fold each alias into its canonical before merging.
    const ids = mergeIds(args.rubricRef ?? args.rubricId, [
      ...(args.rubricRefs ?? []),
      ...(args.rubricIds ?? []),
    ]);
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
