import { describe, expect, it, vi } from 'vitest';
import { scorecardEvidenceFingerprint, type ScorecardRow } from '../../scorecards';
import type { SpecClauseRevision } from './spec-clauses-store';
import { evaluatePlanSpecQuality, SPEC_QUALITY_RUBRIC_REF } from './spec-quality';
import { evaluatePlanSpecQualityGate } from './plan-spec-quality-gate';
import type { PlanClassRubricRef } from './spec-test-adequacy';

function clause(over: Partial<SpecClauseRevision> = {}): SpecClauseRevision {
  return {
    planSlug: 'quality-plan',
    specId: 'SPEC-001-01',
    sourceValId: 'VAL-001-01',
    currentRevision: 1,
    revision: 1,
    planItemId: 'P-001',
    behavior: 'POST /events returns 202 for a valid request',
    behaviorClass: 'happy-path',
    requiredEvidence: [],
    requiredTestLayers: ['integration'],
    mutationRequired: false,
    lifecycleStatus: 'active',
    supersedes: null,
    exemption: null,
    falsifier: null,
    contentHash: 'sha256:spec-one',
    createdBy: 'author',
    createdAt: '2026-08-20T00:00:00.000Z',
    acceptedBy: 'reviewer',
    acceptedAt: '2026-08-20T00:01:00.000Z',
    acceptanceRef: 'D-001',
    ...over,
  };
}

type TestGateDeps = NonNullable<Parameters<typeof evaluatePlanSpecQualityGate>[1]>;

function gateDeps(over: TestGateDeps = {}): TestGateDeps {
  return {
    listAcceptanceRubrics: vi.fn(async () => [{ classRef: 'plan-class-feature-ship' }]),
    ...over,
  };
}

function matchingCard(
  clauses: SpecClauseRevision[],
  classRef: PlanClassRubricRef = 'plan-class-feature-ship',
): ScorecardRow {
  const evaluation = evaluatePlanSpecQuality({
    planSlug: 'quality-plan',
    harnessSlug: 'papercusp',
    planItemIds: ['P-001'],
    clauses,
    classRef,
  });
  return {
    issueId: 'EI-quality-card',
    createdAt: '2026-08-20T00:02:00.000Z',
    createdBy: 'reviewer',
    subject: evaluation.scorecardDraft.subject,
    rubricRef: SPEC_QUALITY_RUBRIC_REF,
    ratings: evaluation.ratings,
    nKeys: Object.keys(evaluation.ratings).length,
    missingKeys: [],
    extraKeys: [],
    rubricResolved: true,
    evidenceFingerprint: scorecardEvidenceFingerprint({
      rubricRef: SPEC_QUALITY_RUBRIC_REF,
      ratings: evaluation.ratings,
    }),
    synthesized: false,
    score10: 10,
    linkedItems: [],
  };
}

function auditPendingCard(clauses: SpecClauseRevision[]): ScorecardRow {
  return {
    ...matchingCard(clauses),
    issueId: 'EI-quality-card-pending',
    gradingAudit: { state: 'pending', metaRubricRef: 'grading-integrity', stampedAt: '2026-08-20T00:03:00.000Z' },
  };
}

function auditFailedCard(clauses: SpecClauseRevision[]): ScorecardRow {
  return {
    ...matchingCard(clauses),
    issueId: 'EI-quality-card-failed',
    gradingAudit: {
      state: 'failed',
      metaRubricRef: 'grading-integrity',
      stampedAt: '2026-08-20T00:03:00.000Z',
      auditIssueId: 'EI-audit-card',
      auditor: 'auditor',
      auditedAt: '2026-08-20T00:04:00.000Z',
    },
  };
}

