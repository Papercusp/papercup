/** scorecards:emit — the typed write facade over the canonical observation ledger. */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { resolveAgentIdentity } from '../coordination/identity';
import { getOrgPg } from '@papercusp/db-org';
import {
  getRubric,
  getRubricCriteriaHash,
  getRubricPlanRevision,
  META_ACCEPTANCE_RUBRIC_ID,
  readRubricPlanRevision,
} from '../../rubrics';
import { getAcceptanceRubricVettingStatus } from '../../acceptance-rubric-vetting';
import { getIssue } from '../../issues-engineer';
import { captureImprovement } from '../../harness/improvements/capture-core';
import { activeWorkspaceId } from '../../workspace-registry';
import { readVettingConsultCritique } from '../../consult/get-feedback-core';
import { readVettingWorkItemCritique } from '../../work-items';
import {
  normalizeScorecardRatings,
  validateObservationRatings,
  validateScorecardCompleteness,
  validateScorecardRatingValues,
  validateScorecardPoorRatingDisposition,
  ObservationEvidenceError,
  type ObservationRatings,
  type ScorecardVetting,
  type ScorecardAcceptance,
  type AcceptanceSeatSuccession,
  type SpecTestAdequacyRerunRecipe,
  asStructuredObservation,
} from '../../harness/improvements/observation-types';
import { readRunningGeneration } from '../../scout/generation-watermark';
import {
  auditVerdictFromRatings,
  listScorecards,
  evaluateScorecardInstrumentContract,
  resolveScorecardReleaseGateBinding,
  scorecardRatingsClaimPass,
  recordGradingAudit,
  scorecardEvidenceFingerprint,
  type ScorecardInstrumentSnapshot,
  type ScorecardReleaseGateSnapshot,
} from '../../scorecards';
import { scorecardInstrumentSnapshotSchema, scorecardRatingEntrySchema } from './evaluate';
import {
  collapseCriticsToSoleParty,
  resolveAcceptanceGraderEligibility,
  resolveAggregatedVettingCritics,
  retiredAcceptanceRubricRefusal,
} from './grader-eligibility';
import { acceptanceGraderLabelPrefix, advanceGradingCascadeOnCard } from '../../acceptance-grader';
import { gradingCardDigestExcerpt } from '../../consult/grading-cascade';
import { GRADING_INTEGRITY_RUBRIC_REF, gradingAuditGateEnabled, needsGradingAudit } from '../../grading-integrity';
import type { ScorecardGradingAudit } from '../../harness/improvements/observation-types';
import { killTask } from '../../task-manager/control';
import { listTasks } from '../../task-manager/store';
import { emitScorecardEmitted } from '../../scorecard-emitted-events';
import {
  evaluateCriterionCargoChecks,
  evaluateCriterionProbeChecks,
  evaluateCriterionTestChecks,
  evaluateCriterionCoverageChecks,
  evaluateCriterionRequirementChecks,
} from '../../rubrics-criterion-checks';
import { getEffectiveItemAudits, getLatestActivationAudit, getPlanItemStatuses } from '../../plan-audits';
import { resolveHarnessPaths } from '../../resolve-harness-paths';
import { resolvePlanHarnessSlug } from '../plans/source';
import { SPEC_TEST_ADEQUACY_RUBRIC_REF, specTestAdequacySubjectRef } from '../plans/spec-test-adequacy';

/**
 * The `planTouched` reverse map: every implementing file the subject plan's work-items
 * recorded as changed, deduped. Returns [] when the plan exists but nothing recorded a
 * `filesChanged` — the CALLER distinguishes that from null (no plan subject at all), and
 * both refuse the check rather than widening its scope to the whole census.
 */
async function planTouchedFiles(workspaceId: string, planSlug: string): Promise<string[]> {
  const { sql } = getOrgPg();
  const rows: { f: string }[] = await sql`
    SELECT DISTINCT jsonb_array_elements_text(
             COALESCE(payload->${TERMINAL_COMPLETION_EVIDENCE_KEY}->'filesChanged', '[]'::jsonb)
           ) AS f
      FROM harness_shared.work_items
     WHERE workspace_id = ${workspaceId}
       AND source_plan_slug = ${planSlug}
  `;
  return rows.map((r) => r.f).filter((f) => typeof f === 'string' && f.trim() !== '');
}
import { readCoverage } from '../testing/coverage';
import { TERMINAL_COMPLETION_EVIDENCE_KEY } from '../../coord-lifecycle/records';
import { resolveAgentWorkspaceRoot } from '../capability/base-dir';
import { trackDetached } from '../../detached-imports';
import { areAcceptanceLineageRelated, isAcceptanceAuthorIdentity } from '../../acceptance-author-identity';
import { acceptanceSeatRefusalHint, resolveAcceptanceSeatSuccession } from '../../acceptance-seat-succession';
import { readAndEvaluateAcceptanceBarLifecycle } from '../../acceptance-bar-lifecycle-evaluator';
// TYPE-ONLY (erased at runtime) — see defaultResolveAuthorSessionState below,
// which mirrors rebind-identity.ts's own dynamic-import discipline for the
// same oracle so this write-path module never carries it on its static graph.
import type { SessionState } from '../coordination/presence-wakeability';

/**
 * A tests-backed scorecard is intentionally a long-running write: it shells one
 * batched Vitest run before filing.  Keep the inner run comfortably inside the
 * tool's declared timeout so process-group settlement, the ledger write, and MCP
 * serialization cannot lose a race to the transport deadline.
 */
/**
 * scorecards:emit accepts deterministic checks spanning up to 50 files. A real
 * 16-file Papercusp acceptance batch takes roughly four minutes, so the old
 * two-minute inner budget rejected a fully green run before it could be filed.
 * Scale that observed batch to the schema cap (12.5 minutes), round up to 13,
 * and keep two more minutes outside the runner for process-group settlement,
 * the ledger write, and MCP serialization.
 */
export const SCORECARD_EMIT_TIMEOUT_SEC = 15 * 60;
export const SCORECARD_TEST_CHECK_TIMEOUT_MS = 13 * 60_000;

const specTestAdequacyFingerprintSchema = z.string().trim().min(1).max(256);
const specTestAdequacyRerunRecipeSchema = z
  .object({
    schemaVersion: z.literal(1),
    evaluator: z.literal('plans:evaluate-spec-test-adequacy'),
    selection: z
      .object({
        planSlug: z.string().trim().min(1).max(120),
        specId: z.string().trim().min(1).max(200),
        specRevision: z.number().int().positive(),
        specFingerprint: specTestAdequacyFingerprintSchema,
        evidence: z
          .array(
            z
              .object({
                evidenceKind: z.string().trim().min(1).max(120),
                evidenceRef: z.string().trim().min(1).max(2000),
              })
              .strict(),
          )
          .max(500),
      })
      .strict(),
    current: z
      .object({
        supplied: z.boolean(),
        fingerprints: z
          .array(
            z
              .object({
                evidenceKind: z.string().trim().min(1).max(120),
                evidenceRef: z.string().trim().min(1).max(2000),
                sourceFingerprint: specTestAdequacyFingerprintSchema,
                // EI-21670417404287969 / EI-21723288985786146 / EI-21597519978995942:
                // `.nullable()` alone makes a key REQUIRED-but-nullable, so a caller had
                // to spell out `fixtureFingerprint: null` on every row that has no
                // fixture. The producers legitimately OMIT a dimension they did not
                // measure — an operational/check row has no test or fixture — so the
                // documented evaluator→emit chain could not be passed through unchanged,
                // and three separate plans (P-003, P-006, and a validator pass) each hit
                // it and filed it. Omission and explicit null mean the same thing here;
                // `unknownWhenMissing` in `derivation` below already fixes the semantics
                // of a missing dimension, so requiring the key adds no information.
                // This matches the three sibling call sites, which were already
                // `.nullable().optional()`: plans/get-spec-evidence.ts:15,
                // plans/evaluate-spec-test-adequacy.ts:17, plans/bind-spec-evidence.ts:25
                // — emit.ts was the lone straggler.
                testFingerprint: specTestAdequacyFingerprintSchema.nullable().optional(),
                fixtureFingerprint: specTestAdequacyFingerprintSchema.nullable().optional(),
                rubricFingerprint: specTestAdequacyFingerprintSchema.nullable().optional(),
                environmentFingerprint: specTestAdequacyFingerprintSchema.nullable().optional(),
              })
              .strict(),
          )
          .max(500),
      })
      .strict(),
    derivation: z
      .object({
        kind: z.literal('listSpecEvidence.currentness'),
        classifier: z.literal('classifySpecEvidenceCurrentness'),
        unknownWhenMissing: z.literal(true),
      })
      .strict(),
  })
  .strict();

