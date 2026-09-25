/**
 * P-039 (review-system-rework-reduction-2026-09-23, R-9) guard: the rubrics:amend dry run reports
 * what an amendment does to ship READINESS, including every BAR it flips from a manual contract
 * (`instrumentKey:'none'`) to automated proof.
 *
 * Measured 2026-09-23 (Avi #302): a 14-criterion amendment on consult-expert-routing-2026-09-22
 * would have flipped 13 manual BARs to automated with no test layers — up to 13 new blocking codes
 * on a gate that read "0 of 14 BARs blocking" — and nothing said so before the outside
 * countersignature was requested. The candidate also CARRIED the old verdict, so even a reader
 * of per-BAR state saw "manual" (the calibration case below pins that defect).
 */
import { describe, expect, it } from 'vitest';
import {
  ACCEPTANCE_BAR_SNAPSHOT_ACTIVE_RUBRIC_LIMIT,
  ACCEPTANCE_BAR_SNAPSHOT_EVIDENCE_LIMIT,
  ACCEPTANCE_BAR_SNAPSHOT_LINEAGE_ROW_LIMIT,
  ACCEPTANCE_BAR_SNAPSHOT_PLAN_ITEM_LIMIT,
  ACCEPTANCE_BAR_SNAPSHOT_SCORECARD_LIMIT,
  predictAmendedBarProofFloor,
  projectAcceptanceBarContractSnapshot,
  type AcceptanceBarContractSnapshot,
  type AcceptanceBarContractSnapshotInput,
  type AcceptanceBarEvidenceSource,
  type BoundedAcceptanceBarRows,
} from './acceptance-bar-contract-snapshot';
import {
  buildAcceptanceBarAmendmentCandidate,
  computeAcceptanceBarHash,
  computeAcceptanceBarSetHash,
  type Rubric,
  type RubricCriterion,
} from './rubrics';
import type { SpecClauseRevision } from './agent-tools/plans/spec-clauses-store';
import {
  AUTOMATED_CONTRACT_LABEL,
  MANUAL_CONTRACT_LABEL,
  evaluateAmendmentReadinessDelta,
} from './acceptance-bar-amendment-readiness';

const iso = '2026-09-23T12:00:00.000Z';
const MANUAL: RubricCriterion['check'] = { kind: 'instrument', instrumentKey: 'none' };
const TESTS: RubricCriterion['check'] = {
  kind: 'tests',
  files: ['packages/operator-core/lib/acceptance-bar-amendment-readiness.test.ts'],
};

function rows<T>(values: T[], limit = Math.max(values.length, 1)): BoundedAcceptanceBarRows<T> {
  return { rows: values, limit, truncated: false };
}

function criterion(n: number, check: RubricCriterion['check'], plane: 'tree' | 'live' = 'tree'): RubricCriterion {
  const value = {
    key: `r-${n}`,
    title: `Outcome ${n}`,
    model: `Outcome ${n} is true.`,
    method: `Run check ${n}.`,
    driftMarkers: `Outcome ${n} is absent.`,
    barKey: `R-${n}`,
    role: 'outcome' as const,
    mandatory: true,
    requiredScope: [plane],
    evidencePlane: plane,
    passRatings: ['healthy'],
    check,
    barProvenance: { lifecycle: 'pre-implementation' as const, declaredAt: iso, declaredBy: 'su-author' },
  };
  return { ...value, barHash: computeAcceptanceBarHash(value) } as RubricCriterion;
}

