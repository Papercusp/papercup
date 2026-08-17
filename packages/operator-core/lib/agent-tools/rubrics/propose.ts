/**
 * rubrics:propose — propose (idempotent upsert) a rubric → status "proposed"
 * (rubric-driven-observations-2026-06-20 P-002 / D-001). Any agent may propose; an
 * independent reviewer or owner/su ratifies it active (rubrics:ratify). Re-proposing the
 * same rubric_id updates its content.
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
  model: z
    .string()
    .min(1)
    .optional()
    .describe(
      'how this criterion is supposed to work (the MODEL). REQUIRED for a standard-kind rubric (the store refuses a standard criterion without it); optional on an acceptance-kind criterion (the light profile)',
    ),
  method: z
    .string()
    .min(1)
    .optional()
    .describe(
      'how to investigate it (signals / queries — the METHOD). REQUIRED for standard kind; optional on acceptance-kind criteria',
    ),
  ratingScale: z.array(z.string()).optional().describe('per-criterion override of the rubric default scale'),
  driftMarkers: z
    .string()
    .optional()
    .describe('what degraded / broken looks like. REQUIRED for standard kind; optional on acceptance-kind criteria'),
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
  criterionClass: z
    .enum(['settle-once', 'violatable'])
    .optional()
    .describe(
      "grading class (P-008): 'violatable' = monotonic-downward, one violation falsifies permanently — mid-run ratings are stamped PROVISIONAL by scorecards:emit until the graded subject terminates. Omitted = settle-once",
    ),
});

export const rubricsProposeArgs = z.object({
  rubricRef: z.string().min(1).max(120).describe('rubric ref/slug, e.g. "pot-coordination-health"'),
  kind: z
    .enum(['standard', 'acceptance'])
    .optional()
    .describe(
      "default 'standard' (a reusable shared-standards library rubric — proposed, then Queen-ratified). 'acceptance' = a one-shot per-plan definition-of-done (acceptance-rubrics-on-every-plan-2026-08-11): requires subjectPlan, activates IMMEDIATELY (no ratification), is hidden from default library reads, and is authored AFTER the plan's implementation, before the plan may be marked done — the completion gate reads it",
    ),
  subjectPlan: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe(
      'acceptance kind only (required there): the slug of the plan this rubric is the definition-of-done FOR. Validated to exist — a dangling link is refused',
    ),
  classRef: z
    .string()
    .min(1)
    .max(120)
    .optional()
    .describe(
      'acceptance kind only: rubricId of the standard-kind CLASS rubric this builds on (feature-ship / bugfix / migration / investigation). With classRef, criteria may be empty (the class alone may stand for e.g. investigation-only plans)',
    ),
  characteristic: z.string().min(1).max(120).describe('umbrella domain, e.g. "hive-coordination"'),
  title: hardText(LIMITS.SHORT_TITLE),
  description: hardText(8000).optional(),
  criteria: z
    .array(criterion)
    .describe(
      'the gradeable items. Standard kind: >=1 required, each with full model/method/driftMarkers. Acceptance kind: 3–7 outcome criteria tracing to the plan\'s goal + Decisions (may be empty with classRef)',
    ),
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
  classDowngradeReason: z
    .string()
    .min(1)
    .max(2000)
    .optional()
    .describe(
      "loss-guard ack (P-008): why a stored 'violatable' criterion is intentionally being downgraded to settle-once (removing its provisional-until-terminal protection)",
    ),
});

export default defineTool({
  name: 'rubrics:propose',
  profile: 'engineer',
  description:
    'Propose a rubric (the shared standard for a system characteristic) → status "proposed". ⚠ WHOLE-DOCUMENT REPLACE: re-proposing an existing rubricRef replaces ALL of its content — rubrics:get it first, edit, and resubmit EVERY criterion with its full method/replication text (a partial criteria list deletes the rest). Loss-guards enforce this: dropping a stored criterion key needs a dropKeys ack; shrinking a criterion\'s method+replication procedure >40% (or losing its REPLICATION DRILL marker) needs allowMethodShrink + shrinkReason.',
  guidance: {
    when: 'You see a recurring characteristic worth grading consistently and no rubric covers it — or you are REVISING an existing rubric (rubrics:get first; resubmit ALL criteria). Author each criterion: model + method + driftMarkers + its own replication drill (the copy-runnable testing procedure); methodRef points at the rubric-level long-form runbook.',
    notWhen: 'A one-off finding — file a free-text observation instead. Activating an existing proposed rubric — rubrics:ratify. Check rubrics:search first to avoid a duplicate.',
    chaining: 'rubrics:search (dedup) → rubrics:get (when revising — edit from the stored document, never from memory) → rubrics:propose → an independent reviewer calls rubrics:ratify. The result reports `completeness` (criteria lacking a replication drill; missing methodRef) and `replicationSqlCheck` (drill SQL that fails against live PG — read its `summary`; `findings` is REAL defects only, bind-placeholder noise split out) — fill/fix the gaps first.',
    seeAlso: [
      'rubrics:search (dedup before proposing)',
      'rubrics:get (fetch before revising — propose REPLACES the stored doc)',
      'rubrics:ratify (an independent reviewer or owner/su activates the proposed rubric)',
    ],
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: rubricsProposeArgs,
  async handler(args, ctx) {
    const id = resolveAgentIdentity(ctx);
    const rubric = await proposeRubric({
      rubricId: args.rubricRef,
      ...(args.kind ? { kind: args.kind } : {}),
      ...(args.subjectPlan ? { subjectPlan: args.subjectPlan } : {}),
      ...(args.classRef ? { classRef: args.classRef } : {}),
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
      ...(args.classDowngradeReason ? { classDowngradeReason: args.classDowngradeReason } : {}),
      by: id.ownerId,
      // Acceptance rubrics activate on propose (plan D-008: no ratification step) — the
      // lib defaults their status to 'active'; standard proposals stay Queen-gated.
      ...(args.kind === 'acceptance' ? {} : { status: 'proposed' as const }),
    });
    // WI-4287: surface testing-procedure completeness on every revision (non-blocking).
    const completeness = rubricCompleteness(rubric);
    // EI-10514: schema-validate embedded replication-drill SQL against live PG
    // (non-blocking — see rubrics-replication-sql.ts for why this warns, never rejects).
    const replicationSqlCheck = await validateRubricReplicationSql(rubric.criteria);
    // Push-on-write (push-audit 2026-07-26): the Rubrics pane + trend read these.
    void import('../../sync-sse')
      .then((m) => {
        m.notifySyncInvalidate('rubrics.list');
        m.notifySyncInvalidate('rubrics.trend');
      })
      .catch(() => {});
    return {
      content: [
        { type: 'text' as const, text: JSON.stringify({ ok: true, rubric, completeness, replicationSqlCheck }) },
      ],
    };
  },
});
