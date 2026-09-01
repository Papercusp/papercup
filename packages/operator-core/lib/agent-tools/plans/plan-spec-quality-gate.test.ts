import { describe, expect, it, vi } from 'vitest';
import { scorecardEvidenceFingerprint, type ScorecardRow } from '../../scorecards';
import type { SpecClauseRevision } from './spec-clauses-store';
import { evaluatePlanSpecQuality, SPEC_QUALITY_RUBRIC_REF } from './spec-quality';
import { evaluatePlanSpecQualityGate } from './plan-spec-quality-gate';

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

function matchingCard(clauses: SpecClauseRevision[]): ScorecardRow {
  const evaluation = evaluatePlanSpecQuality({
    planSlug: 'quality-plan',
    harnessSlug: 'papercusp',
    planItemIds: ['P-001'],
    clauses,
    classRef: 'plan-class-feature-ship',
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
      { listClauses: vi.fn(async () => []), listCards: vi.fn(async () => []) },
    );

    expect(result).toMatchObject({ satisfied: true, applicable: false, mode: 'report-only' });
    expect(result.wouldBlock).toEqual(['no-first-class-spec-clauses']);
  });

  it('fails closed once a plan adopts clauses but leaves an item uncovered', async () => {
    const result = await evaluatePlanSpecQualityGate(
      { harnessSlug: 'papercusp', planSlug: 'quality-plan', planItemIds: ['P-001', 'P-002'] },
      { listClauses: vi.fn(async () => [clause()]), listCards: vi.fn(async () => []) },
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
      { listClauses: vi.fn(async () => clauses), listCards: vi.fn(async () => []) },
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
      { listClauses: vi.fn(async () => clauses), listCards: vi.fn(async () => [matchingCard(clauses)]) },
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
      {
        listClauses: vi.fn(async () => clauses),
        listCards: vi.fn(async () => [matchingCardWithInstrumentSnapshots(clauses)]),
      },
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
      { listClauses: vi.fn(async () => clauses), listCards: vi.fn(async () => [auditPendingCard(clauses)]) },
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
      { listClauses: vi.fn(async () => clauses), listCards: vi.fn(async () => [auditFailedCard(clauses)]) },
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
    const staleClauses = [clause({ currentRevision: 2, revision: 2, contentHash: 'sha256:spec-two' })];
    const result = await evaluatePlanSpecQualityGate(
      { harnessSlug: 'papercusp', planSlug: 'quality-plan', planItemIds: ['P-001'] },
      {
        listClauses: vi.fn(async () => staleClauses),
        // A pending card exists, but for a DIFFERENT (superseded) specSetHash — its
        // subjectRef will not match staleClauses' evaluation, so listCards (scoped by
        // subjectRef) returns nothing for the current evaluation and the generic
        // missing verdict must still apply.
        listCards: vi.fn(async () => [auditPendingCard(clauses)]),
      },
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
      { listClauses: vi.fn(async () => revised), listCards: vi.fn(async () => [matchingCard(oldClauses)]) },
    );

    expect(result).toMatchObject({ satisfied: false, code: 'spec_quality_scorecard_missing' });
  });
});
