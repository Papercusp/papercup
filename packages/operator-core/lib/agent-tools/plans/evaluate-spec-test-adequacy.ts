/** plans:evaluate-spec-test-adequacy — compile exact clause/evidence rows into scorecard drafts. */
import { z } from 'zod';
import { refineEvenWithShapeIssues } from '../_refine-with-shape-issues';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import { resolveEffectiveHarnessSlug } from './_ctx-opts';
import { getAcceptanceRubricsForPlan, getRetiredAcceptanceRubricsForPlan } from '../../rubrics';
import { listSpecClauses } from './spec-clauses-store';
import {
  evidenceCurrentInputKey,
  listSpecEvidence,
  readCurrentOperationalArtifactDisclosures,
  evidenceCurrentInputSchema,
  type EvidenceCurrentInput,
} from './spec-evidence-store';
import { resolvePersistedClassRef } from './plan-spec-quality-gate';
import {
  evaluateSpecTestAdequacy,
  latestLogicalEvidence,
  PLAN_CLASS_RUBRIC_REFS,
  type PlanClassRubricRef,
} from './spec-test-adequacy';
import { resolveSourceBarTestRequirements, type SourceBarRubricCache } from './source-bar-test-requirements';
import { getBuildInfo, type BuildInfo } from '../../build-info';
import { fullBodyRef, isFullDetail, reviewReadDetailArg } from '../_review-read-detail';
import { getWorkItem } from '../../work-items';
import { resolveWorkItemBehaviorContract } from './behavior-contract-resolver';
import { ADHOC_WORK_ITEM_SPEC_SCOPE } from './adhoc-spec-scope';

type MeasurementEvidenceSummary = {
  status: 'none' | 'measured' | 'partial' | 'unmeasured' | 'degraded';
  selectedBindings: number;
  measuredBindings: number;
  unavailableBindings: Array<{ id: number; evidenceKind: string; evidenceRef: string; reason: string }>;
  withoutMeasurementBasis: Array<{ id: number; evidenceKind: string; evidenceRef: string }>;
};

type EvaluatedRow = ReturnType<typeof evaluateSpecTestAdequacy> & {
  measurementEvidence: MeasurementEvidenceSummary;
};

function summarizeMeasurementEvidence(
  evidence: Awaited<ReturnType<typeof listSpecEvidence>>,
): MeasurementEvidenceSummary {
  const unavailableBindings = evidence.flatMap((row) =>
    row.serverMeasurement?.status === 'unavailable'
      ? [{
          id: row.id,
          evidenceKind: row.evidenceKind,
          evidenceRef: row.evidenceRef,
          reason: row.serverMeasurement.reason,
        }]
      : [],
  );
  const withoutMeasurementBasis = evidence.flatMap((row) =>
    row.serverMeasurement === undefined
      ? [{ id: row.id, evidenceKind: row.evidenceKind, evidenceRef: row.evidenceRef }]
      : [],
  );
  const measuredBindings = evidence.filter((row) => row.serverMeasurement?.status === 'measured').length;
  const status: MeasurementEvidenceSummary['status'] = evidence.length === 0
    ? 'none'
    : unavailableBindings.length > 0
      ? 'degraded'
      : withoutMeasurementBasis.length === evidence.length
        ? 'unmeasured'
        : withoutMeasurementBasis.length > 0
          ? 'partial'
          : 'measured';
  return {
    status,
    selectedBindings: evidence.length,
    measuredBindings,
    unavailableBindings,
    withoutMeasurementBasis,
  };
}
const PASS_LIKE = new Set(['pass', 'not-applicable']);
const COMPACT_FAILURE_EVIDENCE_CHARS = 1200;
const COMPACT_FAILURE_BINDINGS_CHARS = 300;

function compactFailureEvidence(evidence: string): { evidence: string; truncated: boolean } {
  if (evidence.length <= COMPACT_FAILURE_EVIDENCE_CHARS) return { evidence, truncated: false };

  // Correct-layer evidence can contain several successful sub-checks before a later
  // required-plane failure. Keeping only the prefix made a compact replay say "pass"
  // while its rating was fail. Keep both ends of the diagnostic statement and the
  // start of the binding list (whose descriptions lead with immutable binding ids).
  const bindingMarker = ' Bound evidence: ';
  const markerAt = evidence.indexOf(bindingMarker);
  const statement = markerAt >= 0 ? evidence.slice(0, markerAt) : evidence;
  const bindings = markerAt >= 0 ? evidence.slice(markerAt + bindingMarker.length) : '';
  const truncationMarker = ' …[middle omitted]… ';
  const bindingBudget = bindings.length > 0
    ? Math.min(COMPACT_FAILURE_BINDINGS_CHARS, bindings.length)
    : 0;
  const baseFixedChars = (markerAt >= 0 ? bindingMarker.length : 0) +
    (bindings.length > bindingBudget ? 1 : 0);
  const needsStatementTruncation = statement.length > COMPACT_FAILURE_EVIDENCE_CHARS - bindingBudget - baseFixedChars;
  const fixedChars = baseFixedChars + (needsStatementTruncation ? truncationMarker.length : 0);
  const statementBudget = COMPACT_FAILURE_EVIDENCE_CHARS - bindingBudget - fixedChars;
  let compactStatement = statement;
  if (statement.length > statementBudget) {
    const headChars = Math.ceil(statementBudget / 2);
    const tailChars = statementBudget - headChars;
    compactStatement = `${statement.slice(0, headChars)}${truncationMarker}${statement.slice(-tailChars)}`;
  }
  const compactBindings = bindings.length > bindingBudget
    ? bindings.slice(0, bindingBudget) + '…'
    : bindings;
  const compact = markerAt >= 0
    ? `${compactStatement}${bindingMarker}${compactBindings}`
    : compactStatement;
  return { evidence: compact.slice(0, COMPACT_FAILURE_EVIDENCE_CHARS), truncated: true };
}

