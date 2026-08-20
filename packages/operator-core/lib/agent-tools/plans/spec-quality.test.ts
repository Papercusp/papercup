import { describe, expect, it } from 'vitest';
import type { SpecClauseRevision } from './spec-clauses-store';
import { evaluatePlanSpecQuality } from './spec-quality';

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
    contentHash: 'sha256:spec-one',
    createdBy: 'author',
    createdAt: '2026-08-20T00:00:00.000Z',
    acceptedBy: 'reviewer',
    acceptedAt: '2026-08-20T00:01:00.000Z',
    acceptanceRef: 'D-001',
    ...over,
  };
}

describe('evaluatePlanSpecQuality', () => {
  it('passes a fully covered feature plan and pins an exact specSetHash subject', () => {
    const result = evaluatePlanSpecQuality({
      planSlug: 'quality-plan',
      planItemIds: ['P-001'],
      clauses: [clause()],
      classRef: 'plan-class-feature-ship',
    });

    expect(result.verdict).toBe('pass');
    expect(result.wouldBlock).toEqual([]);
    expect(result.specSetHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.scorecardDraft.subject.ref).toContain(result.specSetHash);
  });

  it('requires every plan item to carry behavior or an explicit exemption', () => {
    const result = evaluatePlanSpecQuality({
      planSlug: 'quality-plan',
      planItemIds: ['P-001', 'P-002'],
      clauses: [clause()],
      classRef: 'plan-class-feature-ship',
    });

    expect(result.verdict).toBe('fail');
    expect(result.details.uncoveredPlanItemIds).toEqual(['P-002']);
    expect(result.wouldBlock).toContain('item-contract-coverage');
  });

  it('accepts a fully explicit non-behavioral investigation exemption', () => {
    const result = evaluatePlanSpecQuality({
      planSlug: 'quality-plan',
      planItemIds: ['P-001'],
      clauses: [
        clause({
          lifecycleStatus: 'exempt',
          behaviorClass: 'non-automated',
          acceptedBy: null,
          acceptedAt: null,
          acceptanceRef: null,
          exemption: { justification: 'Pure editorial classification.', provenance: 'quality-plan#D-002' },
        }),
      ],
      classRef: 'plan-class-investigation',
    });

    expect(result.verdict).toBe('pass');
    expect(result.details.uncoveredPlanItemIds).toEqual([]);
    expect(result.ratings['explicit-non-behavioral-exemptions'].rating).toBe('pass');
  });

  it('refuses a mislabeled exemption and implementation-coupled behavior', () => {
    const result = evaluatePlanSpecQuality({
      planSlug: 'quality-plan',
      planItemIds: ['P-001', 'P-002'],
      clauses: [
        clause({ behavior: 'The handler.ts function returns true' }),
        clause({
          specId: 'SPEC-002-01',
          sourceValId: 'VAL-002-01',
          planItemId: 'P-002',
          lifecycleStatus: 'exempt',
          behaviorClass: 'happy-path',
          exemption: { justification: 'No code.', provenance: 'D-002' },
        }),
      ],
      classRef: 'plan-class-feature-ship',
    });

    expect(result.wouldBlock).toEqual(
      expect.arrayContaining(['implementation-independence', 'explicit-non-behavioral-exemptions']),
    );
  });

  it('specializes bugfix and migration plans by required behavior class', () => {
    const bug = evaluatePlanSpecQuality({
      planSlug: 'quality-plan',
      planItemIds: ['P-001'],
      clauses: [clause()],
      classRef: 'plan-class-bugfix',
    });
    const migration = evaluatePlanSpecQuality({
      planSlug: 'quality-plan',
      planItemIds: ['P-001'],
      clauses: [clause({ behaviorClass: 'migration-data-integrity' })],
      classRef: 'plan-class-migration',
    });

    expect(bug.wouldBlock).toContain('plan-class-specialization');
    expect(migration.wouldBlock).not.toContain('plan-class-specialization');
  });
});
