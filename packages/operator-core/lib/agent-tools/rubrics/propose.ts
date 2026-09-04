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
import { rubricCriterionWindowSchema, rubricCriterionCheckSchema } from '../plans/rubric-template';
import { VALID_PLAN_SLUG } from '../plans/source';
import { resolveAgentWorkspaceRoot } from '../capability/base-dir';
import { trackDetached } from '../../detached-imports';

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
    .describe(
      'what degraded / broken looks like — the concrete falsifier. REQUIRED for every bespoke criterion of BOTH kinds (standard AND acceptance); an acceptance rubric may only omit criteria entirely, via classRef with an empty criteria array (plan D-009)',
    ),
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
  check: rubricCriterionCheckSchema
    .optional()
    .describe(
      "the criterion's STRUCTURED CHECK (P-011 / D-006), preferred wherever the outcome is objectively checkable: " +
        "kind:'tests' { files:[...] } = deterministic must-pass — paths must resolve against the live tree or " +
        "THIS PROPOSE IS REFUSED, and scorecards:emit actually RUNS the files at grading time (a contradicted " +
        "pass-rating refuses the emit); kind:'instrument' { instrumentKey } = the generalized instrument binding. " +
        'Omitted = fuzzy judgment criterion; when revising, intentionally removing a stored check requires allowMethodShrink:true plus shrinkReason',
    ),
});

export const rubricsProposeArgs = z.object({
  rubricRef: z
    .string()
    .min(1)
    .max(120)
    .regex(VALID_PLAN_SLUG, 'must be a valid plan slug (letters, numbers, ., _, -; optional @run-N suffix)')
    .describe('rubric ref/slug stored as a plan slug, e.g. "pot-coordination-health"'),
  kind: z
    .enum(['standard', 'acceptance'])
    .optional()
    .describe(
      "default 'standard' (a reusable shared-standards library rubric — proposed, then Queen-ratified). 'acceptance' = a one-shot definition-of-done linked by subjectPlan (plan mode) or subjectGoal (goal mode), activates IMMEDIATELY (no ratification), is hidden from default library reads, and is authored AFTER the work's implementation, before it may be marked done — the matching completion gate reads it",
    ),
  subjectPlan: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe(
      'acceptance kind only (required there): the slug of the plan this rubric is the definition-of-done FOR. Validated to exist — a dangling link is refused',
    ),
  subjectGoal: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe(
      "acceptance kind only: the id of the goal this rubric is the definition-of-done FOR. Validated to exist — a dangling link is refused",
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
  methodRef: z
    .string()
    .max(200)
    .nullable()
    .optional()
    .describe('agent-insights runbook slug for the long-form method; null is accepted from rubrics:get when unset'),
  releaseGating: z
    .boolean()
    .optional()
    .describe(
      'mark this standard-kind rubric as a release gate; acceptance-kind rubrics are one-shot and cannot set releaseGating; every standard criterion then requires a unique machine-readable instrument binding',
    ),
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
      "loss-guard ack: allow a criterion's method+replication procedure text to shrink >40%, lose its REPLICATION DRILL marker, or intentionally remove its stored structured check (reverting deterministic enforcement to fuzzy judgment). Requires shrinkReason",
    ),
  shrinkReason: z
    .string()
    .min(1)
    .max(2000)
    .optional()
    .describe('why the procedure shrink or structured-check removal is intentional (required with allowMethodShrink)'),
  classDowngradeReason: z
    .string()
    .min(1)
    .max(2000)
    .optional()
    .describe(
      "loss-guard ack (P-008): why a stored 'violatable' criterion is intentionally being downgraded to settle-once (removing its provisional-until-terminal protection)",
    ),
}).superRefine((args, ctx) => {
  // Keep the published dispatch schema aligned with rubricTemplateDataSchema and
  // proposeRubric: acceptance rubrics are one-shot definitions of done, so they
  // cannot participate in the reusable standard rubric release gate. Without this
  // check, callers pass schema validation and only discover the invalid combination
  // after the whole-document proposal reaches the handler.
  if (args.kind === 'acceptance' && args.releaseGating === true) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['releaseGating'],
      message:
        'releaseGating is standard-kind only — an acceptance rubric is one-shot and watchdog-exempt; set kind:\'standard\' for a reusable release bar',
    });
  }
});