/** A started, post-epoch contract whose BARs carry the given checks. */
function contract(checks: Array<RubricCriterion['check']>, plane: 'tree' | 'live' = 'tree'): {
  snapshot: AcceptanceBarContractSnapshot;
  criteria: RubricCriterion[];
} {
  const criteria = checks.map((check, index) => criterion(index + 1, check, plane));
  const barSetHash = computeAcceptanceBarSetHash(criteria);
  const rubric = {
    rubricId: 'acceptance-plan-a', revision: 2, workspaceId: 'ws-1', kind: 'acceptance',
    subjectPlan: 'plan-a', subjectGoal: null, barSetHash,
    barContract: { schemaVersion: 1, adoptionEpoch: 1, cohort: 'post-epoch', subjectPlanRevision: 7, seededAt: iso, seededBy: 'su-author' },
    characteristic: 'plan-acceptance', title: 'Plan A acceptance', description: 'Acceptance', criteria,
    ratingScale: ['healthy', 'degraded', 'broken', 'unknown'], criteriaHash: 'criteria-hash', status: 'active',
    created: '2026-09-23', updated: '2026-09-23', proposedBy: 'su-author', createdBy: 'su-author',
  } as unknown as Rubric;
  const clauses = criteria.map((bar, index) => ({
    planSlug: 'plan-a', specId: `AUTO-BAR-${bar.barKey}-P-00${index + 1}`, sourceValId: null,
    currentRevision: 1, revision: 1, planItemId: `P-00${index + 1}`, behavior: bar.model,
    behaviorClass: plane === 'tree' ? 'happy-path' : 'non-automated', requiredEvidence: [plane], requiredTestLayers: [], mutationRequired: false,
    lifecycleStatus: 'active', supersedes: null, exemption: null, falsifier: { observation: bar.driftMarkers },
    contentHash: `spec-hash-${index + 1}`, createdBy: 'su-author', createdAt: iso, acceptedBy: 'su-author',
    acceptedAt: iso, acceptanceRef: `acceptance-plan-a@2:${bar.barKey}`,
    sourceBar: { barKey: bar.barKey!, barHash: bar.barHash!, barSetHash, rubricSlug: 'acceptance-plan-a', rubricRevision: 2, evidencePlane: plane },
  }) as SpecClauseRevision);
  const input: AcceptanceBarContractSnapshotInput = {
    planRows: rows([{
      workspaceId: 'ws-1', harnessSlug: 'papercusp', planSlug: 'plan-a', status: 'active', revision: 7,
      contentHash: 'plan-content-hash', adoptionEpoch: 1, cohort: 'post-epoch', barSetHash,
      rubricSlug: 'acceptance-plan-a', rubricRevision: 2, seededAt: iso, seededBy: 'su-author',
    }]),
    rubrics: rows([rubric], ACCEPTANCE_BAR_SNAPSHOT_ACTIVE_RUBRIC_LIMIT),
    planItems: rows(criteria.map((_, index) => ({ itemId: `P-00${index + 1}`, status: 'done' })), ACCEPTANCE_BAR_SNAPSHOT_PLAN_ITEM_LIMIT),
    clauses: rows(clauses, 1_000),
    workContracts: rows(clauses.map((clause, index) => ({
      workItemId: `WI-${index + 1}`, planSlug: clause.planSlug, specId: clause.specId,
      specRevision: clause.revision, specFingerprint: clause.contentHash,
    })), 1_000),
    evidence: rows([] as AcceptanceBarEvidenceSource[], ACCEPTANCE_BAR_SNAPSHOT_EVIDENCE_LIMIT),
    scorecards: rows([], ACCEPTANCE_BAR_SNAPSHOT_SCORECARD_LIMIT),
    vettingScorecards: rows([], ACCEPTANCE_BAR_SNAPSHOT_SCORECARD_LIMIT),
    lineage: { identities: ['su-impl'], workItemRowsRead: criteria.length, auditRowsRead: 1, rowLimit: ACCEPTANCE_BAR_SNAPSHOT_LINEAGE_ROW_LIMIT, truncated: false },
    partyByIdentity: new Map([['su-author', 'su-author'], ['su-impl', 'su-impl']]),
    graderSelectionVia: new Map(),
  };
  return { snapshot: projectAcceptanceBarContractSnapshot(input), criteria };
}

