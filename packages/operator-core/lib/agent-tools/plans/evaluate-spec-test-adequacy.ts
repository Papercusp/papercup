/** plans:evaluate-spec-test-adequacy — compile exact clause/evidence rows into scorecard drafts. */
import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import { resolveEffectiveHarnessSlug } from './_ctx-opts';
import { listSpecClauses } from './spec-clauses-store';
import {
  evidenceCurrentInputKey,
  listSpecEvidence,
  evidenceCurrentInputSchema,
  type EvidenceCurrentInput,
} from './spec-evidence-store';
import { evaluateSpecTestAdequacy, latestLogicalEvidence, PLAN_CLASS_RUBRIC_REFS } from './spec-test-adequacy';
import { getBuildInfo, type BuildInfo } from '../../build-info';

const evaluatorBuildSchema = z
  .object({
    sha: z.string().trim().min(1).max(256).nullable(),
    version: z.string().trim().min(1).max(120),
  })
  .strict();

function evaluatorBuildDiff(recorded: BuildInfo, live: BuildInfo): boolean {
  return recorded.sha !== live.sha || recorded.version !== live.version;
}

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
  /** Build identity recorded by a rerun recipe; used to surface evaluator drift. */
  evaluatorBuild: evaluatorBuildSchema.optional(),
  workItemIds: z.array(z.string().min(1)).min(1).max(500).optional(),
  evidenceRefs: z.array(z.string().trim().min(1).max(2000)).min(1).max(500).optional(),
  specIds: z.array(z.string().min(1)).min(1).max(500).optional(),
  /** Immutable clause revision/fingerprint selected by a persisted replay recipe. */
  specRevision: z.number().int().positive().optional(),
  specFingerprint: z.string().trim().min(1).max(256).optional(),
  /** Reuse the supplied current tuple as a prior server measurement; do not re-measure live files. */
  replaySnapshot: z.boolean().optional(),
  planItemIds: z.array(z.string().regex(/^P-\d{3,}$/)).min(1).max(200).optional(),
  current: z
    .union([
      z.array(evidenceCurrentInputSchema).max(500),
      z
        .object({
          supplied: z.boolean(),
          fingerprints: z.array(evidenceCurrentInputSchema).max(500),
        })
        .strict(),
    ])
    .optional()
    .describe(
      'Caller-supplied fingerprints may be the canonical array or the persisted rerunRecipe.current wrapper; wrapper.supplied:false means current was omitted. Matching stored values remain unknown for freshness and cannot produce freshness:pass without an internal server-measured comparison.',
    ),
  includeDraft: z.boolean().optional(),
  now: z.string().datetime({ offset: true }).optional(),
  limit: z.number().int().min(1).max(1000).optional(),
}).superRefine((args, ctx) => {
  if ((args.specRevision === undefined) !== (args.specFingerprint === undefined)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['specRevision'],
      message: 'specRevision and specFingerprint must be supplied together for an immutable clause pin',
    });
  }
  if (args.replaySnapshot === true && (args.specRevision === undefined || args.specFingerprint === undefined)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['replaySnapshot'],
      message: 'replaySnapshot requires specRevision and specFingerprint',
    });
  }
});