export const scorecardEmitArgs = z
  .object({
    rubricRef: z.string().min(1).max(120),
    sourceHive: z.string().min(1).max(120).optional(),
    targetHive: z.string().min(1).max(120).optional(),
    title: z.string().min(1).max(240).optional(),
    body: z.string().max(8000).optional(),
    ratings: z.record(z.string().min(1), scorecardRatingEntrySchema),
    testedSha: z
      .string()
      .trim()
      .regex(/^[0-9a-f]{7,64}$/i)
      .optional()
      .describe(
        'Commit SHA the supplied ratings actually tested. Required when a releaseGating rubric contains any pass-like rating; emit proves it is both the fresh green pin and current staging HEAD before filing.',
      ),
    acceptance: z
      .object({
        verdict: z.enum(['accept', 'reject']),
        reasoning: z.string().trim().min(1).max(2000),
      })
      .strict()
      .optional()
      .describe(
        "The acceptance-rubric AUTHOR's post-grading call. Valid only for kind:'acceptance', required when that author emits, and refused until a complete independent grading exists. The top-level ratings field remains schema-required and must contain the complete rubric ratings; acceptance does not replace it. Independent graders omit it.",
      ),
    instrumentSnapshots: z.record(z.string().min(1), scorecardInstrumentSnapshotSchema).optional(),
    rerunRecipe: specTestAdequacyRerunRecipeSchema.optional(),
    subject: z
      .object({
        kind: z.enum(['agent-run', 'session', 'work-item', 'plan', 'pot', 'rubric', 'scorecard']).optional(),
        ref: z.string().min(1).max(200),
        windowStart: z.string().min(1).max(64).optional(),
        windowEnd: z.string().min(1).max(64).optional(),
      })
      .strict()
      .optional()
      .describe(
        "WHAT this scorecard grades (stored as observation.subject) — e.g. { kind:'rubric', ref:'<rubricId>' } on a vetting card.",
      ),
    vettingConsult: z
      .string()
      .min(1)
      .max(120)
      .optional()
      .describe(
        "Vetting linkage for a META-RUBRIC scorecard only (consult-min-max-and-rubric-vetting-2026-08-17 P-004): conversation_id of the get_feedback consult that critiqued the vetted rubric. Requires subject:{ kind:'rubric', ref:'<the vetted rubric id>' }. Do not pass this on the later plan-subject acceptance card; that card cites the separately emitted meta-rubric scorecard instead. The rubric must exist, the consult's durable opening question must name the vetted rubric id or its subject plan, AND the consult must carry at least one third-party critique reply (EI-20821478338037350) — an unrelated or opened-but-unanswered consult is refused, not silently accepted. Stamped as observation.vetting with the critique count and critics.",
      ),
    vettingWorkItem: z
      .string()
      .min(1)
      .max(120)
      .optional()
      .describe(
        "Vetting linkage, work-item channel (WI-41477): the WI-/EI- work-item whose third-party COMMENTS carry the critique of the vetted rubric — the channel a LAUNCHED independent reviewer (D-049: certification goes to an agent with no history on the artifact) can actually write to, since consult participants are router-assigned and a launched reviewer is never enrolled. Same predicate as vettingConsult, mirrored clause for clause: the work-item must exist AND carry ≥1 comment authored by neither the emitter nor the vetted rubric's author. Stamped as observation.vetting { workItemId, critiquePosts, critics }. Pass EXACTLY ONE of vettingConsult / vettingWorkItem; the vettingUnanswered waiver is consult-only (a work-item with no third-party comment is not evidence — route a consult instead).",
      ),
    vettingUnanswered: z
      .boolean()
      .optional()
      .describe(
        'Attest that the cited vetting consult received NO critique (every routed reviewer was dead/parked or it expired unanswered) and you are proceeding anyway. Requires BOTH `vettingConsult` and `vettingUnansweredReason`, and is REFUSED when the consult did receive critique — this is the recorded-waiver path, not a way to skip reading replies. Stamped visibly as observation.vetting.unanswered so a later reader can tell a vetted rubric from an un-critiqued one.',
      ),
    vettingUnansweredReason: z
      .string()
      .min(24)
      .max(500)
      .optional()
      .describe(
        'Why no critique was available (required with `vettingUnanswered`). Name what you actually observed — e.g. "all 3 routed reviewers ended; consult expired 19:54Z with 0 posts" — not "no reply yet".',
      ),
    supersedes: z
      .string()
      .min(1)
      .max(120)
      .optional()
      .describe('Issue id of the earlier scorecard this corrected filing replaces.'),
    terminal: z
      .boolean()
      .optional()
      .describe(
        "Affirm the graded SUBJECT has terminated (P-008). Without it, rating any 'violatable'-class criterion stamps the card PROVISIONAL — a working note excluded from rubrics:trend until a terminal re-emit (terminal:true, supersedes the interim) makes the grading final.",
      ),
    force: z
      .boolean()
      .optional()
      .describe('File even when the canonical evidence fingerprint matches the latest scorecard.'),
    acknowledgeExisting: z
      .literal(true)
      .optional()
      .describe(
        'Acknowledge that complete independent scorecards already exist for this rubric revision. Required to append another; force:true only bypasses unchanged-evidence deduplication and never substitutes for this acknowledgement.',
      ),
  })
  .strict();

type SpecTestAdequacyBindingError = {
  code: 'invalid_spec_test_adequacy_binding';
  error: string;
};

/**
 * The completion gate can only match a spec-test-adequacy card to the exact
 * clause revision selected by the evaluator. Refuse malformed or mismatched
 * bindings at the write boundary so an unmatchable card never enters history.
 */
function validateSpecTestAdequacyBinding(
  args: z.infer<typeof scorecardEmitArgs>,
): SpecTestAdequacyBindingError | undefined {
  if (args.rubricRef !== SPEC_TEST_ADEQUACY_RUBRIC_REF) return undefined;

  if (!args.rerunRecipe) {
    return {
      code: 'invalid_spec_test_adequacy_binding',
      error:
        `rubric '${SPEC_TEST_ADEQUACY_RUBRIC_REF}' requires the evaluator's rerunRecipe from ` +
        'plans:evaluate-spec-test-adequacy, including its exact selection; do not emit a hand-built adequacy card',
    };
  }

  const parsedRecipe = specTestAdequacyRerunRecipeSchema.safeParse(args.rerunRecipe);
  if (!parsedRecipe.success) {
    return {
      code: 'invalid_spec_test_adequacy_binding',
      error:
        `rubric '${SPEC_TEST_ADEQUACY_RUBRIC_REF}' requires a valid evaluator rerunRecipe from ` +
        'plans:evaluate-spec-test-adequacy',
    };
  }

  const selection = parsedRecipe.data.selection;
  const expectedRef = specTestAdequacySubjectRef(selection.planSlug, selection.specId, selection.specRevision);
  if (args.subject?.kind !== 'plan' || args.subject.ref !== expectedRef) {
    return {
      code: 'invalid_spec_test_adequacy_binding',
      error:
        `rubric '${SPEC_TEST_ADEQUACY_RUBRIC_REF}' requires subject:{ kind:'plan', ref:'${expectedRef}' } ` +
        'matching rerunRecipe.selection (the evaluator-owned clause revision)',
    };
  }

  return undefined;
}

export async function cleanupAcceptanceGraderTasks(
  rubricRef: string,
  input: { workspaceId?: string } = {},
  deps: {
    list?: typeof listTasks;
    kill?: typeof killTask;
  } = {},
) {
  const prefix = acceptanceGraderLabelPrefix(rubricRef);
  const tasks = await (deps.list ?? listTasks)({
    ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
    states: ['pending', 'running'],
    classes: ['agent-session'],
    limit: 2_000,
  });
  const matched = tasks.filter(
    (task) =>
      task.detail.headless === true && typeof task.detail.label === 'string' && task.detail.label.startsWith(prefix),
  );
  // EI-21390074563933948: these are THIS rubric's own throwaway headless graders
  // (matched by label prefix), not peer work — so a bare SIGTERM that the grader
  // tree shrugs off must ESCALATE on a bounded grace instead of returning
  // incomplete and leaving 20+ live processes behind. Same janitorial shape as
  // gc-desktop-sessions; killTask still verifies emptiness itself and never
  // reports success on a scope that would not die.
  const results = await Promise.all(
    matched.map(async (task) => ({
      taskId: task.taskId,
      outcome: await (deps.kill ?? killTask)(task.taskId, {
        includeSubtree: true,
        escalateAfterMs: 5_000,
      }),
    })),
  );
  return { prefix, matched: matched.length, results };
}

/**
 * Resolve the tree for deterministic acceptance checks. A grader may run from a
 * different Hive than the subject it is grading; in that case repo-relative test
 * paths belong to targetHive, not the grader's checkout. Same-Hive and legacy
 * callers retain the handler's caller-root behavior.
 */
async function resolveDeterministicCheckRoot(
  args: Pick<z.infer<typeof scorecardEmitArgs>, 'targetHive'>,
  input: {
    ctxHarness?: string;
    workspaceId?: string;
    checkRoot?: string;
    rubricWorkspaceId?: string | null;
    rubricSubjectPlan?: string | null;
  },
): Promise<string | undefined> {
  const callerRoot = input.checkRoot ?? resolveAgentWorkspaceRoot({});
  // EI-21384279769470409: a workspace-scoped superuser dispatch may omit
  // ctx.workspaceId even though the rubric itself is workspace-bound.
  const workspaceId = input.workspaceId ?? input.rubricWorkspaceId ?? undefined;
  // Acceptance graders often omit targetHive because the rubric already names its
  // subject plan. Recover that plan's owning harness so repo-relative checks run in
  // the subject tree rather than the grader's checkout. An explicit targetHive is
  // authoritative and short-circuits this fallback, preserving cross-hive callers'
  // existing precedence.
  const targetHive =
    args.targetHive ??
    (input.rubricSubjectPlan && workspaceId
      ? await resolvePlanHarnessSlug(workspaceId, input.rubricSubjectPlan)
      : undefined);
  if (!targetHive || targetHive === input.ctxHarness || !workspaceId) return callerRoot;

  const targetPaths = await resolveHarnessPaths(targetHive, workspaceId);
  return resolveAgentWorkspaceRoot({ projectDir: targetPaths.projectDir });
}

/**
 * EI-21917534129987791: resolve the recorded author's live/parked/ended
 * verdict for the acceptance-author refusal's recovery hint (see
 * {@link authorRebindHint}). Dynamic-imported, mirroring rebind-identity.ts's
 * own liveness probe: the oracle statically pulls presence.ts / adv-sessions /
 * psu-pty-discovery, which this write-path module has no reason to carry on
 * its static graph for a best-effort error-message hint. Never throws — a
 * probe fault degrades to "no hint", never to a blocked or altered refusal.
 */
async function defaultResolveAuthorSessionState(
  ownerId: string,
  _opts: { workspaceId?: string } = {},
): Promise<SessionState | null> {
  try {
    const { resolveSessionStates } = await import('../coordination/liveness-oracle');
    const verdicts = await resolveSessionStates([{ ownerId }], { nowMs: Date.now(), hydratePerId: true });
    return verdicts.get(ownerId)?.sessionState ?? null;
  } catch {
    return null;
  }
}

/*
 * WI-2141007: `authorRebindHint` used to live here, appending "a legitimate
 * successor may run coord:rebind-identity { from: <author> }" to the not-the-
 * author refusal. It was removed, not moved: for the case that most often
 * produced it — an unrelated live PEER holding the plan, not the same agent
 * under a new sid — that advice was a footgun (EI-22135313244682666). Rebinding
 * migrates the dead author's ENTIRE owner-keyed surface set (armed loops,
 * claims, file locks, owner-scoped facts, fleet membership) merely to record one
 * verdict, and using it to pass an independence control defeats the control.
 * `acceptanceSeatRefusalHint` in acceptance-seat-succession.ts replaces it: it
 * names the narrow seat-succession route, and still points a genuine
 * same-agent-new-sid successor at rebind, which remains correct for them.
 */

