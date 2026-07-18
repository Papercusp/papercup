/**
 * rubrics:propose — propose (idempotent upsert) a rubric → status "proposed"
 * (rubric-driven-observations-2026-06-20 P-002 / D-001). Any agent may propose; the
 * Queen/owner ratifies it active (rubrics:ratify). Re-proposing the same rubric_id
 * updates its content.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { hardText, LIMITS } from '../limits';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { proposeRubric, rubricCompleteness } from '../../rubrics';
import { validateRubricReplicationSql } from '../../rubrics-replication-sql';
import { rubricCriterionWindowSchema } from '../plans/rubric-template';

const criterion = z.object({
  key: z.string().min(1).describe('stable kebab id; an observation rating references this'),
  title: z.string().min(1),
  model: z.string().min(1).describe('how this criterion is supposed to work (the MODEL)'),
  method: z.string().min(1).describe('how to investigate it (signals / queries — the METHOD)'),
  ratingScale: z.array(z.string()).optional().describe('per-criterion override of the rubric default scale'),
  driftMarkers: z.string().describe('what degraded / broken looks like'),
  replication: z
    .string()
    .min(1)
    .optional()
    .describe(
      "this criterion's own REPLICATION DRILL: the full copy-runnable testing procedure (fixtures → verbatim subject prompt → spawn/measurement → grading queries → cleanup). Every criterion SHOULD carry one — rubrics:ratify reports the ones that don't",
    ),
  instrumentKey: z
    .string()
    .min(1)
    .optional()
    .describe("stable machine-readable instrument binding; use 'none' only for an explicitly manual criterion"),
  window: rubricCriterionWindowSchema.optional(),
});

export default defineTool({
  name: 'rubrics:propose',
  profile: 'engineer',
  description:
    'Propose a rubric (the shared standard for a system characteristic) → status "proposed". ⚠ WHOLE-DOCUMENT REPLACE: re-proposing an existing rubricRef replaces ALL of its content — rubrics:get it first, edit, and resubmit EVERY criterion with its full method/replication text (a partial criteria list deletes the rest). Loss-guards enforce this: dropping a stored criterion key needs a dropKeys ack; shrinking a criterion\'s method+replication procedure >40% (or losing its REPLICATION DRILL marker) needs allowMethodShrink + shrinkReason.',
  guidance: {
    when: 'You see a recurring characteristic worth grading consistently and no rubric covers it — or you are REVISING an existing rubric (rubrics:get first; resubmit ALL criteria). Author each criterion: model + method + driftMarkers + its own replication drill (the copy-runnable testing procedure); methodRef points at the rubric-level long-form runbook.',
    notWhen: 'A one-off finding — file a free-text observation instead. Activating an existing proposed rubric — rubrics:ratify. Check rubrics:search first to avoid a duplicate.',
    chaining: 'rubrics:search (dedup) → rubrics:get (when revising — edit from the stored document, never from memory) → rubrics:propose → rubrics:ratify (Mug/owner). The result reports `completeness` (criteria lacking a replication drill; missing methodRef) and `replicationSqlCheck` (embedded drill SQL that fails to parse/plan against live PG — a table/column that was renamed since the drill was written; EI-10514) — fill/fix the gaps.',
    seeAlso: [
      'rubrics:search (dedup before proposing)',
      'rubrics:get (fetch before revising — propose REPLACES the stored doc)',
      'rubrics:ratify (Mug/owner activates the proposed rubric)',
    ],
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    rubricRef: z.string().min(1).max(120).describe('rubric ref/slug, e.g. "pot-coordination-health"'),
    characteristic: z.string().min(1).max(120).describe('umbrella domain, e.g. "hive-coordination"'),
    title: hardText(LIMITS.SHORT_TITLE),
    description: hardText(8000).optional(),
    criteria: z.array(criterion).min(1).describe('the per-characteristic gradeable items'),
    ratingScale: z
      .array(z.string())
      .optional()
      .describe('default scale shared by criteria (omit → ["healthy","degraded","broken","unknown"])'),
    methodRef: z.string().max(200).optional().describe('agent-insights runbook slug for the long-form method'),
    releaseGating: z
      .boolean()
      .optional()
      .describe('mark this rubric as a release gate; every criterion then requires a unique machine-readable instrument binding'),
    dropKeys: z
      .array(z.string().min(1))
      .max(100)
      .optional()
      .describe(
        'loss-guard ack: stored criterion keys this proposal INTENTIONALLY drops. Propose is a whole-document replace — omitting a stored key without acking it here is rejected (it would silently delete the criterion)',
      ),
    allowMethodShrink: z
      .boolean()
      .optional()
      .describe(
        "loss-guard ack: allow a criterion's method+replication procedure text to shrink >40% or lose its REPLICATION DRILL marker. Requires shrinkReason",
      ),
    shrinkReason: z
      .string()
      .min(1)
      .max(2000)
      .optional()
      .describe('why the procedure shrink is intentional (required with allowMethodShrink)'),
  }),
  async handler(args, ctx) {
    const id = resolveAgentIdentity(ctx);
    const rubric = await proposeRubric({
      rubricId: args.rubricRef,
      characteristic: args.characteristic,
      title: args.title,
      description: args.description,
      criteria: args.criteria,
      ratingScale: args.ratingScale,
      methodRef: args.methodRef,
      releaseGating: args.releaseGating,
      dropKeys: args.dropKeys,
      allowMethodShrink: args.allowMethodShrink,
      shrinkReason: args.shrinkReason,
      by: id.ownerId,
      status: 'proposed',
    });
    // WI-4287: surface testing-procedure completeness on every revision (non-blocking).
    const completeness = rubricCompleteness(rubric);
    // EI-10514: schema-validate embedded replication-drill SQL against live PG
    // (non-blocking — see rubrics-replication-sql.ts for why this warns, never rejects).
    const replicationSqlCheck = await validateRubricReplicationSql(rubric.criteria);
    return {
      content: [
        { type: 'text' as const, text: JSON.stringify({ ok: true, rubric, completeness, replicationSqlCheck }) },
      ],
    };
  },
});
