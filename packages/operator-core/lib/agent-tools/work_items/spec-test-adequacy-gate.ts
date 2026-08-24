/** Current, per-clause test-adequacy gate used before a work-item close is written. */
import { listScorecards, scorecardEvidenceFingerprint, type ScorecardRow } from '../../scorecards';
import {
  listSpecEvidence,
  listWorkItemSpecRevisionEdges,
  type EvidenceCurrentInput,
} from '../plans/spec-evidence-store';
import { listSpecClauses, type SpecClauseRevision } from '../plans/spec-clauses-store';
import { planStampOf, type WorkItemForContract } from '../plans/behavior-contract-resolver';
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

export type SpecAdequacyCompletionGateResult =
  | { ok: true; applicable: false; checked: [] }
  | { ok: true; applicable: true; checked: string[] }
  | { ok: false; applicable: true; retryable: true; reason: string; checked: string[] };

/**
 * P-016: `planStampOf` moved to the universal contract resolver, which is the more
 * general home — under D-013 provenance is one INPUT to resolution rather than its
 * precondition. Imported rather than re-declared so the two cannot drift.
 */
type WorkItemForSpecGate = WorkItemForContract;

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
  const stamp = planStampOf(input.workItem);
  if (!stamp) return { ok: true, applicable: false, checked: [] };

  const listClauses = deps.listClauses ?? listSpecClauses;
  const listEdges = deps.listEdges ?? listWorkItemSpecRevisionEdges;
  const listEvidence = deps.listEvidence ?? listSpecEvidence;
  const listCards = deps.listCards ?? listScorecards;
  const edges = await listEdges({
    harnessSlug: stamp.harnessSlug,
    planSlug: stamp.planSlug,
    workItemId: input.workItem.id,
  });
  const edgeSpecIds = [...new Set(edges.map((edge) => edge.specId))];
  const [itemClauses, edgeClauses] = await Promise.all([
    listClauses({
      harnessSlug: stamp.harnessSlug,
      planSlug: stamp.planSlug,
      planItemIds: stamp.planItemIds,
    }),
    edgeSpecIds.length
      ? listClauses({ harnessSlug: stamp.harnessSlug, planSlug: stamp.planSlug, specIds: edgeSpecIds })
      : Promise.resolve([] as SpecClauseRevision[]),
  ]);
  const clauses = [...new Map([...itemClauses, ...edgeClauses].map((clause) => [clause.specId, clause])).values()]
    .filter((clause) => clause.lifecycleStatus === 'active' || clause.lifecycleStatus === 'accepted');
  if (clauses.length === 0) return { ok: true, applicable: false, checked: [] };

  if (!input.attestation) {
    const potentiallyTestRequiring = clauses.filter(
      (clause) => clause.behaviorClass !== 'non-automated' || clause.requiredTestLayers.length > 0 || clause.mutationRequired,
    );
    if (potentiallyTestRequiring.length === 0) return { ok: true, applicable: false, checked: [] };
    return {
      ok: false,
      applicable: true,
      retryable: true,
      checked: [],
      reason:
        `current spec-test-adequacy attestation required for ${potentiallyTestRequiring
          .map((clause) => `${clause.specId}@${clause.revision}`)
          .join(', ')}; pass specAdequacy.classRef and current evidence fingerprints`,
    };
  }

  const relevant = clauses.filter((clause) => requiredProofFloor(clause, input.attestation!.classRef) !== 'none');
  if (relevant.length === 0) return { ok: true, applicable: false, checked: [] };
  const evidence = await listEvidence({
    harnessSlug: stamp.harnessSlug,
    planSlug: stamp.planSlug,
    workItemIds: [input.workItem.id],
    specIds: relevant.map((clause) => clause.specId),
    current: input.attestation.current,
    limit: 1000,
  });
  if (evidence.length >= 1000) {
    return {
      ok: false,
      applicable: true,
      retryable: true,
      checked: [],
      reason: 'spec evidence selection hit the 1000-row safety limit; narrow or consolidate bindings before retrying',
    };
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
    return {
      ok: false,
      applicable: true,
      retryable: true,
      checked,
      reason: failures.join('; '),
    };
  }
  return { ok: true, applicable: true, checked };
}
