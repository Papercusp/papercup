import { describe, expect, it } from 'vitest';
import {
  SCOUT_REWARD_DIMENSIONS,
  computeScoutRewardReport,
  normalizeReviewerPreference,
  type ScoutRewardInput,
} from './reward';

const row = (over: Partial<ScoutRewardInput> = {}): ScoutRewardInput => ({
  routedRef: 'wi:one',
  ideaId: 'idea-one',
  lens: 'analogical',
  ...over,
});

describe('Scout P-007 separated rewards', () => {
  it('normalizes existing 1..5 grades without treating them as outcomes', () => {
    expect(normalizeReviewerPreference(1)).toBe(0);
    expect(normalizeReviewerPreference(3)).toBe(0.5);
    expect(normalizeReviewerPreference(5)).toBe(1);

    const report = computeScoutRewardReport([
      row({ reviewerGrade: 5, measuredEffectiveness: { status: 'pending' } }),
    ]);
    const artifact = report.artifacts[0]!;
    expect(artifact.reviewerPreference).toBe(1);
    expect(artifact.prioritizationScore).toBe(1);
    expect(artifact.effectivenessScore).toBeNull();
    expect(report.pendingArtifacts).toBe(1);
    expect(report.maturedArtifacts).toBe(0);
  });

  it('lets a matured outcome determine effectiveness, even when preference disagrees', () => {
    const report = computeScoutRewardReport([
      row({ reviewerGrade: 1, measuredEffectiveness: { status: 'matured', value: 0.8 } }),
    ]);
    const artifact = report.artifacts[0]!;
    expect(artifact.prioritizationScore).toBe(0);
    expect(artifact.effectivenessScore).toBe(0.8);
    expect(report.byLens.analogical).toMatchObject({
      reviewerPreferenceMean: 0,
      measuredEffectivenessMean: 0.8,
      maturedArtifacts: 1,
    });
  });

  it('keeps pending and right-censored outcomes visible and out of matured means', () => {
    const report = computeScoutRewardReport([
      row({ routedRef: 'wi:pending', ideaId: 'p', measuredEffectiveness: { status: 'pending' } }),
      row({ routedRef: 'wi:censored', ideaId: 'c', measuredEffectiveness: { status: 'right-censored' } }),
      row({ routedRef: 'wi:matured', ideaId: 'm', measuredEffectiveness: { status: 'matured', value: 0.4 } }),
    ]);
    expect(report.pendingArtifacts).toBe(1);
    expect(report.rightCensoredArtifacts).toBe(1);
    expect(report.maturedArtifacts).toBe(1);
    expect(report.byLens.analogical).toMatchObject({
      pendingArtifacts: 1,
      rightCensoredArtifacts: 1,
      maturedArtifacts: 1,
      measuredEffectivenessMean: 0.4,
    });
  });

  it('collapses a fused artifact and splits one unit of credit across source lenses', () => {
    const report = computeScoutRewardReport([
      row({ routedRef: 'gym:fused', ideaId: 'idea-a', lens: 'analogical', outcome: 'won', costUsd: 2 }),
      row({ routedRef: 'gym:fused', ideaId: 'idea-b', lens: 'reframing', outcome: 'won', costUsd: 2 }),
    ]);
    expect(report.totalArtifacts).toBe(1);
    expect(report.fusedArtifacts).toBe(1);
    expect(report.collapsedSourceRows).toBe(1);
    expect(report.artifacts[0]).toMatchObject({ sourceCount: 2, fused: true, costUsd: 2, effectivenessScore: 1 });
    expect(report.byLens.analogical.artifactMass).toBe(0.5);
    expect(report.byLens.reframing.artifactMass).toBe(0.5);
    expect(report.byLens.analogical.effectivenessScore).toBe(1);
    expect(report.byLens.reframing.effectivenessScore).toBe(1);
    // The artifact's cost and effectiveness mass are counted once in aggregate,
    // rather than once per source row.
    const lensCost = Object.values(report.byLens).reduce((sum, s) => sum + s.costUsd, 0);
    const lensMass = Object.values(report.byLens).reduce((sum, s) => sum + s.artifactMass, 0);
    expect(lensCost).toBe(2);
    expect(lensMass).toBe(1);
  });

  it('keeps delivery, regression, cost, and uncertainty as separate dimensions', () => {
    const report = computeScoutRewardReport([
      row({
        artifactDelivery: 'missing',
        measuredEffectiveness: { status: 'right-censored' },
        regressions: { status: 'fail', count: 2 },
        cost: { usedUsd: 0.25, budgetUsd: 1 },
        uncertainty: { status: 'unknown', confidence: 0.2 },
      }),
    ]);
    expect(report.dimensions).toEqual(SCOUT_REWARD_DIMENSIONS);
    expect(report.artifacts[0]).toMatchObject({
      artifactDelivery: 'missing',
      regressions: { status: 'fail', count: 2 },
      costUsd: 0.25,
      budgetUsd: 1,
      uncertainty: { status: 'unknown', confidence: 0.2 },
    });
    expect(report.byLens.analogical).toMatchObject({
      artifactDeliveryRate: 0,
      regressionRate: 1,
      uncertaintyRate: 1,
    });
  });
});

