/** Current, per-clause test-adequacy gate used before a work-item close is written. */
import { listScorecards, type ScorecardRow } from '../../scorecards';
import {
  listSpecEvidence,
  listWorkItemSpecRevisionEdges,
  type EvidenceCurrentInput,
} from '../plans/spec-evidence-store';
import { listSpecClauses } from '../plans/spec-clauses-store';
import {
  enforcedClausesOf,
  ENFORCEABLE_LIFECYCLE_STATUSES,
  planStampOf,
  resolveWorkItemBehaviorContract,
  type ResolveBehaviorContractDeps,
  type WorkItemBehaviorContract,
  type WorkItemForContract,
} from '../plans/behavior-contract-resolver';
import type { EnforcementEligibility } from '../plans/spec-enforcement-eligibility';
import {
  evaluateSpecTestAdequacy,
  isNonCodeWorkItemKind,
  requiredProofFloor,
  SPEC_TEST_ADEQUACY_RUBRIC_REF,
  specTestAdequacySubjectRef,
  type PlanClassRubricRef,
  type SpecTestAdequacyResult,
} from '../plans/spec-test-adequacy';

export interface SpecAdequacyCompletionAttestation {
  classRef: PlanClassRubricRef;
  /**
   * Exact immutable proof identities to grade. Historical bindings remain in the
   * ledger, but a caller can exclude superseded run-specific refs just as
   * plans:evaluate-spec-test-adequacy already permits.
   */
  evidenceRefs?: string[];
  current?: EvidenceCurrentInput[];
}

/**
 * `impactReport` is the ADVISORY half of D-013 and is never a verdict. P-016 reports
 * what the universal resolver newly makes visible — standalone behavior-changing work
 * with no resolved clause, clauses reached only through a cross-namespace edge, and
 * edges pinned to superseded revisions — while P-013 owns turning that same reconciled
 * condition into a refusal. It is therefore populated independently of `ok`: a caller
 * that treats a populated report as a failure has imported P-013's enforcement early.
 */
export type SpecAdequacyCompletionGateResult =
  | { ok: true; applicable: false; checked: []; impactReport?: string }
  | { ok: true; applicable: true; checked: string[]; impactReport?: string }
  | {
      ok: false;
      applicable: true;
      retryable: true;
      reason: string;
      checked: string[];
      impactReport?: string;
      pendingGradingAuditTargetIds?: string[];
      failedGradingAuditTargetIds?: string[];
    };

/**
 * P-016: `planStampOf` moved to the universal contract resolver, which is the more
 * general home — under D-013 provenance is one INPUT to resolution rather than its
 * precondition. Imported rather than re-declared so the two cannot drift.
 */
type WorkItemForSpecGate = WorkItemForContract;

/**
 * Re-exported from the resolver rather than re-declared. This was a local
 * `new Set(['active', 'accepted'])` — a second copy of the resolver's own
 * ENFORCEABLE_LIFECYCLE_STATUSES, silently ordered differently, which is precisely the
 * shape that drifts without any test noticing.
 */
const ENFORCEABLE_LIFECYCLE = new Set<string>(ENFORCEABLE_LIFECYCLE_STATUSES);

/**
 * Human-readable gloss for each machine-readable eligibility reason.
 *
 * Keyed by `EnforcementEligibility['reason']` so a new reason cannot be added there and
 * silently render as `undefined` here — the `satisfies` makes tsc demand this entry.
 */
type NotEnforcedReason = Extract<EnforcementEligibility, { enforcing: false }>['reason'];

const NOT_ENFORCED_BECAUSE = {
  historical:
    "the plan already shipped, so its clauses are carried for visibility and never block — no action needed",
  'pre-enforcement':
    'the plan is still a draft, so its clauses are candidate inputs until it is promoted (D-012)',
  'not-yet-reconciled':
    'the plan is active but has not adopted behavior clauses yet — reconcile that plan to enforce them',
} satisfies Record<NotEnforcedReason, string>;

/**
 * Build the advisory report (D-013). Returns undefined when there is nothing to say, so
 * a caller can treat a populated string as "worth surfacing" without inferring a verdict
 * from its mere presence.
 *
 * Everything named here is deliberately OUTSIDE the enforced set: these are the
 * obligations that were invisible before P-016 resolved applicability across plan
 * namespaces. Naming them without acting on them is exactly the split D-013 assigns.
 */