/**
 * P-007 (RSR-P-007-A): the per-clause verdict table a summary read returns. It keeps every
 * field the scorecards:emit replay gate and the grading-integrity auditor compare
 * (specId / specRevision / specFingerprint / ratings[].rating / wouldBlock) so a replay
 * reads the SAME verdicts from either detail level; it drops only the prose — each
 * criterion's evidence text and the scorecardDraft — which is what made one evaluation
 * ~138 KB. A non-passing criterion keeps bounded evidence and its `suggestion`,
 * so the emit refusal can retain the reason from this exact measurement.
 */
function summaryRow(row: EvaluatedRow) {
  return {
    planSlug: row.planSlug,
    specId: row.specId,
    specRevision: row.specRevision,
    specFingerprint: row.specFingerprint,
    planItemId: row.planItemId,
    verdict: row.verdict,
    requiredProofFloor: row.requiredProofFloor,
    wouldBlock: row.wouldBlock,
    // P-019: the binding ids that drag each blocking criterion — ids only, so the compact
    // read stays compact while naming exactly which rows to retract or supersede.
    ...(Object.keys(row.draggingBindingIds).length > 0 ? { draggingBindingIds: row.draggingBindingIds } : {}),
    // Keep transient measurement failures machine-visible in the compact response.
    // Criterion prose alone made a temporary server-measurement timeout look like a
    // stable substantive UNKNOWN rating when the evaluator otherwise returned ok:true.
    measurementEvidence: row.measurementEvidence,
    ratings: Object.fromEntries(
      Object.entries(row.ratings).map(([criterion, entry]) => [
        criterion,
        (() => {
          if (PASS_LIKE.has(entry.rating)) return { rating: entry.rating };
          const compact = compactFailureEvidence(entry.evidence);
          return {
            rating: entry.rating,
            evidence: compact.evidence,
            ...(compact.truncated ? { evidenceTruncated: true } : {}),
            ...(entry.suggestion ? { suggestion: entry.suggestion } : {}),
          };
        })(),
      ]),
    ),
  };
}

const evaluatorBuildSchema = z
  .object({
    sha: z.string().trim().min(1).max(256).nullable(),
    version: z.string().trim().min(1).max(120),
  })
  .strict();

function evaluatorBuildDiff(recorded: BuildInfo, live: BuildInfo): boolean {
  return recorded.sha !== live.sha || recorded.version !== live.version;
}

type EvaluatorClassSource = 'active-acceptance-rubric' | 'retired-acceptance-rubric' | 'work-item-completion-attestation';

type EvaluatorClassResolution =
  | {
      ok: true;
      classRef: PlanClassRubricRef;
      source: EvaluatorClassSource;
      contractSpecIds?: string[];
    }
  | { ok: false; code: string; message: string; wouldBlock: string[] };

export async function resolveEvaluatorClassRef(
  planSlug: string,
  harnessSlug: string,
  selection: { classRef?: PlanClassRubricRef; workItemIds?: string[]; specIds?: string[] },
): Promise<EvaluatorClassResolution> {
  if (planSlug === ADHOC_WORK_ITEM_SPEC_SCOPE) {
    // This system scope is a clause namespace, not a plan with an acceptance rubric.
    // Reuse the completion gate's explicit class attestation, but only for the exact
    // canonical work item's BehaviorContract. It never establishes a namespace-wide class.
    const refuse = (code: string, message: string): EvaluatorClassResolution =>
      ({ ok: false, code, message, wouldBlock: [code.replaceAll('_', '-')] });
    if (!selection.classRef) return refuse('adhoc_class_attestation_required', 'This ad-hoc scope has no persisted plan class; supply an explicit classRef for the selected work item.');
    if (selection.workItemIds?.length !== 1) {
      return refuse('adhoc_work_item_required', 'Select exactly one workItemId to attest its ad-hoc behavior contract.');
    }
    try {
      const workItem = await getWorkItem(selection.workItemIds[0], harnessSlug);
      if (!workItem || workItem.harness !== harnessSlug) {
        return refuse('adhoc_work_item_unresolved', 'The selected work item could not be resolved in this harness.');
      }
      const contract = await resolveWorkItemBehaviorContract(workItem);
      const contractSpecIds = contract.groups
        .filter((group) => group.planSlug === ADHOC_WORK_ITEM_SPEC_SCOPE)
        .flatMap((group) => group.clauses.map((clause) => clause.specId));
      if (contractSpecIds.length === 0) {
        return refuse('adhoc_contract_unresolved', 'The selected work item has no resolved ad-hoc behavior clauses.');
      }
      if (selection.specIds?.some((id) => !contractSpecIds.includes(id))) {
        return refuse('adhoc_spec_outside_work_item', 'Select only clauses in this work item\'s resolved ad-hoc behavior contract.');
      }
      return { ok: true, classRef: selection.classRef, source: 'work-item-completion-attestation', contractSpecIds };
    } catch (error) {
      return refuse('adhoc_contract_read_unavailable',
        'The canonical work item or its behavior contract could not be read (' +
        (error instanceof Error ? error.message : String(error)) + '). Refusing to grade until it can be read.');
    }
  }
  let rubrics: Awaited<ReturnType<typeof getAcceptanceRubricsForPlan>>;
  try {
    rubrics = await getAcceptanceRubricsForPlan(planSlug, { harnessSlug, strict: true });
  } catch (error) {
    return {
      ok: false,
      code: 'plan_class_read_unavailable',
      wouldBlock: ['plan-class-read-unavailable'],
      message:
        "The acceptance-rubric class for plan '" + planSlug + "' could not be read (" +
        (error instanceof Error ? error.message : String(error)) +
        '). Refusing to grade until the authoritative class can be read.',
    };
  }

  let source: EvaluatorClassSource = 'active-acceptance-rubric';
  if (rubrics.length === 0) {
    source = 'retired-acceptance-rubric';
    try {
      // On a shipped plan the acceptance contract retires with the plan. The rubric
      // reader returns newest first; its first row is the class used for the ship.
      rubrics = (await getRetiredAcceptanceRubricsForPlan(planSlug, { harnessSlug })).slice(0, 1);
    } catch (error) {
      return {
        ok: false,
        code: 'plan_class_read_unavailable',
        wouldBlock: ['plan-class-read-unavailable'],
        message:
          "The retired acceptance-rubric class for plan '" + planSlug + "' could not be read (" +
          (error instanceof Error ? error.message : String(error)) +
          '). Refusing to grade until the authoritative class can be read.',
      };
    }
  }

  if (rubrics.length === 0) {
    return {
      ok: false,
      code: 'plan_class_unresolved',
      wouldBlock: ['plan-class-unresolved'],
      message:
        "No active or retired acceptance class could be resolved for plan '" + planSlug +
        "'. A caller-supplied classRef cannot establish the plan's authoritative class.",
    };
  }

  const resolution = resolvePersistedClassRef(planSlug, rubrics);
  if (!resolution.ok) {
    return {
      ok: false,
      code: resolution.code,
      message: resolution.message,
      wouldBlock: resolution.wouldBlock,
    };
  }
  return { ok: true, classRef: resolution.classRef, source };
}