export default defineTool({
  name: 'rubrics:propose',
  profile: 'engineer',
  description:
    'Propose a rubric (the shared standard for a system characteristic) → status "proposed". ⚠ WHOLE-DOCUMENT REPLACE: re-proposing an existing rubricRef replaces ALL of its content — rubrics:get it first, edit, and resubmit EVERY criterion with its full method/replication text and structured check (a partial criteria list deletes the rest). Loss-guards enforce this: dropping a stored criterion key needs a dropKeys ack; removing a stored structured check or shrinking a criterion\'s method+replication procedure >40% (or losing its REPLICATION DRILL marker) needs allowMethodShrink + shrinkReason.',
  guidance: {
    when: 'You see a recurring characteristic worth grading consistently and no rubric covers it — or you are REVISING an existing rubric (rubrics:get first; resubmit ALL criteria, including each stored structured check). Author each criterion: model + method + driftMarkers + its own replication drill (the copy-runnable testing procedure); methodRef points at the rubric-level long-form runbook. Omitting a stored structured check intentionally uses allowMethodShrink:true + shrinkReason because it weakens deterministic enforcement back to fuzzy judgment.',
    notWhen: 'A one-off finding — file a free-text observation instead. Activating an existing proposed rubric — rubrics:ratify. Check rubrics:search first to avoid a duplicate.',
    chaining: 'rubrics:search (dedup) → rubrics:get (when revising — edit from the stored document, never from memory) → rubrics:propose → an independent reviewer calls rubrics:ratify. Preserve every stored structured check; an intentional check removal uses allowMethodShrink:true + shrinkReason. The result reports `completeness` (criteria lacking a replication drill; missing methodRef) and `replicationSqlCheck` (drill SQL that fails against live PG — read its `summary`; `findings` is REAL defects only, bind-placeholder noise split out) — fill/fix the gaps first.',
    returns:
      "{ ok, rubric, completeness, replicationSqlCheck, statusOverride }. statusOverride is non-null ONLY for kind:'acceptance' when the requested activation was silently discarded because that rubricRef is already retired against its shipped plan — content still lands (ok:true, statusOverride.contentApplied:true) but the rubric stays retired; your submitted criteria/description/title DID overwrite the retired document (recoverable via plans:revision-diff, not rubrics:get). A retired-with-the-ship rubric IS the shipped plan's validation record — a NEW acceptance rubric for a shipped subjectPlan is REFUSED (subject_plan_shipped); only a goal subject takes a new rubricRef.",
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
  result: z
    .object({
      ok: z.boolean().optional(),
      rubric: z.unknown().optional(),
      completeness: z.unknown().optional(),
      replicationSqlCheck: z.unknown().optional(),
      statusOverride: z.unknown().nullable().optional(),
    })
    .passthrough(),
  async handler(args, ctx) {
    const id = resolveAgentIdentity(ctx);
    const rubric = await proposeRubric({
      rubricId: args.rubricRef,
      ...(args.kind ? { kind: args.kind } : {}),
      ...(args.subjectPlan ? { subjectPlan: args.subjectPlan } : {}),
      ...(args.subjectGoal ? { subjectGoal: args.subjectGoal } : {}),
      ...(args.classRef ? { classRef: args.classRef } : {}),
      characteristic: args.characteristic,
      title: args.title,
      description: args.description,
      criteria: args.criteria,
      ratingScale: args.ratingScale,
      // rubrics:get projects an unset methodRef as null. Treat that read-back value
      // as omitted so a get → edit → propose round trip reaches the same validated
      // template-data shape instead of failing dispatch validation.
      ...(args.methodRef != null ? { methodRef: args.methodRef } : {}),
      releaseGating: args.releaseGating,
      dropKeys: args.dropKeys,
      allowMethodShrink: args.allowMethodShrink,
      shrinkReason: args.shrinkReason,
      ...(args.classDowngradeReason ? { classDowngradeReason: args.classDowngradeReason } : {}),
      // P-011 (D-006): tests-check paths validate against the tree the AGENT edits.
      checkPathRoot: resolveAgentWorkspaceRoot(ctx),
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
    // EI-21909559308315843 / EI-21909563388028590: an acceptance rubric always activates
    // on propose — the ONE case it doesn't is the deliberate EI-21296891484659125 guard
    // (rubrics.ts) refusing to resurrect an already-retired acceptance rubric via
    // whole-document upsert. That guard is correct; what it lacked was any signal to the
    // caller that their requested activation was silently discarded (the content upsert
    // still lands and returns ok:true). Surface it as a discriminated, non-blocking
    // advisory — never a refusal, so a deliberate content-only edit of a retired rubric
    // still succeeds.
    //
    // `contentApplied` is deliberately always `true` on this branch, not a diff-derived
    // value: proposeRubric() (rubrics.ts) writes `newBody`/`templateData` unconditionally
    // inside its withPlanLock transaction — the retired-status guard only freezes the
    // STATUS field, never the content write, and any earlier refusal (loss-guard,
    // citation-path check, dangling link) throws before this handler ever reaches
    // `rubric.status === 'retired'`. So reaching this branch at all already proves the
    // content write landed; EI-21909563388028590 confirmed this live (a scratch acceptance
    // rubric's title changed on re-propose while its status stayed 'retired'). Without this
    // flag a caller reading only `reason`/`remedy` can reasonably conclude nothing happened
    // beyond the refused reactivation, when in fact their submitted criteria/description/
    // title just overwrote the terminal historical record (recoverable only via
    // plans:revision-diff on the rubricRef, never via rubrics:get).
    const statusOverride =
      args.kind === 'acceptance' && rubric.status === 'retired'
        ? {
            requested: 'active' as const,
            applied: 'retired' as const,
            contentApplied: true as const,
            reason: 'stored-acceptance-retired',
            remedy:
              'this acceptance rubric is retired and cannot be reactivated by re-proposing the same rubricRef — your submitted content WAS written over the retired document anyway (contentApplied:true; recoverable via plans:revision-diff, not rubrics:get). If it retired because its subject plan SHIPPED, there is nothing to reconcile: the retired rubric IS the validation record, and a NEW acceptance rubric for a shipped plan is refused (subject_plan_shipped, EI-22078741539479611). For a goal subject, propose a NEW rubricRef instead of re-proposing this one if you did not intend to overwrite it',
          }
        : null;
    // Push-on-write (push-audit 2026-07-26): the Rubrics pane + trend read these.
    void trackDetached(import('../../sync-sse'))
      .then((m) => {
        m.notifySyncInvalidate('rubrics.list');
        m.notifySyncInvalidate('rubrics.trend');
      })
      .catch(() => {});
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ ok: true, rubric, completeness, replicationSqlCheck, statusOverride }),
        },
      ],
    };
  },
});