export default defineTool({
  name: 'plans:evaluate-spec-test-adequacy',
  description:
    'Grade each affected current spec revision as one row against the reusable spec-test-adequacy rubric. Resolves exact P-005 evidence bindings and returns scorecards:emit-compatible drafts plus every fail/unknown would-block reason. Read-only; it never files a verdict. evidenceRefs selects the exact immutable evidence identities to grade, so a replay can exclude superseded run-specific refs without rewriting history. Explicit selections never succeed vacuously: when specIds/workItemIds/evidenceRefs/planItemIds are supplied but no eligible clause matches, the reply is { ok:false, error:"selection_empty", ... } rather than ok:true with zero rows. On evidence_selection_hit_limit the reply is { ok:false, error, count, limit, remedy } with NO rows field at all; otherwise it is { ok:true, rows, count, verdicts, wouldBlock }. Always check ok and rows.length before indexing rows[0] — do not assume rows[0].scorecardDraft exists.',
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
    const liveEvaluatorBuild = getBuildInfo();
    const recordedEvaluatorBuild = args.evaluatorBuild;
    const evaluatorBuildDrift =
      recordedEvaluatorBuild && evaluatorBuildDiff(recordedEvaluatorBuild, liveEvaluatorBuild)
        ? { recorded: recordedEvaluatorBuild, live: liveEvaluatorBuild }
        : undefined;
    const current =
      args.current === undefined
        ? undefined
        : Array.isArray(args.current)
          ? args.current
          : args.current.supplied
            ? args.current.fingerprints
            : undefined;
    const evidenceLimit = args.limit ?? 1000;
    const allEvidence = await listSpecEvidence({
      harnessSlug,
      planSlugs: [args.slug],
      workItemIds: args.workItemIds,
      specIds: args.specIds,
      specRevision: args.specRevision,
      specFingerprint: args.specFingerprint,
      replaySnapshot: args.replaySnapshot === true,
      ...(args.replaySnapshot === true && current !== undefined
        ? { currentProvenance: 'server-measured' as const }
        : {}),
      evidenceRefs: args.evidenceRefs,
      current,
      limit: evidenceLimit,
    });
    if (allEvidence.length >= evidenceLimit) {
      return {
        data: {
          ok: false,
          error: 'evidence_selection_hit_limit',
          evaluatorBuild: liveEvaluatorBuild,
          ...(evaluatorBuildDrift ? { evaluatorBuildDrift } : {}),
          count: allEvidence.length,
          limit: evidenceLimit,
          remedy: 'Narrow workItemIds/specIds/evidenceRefs or raise limit; a capped evidence set cannot produce an adequacy verdict.',
        },
      };
    }
    const explicitSelection =
      args.specIds !== undefined ||
      args.workItemIds !== undefined ||
      args.evidenceRefs !== undefined ||
      args.planItemIds !== undefined;
    const bindingSelection = args.workItemIds !== undefined || args.evidenceRefs !== undefined;
    if (bindingSelection && allEvidence.length === 0) {
      return {
        data: {
          ok: false,
          error: 'selection_empty',
          evaluatorBuild: liveEvaluatorBuild,
          ...(evaluatorBuildDrift ? { evaluatorBuildDrift } : {}),
          slug: args.slug,
          harnessSlug,
          classRef: args.classRef,
          count: 0,
          selectedEvidenceCount: 0,
          matchedClauseCount: 0,
          eligibleClauseCount: 0,
          selection: {
            specIds: args.specIds ?? null,
            workItemIds: args.workItemIds ?? null,
            evidenceRefs: args.evidenceRefs ?? null,
            planItemIds: args.planItemIds ?? null,
          },
          remedy:
            args.evidenceRefs !== undefined
              ? 'No exact evidence binding matches the selected workItemIds/evidenceRefs; verify those immutable selectors or pass specIds without a binding selector to evaluate intended uncovered clauses.'
              : 'No exact evidence edge exists for the selected work item(s); pass specIds to evaluate intended uncovered clauses.',
        },
      };
    }
    const evidenceSpecIds = new Set(allEvidence.map((row) => row.specId));
    const requestedSpecIds = args.specIds ?? (bindingSelection ? [...evidenceSpecIds] : undefined);
    const clauses = await listSpecClauses({
      harnessSlug,
      planSlug: args.slug,
      specIds: requestedSpecIds,
      planItemIds: args.planItemIds,
      revision: args.specRevision,
    });
    const pinnedClauses = args.specFingerprint
      ? clauses.filter((clause) => clause.contentHash === args.specFingerprint)
      : clauses;
    const eligible = pinnedClauses.filter(
      (clause) => args.includeDraft === true || clause.lifecycleStatus === 'active' || clause.lifecycleStatus === 'accepted',
    );
    if (explicitSelection && eligible.length === 0) {
      return {
        data: {
          ok: false,
          error: 'selection_empty',
          evaluatorBuild: liveEvaluatorBuild,
          ...(evaluatorBuildDrift ? { evaluatorBuildDrift } : {}),
          slug: args.slug,
          harnessSlug,
          classRef: args.classRef,
          count: 0,
          selectedEvidenceCount: allEvidence.length,
          matchedClauseCount: clauses.length,
          eligibleClauseCount: 0,
          selection: {
            specIds: args.specIds ?? null,
            workItemIds: args.workItemIds ?? null,
            evidenceRefs: args.evidenceRefs ?? null,
            planItemIds: args.planItemIds ?? null,
          },
          excludedClauses: pinnedClauses.map((clause) => ({
            specId: clause.specId,
            revision: clause.revision,
            lifecycleStatus: clause.lifecycleStatus,
          })),
          remedy:
            clauses.length > 0 && args.includeDraft !== true
              ? 'The selection matched only draft clauses; pass includeDraft:true to evaluate draft clauses or select active/accepted clauses.'
              : 'Verify the exact slug and specIds/workItemIds/evidenceRefs/planItemIds selection; no eligible clause matched.',
        },
      };
    }
    const now = args.now ? new Date(args.now) : new Date();
    const rows = eligible.map((clause) =>
      evaluateSpecTestAdequacy({
        clause,
        evidence: allEvidence,
        classRef: args.classRef,
        harness: harnessSlug,
        current: (() => {
          const merged = new Map<string, EvidenceCurrentInput>();
          for (const input of current ?? []) merged.set(evidenceCurrentInputKey(input), input);
          // The grade selects the newest append of each exact-clause binding.
          // Its replay must use that SAME measurement, not an older recipe that
          // happens to appear later in the newest-first evidence history.
          const selected = new Set(latestLogicalEvidence(allEvidence.filter((row) =>
            row.planSlug === clause.planSlug &&
            row.specId === clause.specId &&
            row.specRevision === clause.revision &&
            row.specFingerprint === clause.contentHash,
          )));
          for (const row of allEvidence) {
            if (!selected.has(row) || row.serverMeasurement?.status !== 'measured') continue;
            merged.set(evidenceCurrentInputKey(row.serverMeasurement.current), row.serverMeasurement.current);
          }
          return merged.size > 0 ? [...merged.values()] : undefined;
        })(),
        rerunSelection: {
          workItemIds: args.workItemIds,
          evidenceRefs: args.evidenceRefs,
          planItemIds: args.planItemIds,
        },
        now,
      }),
    );
    return {
      data: {
        ok: true,
        evaluatorBuild: liveEvaluatorBuild,
        ...(evaluatorBuildDrift ? { evaluatorBuildDrift } : {}),
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
