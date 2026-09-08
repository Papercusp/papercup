import { describe, expect, it } from 'vitest';
import type { SpecClauseRevision } from './spec-clauses-store';
import { evaluatePlanSpecQuality } from './spec-quality';
import evaluateSpecQualityTool from './evaluate-spec-quality';
import startPlanTool from './start';

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

describe('evaluatePlanSpecQuality', () => {
  it('passes a fully covered feature plan and pins an exact specSetHash subject', () => {
    const result = evaluatePlanSpecQuality({
      planSlug: 'quality-plan',
      harnessSlug: 'papercusp',
      planItemIds: ['P-001'],
      clauses: [clause()],
      classRef: 'plan-class-feature-ship',
    });

    expect(result.verdict).toBe('pass');
    expect(result.wouldBlock).toEqual([]);
    expect(result.specSetHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.scorecardDraft.subject.ref).toContain(result.specSetHash);
    for (const [criterion, entry] of Object.entries(result.ratings)) {
      expect(entry.evidence).toContain('Source store: plans:get-specs { slug:"quality-plan", harness:"papercusp" }.');
      expect(entry.evidence).toContain(
        'Re-run exactly: plans:evaluate-spec-quality { slug:"quality-plan", harness:"papercusp", classRef:"plan-class-feature-ship" }',
      );
      expect(entry.evidence).toContain(`inspect ratings["${criterion}"]`);
    }
  });

  it('requires every plan item to carry behavior or an explicit exemption', () => {
    const result = evaluatePlanSpecQuality({
      planSlug: 'quality-plan',
      harnessSlug: 'papercusp',
      planItemIds: ['P-001', 'P-002'],
      clauses: [clause()],
      classRef: 'plan-class-feature-ship',
    });

    expect(result.verdict).toBe('fail');
    expect(result.details.uncoveredPlanItemIds).toEqual(['P-002']);
    expect(result.wouldBlock).toContain('item-contract-coverage');
  });

  it('does not pass empty behavioral evaluations when clauses are only draft', () => {
    const result = evaluatePlanSpecQuality({
      planSlug: 'quality-plan',
      harnessSlug: 'papercusp',
      planItemIds: ['P-001'],
      clauses: [
        clause({
          lifecycleStatus: 'draft',
          acceptedBy: null,
          acceptedAt: null,
          acceptanceRef: null,
        }),
      ],
      classRef: 'plan-class-feature-ship',
    });

    expect(result.ratings['atomic-observable-behavior'].rating).toBe('not-applicable');
    expect(result.ratings.falsifiability.rating).toBe('not-applicable');
    expect(result.ratings['implementation-independence'].rating).toBe('not-applicable');
    expect(result.ratings['atomic-observable-behavior'].evidence).toContain('0 behavioral clause(s)');
    expect(result.ratings.falsifiability.evidence).toContain('0 behavioral clause(s)');
    expect(result.ratings['implementation-independence'].evidence).toContain('0 behavioral clause(s)');
    expect(result.wouldBlock).toEqual(expect.arrayContaining(['item-contract-coverage', 'plan-class-specialization']));
  });

  it('accepts a fully explicit non-behavioral investigation exemption', () => {
    const result = evaluatePlanSpecQuality({
      planSlug: 'quality-plan',
      harnessSlug: 'papercusp',
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
      harnessSlug: 'papercusp',
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
      harnessSlug: 'papercusp',
      planItemIds: ['P-001'],
      clauses: [clause()],
      classRef: 'plan-class-bugfix',
    });
    const migration = evaluatePlanSpecQuality({
      planSlug: 'quality-plan',
      harnessSlug: 'papercusp',
      planItemIds: ['P-001'],
      clauses: [clause({ behaviorClass: 'migration-data-integrity' })],
      classRef: 'plan-class-migration',
    });

    expect(bug.wouldBlock).toContain('plan-class-specialization');
    expect(migration.wouldBlock).not.toContain('plan-class-specialization');
  });
});

describe('spec-quality activation guidance', () => {
  it('publishes the complete scorecard → independent-audit → start sequence and reviewer recipe', () => {
    const evaluateGuidance = [
      evaluateSpecQualityTool.description,
      evaluateSpecQualityTool.guidance?.when,
      evaluateSpecQualityTool.guidance?.returns,
      evaluateSpecQualityTool.guidance?.chaining,
    ].join('\n');
    const evaluateChain = evaluateSpecQualityTool.guidance?.chaining ?? '';
    const startGuidance = [
      startPlanTool.description,
      startPlanTool.guidance?.when,
      startPlanTool.guidance?.chaining,
    ].join('\n');

    for (const guidance of [evaluateGuidance, startGuidance]) {
      expect(guidance).toContain('plans:evaluate-spec-quality');
      expect(guidance).toContain('scorecards:emit');
      expect(guidance).toContain('grading-integrity');
      expect(guidance).toContain('plans:start');
    }
    expect(evaluateGuidance).toContain('capability:launch-agent');
    expect(evaluateGuidance).toContain("independent:true");
    expect(evaluateGuidance).toContain('different author/lineage');
    expect(evaluateChain.indexOf('plans:evaluate-spec-quality')).toBeLessThan(
      evaluateChain.indexOf('scorecards:emit'),
    );
    expect(evaluateChain.indexOf('scorecards:emit')).toBeLessThan(
      evaluateChain.indexOf('grading-integrity'),
    );
    expect(evaluateChain.indexOf('grading-integrity')).toBeLessThan(evaluateChain.indexOf('plans:start'));
  });
});
