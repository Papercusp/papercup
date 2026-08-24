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
