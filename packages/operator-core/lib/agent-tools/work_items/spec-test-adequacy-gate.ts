/** Current, per-clause test-adequacy gate used before a work-item close is written. */
import { listScorecards, scorecardEvidenceFingerprint, type ScorecardRow } from '../../scorecards';
import {
  listSpecEvidence,
  listWorkItemSpecRevisionEdges,
  type EvidenceCurrentInput,
} from '../plans/spec-evidence-store';
import { listSpecClauses } from '../plans/spec-clauses-store';
import {
  planStampOf,
  resolveWorkItemBehaviorContract,
  type PlanStamp,
  type WorkItemBehaviorContract,
  type WorkItemForContract,
} from '../plans/behavior-contract-resolver';
import {
  evaluateSpecTestAdequacy,
  requiredProofFloor,
  SPEC_TEST_ADEQUACY_RUBRIC_REF,
  type PlanClassRubricRef,
  type SpecTestAdequacyResult,
} from '../plans/spec-test-adequacy';

export interface SpecAdequacyCompletionAttestation {
  classRef: PlanClassRubricRef;
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
  | { ok: false; applicable: true; retryable: true; reason: string; checked: string[]; impactReport?: string };

/**
 * P-016: `planStampOf` moved to the universal contract resolver, which is the more
 * general home — under D-013 provenance is one INPUT to resolution rather than its
 * precondition. Imported rather than re-declared so the two cannot drift.
 */
type WorkItemForSpecGate = WorkItemForContract;

const ENFORCEABLE_LIFECYCLE = new Set(['active', 'accepted']);

/**
 * Build the advisory report (D-013). Returns undefined when there is nothing to say, so
 * a caller can treat a populated string as "worth surfacing" without inferring a verdict
 * from its mere presence.
 *
 * Everything named here is deliberately OUTSIDE the enforced set: these are the
 * obligations that were invisible before P-016 resolved applicability across plan
 * namespaces. Naming them without acting on them is exactly the split D-013 assigns.
 */
function advisoryImpactReport(
  contract: WorkItemBehaviorContract,
  stamp: PlanStamp | null,
): string | undefined {
  const parts: string[] = [];
  // The resolver's own report: a behavior-changing item that resolved no clause at all.
  if (contract.impact.report) parts.push(contract.impact.report);

  // Clauses reachable ONLY through an edge into another plan's namespace (or through no
  // plan stamp at all). Before P-016 the gate scoped its edge read to the stamped plan,
  // so these resolved to nothing and were silently absent rather than reported.
  const unenforced = contract.groups
    .filter((group) => group.planSlug !== stamp?.planSlug)
    .flatMap((group) =>
      group.clauses
        .filter((clause) => ENFORCEABLE_LIFECYCLE.has(clause.lifecycleStatus))
        .map((clause) => `${group.planSlug}/${clause.specId}@${clause.revision}`),
    );
  if (unenforced.length) {
    parts.push(
      `resolved ${unenforced.length} active clause(s) outside this item's plan provenance: ${unenforced.join(', ')}. ` +
        'Reported, not enforced — P-013 owns turning cross-namespace resolution into a hard gate.',
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

function scorecardMatches(card: ScorecardRow, result: SpecTestAdequacyResult): boolean {
  const expectedFingerprint = scorecardEvidenceFingerprint({
    rubricRef: SPEC_TEST_ADEQUACY_RUBRIC_REF,
    ratings: result.ratings,
  });
  return (
    card.subject?.kind === 'plan' &&
    card.subject.ref === result.scorecardDraft.subject.ref &&
    card.rubricResolved &&
    card.missingKeys.length === 0 &&
    card.extraKeys.length === 0 &&
    card.provisional === undefined &&
    card.gradingAudit?.state !== 'pending' &&
    card.gradingAudit?.state !== 'failed' &&
    card.evidenceFingerprint === expectedFingerprint &&
    Object.values(card.ratings).every(acceptedRating)
  );
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
  } = {},
): Promise<SpecAdequacyCompletionGateResult> {
  const listClauses = deps.listClauses ?? listSpecClauses;
  const listEdges = deps.listEdges ?? listWorkItemSpecRevisionEdges;
  const listEvidence = deps.listEvidence ?? listSpecEvidence;
  const listCards = deps.listCards ?? listScorecards;

  // D-012/D-013: applicability is BEHAVIOR-owned, not plan-owned. Resolve the item's
  // whole contract across plan namespaces FIRST. Before P-016 this function opened with
  // `const stamp = planStampOf(item); if (!stamp) return { applicable: false }` and then
  // read edges scoped to `stamp.planSlug`, so (i) a STANDALONE bug/change resolved
  // nothing at all and (ii) an edge into another plan's namespace was invisible. Both
  // are resolvable states now, which is the gap D-012 exists to close.
  const contract = await resolveWorkItemBehaviorContract(input.workItem, { listEdges, listClauses });
  const stamp = planStampOf(input.workItem);
  const impactReport = advisoryImpactReport(contract, stamp);
  const withReport = <T extends object>(result: T): T & { impactReport?: string } =>
    impactReport ? { ...result, impactReport } : result;

  // ⚠ D-013 SPLITS this surface deliberately, and the split is load-bearing: P-016
  // REPORTS the newly-resolved surface; P-013 turns the same reconciled condition into
  // hard enforcement. So the ENFORCED set below stays exactly what the plan-stamped path
  // enforced before P-016 — the stamped namespace's own clauses, same merge order, same
  // lifecycle filter. Widening it here would ship P-013's hard gate early and could
  // refuse completions fleet-wide on edges authored as documentation. The newly-visible
  // clauses travel in `impactReport` instead, where they inform without blocking.
  const enforcedGroup = stamp
    ? contract.groups.find((group) => group.planSlug === stamp.planSlug)
    : undefined;
  const clauses = (enforcedGroup?.clauses ?? []).filter((clause) =>
    ENFORCEABLE_LIFECYCLE.has(clause.lifecycleStatus),
  );
  if (!stamp || clauses.length === 0) return withReport({ ok: true, applicable: false, checked: [] });

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
          .join(', ')}; pass specAdequacy.classRef and current evidence fingerprints`,
    });
  }

  const relevant = clauses.filter((clause) => requiredProofFloor(clause, input.attestation!.classRef) !== 'none');
  if (relevant.length === 0) return withReport({ ok: true, applicable: false, checked: [] });
  const evidence = await listEvidence({
    harnessSlug: stamp.harnessSlug,
    planSlug: stamp.planSlug,
    workItemIds: [input.workItem.id],
    specIds: relevant.map((clause) => clause.specId),
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
  for (const clause of relevant) {
    const result = evaluateSpecTestAdequacy({
      clause,
      evidence,
      classRef: input.attestation.classRef,
    });
    const label = `${clause.specId}@${clause.revision}`;
    if (result.verdict !== 'pass') {
      failures.push(`${label}: ${result.verdict} [${result.wouldBlock.join(', ') || 'no passing verdict'}]`);
      continue;
    }
    const cards = await listCards({
      rubricRef: SPEC_TEST_ADEQUACY_RUBRIC_REF,
      subjectRef: result.scorecardDraft.subject.ref,
      limit: 20,
    });
    if (!cards.some((card) => scorecardMatches(card, result))) {
      failures.push(`${label}: no current terminal complete scorecard matches the exact evidence fingerprint`);
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
    });
  }
  return withReport({ ok: true, applicable: true, checked });
}