export async function emitScorecard(
  args: z.infer<typeof scorecardEmitArgs>,
  input: {
    createdBy: string;
    ctxHarness?: string;
    role?: string;
    workspaceId?: string;
    /** P-011 (D-006): the tree tests-check files resolve + run against — the handler
     *  passes its ctx-resolved root; omitted ⇒ the resolver's ctx-less fallback. */
    checkRoot?: string;
  },
  deps: {
    /** Injectable seam for tests — production runs the real router via the testing:run core. */
    evaluateChecks?: typeof evaluateCriterionTestChecks;
    /** Injectable seam for tests — production replays typed ContinuityProbes. */
    evaluateProbeChecks?: typeof evaluateCriterionProbeChecks;
    /** Host-bound direct dispatcher used by ContinuityProbe checks. */
    dispatchTool?: (name: string, args: Record<string, unknown>) => Promise<unknown>;
    /** Injectable seam for tests — production runs the native Cargo crate runner. */
    evaluateCargoChecks?: typeof evaluateCriterionCargoChecks;
    evaluateCoverageChecks?: typeof evaluateCriterionCoverageChecks;
    /** Injectable seam for tests — production runs the real P-014 activation↔completion join. */
    evaluateRequirementChecks?: typeof evaluateCriterionRequirementChecks;
    /** Injectable live release-gate read; production uses gitPipelineSnapshot. */
    releaseGateSnapshot?: () => Promise<ScorecardReleaseGateSnapshot>;
    /** Audited coord-identity continuity resolver. */
    sameAcceptanceAuthor?: typeof isAcceptanceAuthorIdentity;
    /** Spawn/rebind ancestry resolver for independent-grader enforcement. */
    lineageRelated?: typeof areAcceptanceLineageRelated;
    /** EI-21917534129987791: liveness probe backing the author-rebind recovery
     *  hint on the "acceptance must be recorded by the author" refusal. */
    resolveAuthorSessionState?: (ownerId: string, opts: { workspaceId?: string }) => Promise<SessionState | null>;
  } = {},
) {
  const rubric = await getRubric(args.rubricRef);
  if (!rubric) return { ok: false as const, error: `rubric '${args.rubricRef}' not found` };
  // P-004: the meta-rubric is an attestation surface, not a free-standing
  // observation. Without a subject the scorecard cannot say WHICH acceptance
  // rubric it vetted, so it can never satisfy the ship gate and only creates a
  // misleading "successful" history row. Enforce this at the write boundary,
  // before revision reads, deduplication, checks, or the ledger write.
  if (args.rubricRef === META_ACCEPTANCE_RUBRIC_ID && !args.subject) {
    return {
      ok: false as const,
      code: 'meta_acceptance_subject_required' as const,
      error:
        `scorecard for meta-rubric '${META_ACCEPTANCE_RUBRIC_ID}' requires subject:{ kind:'rubric', ref:'<acceptance-rubric-id>' } ` +
        'naming the specific acceptance rubric being vetted; a subject-less meta-scorecard cannot attest a rubric or satisfy the acceptance ship gate',
    };
  }
  // EI-21542997259558722: an acceptance rubric retires with its shipped or
  // superseded subject plan. A queued/carry-resumed grader can wake much later
  // with a valid rubric id and otherwise append a redundant verdict after the
  // plan is already terminal. Refuse at the write facade's entry, before
  // revision reads, deduplication, deterministic checks, or the ledger write.
  // Historical cards remain readable through scorecards:list.
  if (rubric.kind === 'acceptance' && rubric.status === 'retired') {
    return { ok: false as const, ...retiredAcceptanceRubricRefusal(rubric) };
  }
  const specTestAdequacyBindingError = validateSpecTestAdequacyBinding(args);
  if (specTestAdequacyBindingError) return { ok: false as const, ...specTestAdequacyBindingError };
  try {
    // EI-21765534049482705: a meta-rubric card whose subject is an active
    // acceptance rubric is the vetting attestation consumed by the completion
    // gates. Without a linked critique channel it looks like a successful
    // scorecard, but the plan/goal gates must (correctly) ignore it forever.
    // Resolve the subject here so the writer rejects the inert card at the
    // point where the missing evidence is still actionable. Plain meta-rubric
    // scorecards without an acceptance-rubric subject remain valid.
    const missingAcceptanceRubricVetting =
      args.rubricRef === META_ACCEPTANCE_RUBRIC_ID &&
      args.subject?.kind === 'rubric' &&
      !args.vettingConsult &&
      !args.vettingWorkItem &&
      args.vettingUnanswered !== true;
    if (missingAcceptanceRubricVetting) {
      // `missingAcceptanceRubricVetting` already established subject?.kind === 'rubric',
      // but that narrowing does not flow through the aliased conjunction — bind the ref
      // once so the guard and the message cannot disagree about its nullability.
      const vettedRubricRef = args.subject!.ref;
      const subjectRubric = await getRubric(vettedRubricRef);
      if (subjectRubric?.kind === 'acceptance' && subjectRubric.status === 'active') {
        return {
          ok: false as const,
          code: 'acceptance_rubric_vetting_required' as const,
          error:
            `meta-rubric scorecard for active acceptance rubric '${vettedRubricRef}' requires vetting linkage — ` +
            `pass vettingConsult:'<consult conversation_id>' or vettingWorkItem:'<review WI-/EI- id>'. ` +
            `If no critique is available, use vettingConsult with vettingUnanswered:true and ` +
            `vettingUnansweredReason:'<what you observed>' so the waiver is recorded visibly.`,
        };
      }
    }
    // Bind every scorecard to the exact rubric plan-row revision used for grading.
    // A failed read remains unrecorded; historical cards must not be back-filled
    // from whatever the rubric says today.
    const rubricRevision = await getRubricPlanRevision(args.rubricRef);
    // WI-1393208: also pin the rubric's criteriaHash (the field designed exactly
    // for this — see its doc comment) so a later criterion/method/description
    // edit is machine-detectable against this card, not just a plan-row revision
    // bump (which fires on ANY propose, typo included, and says nothing about
    // WHAT changed). Same fail-open/unrecorded-on-failure contract as rubricRevision.
    const criteriaHash = await getRubricCriteriaHash(args.rubricRef);
    const acceptance = args.acceptance as ScorecardAcceptance | undefined;
    // WI-2141007: set when this verdict is recorded by a SUCCESSOR to a dead
    // rubric author rather than by the author themselves. Declared out here
    // because it is stamped onto the persisted card below, outside the
    // acceptance-kind guard block that resolves it.
    let seatSuccession: AcceptanceSeatSuccession | undefined;
    // Acceptance authority belongs to the rubric author of record. A later
    // repair/re-propose records its actor in proposedBy, but must not transfer
    // the right to issue the plan verdict away from createdBy. Keep proposedBy
    // only as a legacy fallback for rows whose original creator is unavailable.
    const implementer = rubric.createdBy ?? rubric.proposedBy ?? null;
    if (acceptance && rubric.kind !== 'acceptance') {
      return {
        ok: false as const,
        error:
          "acceptance is valid only for kind:'acceptance' rubrics — a standard scorecard records ratings, not a plan ship verdict",
      };
    }
    if (rubric.kind === 'acceptance') {
      // P-003: the grading door consumes the same bounded BAR snapshot as the
      // start/ship doors. This is intentionally before deterministic checks and
      // task cleanup, so a BAR-only or divergent contract is refused before a
      // costly grading pass is spent.
      if (rubric.barContract?.adoptionEpoch != null && rubric.subjectPlan) {
        const lifecycle = await readAndEvaluateAcceptanceBarLifecycle(rubric.subjectPlan, 'pre-grading', {
          expectedApplicable: true,
        });
        if (!lifecycle.satisfied) {
          return {
            ok: false as const,
            code: 'acceptance_bar_contract_not_ready' as const,
            error: lifecycle.message ?? 'acceptance BAR contract is not ready for grading',
            lifecycle,
          };
        }
      }
      const sameAcceptanceAuthor = deps.sameAcceptanceAuthor ?? isAcceptanceAuthorIdentity;
      const lineageRelated = deps.lineageRelated ?? areAcceptanceLineageRelated;
      const identityWorkspace = rubric.workspaceId || input.workspaceId || activeWorkspaceId();
      // EI-21974075442192005: every rail resolved here is a pure IDENTITY fact,
      // settled before a single criterion is rated — yet all of them used to be
      // reachable ONLY through this terminal call, so a launched reviewer could
      // complete an entire grading pass and only then learn it could never file
      // the result. The rails now live in `grader-eligibility.ts`, which
      // `scorecards:evaluate` pre-flights against, so the disqualification is
      // discoverable before the work. Codes, messages and evaluation order are
      // unchanged; do not re-implement any of them here or in the pre-flight.
      const eligibility = await resolveAcceptanceGraderEligibility({
        rubric,
        callerId: input.createdBy,
        workspaceId: identityWorkspace,
        // WI-2141007: say WHICH question we are asking. Supplying `acceptance`
        // is an author-side verdict, not an offer of independent grading, so the
        // grading-independence rails must not answer it — they used to, which
        // both printed remedy advice for a problem the caller did not have AND
        // returned before seat succession could be considered at all.
        intent: acceptance ? 'acceptance' : 'grading',
        deps: { sameAcceptanceAuthor, lineageRelated },
      });
      if (eligibility.refusal) return { ok: false as const, ...eligibility.refusal };
      // WI-2141007: the acceptance seat is INHERITABLE when its author is dead.
      // Attempt succession before refusing — otherwise a plan whose implementer
      // was reaped (the normal case on a fleet that reaps members) can never
      // ship through any supported path. `callerIsImplementer` below therefore
      // means "holds author authority", by identity OR by audited succession.
      if (!eligibility.callerIsImplementer && acceptance) {
        const resolveAuthorSessionState = deps.resolveAuthorSessionState ?? defaultResolveAuthorSessionState;
        const seat = await resolveAcceptanceSeatSuccession({
          authorId: implementer,
          callerId: input.createdBy,
          subjectPlan: rubric.subjectPlan ?? null,
          workspaceId: identityWorkspace,
          harness: input.ctxHarness ?? null,
          resolveAuthorSessionState,
        });
        if (seat.eligible) {
          seatSuccession = seat.succession;
        } else {
          return {
            ok: false as const,
            error:
              `acceptance must be recorded by the acceptance-rubric author ('${implementer ?? 'unknown'}'), ` +
              `not grader '${input.createdBy}' — independent graders emit ratings without acceptance` +
              acceptanceSeatRefusalHint(seat, implementer, rubric.subjectPlan ?? null),
          };
        }
      }
      const callerIsImplementer = eligibility.callerIsImplementer || seatSuccession != null;
      if (callerIsImplementer && !acceptance) {
        return {
          ok: false as const,
          error:
            "the acceptance-rubric author must record acceptance:{ verdict:'accept'|'reject', reasoning } after reading the independent grading; independent graders omit acceptance",
        };
      }
      if (callerIsImplementer && acceptance && args.supersedes) {
        return {
          ok: false as const,
          error:
            "the acceptance-rubric author's verdict is a separate newer scorecard and must not use supersedes; omit supersedes so the independent grading remains visible to the plan-acceptance gate",
        };
      }
      if (callerIsImplementer) {
        const prior = await listScorecards({ rubricRef: args.rubricRef, limit: 50 });
        let independent = undefined;
        for (const card of prior) {
          if (!card.rubricResolved || card.missingKeys.length !== 0 || card.synthesized || card.createdBy == null)
            continue;
          // Independence against the ORIGINAL author is unchanged — a seat
          // succession must never launder a related grader into an independent one.
          if (await lineageRelated(implementer, card.createdBy, { workspaceId: identityWorkspace })) continue;
          // WI-2141007: a SUCCESSOR now holds author authority, so they may not
          // accept a grading from their OWN lineage either. Without this the
          // three-party chain (author -> critic -> grader) collapses into one
          // session grading its own work and then accepting it — which is the
          // hole the lineage rule exists to close, re-opened one level along.
          if (
            seatSuccession &&
            (await lineageRelated(input.createdBy, card.createdBy, { workspaceId: identityWorkspace }))
          )
            continue;
          independent = card;
          break;
        }
        if (!independent) {
          return {
            ok: false as const,
            error:
              `acceptance must follow a complete independent grading by someone other than '${implementer}'` +
              (seatSuccession
                ? ` (and, because you inherited this seat from that dead author, by someone outside YOUR lineage too)`
                : '') +
              ` — have a non-implementer emit ratings first, then record the implementer's verdict`,
          };
        }
      }
      // EI-22177729599840121: vet-before-grade ordering was previously enforced ONLY at
      // ship time (plan-acceptance-gate.ts's acceptance_rubric_vetted_after_grading /
      // acceptance_rubric_unvetted), discovered only AFTER the independent grading pass
      // — often unrepeatable, since the independent-grader pool deliberately excludes
      // the rubric author's whole lineage — had already been spent. The violation is
      // fully determinable right here: any valid vetting attestation already on record
      // for the rubric's CURRENT revision necessarily predates the card being emitted
      // now, so "does a valid attestation exist yet" IS the order check at this moment.
      // Scoped to the plain independent-grading path (`!callerIsImplementer`, which by
      // construction above also means `!acceptance` here) — the author's own later
      // acceptance-verdict re-emit is unaffected, and the ship-time gate remains the
      // authoritative backstop for whatever this earlier check cannot see.
      if (!callerIsImplementer) {
        const vettingStatus = await getAcceptanceRubricVettingStatus(rubric, { listScorecards });
        if (vettingStatus.required && !vettingStatus.satisfied) {
          return {
            ok: false as const,
            code: 'acceptance_rubric_unvetted' as const,
            error:
              vettingStatus.reason === 'stale-attestation'
                ? `acceptance rubric '${rubric.rubricId}' was vetted at revision ` +
                  `${vettingStatus.attestedRevisions.join('/') || '(unrecorded)'}, but the rubric is now at ` +
                  `revision ${vettingStatus.currentRevision} — the content changed after vetting, so the ` +
                  `attestation no longer covers what you are about to grade. Re-vet the CURRENT revision first: ` +
                  `scorecards:emit { rubricRef:'${META_ACCEPTANCE_RUBRIC_ID}', ` +
                  `subject:{ kind:'rubric', ref:'${rubric.rubricId}' }, vettingConsult:'<consult conversation_id>' ` +
                  `(or vettingWorkItem:'<review WI-/EI- id>'), ratings:{ <every meta criterion> } } — THEN grade. ` +
                  `Grading now would be discovered invalid only at ship, after this pass is spent.`
                : `acceptance rubric '${rubric.rubricId}' has not been VETTED against the meta-rubric yet ` +
                  `(consult-min-max-and-rubric-vetting-2026-08-17). Grading it now would be discovered invalid ` +
                  `only at ship — AFTER your independent grading pass is spent, which the independent-grader pool's ` +
                  `own constraints can make expensive to redo. Have the rubric AUTHOR vet it first: ` +
                  `consult:get_feedback for external critique of the rubric, then scorecards:emit ` +
                  `{ rubricRef:'${META_ACCEPTANCE_RUBRIC_ID}', subject:{ kind:'rubric', ref:'${rubric.rubricId}' }, ` +
                  `vettingConsult:'<the consult conversation_id>', ratings:{ <every meta criterion, with evidence> } } ` +
                  `— THEN grade.`,
          };
        }
      }
    }
    const ratings = normalizeScorecardRatings(args.ratings as ObservationRatings, rubric);
    const observationForValidation = { rubricRef: args.rubricRef, ratings };
    // `validateScorecardCompleteness` intentionally permits an empty ratings map
    // for generic/free-text observations. scorecards:emit is different: it has
    // already resolved a rubric, so an empty map is an incomplete scorecard and
    // must fail before any deduplication or ledger write can occur.
    if (Object.keys(ratings).length === 0 && rubric.criteria.length > 0) {
      throw new ObservationEvidenceError(
        `scorecard for rubric '${args.rubricRef}' is INVALID/INCOMPLETE — missing required criterion key(s): ` +
          `${rubric.criteria.map((criterion) => criterion.key).join(', ')}. ` +
          `A rubric scorecard must rate exactly the declared criteria (rate a not-assessable one 'unknown' ` +
          'WITH evidence, never omit every criterion).',
      );
    }
    validateObservationRatings(observationForValidation);
    validateScorecardCompleteness(
      observationForValidation,
      rubric.criteria.map((criterion) => criterion.key),
    );
    validateScorecardRatingValues(observationForValidation, rubric);
    // scorecard-poor-rating-disposition (owner-directed 2026-08-31): a poor rating
    // on a standard rubric must carry `remediation` (WI-/EI-/F- ref) or an explicit
    // `disregard` — the agent-facing emit door enforces what the schema teaches.
    validateScorecardPoorRatingDisposition(observationForValidation, rubric);
    // WI-2141007: the acceptance record as PERSISTED — the caller's verdict plus,
    // when the seat was inherited from a dead author, the server-stamped audited
    // succession. Computed once so the two persistence sites below cannot drift
    // apart. Deliberately NOT used for `evidenceFingerprint` above: the seat
    // carries a `succeededAt` timestamp, and folding a clock into the dedup
    // fingerprint would make every re-emit look like new content.
    const acceptanceRecord: ScorecardAcceptance | undefined = acceptance
      ? seatSuccession
        ? { ...acceptance, seat: seatSuccession }
        : acceptance
      : undefined;
    const instrumentSnapshots = args.instrumentSnapshots as Record<string, ScorecardInstrumentSnapshot> | undefined;
    const instrumentContract = evaluateScorecardInstrumentContract({
      rubric,
      ratings,
      instrumentSnapshots,
    });
    if (rubric.releaseGating && !instrumentContract.valid) {
      return {
        ok: false as const,
        error:
          `release-gating instrument contract invalid for '${args.rubricRef}' — ` +
          'inspect instrumentContract for missing/stale/window/verdict mismatches',
        instrumentContract,
      };
    }
    const releaseGateBinding =
      rubric.releaseGating && scorecardRatingsClaimPass(ratings)
        ? await resolveScorecardReleaseGateBinding(args.testedSha, {
            ...(deps.releaseGateSnapshot ? { snapshot: deps.releaseGateSnapshot } : {}),
          })
        : undefined;
    if (releaseGateBinding?.status === 'stale-pass-blocked') {
      return {
        ok: false as const,
        code: 'stale_pass_blocked' as const,
        error:
          `release-gating pass blocked for '${args.rubricRef}' — ${releaseGateBinding.reason}. ` +
          'Re-run the drill at the current staging commit after that same commit has a fresh green gate verdict, then pass testedSha.',
        releaseGateBinding,
        canonicalRatings: ratings,
      };
    }
    const boundTestedSha =
      releaseGateBinding?.status === 'bound' ? (releaseGateBinding.testedSha ?? undefined) : undefined;
    const evidenceFingerprint = scorecardEvidenceFingerprint({
      rubricRef: args.rubricRef,
      ratings,
      instrumentSnapshots,
      ...(acceptance ? { acceptance } : {}),
      ...(args.rerunRecipe ? { rerunRecipe: args.rerunRecipe as SpecTestAdequacyRerunRecipe } : {}),
      ...(boundTestedSha ? { testedSha: boundTestedSha } : {}),
    });
    // ── the vetting stamp (consult-min-max-and-rubric-vetting-2026-08-17 P-004) ──
    // A vetting scorecard (meta-rubric grading of an acceptance rubric) links the
    // get_feedback consult that critiqued the rubric and pins the rubric's plan-row
    // version, so the acceptance gate can tell whether the attestation still covers
    // the CURRENT revision. Both halves are validated to EXIST before anything is
    // stamped — the gate trusts the stamp rather than re-querying, so a dangling
    // link here would be a booby trap (same posture as the acceptance-kind link
    // guards in proposeRubric).
    let vetting: ScorecardVetting | undefined;
    let vettedSubjectPlan: string | null = null;
    // WI-41477: two alternate recording channels, one predicate. The consult channel
    // is the router-assigned get_feedback flow; the work-item channel is where a
    // LAUNCHED independent reviewer's critique actually lands (D-049 — consult
    // participants are router-assigned, so a reviewer launched to certify a specific
    // artifact can never post into a consult thread). Exactly one may be passed.
    if (args.vettingConsult && args.vettingWorkItem) {
      return {
        ok: false as const,
        error:
          'pass EXACTLY ONE of vettingConsult / vettingWorkItem — they are alternate recording channels for the ' +
          'same attestation, and a card stamped from both would be unreadable as evidence',
      };
    }
    if (args.vettingWorkItem && args.vettingUnanswered) {
      return {
        ok: false as const,
        error:
          'vettingUnanswered is consult-only — it waives a consult nobody answered. A work-item with no ' +
          'third-party comment is not attestable evidence; route a consult (vettingConsult) and waive THAT if no ' +
          'reviewer can be had',
      };
    }
    if (args.vettingUnanswered && !args.vettingConsult) {
      return {
        ok: false as const,
        error:
          'vettingUnanswered requires vettingConsult — the waiver attests that a SPECIFIC consult received no critique, ' +
          'and the acceptance gate can recognize it only when observation.vetting carries that consultId. Keep ' +
          'vettingConsult in the call alongside vettingUnanswered + vettingUnansweredReason.',
      };
    }
    if (args.vettingConsult || args.vettingWorkItem) {
      const subjectRef = args.subject?.ref;
      if (!subjectRef) {
        return {
          ok: false as const,
          error:
            "vetting linkage requires `subject` naming the vetted rubric — pass subject:{ kind:'rubric', ref:'<the acceptance rubricId>' }",
        };
      }
      if (args.subject?.kind !== 'rubric') {
        return {
          ok: false as const,
          error:
            `vetting linkage is only valid on the META-RUBRIC scorecard that grades a rubric — ` +
            `pass subject:{ kind:'rubric', ref:'<the acceptance rubricId>' }. ` +
            `For the later ${args.subject?.kind ?? 'untyped'}-subject acceptance card, omit ` +
            `vettingConsult/vettingWorkItem and cite the separately emitted meta-rubric scorecard instead`,
        };
      }
      const vettedRubric = await getRubric(subjectRef);
      if (!vettedRubric) {
        return {
          ok: false as const,
          error: `vetting subject '${subjectRef}' does not resolve to a rubric — the vetting stamp would be a dangling link`,
        };
      }
      if (
        vettedRubric.kind === 'acceptance' &&
        vettedRubric.subjectPlan &&
        vettedRubric.barContract?.adoptionEpoch != null
      ) {
        // P-003: vetting is the first phase that requires the as-built METHOD
        // and its runnable/manual check. Reuse the same snapshot rather than
        // inspecting the submitted meta-scorecard in isolation.
        const lifecycle = await readAndEvaluateAcceptanceBarLifecycle(vettedRubric.subjectPlan, 'pre-vetting');
        if (!lifecycle.satisfied) {
          return {
            ok: false as const,
            code: 'acceptance_bar_contract_not_ready' as const,
            error: lifecycle.message ?? 'acceptance BAR contract is not ready for vetting',
            lifecycle,
          };
        }
      }
      vettedSubjectPlan = vettedRubric.subjectPlan ?? null;
      if (args.vettingWorkItem) {
        // Mirror of the consult predicate below, clause for clause: the consult path
        // excludes the emitter and the consult REQUESTER; here the analogous
        // self-review parties are the emitter and the vetted rubric's author (the
        // vetting requester in the launched-reviewer flow).
        const critique = await readVettingWorkItemCritique(args.vettingWorkItem, [
          input.createdBy,
          vettedRubric.createdBy,
          vettedRubric.proposedBy,
        ]);
        if (!critique.exists) {
          return {
            ok: false as const,
            error:
              `vetting work-item '${args.vettingWorkItem}' not found — the vetting stamp would be a dangling link. ` +
              `Pass the WI-/EI- id of the review work-item whose comments carry the critique of rubric '${subjectRef}'`,
          };
        }
        if (critique.critiquePosts === 0) {
          return {
            ok: false as const,
            error:
              `vetting work-item '${args.vettingWorkItem}' carries NO third-party critique: comments by the emitter ` +
              `or the vetted rubric's author do not count — independent review means someone ELSE engaged with ` +
              `rubric '${subjectRef}'. A vetting attestation over an un-critiqued work-item would make the ` +
              `acceptance gate vacuously green. If no reviewer can be had at all, use the consult channel ` +
              `(vettingConsult + vettingUnanswered) so the waiver is recorded visibly`,
          };
        }
        const rubricRevision = await getRubricPlanRevision(subjectRef);
        const criteriaHash = await getRubricCriteriaHash(subjectRef);
        vetting = {
          workItemId: args.vettingWorkItem,
          ...(rubricRevision != null ? { rubricRevision } : {}),
          ...(criteriaHash != null ? { criteriaHash } : {}),
          critiquePosts: critique.critiquePosts,
          ...(critique.critics.length > 0 ? { critics: critique.critics } : {}),
        };
      }
    }
    if (args.vettingConsult) {
      const subjectRef = args.subject!.ref;
      const critique = await readVettingConsultCritique(
        getOrgPg().sql,
        activeWorkspaceId(),
        args.vettingConsult,
        input.createdBy,
        [subjectRef, vettedSubjectPlan].filter((ref): ref is string => typeof ref === 'string' && ref.length > 0),
      );
      if (!critique.exists) {
        return {
          ok: false as const,
          error:
            `vetting consult '${args.vettingConsult}' not found in consult_state — open the critique consult first ` +
            `(consult:get_feedback about rubric '${subjectRef}') and pass its conversation_id`,
        };
      }
      // EI-20821478338037350: the gate's purpose is EXTERNAL CRITIQUE, so the
      // predicate has to be "someone critiqued it", not "a consult row exists".
      // The two failure modes are reported apart because their remedies differ:
      // silence means wait or re-route; a decline means the reviewer already
      // told you they cannot help, so waiting is pointless.
      const waived = args.vettingUnanswered === true;
      if (critique.critiquePosts === 0 && !waived) {
        const because =
          critique.declinePosts > 0
            ? `every routed reviewer DECLINED (${critique.declinePosts} decline post(s)) — waiting will not produce critique, so re-route the consult`
            : `nobody has replied yet (consult state '${critique.state ?? 'unknown'}') — wait for critique or re-route the consult`;
        return {
          ok: false as const,
          error:
            `vetting consult '${args.vettingConsult}' exists but carries NO critique: ${because}. ` +
            `A vetting attestation over an un-critiqued consult would make the acceptance gate vacuously green. ` +
            `If no reviewer can be had at all, say so explicitly: vettingUnanswered:true + vettingUnansweredReason:'<what you observed>'.`,
        };
      }
      if (waived && critique.critiquePosts > 0) {
        return {
          ok: false as const,
          error:
            `vettingUnanswered was passed, but consult '${args.vettingConsult}' DID receive critique ` +
            `(${critique.critiquePosts} post(s) from ${critique.critics.join(', ')}) — read the critique, improve the ` +
            `rubric from it, and re-emit without the waiver`,
        };
      }
      if (waived && !args.vettingUnansweredReason) {
        return {
          ok: false as const,
          error:
            'vettingUnanswered requires vettingUnansweredReason — an unexplained no-critique waiver is exactly the ' +
            'silent pass this gate exists to prevent',
        };
      }
      if (!waived && critique.critiquePosts > 0 && critique.relevance?.matched !== true) {
        return {
          ok: false as const,
          error:
            `vetting_consult_unrelated: consult '${args.vettingConsult}' carries third-party posts, but its durable ` +
            `opening question does not mention vetted rubric '${subjectRef}'` +
            (vettedSubjectPlan ? ` or subject plan '${vettedSubjectPlan}'` : '') +
            `. Open a rubric-specific consult and cite that conversation_id; an arbitrary answered consult cannot ` +
            `evidence this rubric's vetting.`,
        };
      }
      const rubricRevision = await getRubricPlanRevision(subjectRef);
      const criteriaHash = await getRubricCriteriaHash(subjectRef);
      vetting = {
        consultId: args.vettingConsult,
        ...(rubricRevision != null ? { rubricRevision } : {}),
        ...(criteriaHash != null ? { criteriaHash } : {}),
        critiquePosts: critique.critiquePosts,
        ...(critique.critics.length > 0 ? { critics: critique.critics } : {}),
        ...(waived ? { unanswered: true as const, unansweredReason: args.vettingUnansweredReason } : {}),
      };
    }
    // D-031 fallback advisory: when the vetting channel's recorded critics all
    // resolve to ONE party, that party cannot later supply the independent
    // acceptance grade because grader_is_sole_vetting_critic must refuse the
    // two-party chain. Surface the sequencing consequence now, without weakening
    // the later refusal or changing the durable vetting stamp.
    //
    // EI-21974075442192005: this advisory now derives from the SAME predicate as
    // the refusal it predicts (`collapseCriticsToSoleParty`). It previously read
    // `critics.length === 1` — the exact test WI-905074 had already widened on
    // the REFUSAL side — so a vetting record naming two critics of one lineage
    // was refused at grading time having never been warned at attestation time.
    // An advisory narrower than the rail it speaks for is worse than none: its
    // silence reads as clearance.
    const advisoryCritics = vetting?.critics ?? [];
    // EI-22182364716054326: this attestation is ONE channel's critique — a second
    // independent critic may already be recorded on the OTHER channel (a prior
    // vettingWorkItem card when this one is vettingConsult, or vice versa).
    // resolveAggregatedVettingCritics reads only PERSISTED cards, so it cannot
    // see the one this very call is about to write; union it in here so the
    // advisory predicts what resolveAcceptanceGraderEligibility will compute
    // once this card lands, instead of judging this channel in isolation.
    let unionedAdvisoryCritics = advisoryCritics;
    if (advisoryCritics.length > 0 && args.subject?.ref) {
      const { critics: otherChannelCritics } = await resolveAggregatedVettingCritics(
        args.subject.ref,
        vetting?.rubricRevision ?? null,
      );
      const seen = new Set(advisoryCritics);
      unionedAdvisoryCritics = [...advisoryCritics, ...otherChannelCritics.filter((c) => !seen.has(c))];
    }
    const soleVettingParty =
      unionedAdvisoryCritics.length > 0
        ? await collapseCriticsToSoleParty(unionedAdvisoryCritics, {
            workspaceId: input.workspaceId || activeWorkspaceId(),
            lineageRelated: deps.lineageRelated ?? areAcceptanceLineageRelated,
          })
        : null;
    const vettingWarning =
      soleVettingParty != null
        ? `vetting for acceptance rubric '${args.subject?.ref ?? 'unknown'}' records ` +
          (unionedAdvisoryCritics.length === 1
            ? `a sole critic '${soleVettingParty}'`
            : `${unionedAdvisoryCritics.length} vetting critics who all resolve to one party ('${soleVettingParty}')`) +
          `. That party cannot later emit the independent acceptance grade; the sole-vetting-critic rail will refuse it. ` +
          `Use another lineage-independent grader or obtain a second independent critic before grading.`
        : undefined;
    // P-008 (EI-20581177540737568): a 'violatable' criterion is monotonic-downward — one
    // violation falsifies it permanently — so a mid-run rating of one cannot be final.
    // DEFAULT IS PROVISIONAL: the emitter must AFFIRM subject termination (terminal:true)
    // to file a final card. Forgetting the flag yields a card that doesn't count toward
    // the trend, never a false final (WI-39348's exemplary went stale 28 minutes after
    // an honest interim grade; the burden now sits on the safe side by construction).
    const violatableRatedKeys = rubric.criteria
      .filter((c) => c.criterionClass === 'violatable' && ratings[c.key] !== undefined)
      .map((c) => c.key);
    const provisional =
      !args.terminal && violatableRatedKeys.length > 0
        ? { violatableKeys: violatableRatedKeys, stampedAt: new Date().toISOString() }
        : undefined;
    // ── P-013 (D-004): grade-the-grader ──
    // AUDIT PATH — this emit IS a grading audit (rubricRef = the meta-rubric).
    // Validated BEFORE filing: an audit card filed and then unable to settle its
    // subject would strand both halves. Mirrors the acceptance grader ≠ author rule.
    let auditContext: { subjectIssueId: string; auditor: string } | null = null;
    if (args.rubricRef === GRADING_INTEGRITY_RUBRIC_REF) {
      if (args.subject?.kind !== 'scorecard' || !args.subject.ref) {
        return {
          ok: false as const,
          error:
            "grading-integrity audits a SCORECARD — pass subject:{ kind:'scorecard', ref:'<the graded card's issue id>' } (D-004: terminal cards only, one level deep)",
        };
      }
      const graded = await getIssue(args.subject.ref);
      const gradedObservation =
        graded?.payload && typeof graded.payload === 'object' && !Array.isArray(graded.payload)
          ? asStructuredObservation((graded.payload as { observation?: unknown }).observation)
          : undefined;
      if (!gradedObservation?.rubricRef || !gradedObservation.ratings) {
        return { ok: false as const, error: `audit subject '${args.subject.ref}' is not a scorecard` };
      }
      if (!gradedObservation.gradingAudit) {
        return {
          ok: false as const,
          error: `audit subject '${args.subject.ref}' carries no gradingAudit stamp — only terminal standard-rubric cards emitted under the audit gate are auditable`,
        };
      }
      if (gradedObservation.gradingAudit.state !== 'pending') {
        return {
          ok: false as const,
          error: `audit subject '${args.subject.ref}' is already audited (${gradedObservation.gradingAudit.state}) — supersede the AUDIT card instead of re-auditing (D-004: one level, no regress)`,
        };
      }
      const gradedAuthor = graded?.createdBy ?? null;
      // Unattributable identity on EITHER side refuses — strict toward auditing again.
      if (!gradedAuthor || !input.createdBy || gradedAuthor === input.createdBy) {
        return {
          ok: false as const,
          error: `self_audit_refused: a grading audit must come from a NON-AUTHOR (graded card author: ${gradedAuthor ?? 'unknown'}, auditor: ${input.createdBy ?? 'unknown'}) — mirror of the acceptance grader ≠ author rule`,
        };
      }
      auditContext = { subjectIssueId: args.subject.ref, auditor: input.createdBy };
    }
    // PENDING STAMP — a terminal standard-rubric card is final but UNAUDITED until a
    // non-author audit settles it (never the audit card itself: one level).
    let gradingAudit: ScorecardGradingAudit | undefined;
    if (
      needsGradingAudit({
        rubricKind: rubric.kind,
        rubricRef: args.rubricRef,
        provisional: provisional !== undefined,
      }) &&
      (await gradingAuditGateEnabled())
    ) {
      gradingAudit = {
        state: 'pending',
        metaRubricRef: GRADING_INTEGRITY_RUBRIC_REF,
        stampedAt: new Date().toISOString(),
      };
    }
    let sourceHive = args.sourceHive ?? input.ctxHarness;
    // P-013: a pending subject card is waiting for a GRADING-INTEGRITY audit,
    // not another ordinary scorecard against the same rubric. Without this
    // boundary a non-author auditor can accidentally file a second peer card
    // that looks successful while leaving the original card pending until the
    // far-end completion gate notices. Refuse the ambiguous form before any
    // scorecard write and teach the only form that settles the pending stamp.
    if (args.subject) {
      const pendingSubject = (
        await listScorecards({
          rubricRef: args.rubricRef,
          subjectRef: args.subject.ref,
          limit: 100,
        })
      ).find(
        (card) =>
          card.gradingAudit?.state === 'pending' &&
          card.subject?.ref === args.subject?.ref &&
          (card.subject?.kind ?? null) === (args.subject?.kind ?? null) &&
          card.createdBy != null &&
          card.createdBy !== input.createdBy,
      );
      if (pendingSubject) {
        return {
          ok: false as const,
          code: 'grading_audit_required' as const,
          error:
            `scorecard '${pendingSubject.issueId}' for rubric '${args.rubricRef}' has a pending grading audit — ` +
            "emit the audit as { rubricRef:'grading-integrity', ratings, terminal:true, " +
            `subject:{ kind:'scorecard', ref:'${pendingSubject.issueId}' } } instead of filing another ` +
            'same-rubric peer scorecard',
        };
      }
    }
    if (args.supersedes) {
      const superseded = await getIssue(args.supersedes);
      const raw =
        superseded?.payload && typeof superseded.payload === 'object' && !Array.isArray(superseded.payload)
          ? (superseded.payload as { observation?: unknown }).observation
          : undefined;
      const prior = asStructuredObservation(raw);
      if (!prior?.rubricRef || !prior.ratings) {
        return { ok: false as const, error: `superseded scorecard '${args.supersedes}' not found` };
      }
      if (prior.rubricRef !== args.rubricRef) {
        return {
          ok: false as const,
          error: `superseded scorecard '${args.supersedes}' grades '${prior.rubricRef}', not '${args.rubricRef}'`,
        };
      }
      // EI-21574072776977281: a correction belongs to the scorecard lineage it
      // replaces, not whichever Hive happens to host the correcting session.
      // When the caller omits sourceHive, inherit the prior card's canonical
      // value — including undefined for pre-sourceHive legacy rows. This keeps a
      // workspace-scoped caller able to correct a Hive-bound card and a
      // Hive-scoped caller able to finalize a legacy unscoped card without
      // opening an unscoped transport just to reproduce the old partition.
      if (args.sourceHive === undefined) sourceHive = prior.sourceHive;
      if ((prior.sourceHive ?? undefined) !== (sourceHive ?? undefined)) {
        // WI-2141737: say which of the two facts this is, and name the form that
        // settles it. An ABSENT stored sourceHive (a card filed before the stamp
        // existed) is not the same fact as an empty one, but rendering it as ''
        // made it read as a value the caller could pass — and `sourceHive` is
        // declared min(1), so no caller can pass ''. Read together, those two
        // signals say "this card can never be superseded", which is false: the
        // inherit-on-omit branch directly above finalizes exactly these cards.
        // The reporter of WI-2141737 lost an investigation to that reading and
        // shipped a card whose supersede edge is still unwritten, so the refusal
        // owes the caller the satisfiable form rather than only the mismatch.
        const priorLabel =
          prior.sourceHive === undefined
            ? 'no sourceHive at all (filed before the sourceHive stamp existed)'
            : `sourceHive '${prior.sourceHive}'`;
        return {
          ok: false as const,
          error:
            `superseded scorecard '${args.supersedes}' belongs to ${priorLabel}, not '${sourceHive ?? ''}' — ` +
            "omit sourceHive to inherit the superseded card's own value instead of this session's hive",
        };
      }
    }
    // EI-22001573837456548: scorecard history is append-only and independent
    // graders cannot retract a redundant card. Read a bounded, complete-enough
    if (!args.acceptance && !args.acknowledgeExisting) {
      // This is intentionally a broader read than the source-hive-scoped latest
      // read below: the redundancy tuple is (rubricRef, rubricRevision), not
      // (rubricRef, sourceHive, rubricRevision). `force` intentionally does not
      // bypass this guard; it only means "the evidence changed despite the latest
      // fingerprint".
      const priorScorecards = await listScorecards({ rubricRef: args.rubricRef, limit: 500 });
      const existingIndependentScorecardIds = priorScorecards
        .filter(
          (card) =>
            card.rubricRef === args.rubricRef &&
            (card.rubricRevision ?? null) === (rubricRevision ?? null) &&
            card.rubricResolved &&
            card.missingKeys.length === 0 &&
            (card.extraKeys?.length ?? 0) === 0 &&
            !card.synthesized &&
            card.createdBy != null &&
            card.createdBy !== input.createdBy &&
            !card.acceptance,
        )
        .map((card) => card.issueId);
      if (existingIndependentScorecardIds.length > 0) {
        const revisionLabel = rubricRevision == null ? 'unversioned' : String(rubricRevision);
        return {
          ok: false as const,
          code: 'existing_independent_scorecards' as const,
          error:
            `complete independent scorecard(s) already exist for rubric '${args.rubricRef}' revision ${revisionLabel}: ` +
            `${existingIndependentScorecardIds.join(', ')} — re-run with acknowledgeExisting:true to append another; ` +
            'force:true only bypasses unchanged-evidence deduplication and does not acknowledge existing cards',
          existingIndependentScorecardIds,
          acknowledgementRequired: 'acknowledgeExisting:true' as const,
        };
      }
    }
    // Preserve the existing source-hive partition for unchanged-evidence dedup.
    // The broad population read above is only for the cross-hive redundancy guard.
    const latest = (await listScorecards({ rubricRef: args.rubricRef, sourceHive, limit: 1 }))[0];
    const latestFingerprint = latest
      ? (latest.evidenceFingerprint ??
        scorecardEvidenceFingerprint({
          rubricRef: latest.rubricRef,
          ratings: latest.ratings,
          ...(latest.acceptance ? { acceptance: latest.acceptance } : {}),
          ...(latest.rerunRecipe ? { rerunRecipe: latest.rerunRecipe } : {}),
          ...(latest.testedSha ? { testedSha: latest.testedSha } : {}),
        }))
      : null;
    const sameCorrectionAlreadyExists = args.supersedes && latest?.supersedes === args.supersedes;
    // P-008: a terminal re-emit of IDENTICAL ratings is the finalization step, not a
    // duplicate — the fingerprint (rubricRef+ratings+snapshots, unchanged for
    // compatibility with stored rows) cannot see finality, so compare it separately.
    const finalityChanged = latest !== undefined && (latest.provisional !== undefined) !== (provisional !== undefined);
    // P-004: a re-emit that only moves the vetting stamp — a new consult, or the same
    // consult re-attested against a NEW rubric revision after the author improved the
    // rubric — is the re-vetting step, not a duplicate. The fingerprint cannot see it
    // (rubricRef + ratings + snapshots only, unchanged for stored-row compatibility),
    // so compare the stamps separately, like finality above.
    // EI-20821478338037350: the waiver→critiqued upgrade is the same kind of move.
    // An author who honestly attested `unanswered` and LATER receives critique must be
    // able to re-emit the real stamp over the waived one; without this the fingerprint
    // (identical rubricRef + ratings + consult + revision) declines it as unchanged and
    // the recorded waiver is stuck on the card forever.
    const vettingChanged =
      (latest?.vetting?.consultId ?? null) !== (vetting?.consultId ?? null) ||
      // WI-41477: the work-item channel is the same kind of move — a re-emit that
      // switches channel or cites a different review work-item is a re-vetting step.
      (latest?.vetting?.workItemId ?? null) !== (vetting?.workItemId ?? null) ||
      (latest?.vetting?.rubricRevision ?? null) !== (vetting?.rubricRevision ?? null) ||
      (latest?.vetting?.unanswered ?? false) !== (vetting?.unanswered ?? false);
    // The rubric revision is part of the grading binding but deliberately remains
    // outside the historical evidence fingerprint. A rubric edit must therefore
    // escape unchanged-evidence deduplication and create a new auditable card.
    const rubricRevisionChanged = (latest?.rubricRevision ?? null) !== (rubricRevision ?? null);
    if (
      !args.force &&
      !finalityChanged &&
      !vettingChanged &&
      !rubricRevisionChanged &&
      latestFingerprint === evidenceFingerprint &&
      (!args.supersedes || sameCorrectionAlreadyExists)
    ) {
      const acceptanceGraderCleanup =
        rubric.kind === 'acceptance' && input.role === 'judge'
          ? await cleanupAcceptanceGraderTasks(args.rubricRef, { workspaceId: input.workspaceId })
          : undefined;
      return {
        ok: true as const,
        created: false,
        reason: 'unchanged-evidence' as const,
        evidenceFingerprint,
        previousIssueId: latest?.issueId ?? null,
        canonicalRatings: ratings,
        ...(vettingWarning ? { warning: vettingWarning } : {}),
        ...(acceptanceGraderCleanup ? { acceptanceGraderCleanup } : {}),
      };
    }

    // ── P-011 (owner-ratified D-006): deterministic criterion checks ──
    // Every RATED criterion whose rubric check is kind:'tests' has its files actually
    // RUN here, at grading time (never a stale ledger read): a path that no longer
    // resolves refuses the emit, an unjudgeable run refuses the emit, and a
    // pass-claiming rating the run contradicts refuses the emit. Placed AFTER the
    // unchanged-evidence decline above so a deduped re-emit never burns a test run,
    // and BEFORE the write so a card is only ever filed with its live check verdicts
    // stamped (observation.checkRuns). Criteria without a tests-check are untouched.
    let checkRuns: Record<string, import('../../rubrics-criterion-checks').CriterionCheckRun> | undefined;
    const testCheckedCriteria = rubric.criteria.filter((c) => c.check?.kind === 'tests');
    if (testCheckedCriteria.length > 0) {
      const evaluateChecks = deps.evaluateChecks ?? evaluateCriterionTestChecks;
      const checkRoot = await resolveDeterministicCheckRoot(args, {
        ...input,
        rubricWorkspaceId: rubric.workspaceId,
        rubricSubjectPlan: rubric.subjectPlan,
      });
      const checkEvaluation = await evaluateChecks({
        criteria: rubric.criteria,
        ratings,
        ...(checkRoot ? { root: checkRoot } : {}),
        // One shared budget for the batched run. scorecards:emit declares a longer
        // tool timeout below, so the transport gives this mutation enough time to
        // return a typed verdict (and still leaves a full minute for process-group
        // settlement, the ledger write, and response serialization).
        timeoutMs: SCORECARD_TEST_CHECK_TIMEOUT_MS,
      });
      if (!checkEvaluation.ok) {
        return {
          ok: false as const,
          error: checkEvaluation.detail,
          checkRefusal: checkEvaluation,
        };
      }
      checkRuns = Object.keys(checkEvaluation.checkRuns).length > 0 ? checkEvaluation.checkRuns : undefined;
    }

    // Typed ContinuityProbe criterion checks use the same read-only dispatcher
    // and bounded batch executor as carried checks. They run after unchanged
    // evidence deduplication and before persistence, so every filed card keeps
    // the live predicate result that justified its rating.
    const probeCheckedCriteria = rubric.criteria.filter((c) => c.check?.kind === 'probe');
    if (probeCheckedCriteria.length > 0) {
      const evaluateProbe = deps.evaluateProbeChecks ?? evaluateCriterionProbeChecks;
      const probeEvaluation = await evaluateProbe({
        criteria: rubric.criteria,
        ratings,
        dispatchTool: deps.dispatchTool,
      });
      if (!probeEvaluation.ok) {
        return {
          ok: false as const,
          error: probeEvaluation.detail,
          checkRefusal: probeEvaluation,
        };
      }
      if (Object.keys(probeEvaluation.checkRuns).length > 0) {
        checkRuns = { ...(checkRuns ?? {}), ...probeEvaluation.checkRuns };
      }
    }

    // ── P-011 (owner-ratified D-006): native Cargo criterion checks ──
    // Vitest's file router intentionally refuses Rust source paths. Cargo checks
    // use their own manifest boundary and preserve explicit source attribution in
    // the stamped native run instead of routing `.rs` files through Vitest.
    const cargoCheckedCriteria = rubric.criteria.filter((c) => c.check?.kind === 'cargo');
    if (cargoCheckedCriteria.length > 0) {
      const evaluateCargo = deps.evaluateCargoChecks ?? evaluateCriterionCargoChecks;
      const checkRoot = await resolveDeterministicCheckRoot(args, {
        ...input,
        rubricWorkspaceId: rubric.workspaceId,
        rubricSubjectPlan: rubric.subjectPlan,
      });
      const checkEvaluation = await evaluateCargo({
        criteria: rubric.criteria,
        ratings,
        ...(checkRoot ? { root: checkRoot } : {}),
        timeoutMs: SCORECARD_TEST_CHECK_TIMEOUT_MS,
      });
      if (!checkEvaluation.ok) {
        return {
          ok: false as const,
          error: checkEvaluation.detail,
          checkRefusal: checkEvaluation,
        };
      }
      if (Object.keys(checkEvaluation.checkRuns).length > 0) {
        checkRuns = { ...(checkRuns ?? {}), ...checkEvaluation.checkRuns };
      }
    }

    // ── P-006 (deterministic-coverage-census): kind:'coverage' criterion checks ──
    // The census counterpart of the block above, and it reads THE shared derivation
    // (`readCoverage`) rather than querying testing_surface_depth itself — the panel,
    // both state cells, the tool and now this gate all resolve through one function, so
    // the gate cannot disagree with the panel a human just read. A scope matching zero
    // surfaces REFUSES (a coverage gate over an empty scope is vacuously green, which is
    // precisely the defect this plan exists to make unrepresentable).
    const coverageCheckedCriteria = rubric.criteria.filter((c) => c.check?.kind === 'coverage');
    if (coverageCheckedCriteria.length > 0) {
      const evaluateCoverage = deps.evaluateCoverageChecks ?? evaluateCriterionCoverageChecks;
      // Hoisted to local consts so the narrowing survives into the closure below —
      // narrowing a property access does not carry across a function boundary.
      const subjectPlan = rubric.subjectPlan;
      const workspaceId = input.workspaceId;
      const coverageEvaluation = await evaluateCoverage({
        criteria: rubric.criteria,
        ratings,
        readCoverage: (a) => readCoverage(a),
        // planTouched resolves to the files the subject plan's COMPLETED work actually
        // changed. Only an acceptance rubric has a subject plan; anywhere else this
        // returns null and the check refuses rather than silently widening its scope.
        // The workspace is required for the SAME reason: planTouchedFiles filters on
        // `workspace_id`, so resolving it without one would widen the scope to every
        // workspace's rows — the silent-widening this check exists to refuse.
        resolvePlanTouchedFiles: () =>
          subjectPlan && workspaceId ? planTouchedFiles(workspaceId, subjectPlan) : Promise.resolve(null),
      });
      if (!coverageEvaluation.ok) {
        return {
          ok: false as const,
          error: coverageEvaluation.detail,
          checkRefusal: coverageEvaluation,
        };
      }
      if (Object.keys(coverageEvaluation.checkRuns).length > 0) {
        checkRuns = { ...(checkRuns ?? {}), ...coverageEvaluation.checkRuns };
      }
    }

    // ── P-026 (design-to-code-coverage-seam): kind:'requirements' criterion checks ──
    // The design→code counterpart of the two blocks above. It runs the SAME P-014
    // activation↔completion join that `plan-acceptance-gate` enforces as
    // `requirement_unrealized`, for a different reader: the gate answers "may the author
    // ship", this answers "which of the plan's stated promises have no observable code"
    // for the INDEPENDENT GRADER — who cannot run Bash, and therefore has no other way to
    // ask. Reusing the judge rather than re-deriving it is the point: two implementations
    // of this join could disagree, and the one the grader sees must be the one the gate
    // enforces.
    const requirementsCheckedCriteria = rubric.criteria.filter((c) => c.check?.kind === 'requirements');
    if (requirementsCheckedCriteria.length > 0) {
      const evaluateRequirements = deps.evaluateRequirementChecks ?? evaluateCriterionRequirementChecks;
      // Hoisted for the same narrowing reason as the coverage block above.
      const requirementsPlan = rubric.subjectPlan;
      const requirementsEvaluation = await evaluateRequirements({
        criteria: rubric.criteria,
        ratings,
        readRequirementRealization: async () => {
          if (!requirementsPlan) return null;
          // Read all three together. They are independent queries over the same plan, and
          // the judge's own contract treats an empty planItems list as "not supplied"
          // (never as "the plan has no items"), so a transient read failure degrades to
          // the pre-P-016 behaviour instead of convicting every target.
          const [activationAudit, itemAudits, planItems] = await Promise.all([
            getLatestActivationAudit(requirementsPlan),
            getEffectiveItemAudits(requirementsPlan),
            getPlanItemStatuses(requirementsPlan),
          ]);
          return {
            planSlug: requirementsPlan,
            mappings: activationAudit?.activation?.mappings ?? [],
            itemAudits,
            planItems,
          };
        },
      });
      if (!requirementsEvaluation.ok) {
        return {
          ok: false as const,
          error: requirementsEvaluation.detail,
          checkRefusal: requirementsEvaluation,
        };
      }
      if (Object.keys(requirementsEvaluation.checkRuns).length > 0) {
        checkRuns = { ...(checkRuns ?? {}), ...requirementsEvaluation.checkRuns };
      }
    }

    const gradedGeneration = await readRunningGeneration().catch(() => null);
    const result = await captureImprovement({
      title: args.title ?? `Scorecard: ${rubric.title}${sourceHive ? ` — ${sourceHive}` : ''}`,
      kind: 'change',
      body: args.body,
      lane: 'observation',
      // D-002 (observation-lane-scorecard-classification-2026-08-16): an emitted
      // scorecard is a COMPLETED verdict — file it terminal so it never renders as
      // an untriaged open observation. Reads are state-agnostic (scorecards:list
      // selects on payload.observation.rubricRef only), so history/trends/gates
      // are unaffected.
      initialState: 'done',
      createdBy: input.createdBy,
      filedByRole: 'su',
      payloadExtra: {
        observation: {
          rubricRef: args.rubricRef,
          ...(rubricRevision != null ? { rubricRevision } : {}),
          ...(criteriaHash != null ? { criteriaHash } : {}),
          ratings,
          ...(boundTestedSha ? { testedSha: boundTestedSha } : {}),
          ...(releaseGateBinding ? { releaseGateBinding } : {}),
          ...(acceptanceRecord ? { acceptance: acceptanceRecord } : {}),
          ...(args.rerunRecipe ? { rerunRecipe: args.rerunRecipe } : {}),
          ...(sourceHive ? { sourceHive } : {}),
          ...(args.targetHive ? { targetHive: args.targetHive } : {}),
          ...(instrumentSnapshots ? { instrumentSnapshots } : {}),
          evidenceFingerprint,
          ...(args.supersedes ? { supersedes: args.supersedes } : {}),
          ...(gradedGeneration ? { gradedGeneration } : {}),
          ...(provisional ? { provisional } : {}),
          ...(gradingAudit ? { gradingAudit } : {}),
          ...(args.subject ? { subject: args.subject } : {}),
          ...(vetting ? { vetting } : {}),
          ...(checkRuns ? { checkRuns } : {}),
        },
      },
    });
    if (result.created) {
      // Push-on-write (push-audit 2026-07-26): the Verify stage's scorecard
      // list + rubric trend + release-readiness strip all fold this filing in.
      void trackDetached(import('../../sync-sse'))
        .then((m) => {
          m.notifySyncInvalidate('scorecards.list');
          m.notifySyncInvalidate('rubrics.trend');
          m.notifySyncInvalidate('learning.releaseReadiness');
        })
        .catch(() => {});
    }
    // P-013: settle the audited card's stamp now that the audit card is filed. A
    // settlement failure is surfaced loudly, never swallowed — the auditor must know
    // the subject is still pending.
    let auditSettlement: Awaited<ReturnType<typeof recordGradingAudit>> | undefined;
    if (auditContext && result.created && result.issue?.id) {
      auditSettlement = await recordGradingAudit(auditContext.subjectIssueId, {
        auditIssueId: result.issue.id,
        auditor: auditContext.auditor,
        verdict: auditVerdictFromRatings(ratings),
      });
    }
    const acceptanceGraderCleanup =
      rubric.kind === 'acceptance' && input.role === 'judge'
        ? await cleanupAcceptanceGraderTasks(args.rubricRef, { workspaceId: input.workspaceId })
        : undefined;
    // EI-21434202765745827: fire the awaitable "this rubric was just graded" key. The
    // plan-completion contract REQUIRES a non-implementer to grade an implementer's plan,
    // so "wait for someone else's scorecard" is the designed happy path of every ship —
    // but until this emit there was no key for it, and the implementer could only re-poll
    // scorecards:list. Gated on `result.created` so only a genuinely FILED card wakes
    // anyone (a refused or re-read emit fires nothing), and fail-soft inside, so a failed
    // emit can never fail the scorecard write that already succeeded.
    if (result.created && result.issue?.id) {
      await emitScorecardEmitted(
        {
          issueId: result.issue.id,
          rubricRef: args.rubricRef,
          rubricKind: rubric.kind ?? null,
          subjectKind: args.subject?.kind ?? null,
          subjectRef: args.subject?.ref ?? null,
          createdBy: input.createdBy ?? null,
          hasAcceptance: Boolean(args.acceptance),
        },
        input.workspaceId ? { workspaceId: input.workspaceId } : {},
      );
    }
    // unified-responder-selection-critique-and-grading-2026-08-30 D-003 [owner]:
    // grading is a CASCADE of up to two graders, and grader 2 is woken holding
    // grader 1's card. Filing the card is the act that discharges a grading, so
    // it is what advances the chain — see advanceGradingCascadeOnCard for why a
    // consult reply alone is not enough, and for the two independent reasons a
    // duplicate or out-of-turn card cannot double-advance it. Same `created`
    // gate as the emit above, and the same fail-soft contract: it swallows its
    // own faults rather than failing a card that is already written.
    if (result.created && rubric.kind === 'acceptance' && input.workspaceId && input.createdBy && !args.acceptance) {
      await advanceGradingCascadeOnCard({
        workspaceId: input.workspaceId,
        rubricRef: args.rubricRef,
        graderOwnerId: input.createdBy,
        cardSummary: gradingCardDigestExcerpt(ratings),
      });
    }
    return {
      ok: true as const,
      created: result.created,
      issueId: result.issue?.id ?? null,
      evidenceFingerprint,
      // P-013: surfaced loudly — this card does not enter the trend until audited.
      // A bare boolean was NOT loud enough: it says THAT the card is pending but not what
      // settles it, so callers rediscovered the mechanism a gate-refusal later
      // (EI-22068670622018218: emitted the exact terminal cards, read `gradingAuditPending`
      // as incidental, then read plans:start's refusal as the cards being missing) or by
      // hand-tracing the audit contract. The next step ships WITH the stamp that creates it.
      ...(gradingAudit
        ? {
            gradingAuditPending: true,
            gradingAuditNextStep:
              'This card does not satisfy a gate until a NON-AUTHOR audits it. A DIFFERENT agent must emit ' +
              `{ rubricRef:'${GRADING_INTEGRITY_RUBRIC_REF}', terminal:true, subject:{ kind:'scorecard', ` +
              `ref:'${result.issue?.id ?? '<this card id>'}' }, ratings:{...} }. Self-audits are refused, and ` +
              're-emitting this card yourself files a duplicate pending card instead of settling this one.',
          }
        : {}),
      ...(auditSettlement
        ? {
            gradingAuditRecorded: auditSettlement.ok,
            ...(auditSettlement.gradingAudit ? { gradingAudit: auditSettlement.gradingAudit } : {}),
            ...(auditSettlement.error ? { gradingAuditError: auditSettlement.error } : {}),
          }
        : {}),
      ...(args.supersedes ? { supersedes: args.supersedes } : {}),
      canonicalRatings: ratings,
      ...(releaseGateBinding ? { releaseGateBinding } : {}),
      ...(acceptanceRecord ? { acceptance: acceptanceRecord } : {}),
      // P-008: surfaced loudly so the emitter knows this card is a working note — a
      // terminal re-emit (terminal:true, supersedes this issueId) finalizes it.
      ...(provisional ? { provisional } : {}),
      // P-011: the live deterministic check verdicts this card was filed with.
      ...(checkRuns ? { checkRuns } : {}),
      ...(vettingWarning ? { warning: vettingWarning } : {}),
      ...(acceptanceGraderCleanup ? { acceptanceGraderCleanup } : {}),
    };
  } catch (error) {
    if (error instanceof ObservationEvidenceError) return { ok: false as const, error: error.message };
    throw error;
  }
}