function matchingCardWithInstrumentSnapshots(clauses: SpecClauseRevision[]): ScorecardRow {
  const evaluation = evaluatePlanSpecQuality({
    planSlug: 'quality-plan',
    harnessSlug: 'papercusp',
    planItemIds: ['P-001'],
    clauses,
    classRef: 'plan-class-feature-ship',
  });
  const instrumentSnapshots = {
    'spec-quality.proof': {
      verdict: 'pass' as const,
      measuredAt: '2026-08-20T00:01:30.000Z',
      value: { checked: 1 },
      evidenceRef: 'test:spec-quality-proof',
    },
  };
  return {
    ...matchingCard(clauses),
    instrumentSnapshots,
    evidenceFingerprint: scorecardEvidenceFingerprint({
      rubricRef: SPEC_QUALITY_RUBRIC_REF,
      ratings: evaluation.ratings,
      instrumentSnapshots,
    }),
  };
}

describe('evaluatePlanSpecQualityGate', () => {
  it('keeps legacy/no-clause plans report-only', async () => {
    const result = await evaluatePlanSpecQualityGate(
      { harnessSlug: 'papercusp', planSlug: 'legacy-plan', planItemIds: ['P-001'] },
      gateDeps({ listClauses: vi.fn(async () => []), listCards: vi.fn(async () => []) }),
    );

    expect(result).toMatchObject({ satisfied: true, applicable: false, mode: 'report-only' });
    expect(result.wouldBlock).toEqual(['no-first-class-spec-clauses']);
  });

  it('does not treat an unavailable clause store as a proven legacy/no-clause plan', async () => {
    const listCards = vi.fn();
    const listAcceptanceRubrics = vi.fn();
    const result = await evaluatePlanSpecQualityGate(
      { harnessSlug: 'papercusp', planSlug: 'quality-plan', planItemIds: ['P-001'] },
      {
        listClauses: async () => { throw new Error('clauses unavailable'); },
        listCards, listAcceptanceRubrics,
      },
    );
    expect(result).toMatchObject({
      satisfied: false, mode: 'enforced', code: 'spec_quality_unavailable',
      wouldBlock: ['spec-quality-read-unavailable'],
    });
    expect(listCards).not.toHaveBeenCalled();
    expect(listAcceptanceRubrics).not.toHaveBeenCalled();
  });

  it('fails closed once a plan adopts clauses but leaves an item uncovered', async () => {
    const result = await evaluatePlanSpecQualityGate(
      { harnessSlug: 'papercusp', planSlug: 'quality-plan', planItemIds: ['P-001', 'P-002'] },
      gateDeps({ listClauses: vi.fn(async () => [clause()]), listCards: vi.fn(async () => []) }),
    );

    expect(result).toMatchObject({
      satisfied: false,
      applicable: true,
      mode: 'enforced',
      code: 'spec_quality_failed',
    });
    expect(result.wouldBlock).toContain('item-contract-coverage');
  });

  it('refuses structurally passing clauses without an exact current scorecard', async () => {
    const clauses = [clause()];
    const result = await evaluatePlanSpecQualityGate(
      { harnessSlug: 'papercusp', planSlug: 'quality-plan', planItemIds: ['P-001'] },
      gateDeps({ listClauses: vi.fn(async () => clauses), listCards: vi.fn(async () => []) }),
    );

    expect(result).toMatchObject({
      satisfied: false,
      applicable: true,
      code: 'spec_quality_scorecard_missing',
      wouldBlock: ['exact-specSetHash-scorecard-missing'],
    });
  });

  it('accepts only the complete scorecard matching the exact current specSetHash', async () => {
    const clauses = [clause()];
    const result = await evaluatePlanSpecQualityGate(
      { harnessSlug: 'papercusp', planSlug: 'quality-plan', planItemIds: ['P-001'] },
      gateDeps({ listClauses: vi.fn(async () => clauses), listCards: vi.fn(async () => [matchingCard(clauses)]) }),
    );

    expect(result).toMatchObject({
      satisfied: true,
      applicable: true,
      mode: 'enforced',
      classRef: 'plan-class-feature-ship',
      scorecardId: 'EI-quality-card',
      wouldBlock: [],
    });
  });

  it('accepts an instrumented scorecard using the persisted snapshot-aware fingerprint', async () => {
    const clauses = [clause()];
    const result = await evaluatePlanSpecQualityGate(
      { harnessSlug: 'papercusp', planSlug: 'quality-plan', planItemIds: ['P-001'] },
      gateDeps({
        listClauses: vi.fn(async () => clauses),
        listCards: vi.fn(async () => [matchingCardWithInstrumentSnapshots(clauses)]),
      }),
    );

    expect(result).toMatchObject({
      satisfied: true,
      applicable: true,
      scorecardId: 'EI-quality-card',
      wouldBlock: [],
    });
  });

  it('reports the grading-audit-pending prerequisite instead of "scorecard missing" (EI-22068670622018218)', async () => {
    const clauses = [clause()];
    const result = await evaluatePlanSpecQualityGate(
      { harnessSlug: 'papercusp', planSlug: 'quality-plan', planItemIds: ['P-001'] },
      gateDeps({ listClauses: vi.fn(async () => clauses), listCards: vi.fn(async () => [auditPendingCard(clauses)]) }),
    );

    expect(result).toMatchObject({
      satisfied: false,
      applicable: true,
      mode: 'enforced',
      code: 'spec_quality_scorecard_grading_audit_pending',
      scorecardId: 'EI-quality-card-pending',
      wouldBlock: ['exact-specSetHash-scorecard-grading-audit-pending'],
    });
    expect(result.message).toContain('grading-integrity');
    expect(result.message).toContain('EI-quality-card-pending');
  });

  it('reports the grading-audit-failed verdict distinctly from a pending one', async () => {
    const clauses = [clause()];
    const result = await evaluatePlanSpecQualityGate(
      { harnessSlug: 'papercusp', planSlug: 'quality-plan', planItemIds: ['P-001'] },
      gateDeps({ listClauses: vi.fn(async () => clauses), listCards: vi.fn(async () => [auditFailedCard(clauses)]) }),
    );

    expect(result).toMatchObject({
      satisfied: false,
      applicable: true,
      mode: 'enforced',
      code: 'spec_quality_scorecard_grading_audit_failed',
      scorecardId: 'EI-quality-card-failed',
      wouldBlock: ['exact-specSetHash-scorecard-grading-audit-failed'],
    });
  });

  it('still reports plain "missing" when no exact card exists at all, pending or not', async () => {
    const clauses = [clause()];
    // computeSpecSetHash hashes semantic content (behavior, behaviorClass, etc.) —
    // NOT revision/contentHash — so the differentiator here must change `behavior`,
    // mirroring the sibling "invalidates an older card" case below.
    const revisedClauses = [
      clause({
        currentRevision: 2,
        revision: 2,
        behavior: 'POST /events returns 201 for a valid request',
        contentHash: 'sha256:spec-two',
      }),
    ];
    const result = await evaluatePlanSpecQualityGate(
      { harnessSlug: 'papercusp', planSlug: 'quality-plan', planItemIds: ['P-001'] },
      gateDeps({
        listClauses: vi.fn(async () => revisedClauses),
        // A pending card exists, but for the SUPERSEDED specSetHash (built off the
        // pre-revision `clauses`) — its subjectRef will not match revisedClauses'
        // evaluation, so the generic missing verdict must still apply, not the
        // grading-audit-pending one.
        listCards: vi.fn(async () => [auditPendingCard(clauses)]),
      }),
    );

    expect(result).toMatchObject({ satisfied: false, code: 'spec_quality_scorecard_missing' });
  });

  it('invalidates an older card after a semantic clause revision', async () => {
    const oldClauses = [clause()];
    const revised = [
      clause({
        currentRevision: 2,
        revision: 2,
        behavior: 'POST /events returns 201 for a valid request',
        contentHash: 'sha256:spec-two',
      }),
    ];
    const result = await evaluatePlanSpecQualityGate(
      { harnessSlug: 'papercusp', planSlug: 'quality-plan', planItemIds: ['P-001'] },
      gateDeps({ listClauses: vi.fn(async () => revised), listCards: vi.fn(async () => [matchingCard(oldClauses)]) }),
    );

    expect(result).toMatchObject({ satisfied: false, code: 'spec_quality_scorecard_missing' });
  });

  it('uses the persisted acceptance class and ignores a passing scorecard under another class', async () => {
    const clauses = [clause({ behaviorClass: 'failure' })];
    const listAcceptanceRubrics = vi.fn(async () => [{ classRef: 'plan-class-bugfix' }]);
    const listCards = vi.fn(async () => [matchingCard(clauses, 'plan-class-feature-ship')]);
    const result = await evaluatePlanSpecQualityGate(
      { harnessSlug: 'papercusp', planSlug: 'quality-plan', planItemIds: ['P-001'] },
      gateDeps({
        listClauses: vi.fn(async () => clauses),
        listAcceptanceRubrics,
        listCards,
      }),
    );

    expect(result).toMatchObject({
      satisfied: false,
      applicable: true,
      classRef: 'plan-class-bugfix',
      code: 'spec_quality_scorecard_missing',
      wouldBlock: ['exact-specSetHash-scorecard-missing'],
    });
    expect(result.candidates).toEqual([
      expect.objectContaining({ classRef: 'plan-class-bugfix', verdict: 'pass' }),
    ]);
    expect(listAcceptanceRubrics).toHaveBeenCalledWith('quality-plan');
    expect(listCards).toHaveBeenCalledWith(
      expect.objectContaining({
        subjectRef: expect.stringContaining('spec-set:plan-class-bugfix:'),
      }),
    );
  });

  it('fails closed when the active acceptance rubric has no persisted classRef', async () => {
    const listCards = vi.fn(async () => []);
    const result = await evaluatePlanSpecQualityGate(
      { harnessSlug: 'papercusp', planSlug: 'quality-plan', planItemIds: ['P-001'] },
      gateDeps({
        listClauses: vi.fn(async () => [clause()]),
        listAcceptanceRubrics: vi.fn(async () => [{ classRef: null }]),
        listCards,
      }),
    );

    expect(result).toMatchObject({
      satisfied: false,
      applicable: true,
      code: 'spec_quality_class_missing',
      wouldBlock: ['acceptance-rubric-class-missing'],
    });
    expect(result.classRef).toBeUndefined();
    expect(listCards).not.toHaveBeenCalled();
  });

  it('fails closed when multiple active acceptance rubrics make the class ambiguous', async () => {
    const listCards = vi.fn(async () => []);
    const result = await evaluatePlanSpecQualityGate(
      { harnessSlug: 'papercusp', planSlug: 'quality-plan', planItemIds: ['P-001'] },
      gateDeps({
        listClauses: vi.fn(async () => [clause()]),
        listAcceptanceRubrics: vi.fn(async () => [
          { classRef: 'plan-class-feature-ship' },
          { classRef: 'plan-class-bugfix' },
        ]),
        listCards,
      }),
    );

    expect(result).toMatchObject({
      satisfied: false,
      applicable: true,
      code: 'spec_quality_class_ambiguous',
      wouldBlock: ['acceptance-rubric-class-ambiguous'],
    });
    expect(listCards).not.toHaveBeenCalled();
  });

  it('fails closed when the persisted classRef is not a known plan class', async () => {
    const listCards = vi.fn(async () => []);
    const result = await evaluatePlanSpecQualityGate(
      { harnessSlug: 'papercusp', planSlug: 'quality-plan', planItemIds: ['P-001'] },
      gateDeps({
        listClauses: vi.fn(async () => [clause()]),
        listAcceptanceRubrics: vi.fn(async () => [{ classRef: 'subject-plan-ref' }]),
        listCards,
      }),
    );

    expect(result).toMatchObject({
      satisfied: false,
      applicable: true,
      code: 'spec_quality_class_invalid',
      wouldBlock: ['acceptance-rubric-class-invalid'],
    });
    expect(listCards).not.toHaveBeenCalled();
  });
});