/**
 * Exported so a scorecard's `rerunRecipe.args` can be validated against the REAL
 * schema rather than a hand-copied list of field names. A recipe that its own
 * evaluator rejects is not a rerun recipe, and a guard that restates the field
 * names here would pass through exactly the drift it is meant to catch.
 */
// RSR-P-008-A: the clause-pin rules are reported alongside any shape defect.
export const argsSchema = refineEvenWithShapeIssues(z.object({
  harness: harnessArg,
  slug: z.string().min(1),
  classRef: z
    .enum(PLAN_CLASS_RUBRIC_REFS)
    .optional()
    .describe('Derived from the persisted subject acceptance class when omitted; a supplied value must match. Ad-hoc work items still need explicit class attestation.'),
  /** Build identity recorded by a rerun recipe; used to surface evaluator drift. */
  evaluatorBuild: evaluatorBuildSchema.optional(),
  workItemIds: z.array(z.string().min(1)).min(1).max(500).optional(),
  evidenceRefs: z.array(z.string().trim().min(1).max(2000)).min(1).max(500).optional(),
  /** Exact immutable evidence binding row ids; an empty array selects no rows. */
  bindingIds: z.array(z.number().int().positive().max(Number.MAX_SAFE_INTEGER)).max(500).optional(),
  specIds: z.array(z.string().min(1)).min(1).max(500).optional(),
  /** Immutable clause revision/fingerprint selected by a persisted replay recipe. */
  specRevision: z.number().int().positive().optional().describe(
    'Immutable clause revision pin. Supply together with specFingerprint; both are required when replaySnapshot is true.',
  ),
  specFingerprint: z.string().trim().min(1).max(256).optional().describe(
    'Immutable clause fingerprint pin. Supply together with specRevision; both are required when replaySnapshot is true.',
  ),
  /** Replay a persisted recipe against its pinned immutable clause revision. */
  replaySnapshot: z.boolean().optional().describe(
    'When true, grade the pinned immutable clause revision instead of the live one. Requires both specRevision and specFingerprint from the same immutable clause revision. Normal evaluator calls still re-measure bindings with persisted recipes; the grading auditor uses a separate internal historical replay to reproduce the card’s emission-time verdict.',
  ),
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
      z.boolean(),
    ])
    .optional()
    .describe(
      'Caller-supplied fingerprints may be the canonical array or the persisted rerunRecipe.current wrapper; wrapper.supplied:false and boolean true/false omit caller fingerprints and use independent server measurement. In normal evaluator calls, matching caller values remain unknown and cannot produce freshness:pass; the internal grading-audit replay uses them only with the card’s historical cutoff to reproduce its original verdict.',
    ),
  includeDraft: z.boolean().optional(),
  now: z.string().datetime({ offset: true }).optional(),
  limit: z.number().int().min(1).max(1000).optional().describe(
    'Maximum evidence rows to load for the filtered plan/spec/work-item/evidence scope, not the number of selected clauses. The default is 1000. If loaded rows reach this ceiling, evaluation refuses with evidence_selection_hit_limit and no verdict because the cohort may be truncated; omit this argument or set it above the expected evidence rows (up to 1000), or narrow the selectors.',
  ),
  detail: reviewReadDetailArg,
}), (args, ctx) => {
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

type HistoricalAuditSelection = {
  planSlug: string;
  specId: string;
  specRevision: number;
  specFingerprint: string;
  evidence: Array<{ evidenceKind: string; evidenceRef: string }>;
  bindingIds?: number[];
};

/**
 * Internal-only replay for grading audits. It reconstructs the evidence cohort and
 * currentness tuple as of the graded card's creation time; it must not be used as a
 * current ship-read. The normal evaluator deliberately stays current-only.
 */
export async function replaySpecTestAdequacyForHistoricalAudit(input: {
  args: z.infer<typeof argsSchema>;
  selection: HistoricalAuditSelection;
  workspaceId: string;
  auditAsOf: Date;
}): Promise<Record<string, unknown>> {
  if (input.args.classRef === undefined) return { ok: false, error: 'historical_class_attestation_required', remedy: 'Historical replay requires the class recorded in the emission recipe.' };
  const { args, selection, workspaceId, auditAsOf } = input;
  const evidenceRefs = [...new Set(selection.evidence.map((entry) => entry.evidenceRef))].sort();
  const recipeEvidenceRefs = [...new Set(args.evidenceRefs ?? [])].sort();
  const normalizeBindingIds = (ids: number[] | undefined) =>
    ids === undefined ? undefined : [...new Set(ids)].sort((a, b) => a - b);
  const argsBindingIds = normalizeBindingIds(args.bindingIds);
  const selectionBindingIds = normalizeBindingIds(selection.bindingIds);
  const bindingIds = argsBindingIds ?? selectionBindingIds;
  const bindingIdsAgree =
    argsBindingIds === undefined ||
    selectionBindingIds === undefined ||
    JSON.stringify(argsBindingIds) === JSON.stringify(selectionBindingIds);
  const bindingIdsValid = [argsBindingIds, selectionBindingIds]
    .filter((ids): ids is number[] => ids !== undefined)
    .every((ids) => ids.every((id) => Number.isSafeInteger(id) && id > 0));
  const selectedEvidence = selection.evidence.map((entry) => JSON.stringify([entry.evidenceKind, entry.evidenceRef]));
  const exactEvidence = new Set(selectedEvidence);
  const validCutoff = Number.isFinite(auditAsOf.getTime());
  if (
    !validCutoff ||
    !workspaceId ||
    !bindingIdsAgree ||
    !bindingIdsValid ||
    args.replaySnapshot !== true ||
    args.slug !== selection.planSlug ||
    args.specRevision !== selection.specRevision ||
    args.specFingerprint !== selection.specFingerprint ||
    !args.specIds?.includes(selection.specId) ||
    evidenceRefs.length === 0 ||
    JSON.stringify(evidenceRefs) !== JSON.stringify(recipeEvidenceRefs)
  ) {
    return { ok: false, error: 'historical_audit_recipe_not_exact' };
  }

  const current =
    args.current === undefined || typeof args.current === 'boolean'
      ? undefined
      : Array.isArray(args.current)
        ? args.current
        : args.current.supplied
          ? args.current.fingerprints
          : undefined;
  const evidenceLimit = args.limit ?? 1000;
  const loaded = await listSpecEvidence({
    harnessSlug: args.harness,
    workspaceId,
    planSlugs: [selection.planSlug],
    workItemIds: args.workItemIds,
    specIds: [selection.specId],
    specRevision: selection.specRevision,
    specFingerprint: selection.specFingerprint,
    replaySnapshot: true,
    evidenceRefs,
    bindingIds,
    ...(current !== undefined ? { currentProvenance: 'historical-snapshot' as const } : {}),
    current,
    includeRetracted: true,
    auditAsOf,
    limit: evidenceLimit,
  });
  if (loaded.length >= evidenceLimit) {
    return { ok: false, error: 'historical_evidence_selection_hit_limit', count: loaded.length, limit: evidenceLimit };
  }
  const evidence = loaded.filter(
    (row) =>
      row.planSlug === selection.planSlug &&
      row.specId === selection.specId &&
      row.specRevision === selection.specRevision &&
      row.specFingerprint === selection.specFingerprint &&
      exactEvidence.has(JSON.stringify([row.evidenceKind, row.evidenceRef])),
  );
  if (evidence.length === 0) return { ok: false, error: 'historical_selection_empty', count: 0 };

  const clauses = await listSpecClauses({
    harnessSlug: args.harness,
    workspaceId,
    planSlug: selection.planSlug,
    specIds: [selection.specId],
    revision: selection.specRevision,
    limit: 1,
  });
  const clause = clauses.find(
    (candidate) =>
      candidate.specId === selection.specId &&
      candidate.revision === selection.specRevision &&
      candidate.contentHash === selection.specFingerprint,
  );
  if (!clause || (args.includeDraft !== true && clause.lifecycleStatus !== 'active' && clause.lifecycleStatus !== 'accepted')) {
    return { ok: false, error: 'historical_clause_snapshot_unavailable' };
  }

  const historicalEvidence = current === undefined
    ? evidence.map((row) => ({
        ...row,
        currentness: {
          ...row.currentness,
          overall: 'unknown' as const,
          provenance: 'replayed-snapshot' as const,
          staleReasons: [],
          unknownReasons: [...new Set([...row.currentness.unknownReasons, 'historical-audit-only'])],
        },
      }))
    : evidence;
  const sourceBarTestRequirements = await resolveSourceBarTestRequirements(clause.sourceBar);
  const evaluated = evaluateSpecTestAdequacy({
    clause,
    evidence: historicalEvidence,
    classRef: input.args.classRef,
    harness: args.harness,
    sourceBarTestRequirements,
    current,
    rerunSelection: {
      workItemIds: args.workItemIds,
      evidenceRefs,
      bindingIds,
      planItemIds: args.planItemIds,
    },
    now: auditAsOf,
  });
  const recordedEvaluatorBuild = args.evaluatorBuild;
  const liveEvaluatorBuild = getBuildInfo();
  const evaluatorBuildDrift =
    recordedEvaluatorBuild && evaluatorBuildDiff(recordedEvaluatorBuild, liveEvaluatorBuild)
      ? { recorded: recordedEvaluatorBuild, live: liveEvaluatorBuild }
      : undefined;

  return {
    ok: true,
    evaluatorBuild: liveEvaluatorBuild,
    ...(evaluatorBuildDrift ? { evaluatorBuildDrift } : {}),
    rows: [summaryRow({ ...evaluated, measurementEvidence: summarizeMeasurementEvidence(evidence) })],
    count: 1,
    historicalAuditOnly: {
      provenance: 'historical-audit-only',
      asOf: auditAsOf.toISOString(),
      freshness: current !== undefined ? 'historical-snapshot' : 'unknown-at-emission',
      bindings: evidence.map((row) => ({
        id: row.id,
        evidenceKind: row.evidenceKind,
        evidenceRef: row.evidenceRef,
        createdAt: row.createdAt,
        withdrawal: row.withdrawal ?? null,
      })),
    },
  };
}

export default defineTool({
  name: 'plans:evaluate-spec-test-adequacy',
  description:
    'Grade each affected current spec revision as one row against the reusable spec-test-adequacy rubric. Resolves exact P-005 evidence bindings and returns a per-clause verdict table with every would-block reason; detail:"full" adds criterion evidence and scorecards:emit-compatible drafts. Read-only; it never files a verdict. evidenceRefs selects immutable evidence references; bindingIds pins a replay to the exact persisted binding rows, including when references repeat. The optional limit is an evidence-row ceiling, not a clause count; omit it for the 1000-row default or set it above the filtered evidence cohort. When replaySnapshot is true, include both specRevision and specFingerprint from the same immutable clause revision. Always check ok and rows.length before indexing rows[0].',
  guidance: {
    returns:
      'A caller classRef that disagrees with the plan acceptance class is refused with ok:false, no rows, and callerClassRef/declaredClassRef/classRefSource. The system ad-hoc scope instead requires exactly one workItemId and uses its explicit completion-class attestation, limited to its resolved BehaviorContract clauses; classRefSource is work-item-completion-attestation. On success { ok, rows, count, verdicts, wouldBlock, includeDraft, excludedDraftCount, excludedDraftSpecIds, excludedClauses } has ok:true; every successful result reports the resolved classRef and its source. Every successful result reports the lifecycle-filtered clauses and an explicit draft-exclusion count, including zero, so row counts do not imply that excluded drafts were evaluated. No call succeeds vacuously: when the plan has clauses but none is eligible — selector or not — the reply is ok:false with error:"selection_empty" rather than ok:true with zero rows. The optional limit caps evidence rows across the filtered scope, not the number of selected clauses; its default is 1000. When loaded rows reach the ceiling, evidence_selection_hit_limit returns ok:false with error, count, limit and remedy and NO rows field because the cohort may be truncated. The default detail:"summary" rows carry specId, specRevision, specFingerprint, verdict, wouldBlock and ratings[criterion].rating, plus a top-level fullBody ref (the exact re-call with detail:"full"); rows[].scorecardDraft and criterion evidence text exist only under detail:"full".',
    when: 'During implementation feedback or immediately before attempting work-item completion for spec-covered behavior.',
    notWhen: 'Authoring clauses — plans:set-specs. Binding proof — plans:bind-spec-evidence. Filing a returned draft — scorecards:emit. Indexing rows[0] without checking ok/rows.length first — an empty or error-shaped reply has no rows[0] to read.',
    chaining:
      'plans:get-specs → plans:bind-spec-evidence → plans:evaluate-spec-test-adequacy → plans:certify-spec-clauses files each passing card. P-007 consumes current emitted rows at work_items:complete.',
    seeAlso: ['plans:get-spec-evidence', 'scorecards:emit', 'rubrics:get spec-test-adequacy'],
  },
  capability: 'plans:read',
  requirePrincipal: false,
  skipWorkspaceTx: true,
  agentRoles: [...AGENT_ROLES],
  ignoreSessionPayloadTier: true,
  modality: ['text'],
  args: argsSchema,
  // Structural shape behind `guidance.returns` (guidance-output-schema-live-guard). Kept
  // deliberately OPEN: the three reply arms (success, selection_empty, hit-limit) carry
  // different optional fields, and MCP clients validate structuredContent against this,
  // so only fields every arm types identically are declared.
  result: z
    .object({
      ok: z.boolean(),
      error: z.string().optional(),
      rows: z.array(z.record(z.string(), z.unknown())).optional(),
      count: z.number().int().nonnegative(),
      includeDraft: z.boolean().optional(),
      excludedDraftCount: z.number().int().nonnegative().optional(),
      excludedDraftSpecIds: z.array(z.string()).optional(),
      excludedClauses: z.array(z.object({
        specId: z.string(),
        revision: z.number().int(),
        lifecycleStatus: z.string(),
      })).optional(),
      verdicts: z.record(z.string(), z.number()).optional(),
      wouldBlock: z.array(z.record(z.string(), z.unknown())).optional(),
    })
    .passthrough(),
  async handler(args, ctx) {
    const sctx = harnessScopedCtx(args.harness, ctx);
    const harnessSlug = resolveEffectiveHarnessSlug(sctx);
    const liveEvaluatorBuild = getBuildInfo();
    const recordedEvaluatorBuild = args.evaluatorBuild;
    const evaluatorBuildDrift =
      recordedEvaluatorBuild && evaluatorBuildDiff(recordedEvaluatorBuild, liveEvaluatorBuild)
        ? { recorded: recordedEvaluatorBuild, live: liveEvaluatorBuild }
        : undefined;
    const classResolution = await resolveEvaluatorClassRef(args.slug, harnessSlug, args);
    if (!classResolution.ok) {
      return {
        data: {
          ok: false,
          error: classResolution.code,
          evaluatorBuild: liveEvaluatorBuild,
          ...(evaluatorBuildDrift ? { evaluatorBuildDrift } : {}),
          slug: args.slug,
          harnessSlug,
          callerClassRef: args.classRef,
          count: 0,
          wouldBlock: classResolution.wouldBlock.map((code) => ({ code })),
          remedy: classResolution.message,
        },
      };
    }
    const classRef = classResolution.classRef;
    if (args.classRef !== undefined && args.classRef !== classRef) {
      return {
        data: {
          ok: false,
          error: 'plan_class_mismatch',
          evaluatorBuild: liveEvaluatorBuild,
          ...(evaluatorBuildDrift ? { evaluatorBuildDrift } : {}),
          slug: args.slug,
          harnessSlug,
          classRef,
          declaredClassRef: classRef,
          classRefSource: classResolution.source,
          callerClassRef: args.classRef,
          count: 0,
          wouldBlock: [{ code: 'plan_class_mismatch', declaredClassRef: classRef, callerClassRef: args.classRef }],
          remedy: 'Re-read the plan acceptance rubric and rerun with its persisted classRef. The caller value cannot override the plan class.',
        },
      };
    }
    const current =
      args.current === undefined || typeof args.current === 'boolean'
        ? undefined
        : Array.isArray(args.current)
          ? args.current
          : args.current.supplied
            ? args.current.fingerprints
            : undefined;
    // Resolve plan-item selectors before the bounded evidence read. Otherwise a
    // large unrelated part of the plan can exhaust the limit before these clauses
    // are selected. Reuse the same clause snapshot when evaluating below.
    const itemClauses = args.planItemIds === undefined ? undefined : await listSpecClauses({
      harnessSlug,
      planSlug: args.slug,
      specIds: args.specIds ?? classResolution.contractSpecIds,
      planItemIds: args.planItemIds,
      revision: args.specRevision,
    });
    const itemSpecIds = itemClauses?.filter((clause) =>
      (!classResolution.contractSpecIds || classResolution.contractSpecIds.includes(clause.specId)) &&
      (!args.specFingerprint || clause.contentHash === args.specFingerprint),
    ).map((clause) => clause.specId);
    const evidenceLimit = args.limit ?? 1000;
    const bindingSelection =
      args.workItemIds !== undefined || args.evidenceRefs !== undefined || args.bindingIds !== undefined;
    // An empty spec filter means all specs in the store. Never widen an empty
    // plan-item selection into that read; the existing selection guard handles it.
    const allEvidence = itemSpecIds?.length === 0 ? [] : await listSpecEvidence({
      harnessSlug,
      planSlugs: [args.slug],
      workItemIds: args.workItemIds,
      specIds: itemSpecIds ?? args.specIds,
      specRevision: args.specRevision,
      specFingerprint: args.specFingerprint,
      replaySnapshot: args.replaySnapshot === true,
        // `current` here is caller-supplied. Label it a replayed snapshot rather than
      // claiming the server measured it — otherwise any caller passing
      // replaySnapshot:true plus self-authored fingerprints mints a 'server-measured'
      // freshness verdict. The store still re-measures every binding that carries a
      // measurement recipe and prefers that result; this label applies only where it
      // cannot (WI-10002320; round trip pinned by scorecards/emit.evaluator-round-trip.test.ts).
      ...(args.replaySnapshot === true && current !== undefined
        ? { currentProvenance: 'replayed-snapshot' as const }
        : {}),
      evidenceRefs: args.evidenceRefs,
      current,
      bindingIds: args.bindingIds,
      limit: evidenceLimit,
    });
    if (allEvidence.length >= evidenceLimit) {
      return {
        data: {
          ok: false,
          error: 'evidence_selection_hit_limit',
          evaluatorBuild: liveEvaluatorBuild,
          ...(evaluatorBuildDrift ? { evaluatorBuildDrift } : {}),
          classRef,
          declaredClassRef: classRef,
          classRefSource: classResolution.source,
          count: allEvidence.length,
          limit: evidenceLimit,
          remedy: 'Narrow workItemIds/specIds/evidenceRefs/bindingIds or raise limit; a capped evidence set cannot produce an adequacy verdict.',
        },
      };
    }
    const explicitSelection =
      args.specIds !== undefined ||
      args.workItemIds !== undefined ||
      args.evidenceRefs !== undefined ||
      args.bindingIds !== undefined ||
      args.planItemIds !== undefined;
    if (bindingSelection && allEvidence.length === 0) {
      return {
        data: {
          ok: false,
          error: 'selection_empty',
          evaluatorBuild: liveEvaluatorBuild,
          ...(evaluatorBuildDrift ? { evaluatorBuildDrift } : {}),
          slug: args.slug,
          harnessSlug,
          classRef,
          declaredClassRef: classRef,
          classRefSource: classResolution.source,
          count: 0,
          selectedEvidenceCount: 0,
          matchedClauseCount: 0,
          eligibleClauseCount: 0,
          selection: {
            specIds: args.specIds ?? null,
            workItemIds: args.workItemIds ?? null,
            evidenceRefs: args.evidenceRefs ?? null,
            bindingIds: args.bindingIds ?? null,
            planItemIds: args.planItemIds ?? null,
          },
          remedy: (
            args.bindingIds !== undefined
              ? 'No current evidence binding matches the selected bindingIds. The row may be absent, retracted, or outside the pinned clause; inspect the target history before changing the selector.'
              : args.evidenceRefs !== undefined
                ? 'No current evidence binding matches the selected workItemIds/evidenceRefs. The binding may be absent, retracted, or superseded, or the selectors may not identify a bound proof. Check the target evidence history before changing them; pass specIds without a binding selector to evaluate intended uncovered clauses.'
                : 'No current evidence edge exists for the selected work item(s). The work item may lack a binding, or its proof may have been retracted or superseded. Check the target history; pass specIds to evaluate intended uncovered clauses.'
          ) + (args.planItemIds !== undefined
            ? ' A binding may exist only outside the selected planItemIds; inspect its clause mapping and the intersection of selectors. Nothing was graded.'
            : ''),
        },
      };
    }
    const evidenceSpecIds = new Set(allEvidence.map((row) => row.specId));
    const requestedSpecIds = args.specIds ?? (bindingSelection ? [...evidenceSpecIds] : classResolution.contractSpecIds);
    const clauses = itemClauses?.filter((clause) =>
      !requestedSpecIds || requestedSpecIds.includes(clause.specId),
    ) ?? await listSpecClauses({
      harnessSlug,
      planSlug: args.slug,
      specIds: requestedSpecIds,
      planItemIds: args.planItemIds,
      revision: args.specRevision,
    });
    const pinnedClauses = clauses.filter((clause) =>
      (!classResolution.contractSpecIds || classResolution.contractSpecIds.includes(clause.specId)) &&
      (!args.specFingerprint || clause.contentHash === args.specFingerprint),
    );
    const isEligibleClause = (clause: (typeof pinnedClauses)[number]) =>
      args.includeDraft === true || clause.lifecycleStatus === 'active' || clause.lifecycleStatus === 'accepted';
    const eligible = pinnedClauses.filter(isEligibleClause);
    const excludedClauses = pinnedClauses
      .filter((clause) => !isEligibleClause(clause))
      .map((clause) => ({
        specId: clause.specId,
        revision: clause.revision,
        lifecycleStatus: clause.lifecycleStatus,
      }));
    const excludedDraftClauses = excludedClauses.filter((clause) => clause.lifecycleStatus === 'draft');
    // Other ratings describe the caller's selected diagnostic cohort, but the
    // disclosed-gap rubric is universal: every active binding for each clause must
    // be checked. Keep that population separate so binding selectors cannot hide a
    // disclosure without widening the rest of the diagnostic read.
    const disclosedGapEvidence = bindingSelection && eligible.length > 0
      ? await listSpecEvidence({
          harnessSlug,
          planSlugs: [args.slug],
          specIds: [...new Set(eligible.map((clause) => clause.specId))],
          specRevision: args.specRevision,
          specFingerprint: args.specFingerprint,
          replaySnapshot: args.replaySnapshot === true,
          ...(args.replaySnapshot === true && current !== undefined
            ? { currentProvenance: 'replayed-snapshot' as const }
            : {}),
          current,
          limit: evidenceLimit,
        })
      : allEvidence;
    if (bindingSelection && disclosedGapEvidence.length >= evidenceLimit) {
      return {
        data: {
          ok: false,
          error: 'evidence_selection_hit_limit',
          evaluatorBuild: liveEvaluatorBuild,
          ...(evaluatorBuildDrift ? { evaluatorBuildDrift } : {}),
          slug: args.slug,
          harnessSlug,
          classRef,
          declaredClassRef: classRef,
          classRefSource: classResolution.source,
          count: disclosedGapEvidence.length,
          selectedEvidenceCount: allEvidence.length,
          limit: evidenceLimit,
          remedy:
            'The unscoped active-binding population needed for disclosed-gap reached the evidence-row ceiling; narrow the selected clauses or raise limit. A capped population cannot produce a safe disclosed-gap verdict.',
        },
      };
    }
    const artifactDisclosures = await readCurrentOperationalArtifactDisclosures(
      typeof ctx.workspaceId === 'string' ? ctx.workspaceId : '',
      harnessSlug,
      disclosedGapEvidence,
    );
    const withArtifactDisclosures = (rows: typeof allEvidence) => rows.map((row) => {
      const gaps = row.id === undefined ? undefined : artifactDisclosures.get(row.id);
      if (!gaps?.length) return row;
      const existing = row.details.adequacy;
      const adequacy = existing && typeof existing === 'object' && !Array.isArray(existing)
        ? existing as Record<string, unknown>
        : {};
      const existingGaps = Array.isArray(adequacy.disclosedGap)
        ? adequacy.disclosedGap.filter((gap): gap is string => typeof gap === 'string')
        : typeof adequacy.disclosedGap === 'string'
          ? [adequacy.disclosedGap]
          : [];
      return {
        ...row,
        details: {
          ...row.details,
          adequacy: {
            ...adequacy,
            disclosedGap: [...new Set([...existingGaps, ...gaps])],
          },
        },
      };
    });
    const evaluationEvidence = withArtifactDisclosures(allEvidence);
    const disclosedGapEvaluationEvidence = bindingSelection
      ? withArtifactDisclosures(disclosedGapEvidence)
      : evaluationEvidence;
    // EI-23420771213407749: this vacuous-success guard must fire on an UNSELECTED call too.
    // Keyed on `explicitSelection` alone, a no-selector call whose clauses all get filtered
    // out (draft, or pinned away by specFingerprint) fell through to ok:true/rows:[]/count:0 —
    // a zero-work false green returned by the very tool the ship gate's own remedy text tells
    // an agent to run FIRST, so the false clean lands exactly where it is most trusted.
    // `clauses.length > 0` is the honest discriminator: clauses EXISTED and none survived
    // filtering, so nothing was measured. A plan with genuinely no clauses still returns
    // ok:true with zero rows — that is a true statement about an empty set, not a false green.
    if (eligible.length === 0 && (explicitSelection || clauses.length > 0)) {
      return {
        data: {
          ok: false,
          error: 'selection_empty',
          evaluatorBuild: liveEvaluatorBuild,
          ...(evaluatorBuildDrift ? { evaluatorBuildDrift } : {}),
          slug: args.slug,
          harnessSlug,
          classRef,
          declaredClassRef: classRef,
          classRefSource: classResolution.source,
          count: 0,
          selectedEvidenceCount: allEvidence.length,
          matchedClauseCount: clauses.length,
          eligibleClauseCount: 0,
          selection: {
            specIds: args.specIds ?? null,
            workItemIds: args.workItemIds ?? null,
            evidenceRefs: args.evidenceRefs ?? null,
            bindingIds: args.bindingIds ?? null,
            planItemIds: args.planItemIds ?? null,
          },
          excludedClauses,
          remedy:
            clauses.length > 0 && args.includeDraft !== true
              ? `${explicitSelection ? 'The selection matched' : 'This plan has'} ${clauses.length} clause(s), but none is eligible — pass includeDraft:true to evaluate draft clauses, or select active/accepted clauses. Nothing was graded, so this is NOT a clean adequacy result.`
              : 'Verify the exact slug and specIds/workItemIds/evidenceRefs/bindingIds/planItemIds selection; no eligible clause matched. Nothing was graded, so this is NOT a clean adequacy result.',
        },
      };
    }
    const now = args.now ? new Date(args.now) : new Date();
    const sourceBarRubricCache: SourceBarRubricCache = new Map();
    const rows = await Promise.all(eligible.map(async (clause) => {
      const sourceBarTestRequirements = await resolveSourceBarTestRequirements(
        clause.sourceBar,
        sourceBarRubricCache,
      );
      const clauseEvidence = allEvidence.filter((row) =>
        row.planSlug === clause.planSlug &&
        row.specId === clause.specId &&
        row.specRevision === clause.revision &&
        row.specFingerprint === clause.contentHash,
      );
      const clauseDisclosedGapEvidence = disclosedGapEvaluationEvidence.filter((row) =>
        row.planSlug === clause.planSlug &&
        row.specId === clause.specId &&
        row.specRevision === clause.revision &&
        row.specFingerprint === clause.contentHash,
      );
      const latestClauseEvidence = new Set(latestLogicalEvidence(clauseEvidence));
      const evaluated = evaluateSpecTestAdequacy({
        clause,
        evidence: evaluationEvidence,
        disclosedGapEvidence: clauseDisclosedGapEvidence,
        classRef,
        harness: harnessSlug,
        sourceBarTestRequirements,
        current: (() => {
          const merged = new Map<string, EvidenceCurrentInput>();
          for (const input of current ?? []) merged.set(evidenceCurrentInputKey(input), input);
          // The grade selects the newest append of each exact-clause binding.
          // Its replay must use that SAME measurement, not an older recipe that
          // happens to appear later in the newest-first evidence history.
          for (const row of clauseEvidence) {
            if (!latestClauseEvidence.has(row) || row.serverMeasurement?.status !== 'measured') continue;
            merged.set(evidenceCurrentInputKey(row.serverMeasurement.current), row.serverMeasurement.current);
          }
          return merged.size > 0 ? [...merged.values()] : undefined;
        })(),
        rerunSelection: {
          workItemIds: args.workItemIds,
          evidenceRefs: args.evidenceRefs,
          bindingIds: args.bindingIds,
          planItemIds: args.planItemIds,
        },
        now,
      });
      return {
        ...evaluated,
        measurementEvidence: summarizeMeasurementEvidence(clauseEvidence),
      };
    }));
    // acceptance-machinery-seam-fixes-2026-09-16 P-001 (R-1): a read whose EVIDENCE COHORT is
    // pinned (workItemIds / evidenceRefs / bindingIds) is a DIAGNOSTIC, not the ship verdict — the ship gate
    // (acceptance-bar-contract-snapshot) grades every binding of a clause unscoped, so a pinned
    // pass 7/0/0 and an unscoped gate 1/7 are BOTH correct readings of different questions.
    // Measured 2026-09-16 on green-gate-zero-wait-convergence-2026-09-08 (WI-10001661 ledger 2).
    // The label rides on the result so the number can never be quoted without its scope.
    const governing = !bindingSelection;
    const governingNote = governing
      ? null
      : 'DIAGNOSTIC READ — the evidence cohort is PINNED (workItemIds/evidenceRefs/bindingIds). The ship gate evaluates every binding of each clause UNSCOPED, so a pass here is not the ship verdict; read plans:get { slug, shipReadiness:true } for the governing per-bar state.';
    const evaluatorBuildDriftNote = evaluatorBuildDrift
      ? 'EVALUATOR BUILD DRIFT — request recorded evaluator ' +
        String(evaluatorBuildDrift.recorded.sha ?? 'unknown') +
        '@' +
        evaluatorBuildDrift.recorded.version +
        '; this draft was computed by live evaluator ' +
        String(evaluatorBuildDrift.live.sha ?? 'unknown') +
        '@' +
        evaluatorBuildDrift.live.version +
        ', not replayed under the recorded build. Compare ratings as cross-build results.'
      : null;
    const scorecardEvidenceNotes = [
      ...(governingNote ? [governingNote] : []),
      ...(evaluatorBuildDriftNote ? [evaluatorBuildDriftNote] : []),
    ];
    const scorecardRows =
      scorecardEvidenceNotes.length > 0
        ? rows.map((row) => ({
            ...row,
            scorecardDraft: {
              ...row.scorecardDraft,
              ratings: Object.fromEntries(
                Object.entries(row.scorecardDraft.ratings).map(([criterion, rating]) => [
                  criterion,
                  {
                    ...rating,
                    evidence: [rating.evidence, ...scorecardEvidenceNotes].join('\n\n'),
                  },
                ]),
              ),
            },
          }))
        : rows;
    return {
      data: {
        ok: true,
        evaluatorBuild: liveEvaluatorBuild,
        ...(evaluatorBuildDrift ? { evaluatorBuildDrift } : {}),
        slug: args.slug,
        harnessSlug,
        classRef,
        declaredClassRef: classRef,
        classRefSource: classResolution.source,
        rubricRef: 'spec-test-adequacy',
        governing,
        includeDraft: args.includeDraft === true,
        excludedDraftCount: excludedDraftClauses.length,
        excludedDraftSpecIds: excludedDraftClauses.map((clause) => clause.specId),
        excludedClauses,
        ...(governingNote ? { governingNote } : {}),
        ...(isFullDetail(args.detail)
          ? { detail: 'full' as const, rows: scorecardRows }
          : {
              detail: 'summary' as const,
              rows: rows.map(summaryRow),
              fullBody: fullBodyRef('plans:evaluate-spec-test-adequacy', args, [
                'rows[].ratings[].evidence',
                'rows[].evidenceRefs',
                'rows[].scorecardDraft',
              ]),
            }),
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