function advisoryImpactReport(contract: WorkItemBehaviorContract): string | undefined {
  const parts: string[] = [];
  // The resolver's own report: a behavior-changing item that resolved no clause at all.
  if (contract.impact.report) parts.push(contract.impact.report);

  // Clauses this item genuinely owns that are nonetheless NOT enforced, grouped by WHY.
  //
  // P-013 moved the boundary this report describes. Under P-016 the unenforced set was
  // "every namespace but the stamped one", because cross-namespace resolution was
  // reported-only; that is no longer true — a cross-namespace clause in an eligible plan
  // now refuses. The remaining unenforced set is exactly the plans that are not yet
  // ELIGIBLE, so the report must name the eligibility reason rather than repeat the old
  // provenance split. Reporting the reason is also P-013's own scope line ("instrument
  // gate reasons"): `historical` is a correct permanent exemption and needs no follow-up,
  // while `not-yet-reconciled` is a migration TODO on that plan. A bare "not enforced"
  // collapses the two, and they want opposite action.
  const byReason = new Map<NotEnforcedReason, string[]>();
  for (const group of contract.groups) {
    if (group.eligibility.enforcing) continue;
    const labels = group.clauses
      .filter((clause) => ENFORCEABLE_LIFECYCLE.has(clause.lifecycleStatus))
      .map((clause) => `${group.planSlug}/${clause.specId}@${clause.revision}`);
    if (labels.length === 0) continue;
    const bucket = byReason.get(group.eligibility.reason);
    if (bucket) bucket.push(...labels);
    else byReason.set(group.eligibility.reason, [...labels]);
  }
  for (const [reason, labels] of byReason) {
    parts.push(
      `resolved ${labels.length} active clause(s) that are NOT enforced (${NOT_ENFORCED_BECAUSE[reason]}): ` +
        `${labels.join(', ')}. Reported, not enforced.`,
    );
  }

  // A stale edge is a coverage claim against a promise that has since been revised.
  const stale = contract.groups.flatMap((group) =>
    group.staleEdges.map(
      (edge) => `${group.planSlug}/${edge.specId} edge@${edge.edgeRevision} vs current@${edge.currentRevision}`,
    ),
  );
  if (stale.length) {
    parts.push(`coverage edges pinned to superseded revisions: ${stale.join(', ')}. Reported, not enforced.`);
  }

  return parts.length ? parts.join(' | ') : undefined;
}

function acceptedRating(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const rating = (value as { rating?: unknown }).rating;
  return typeof rating === 'string' && ['pass', 'waived', 'not-applicable'].includes(rating.toLowerCase());
}

function ratingVerdictsMatch(card: ScorecardRow, result: SpecTestAdequacyResult): boolean {
  const expected = Object.entries(result.ratings);
  if (Object.keys(card.ratings).length !== expected.length) return false;
  return expected.every(([key, value]) => {
    const actual = card.ratings[key];
    return (
      actual &&
      typeof actual === 'object' &&
      !Array.isArray(actual) &&
      (actual as { rating?: unknown }).rating === value.rating
    );
  });
}

function scorecardMatches(card: ScorecardRow, result: SpecTestAdequacyResult): boolean {
  const expectedSubjectRef = specTestAdequacySubjectRef(result.planSlug, result.specId, result.specRevision);
  return (
    card.subject?.kind === 'plan' &&
    card.subject.ref === expectedSubjectRef &&
    card.rubricResolved &&
    card.missingKeys.length === 0 &&
    card.extraKeys.length === 0 &&
    card.provisional === undefined &&
    card.gradingAudit?.state !== 'pending' &&
    card.gradingAudit?.state !== 'failed' &&
    // The evaluator owns the criterion verdicts, while the independent grading audit
    // owns whether each evidence explanation is complete and re-runnable. Requiring the
    // entire scorecard fingerprint here coupled those two responsibilities: enriching a
    // terse evaluator explanation with the probe demanded by grading-integrity changed
    // the fingerprint and made the two gates impossible to satisfy simultaneously.
    // Match the exact criterion set + verdicts instead. Fresh/current evidence is still
    // recomputed above, and the independently settled audit remains mandatory below.
    ratingVerdictsMatch(card, result) &&
    Object.values(card.ratings).every(acceptedRating)
  );
}

/**
 * Keep the machine-readable would-block list, but do not throw away the evaluator's
 * criterion evidence. In particular, `unknown [freshness]` is not actionable when the
 * actual cause is an omitted `testFingerprint`/`fixtureFingerprint`/other dimension.
 * Bound the appended prose because evidence refs are caller-controlled and the evaluator
 * may have selected many historical bindings.
 */
const FINGERPRINT_FIELD_BY_DIMENSION = {
  source: 'sourceFingerprint',
  test: 'testFingerprint',
  fixture: 'fixtureFingerprint',
  rubric: 'rubricFingerprint',
  environment: 'environmentFingerprint',
} as const;

