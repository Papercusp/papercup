/** plans:evaluate-spec-test-adequacy — compile exact clause/evidence rows into scorecard drafts. */
import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import { resolveEffectiveHarnessSlug } from './_ctx-opts';
import { listSpecClauses } from './spec-clauses-store';
import { listSpecEvidence, SPEC_EVIDENCE_KINDS } from './spec-evidence-store';
import { evaluateSpecTestAdequacy, PLAN_CLASS_RUBRIC_REFS } from './spec-test-adequacy';

const fingerprint = z.string().trim().min(1).max(256);
const currentSchema = z.object({
  evidenceKind: z.enum(SPEC_EVIDENCE_KINDS),
  evidenceRef: z.string().trim().min(1).max(2000),
  sourceFingerprint: fingerprint,
  testFingerprint: fingerprint.nullable().optional(),
  fixtureFingerprint: fingerprint.nullable().optional(),
  rubricFingerprint: fingerprint.nullable().optional(),
  environmentFingerprint: fingerprint.nullable().optional(),
});

/**
 * Exported so a scorecard's `rerunRecipe.args` can be validated against the REAL
 * schema rather than a hand-copied list of field names. A recipe that its own
 * evaluator rejects is not a rerun recipe, and a guard that restates the field
 * names here would pass through exactly the drift it is meant to catch.
 */
export const argsSchema = z.object({
  harness: harnessArg,
  slug: z.string().min(1),
  classRef: z
    .enum(PLAN_CLASS_RUBRIC_REFS)
    .describe('Existing plan-class standard rubric referenced by the plan acceptance rubric.'),
  workItemIds: z.array(z.string().min(1)).min(1).max(500).optional(),
  specIds: z.array(z.string().min(1)).min(1).max(500).optional(),
  planItemIds: z.array(z.string().regex(/^P-\d{3,}$/)).min(1).max(200).optional(),
  current: z.array(currentSchema).max(500).optional(),
  includeDraft: z.boolean().optional(),
  now: z.string().datetime({ offset: true }).optional(),
  limit: z.number().int().min(1).max(1000).optional(),
});

export default defineTool({
  name: 'plans:evaluate-spec-test-adequacy',
  description:
    'Grade each affected current spec revision as one row against the reusable spec-test-adequacy rubric. Resolves exact P-005 evidence bindings and returns scorecards:emit-compatible drafts plus every fail/unknown would-block reason. Read-only; it never files a verdict. Two distinct response shapes: on evidence_selection_hit_limit the reply is { ok:false, error, count, limit, remedy } with NO rows field at all; otherwise it is { ok:true, rows, count, verdicts, wouldBlock } where rows is legitimately [] when no clause is eligible (no lifecycleStatus active/accepted match, or the specIds/workItemIds/planItemIds filter matched nothing). Always check ok and rows.length before indexing rows[0] — do not assume rows[0].scorecardDraft exists.',
  guidance: {
    when: 'During implementation feedback or immediately before attempting work-item completion for spec-covered behavior.',
    notWhen: 'Authoring clauses — plans:set-specs. Binding proof — plans:bind-spec-evidence. Filing a returned draft — scorecards:emit. Indexing rows[0] without checking ok/rows.length first — an empty or error-shaped reply has no rows[0] to read.',
    chaining:
      'plans:get-specs → plans:bind-spec-evidence → plans:evaluate-spec-test-adequacy with current fingerprints → scorecards:emit each passing draft. P-007 consumes current emitted rows at work_items:complete.',
    seeAlso: ['plans:get-spec-evidence', 'scorecards:emit', 'rubrics:get spec-test-adequacy'],
  },
  capability: 'plans:read',
  requirePrincipal: false,
  skipWorkspaceTx: true,
  agentRoles: [...AGENT_ROLES],
  modality: ['text'],
  args: argsSchema,
  async handler(args, ctx) {
    const sctx = harnessScopedCtx(args.harness, ctx);
    const harnessSlug = resolveEffectiveHarnessSlug(sctx);
    const evidenceLimit = args.limit ?? 1000;
    const allEvidence = await listSpecEvidence({
      harnessSlug,
      planSlugs: [args.slug],
      workItemIds: args.workItemIds,
      specIds: args.specIds,
      current: args.current,
      limit: evidenceLimit,
    });
    if (allEvidence.length >= evidenceLimit) {
      return {
        data: {
          ok: false,
          error: 'evidence_selection_hit_limit',
          count: allEvidence.length,
          limit: evidenceLimit,
          remedy: 'Narrow workItemIds/specIds or raise limit; a capped evidence set cannot produce an adequacy verdict.',
        },
      };
    }
    const evidenceSpecIds = new Set(allEvidence.map((row) => row.specId));
    const requestedSpecIds = args.specIds ?? (args.workItemIds ? [...evidenceSpecIds] : undefined);
    const clauses = await listSpecClauses({
      harnessSlug,
      planSlug: args.slug,
      specIds: requestedSpecIds,
      planItemIds: args.planItemIds,
    });
    const eligible = clauses.filter(
      (clause) => args.includeDraft === true || clause.lifecycleStatus === 'active' || clause.lifecycleStatus === 'accepted',
    );
    const now = args.now ? new Date(args.now) : new Date();
    const rows = eligible.map((clause) =>
      evaluateSpecTestAdequacy({ clause, evidence: allEvidence, classRef: args.classRef, current: args.current, now }),
    );
    return {
      data: {
        ok: true,
        slug: args.slug,
        harnessSlug,
        classRef: args.classRef,
        rubricRef: 'spec-test-adequacy',
        rows,
        count: rows.length,
        verdicts: {
          pass: rows.filter((row) => row.verdict === 'pass').length,
          fail: rows.filter((row) => row.verdict === 'fail').length,
          unknown: rows.filter((row) => row.verdict === 'unknown').length,
        },
        wouldBlock: rows
          .filter((row) => row.wouldBlock.length > 0)
          .map((row) => ({ specId: row.specId, revision: row.specRevision, criteria: row.wouldBlock })),
        uncoveredWorkItemSelection:
          args.workItemIds && evidenceSpecIds.size === 0
            ? {
                workItemIds: args.workItemIds,
                reason: 'No exact evidence edge exists for the selected work item(s); pass specIds to evaluate intended uncovered clauses.',
              }
            : null,
      },
    };
  },
});