export default defineTool({
  name: 'scorecards:emit',
  profile: 'engineer',
  // P-011 prompt-weight: `description` + when/notWhen/chaining are counted; `returns` and
  // `seeAlso` are FREE. This tool had no `returns` at all, so its response and refusal
  // semantics (the acknowledgeExisting/force dedup rules, the generation + instrument
  // stamping, the existing_independent_scorecards retry) were being paid for in counted
  // prose. Moved verbatim below — nothing deleted (EI-22083648545226771).
  description:
    "Validate, canonicalize, and file one COMPLETE rubric scorecard through the existing observation ledger. Requires evidence for every declared criterion. For kind:'acceptance', a non-implementer emits ratings first; the rubric author then emits a separate newer card with acceptance:{verdict,reasoning} and no supersedes, so the independent grading remains visible to the plan-acceptance gate. Every emit, including the author acceptance call, still requires schema-complete ratings; acceptance does not replace ratings.",
  guidance: {
    when: 'Filing a GRADE-mode or release-readiness scorecard. Prefer this typed surface over hand-assembling improvements:capture observation payloads.',
    notWhen:
      'Building the grading skeleton or previewing a delta — scorecards:evaluate. Free-text observations — improvements:capture.',
    returns:
      'Returns { ok, created, issueId, evidenceFingerprint, canonicalRatings }. A positive releaseGating card also returns and stores `releaseGateBinding`; a failed binding returns code `stale_pass_blocked` with status `stale-pass-blocked`, the gate reason/failing tests, tested vs green/head SHAs, and `commitsBehindHead`, and writes no card. A terminal standard-rubric card also carries `gradingAuditPending: true` alongside `gradingAuditNextStep`, which names the NON-AUTHOR grading-integrity emit that settles it — self-audits are refused, and re-emitting the card yourself files a duplicate pending card instead of settling this one. `provisional` marks a working note that a terminal re-emit (terminal:true, supersedes this issueId) finalizes. REFUSALS: when complete independent scorecards already exist for the same rubric revision, emit returns existing_independent_scorecards — inspect its ids and retry with acknowledgeExisting:true when another independent sample is intentional; force:true only bypasses unchanged-evidence deduplication. Stamps the running generation and stores deterministic instrument snapshots.',
    chaining:
      'scorecards:evaluate { rubricRef } → grade every returned criterion → scorecards:evaluate { rubricRef, ratings, instrumentSnapshots, testedSha } → scorecards:emit with that same canonical payload → scorecards:list / rubrics:trend. `testedSha` is required when a releaseGating rubric has a pass-like rating. For acceptance rubrics, the non-implementer grading and the author acceptance are separate cards; the author acceptance still supplies schema-complete ratings; do not pass supersedes on the author acceptance.',
    seeAlso: ['scorecards:evaluate', 'scorecards:list', 'rubrics:trend'],
  },
  capability: 'coord:write',
  requirePrincipal: false,
  // P-011 (D-006): grading a rubric with tests-checks shells a real Vitest run and can
  // block for tens of seconds without ever reading `ctx.tx` — holding the ambient
  // workspace transaction across that wait would trip idle_in_transaction_session_timeout
  // (60s), surfacing as a bare `write CONNECTION_CLOSED`. Same declaration as
  // testing:run, for the same reason; every DB access here manages its own connection.
  skipWorkspaceTx: true,
  // EI-20965113106044588: the deterministic gate can legitimately exceed the flat
  // 55s MCP deadline. Declaring the real tool budget makes effectiveMcpDeadlineMs
  // extend the transport race instead of returning request_timeout while the
  // mutation is still running server-side.
  timeoutSec: SCORECARD_EMIT_TIMEOUT_SEC,
  agentRoles: [...COORD_ROLES, 'judge'],
  args: scorecardEmitArgs,
  // The `returns` prose above INTERPRETS this result; the structural shape comes from
  // here (guidance-output-schema-live-guard). `ok` is a BOOLEAN, not a literal true:
  // the ObservationEvidenceError path returns `{ ok:false, error }`. Everything past
  // the five promised fields is conditional — gradingAudit*, acceptance, provisional,
  // supersedes, checkRuns, warning, acceptanceGraderCleanup are all spread in only when
  // they apply — so the object stays OPEN rather than enumerating a shape the handler
  // does not always produce.
  result: z
    .object({
      ok: z.boolean(),
      created: z.boolean().optional(),
      issueId: z.string().nullable().optional(),
      evidenceFingerprint: z.string().optional(),
      canonicalRatings: z.record(z.string(), z.unknown()).optional(),
      error: z.string().optional(),
    })
    .passthrough(),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    const ctxHarness =
      typeof ctx.harnessSlug === 'string' && ctx.harnessSlug && ctx.harnessSlug !== '*' ? ctx.harnessSlug : undefined;
    return {
      data: await emitScorecard(
        args,
        {
          createdBy: identity.ownerId,
          ctxHarness,
          role: ctx.role,
          workspaceId: identity.workspaceId ?? undefined,
          // P-011: tests-checks resolve + run against the tree the AGENT edits.
          checkRoot: resolveAgentWorkspaceRoot(ctx),
        },
        { dispatchTool: ctx.dispatchTool },
      ),
    };
  },
});