function humanizeFreshnessEvidence(evidence: string): string {
  return evidence.replace(
    /\b(source|test|fixture|rubric|environment)(-current-fingerprint-not-supplied|-stale|_fingerprint_absent|_fingerprint_mismatch)\b/g,
    (_match, dimension: keyof typeof FINGERPRINT_FIELD_BY_DIMENSION, reason: string) => {
      const field = FINGERPRINT_FIELD_BY_DIMENSION[dimension];
      return reason === '-stale' || reason === '_fingerprint_mismatch'
        ? `${field} mismatched`
        : `${field} omitted`;
    },
  );
}

function adequacyFailureReason(label: string, result: SpecTestAdequacyResult): string {
  const blockers = result.wouldBlock.join(', ') || 'no passing verdict';
  const freshness = result.wouldBlock.includes('freshness') ? result.ratings.freshness : undefined;
  const details = freshness ? `freshness: ${humanizeFreshnessEvidence(freshness.evidence)}` : '';
  const boundedDetails = details.length > 2_000 ? `${details.slice(0, 1_997)}…` : details;
  return `${label}: ${result.verdict} [${blockers}]${boundedDetails ? ` — ${boundedDetails}` : ''}`;
}

export async function specTestAdequacyCompletionGate(
  input: {
    workItem: WorkItemForSpecGate;
    attestation?: SpecAdequacyCompletionAttestation;
  },
  deps: {
    listClauses?: typeof listSpecClauses;
    listEdges?: typeof listWorkItemSpecRevisionEdges;
    listEvidence?: typeof listSpecEvidence;
    listCards?: typeof listScorecards;
    /**
     * Forwarded to the contract resolver, which needs plan status to decide eligibility.
     * Exposed here rather than left to the resolver's default so this gate stays fully
     * injectable — a unit test that could not stub it would open a real database.
     */
    listPlanStatuses?: ResolveBehaviorContractDeps['listPlanStatuses'];
  } = {},
): Promise<SpecAdequacyCompletionGateResult> {
  const listClauses = deps.listClauses ?? listSpecClauses;
  const listEdges = deps.listEdges ?? listWorkItemSpecRevisionEdges;
  const listEvidence = deps.listEvidence ?? listSpecEvidence;
  const listCards = deps.listCards ?? listScorecards;
  const listPlanStatuses = deps.listPlanStatuses;

  // D-012/D-013: applicability is BEHAVIOR-owned, not plan-owned. Resolve the item's
  // whole contract across plan namespaces FIRST. Before P-016 this function opened with
  // `const stamp = planStampOf(item); if (!stamp) return { applicable: false }` and then
  // read edges scoped to `stamp.planSlug`, so (i) a STANDALONE bug/change resolved
  // nothing at all and (ii) an edge into another plan's namespace was invisible. Both
  // are resolvable states now, which is the gap D-012 exists to close.
  const contract = await resolveWorkItemBehaviorContract(input.workItem, {
    listEdges,
    listClauses,
    listPlanStatuses,
  });
  const stamp = planStampOf(input.workItem);
  const impactReport = advisoryImpactReport(contract);
  const withReport = <T extends object>(result: T): T & { impactReport?: string } =>
    impactReport ? { ...result, impactReport } : result;

  // P-013 CLOSES the D-013 split this block used to hold open. P-016 resolved clauses
  // across plan namespaces but deliberately enforced only the stamped namespace's, so a
  // cross-namespace obligation was visible and toothless; that half-state was always
  // meant to end here.
  //
  // The enforced set is now every ELIGIBLE namespace's clauses — eligibility being the
  // single predicate in `spec-enforcement-eligibility.ts`, computed once by the resolver
  // so this gate and the sync-resolver view that renders it cannot drift. That predicate
  // is what keeps the widening from refusing fleet-wide: a shipped plan (historical), a
  // draft (pre-enforcement), and an active-but-unreconciled plan all stay report-only, so
  // enforcement arrives per plan as each is reconciled — "new and explicitly reconciled
  // plans, then migrate active plans individually", which is this item's scope line.
  //
  // The `!stamp` early return is GONE with it, and that is a behavior change worth naming:
  // a standalone bug/change whose edges reach an eligible plan's clauses is now enforced.
  // Keeping that return would have re-created the D-012 gap one level down — an item
  // escaping its own resolved obligations purely by carrying no plan provenance.
  const { planSlugs: enforcedPlanSlugs, clauses } = enforcedClausesOf(contract);
  if (clauses.length === 0) return withReport({ ok: true, applicable: false, checked: [] });

  // `task` is the canonical non-code kind (research was folded into it). A plan may
  // still carry projected clauses for a task deliverable, but executable L3/L4 proof
  // is not a meaningful completion obligation for that item. Resolve the contract first
  // so cross-plan diagnostics remain available, then bypass the proof gate before an
  // absent attestation can make the non-code item structurally uncloseable.
  if (isNonCodeWorkItemKind(input.workItem.kind)) {
    return withReport({ ok: true, applicable: false, checked: [] });
  }

  if (!input.attestation) {
    const potentiallyTestRequiring = clauses.filter(
      (clause) => clause.behaviorClass !== 'non-automated' || clause.requiredTestLayers.length > 0 || clause.mutationRequired,
    );
    if (potentiallyTestRequiring.length === 0) return withReport({ ok: true, applicable: false, checked: [] });
    return withReport({
      ok: false,
      applicable: true,
      retryable: true,
      checked: [],
      reason:
        `current spec-test-adequacy attestation required for ${potentiallyTestRequiring
          .map((clause) => `${clause.specId}@${clause.revision}`)
          .join(', ')}; pass a TOP-LEVEL \`specAdequacy\` argument to work_items:complete — a SIBLING of ` +
        `\`completion\`, never nested inside it (\`completion.specAdequacy\` is rejected) — with ` +
        `\`classRef\` and current evidence fingerprints`,
    });
  }

  const relevant = clauses.filter((clause) => requiredProofFloor(clause, input.attestation!.classRef) !== 'none');
  if (relevant.length === 0) return withReport({ ok: true, applicable: false, checked: [] });
  // ⚠ The evidence read is scoped by the SAME namespaces as the enforced clause set, and
  // that coupling is not optional. This was `planSlug: stamp.planSlug` — a single-plan
  // read. Widening the enforced set above while leaving this read single-plan would make
  // every cross-namespace clause find ZERO evidence and refuse spuriously: the gate would
  // demand proof it had just made itself unable to see. `listSpecEvidence` takes
  // `planSlugs` for exactly this reason, and it is ONE query, not an N-plan fan-out, so
  // the 1000-row safety limit below still caps the whole selection.
  //
  // Evidence is not cross-credited between namespaces despite the wider read:
  // `evaluateSpecTestAdequacy` matches each row on `planSlug` AND `specId`, so two plans
  // sharing a spec id cannot satisfy each other's clause.
  const harnessSlug = stamp?.harnessSlug ?? input.workItem.harness?.trim() ?? undefined;
  const evidence = await listEvidence({
    harnessSlug,
    planSlugs: enforcedPlanSlugs,
    workItemIds: [input.workItem.id],
    specIds: relevant.map((clause) => clause.specId),
    evidenceRefs: input.attestation.evidenceRefs,
    current: input.attestation.current,
    limit: 1000,
  });
  if (evidence.length >= 1000) {
    return withReport({
      ok: false,
      applicable: true,
      retryable: true,
      checked: [],
      reason: 'spec evidence selection hit the 1000-row safety limit; narrow or consolidate bindings before retrying',
    });
  }

  const checked: string[] = [];
  const failures: string[] = [];
  const pendingGradingAuditTargetIds = new Set<string>();
  const failedGradingAuditTargetIds = new Set<string>();
  for (const clause of relevant) {
    const result = evaluateSpecTestAdequacy({
      clause,
      evidence,
      classRef: input.attestation.classRef,
      workItemKind: input.workItem.kind,
    });
    const label = `${clause.specId}@${clause.revision}`;
    if (result.verdict !== 'pass') {
      failures.push(adequacyFailureReason(label, result));
      continue;
    }
    const subjectRef = specTestAdequacySubjectRef(result.planSlug, result.specId, result.specRevision);
    const cards = await listCards({
      rubricRef: SPEC_TEST_ADEQUACY_RUBRIC_REF,
      subjectRef,
      limit: 20,
    });
    if (!cards.some((card) => scorecardMatches(card, result))) {
      for (const card of cards) {
        if (
          (card.gradingAudit?.state === 'pending' || card.gradingAudit?.state === 'failed') &&
          !card.supersededBy &&
          !card.retracted &&
          card.issueId
        ) {
          if (card.gradingAudit.state === 'pending') pendingGradingAuditTargetIds.add(card.issueId);
          else failedGradingAuditTargetIds.add(card.issueId);
        }
      }
      failures.push(`${label}: no current terminal complete scorecard matches the exact evaluator verdicts`);
      continue;
    }
    checked.push(label);
  }
  if (failures.length) {
    return withReport({
      ok: false,
      applicable: true,
      retryable: true,
      checked,
      reason: failures.join('; '),
      ...(pendingGradingAuditTargetIds.size
        ? { pendingGradingAuditTargetIds: [...pendingGradingAuditTargetIds] }
        : {}),
      ...(failedGradingAuditTargetIds.size
        ? { failedGradingAuditTargetIds: [...failedGradingAuditTargetIds] }
        : {}),
    });
  }
  return withReport({ ok: true, applicable: true, checked });
}