/** The candidate rubrics:amend builds for `nextChecks`, optionally without the P-039 re-prediction. */
function amend(
  current: ReturnType<typeof contract>,
  nextChecks: Array<RubricCriterion['check']>,
  { predict = true } = {},
): AcceptanceBarContractSnapshot {
  const nextCriteria = nextChecks.map((check, index) => criterion(index + 1, check, current.criteria[index]!.evidencePlane as 'tree' | 'live'));
  const raw = buildAcceptanceBarAmendmentCandidate(
    current.snapshot,
    nextCriteria,
    new Map(nextCriteria.map((bar, index) => [bar.barKey!, { planItemIds: [`P-00${index + 1}`] }])),
    new Map(nextCriteria.map((_, index) => [`P-00${index + 1}`, 'done'])),
    {
      rubricRevision: 3,
      subjectPlanRevision: 8,
      barSetHash: computeAcceptanceBarSetHash(nextCriteria),
      barContract: { schemaVersion: 1, adoptionEpoch: 1, cohort: 'post-epoch', subjectPlanRevision: 8, seededAt: iso, seededBy: 'su-author' } as Rubric['barContract'],
    },
  );
  return predict ? predictAmendedBarProofFloor(current.snapshot, raw, nextCriteria) : raw;
}

describe('rubrics:amend dry-run readiness delta (P-039 guard)', () => {
  it('reports a manual BAR given a tests check as a flip that only raises the proof floor', () => {
    const current = contract([MANUAL, MANUAL]);
    // Calibration: both BARs really are manual contracts before the amendment.
    expect(current.snapshot.bars.map((bar) => bar.automatedProofRequired)).toEqual([false, false]);

    const delta = evaluateAmendmentReadinessDelta(current.snapshot, amend(current, [TESTS, MANUAL]));

    expect(delta.flippedToAutomated).toEqual(['R-1']);
    expect(delta.flippedToManual).toEqual([]);
    const r1 = delta.bars.find((bar) => bar.barKey === 'R-1');
    expect(r1).toMatchObject({ contractBefore: 'manual', contractAfter: 'automated', label: AUTOMATED_CONTRACT_LABEL });
    expect(r1?.codesAdded).toContain('bar_snapshot_proof_depth_missing');
    expect(r1?.codesRemoved).toEqual([]);
    expect(delta.bars.map((bar) => bar.barKey)).not.toContain('R-2');
    expect(delta.codesAdded).toContain('bar_snapshot_proof_depth_missing');
    expect(delta.after.blockingBarCount).toBeGreaterThanOrEqual(delta.before.blockingBarCount);
    expect(delta.raisesProofFloorOnly).toBe(true);
    expect(delta.summary).toContain('ONLY RAISES THE PROOF FLOOR');
    expect(delta.summary).toContain(`Flips from ${MANUAL_CONTRACT_LABEL} to ${AUTOMATED_CONTRACT_LABEL}: R-1.`);
  });

  it('re-predicts a check change when the criterion carries a stale barHash alias', () => {
    const current = contract([MANUAL, MANUAL]);
    expect(current.snapshot.bars[0]?.automatedProofRequired).toBe(false);
    const nextCriteria = current.criteria.map((bar, index) =>
      index === 0 ? { ...bar, check: TESTS } : bar,
    );
    // Requirement patches can retain the prior read alias until the canonical
    // writer re-hashes the criterion. The check delta still raises the floor.
    expect(nextCriteria[0]?.barHash).toBe(current.criteria[0]?.barHash);
    const raw = buildAcceptanceBarAmendmentCandidate(
      current.snapshot,
      nextCriteria,
      new Map(nextCriteria.map((bar, index) => [bar.barKey!, { planItemIds: [`P-00${index + 1}`] }])),
      new Map(nextCriteria.map((_, index) => [`P-00${index + 1}`, 'done'])),
      {
        rubricRevision: 3,
        subjectPlanRevision: 8,
        barSetHash: computeAcceptanceBarSetHash(nextCriteria),
        barContract: { schemaVersion: 1, adoptionEpoch: 1, cohort: 'post-epoch', subjectPlanRevision: 8, seededAt: iso, seededBy: 'su-author' } as Rubric['barContract'],
      },
    );
    const predicted = predictAmendedBarProofFloor(current.snapshot, raw, nextCriteria);
    expect(predicted.bars[0]?.automatedProofRequired).toBe(true);
    expect(evaluateAmendmentReadinessDelta(current.snapshot, predicted).flippedToAutomated).toEqual(['R-1']);
  });

  it('raises the floor for a live-plane manual BAR changed to tests without layers', () => {
    const current = contract([MANUAL, MANUAL], 'live');
    expect(current.snapshot.bars[0]?.automatedProofRequired).toBe(false);
    const nextCriteria = current.criteria.map((bar, index) =>
      index === 0 ? { ...bar, check: TESTS } : bar,
    );
    const raw = buildAcceptanceBarAmendmentCandidate(
      current.snapshot,
      nextCriteria,
      new Map(nextCriteria.map((bar, index) => [bar.barKey!, { planItemIds: [`P-00${index + 1}`] }])),
      new Map(nextCriteria.map((_, index) => [`P-00${index + 1}`, 'done'])),
      {
        rubricRevision: 3,
        subjectPlanRevision: 8,
        barSetHash: computeAcceptanceBarSetHash(nextCriteria),
        barContract: { schemaVersion: 1, adoptionEpoch: 1, cohort: 'post-epoch', subjectPlanRevision: 8, seededAt: iso, seededBy: 'su-author' } as Rubric['barContract'],
      },
    );
    const predicted = predictAmendedBarProofFloor(current.snapshot, raw, nextCriteria);
    expect(predicted.bars[0]?.automatedProofRequired).toBe(true);
    expect(evaluateAmendmentReadinessDelta(current.snapshot, predicted).flippedToAutomated).toEqual(['R-1']);
  });

  it('CALIBRATION: without the re-prediction the candidate carries the old manual verdict and the flip is invisible', () => {
    const current = contract([MANUAL, MANUAL]);
    const delta = evaluateAmendmentReadinessDelta(current.snapshot, amend(current, [TESTS, MANUAL], { predict: false }));
    expect(delta.flippedToAutomated).toEqual([]);
    expect(delta.raisesProofFloorOnly).toBe(false);
  });

  it('reports nothing for an amendment that changes no BAR', () => {
    const current = contract([MANUAL, TESTS]);
    const delta = evaluateAmendmentReadinessDelta(current.snapshot, amend(current, [MANUAL, TESTS]));
    expect(delta.bars).toEqual([]);
    expect(delta.flippedToAutomated).toEqual([]);
    expect(delta.codesAdded).toEqual([]);
    expect(delta.raisesProofFloorOnly).toBe(false);
    expect(delta.summary).not.toContain('ONLY RAISES');
  });

  it('is not "floor only" when the same amendment also repairs a blocking code', () => {
    // R-2 has no check at all (bar_snapshot_check_missing); the amendment supplies one.
    const current = contract([MANUAL, undefined]);
    const delta = evaluateAmendmentReadinessDelta(current.snapshot, amend(current, [TESTS, MANUAL]));
    expect(delta.flippedToAutomated).toEqual(['R-1']);
    expect(delta.bars.find((bar) => bar.barKey === 'R-2')?.codesRemoved).toContain('bar_snapshot_check_missing');
    expect(delta.raisesProofFloorOnly).toBe(false);
    expect(delta.summary).not.toContain('ONLY RAISES');
  });

  it('labels a BAR the amendment makes manual with the manual-contract label', () => {
    const current = contract([TESTS]);
    expect(current.snapshot.bars[0]?.automatedProofRequired).toBe(true);
    const delta = evaluateAmendmentReadinessDelta(current.snapshot, amend(current, [MANUAL]));
    expect(delta.flippedToManual).toEqual(['R-1']);
    expect(delta.bars[0]).toMatchObject({ barKey: 'R-1', contractAfter: 'manual', label: MANUAL_CONTRACT_LABEL });
    expect(delta.raisesProofFloorOnly).toBe(false);
  });
});
