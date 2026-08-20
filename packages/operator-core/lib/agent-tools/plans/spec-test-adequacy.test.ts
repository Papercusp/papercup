import { describe, expect, it } from 'vitest';
import type { SpecClauseRevision } from './spec-clauses-store';
import type { SpecEvidenceForAdequacy } from './spec-test-adequacy';
import { evaluateSpecTestAdequacy, requiredProofFloor } from './spec-test-adequacy';

function clause(over: Partial<SpecClauseRevision> = {}): SpecClauseRevision {
  return {
    planSlug: 'reconnect-plan',
    specId: 'SPEC-003-01',
    sourceValId: 'VAL-003-01',
    currentRevision: 1,
    revision: 1,
    planItemId: 'P-003',
    behavior: 'An acknowledged event is not replayed after reconnect.',
    behaviorClass: 'happy-path',
    requiredEvidence: ['integration fixture'],
    requiredTestLayers: ['integration'],
    mutationRequired: false,
    lifecycleStatus: 'active',
    supersedes: null,
    exemption: null,
    contentHash: 'sha256:spec-v1',
    createdBy: 'su-test',
    createdAt: '2026-08-20T00:00:00.000Z',
    acceptedBy: 'reviewer',
    acceptedAt: '2026-08-20T00:01:00.000Z',
    acceptanceRef: 'D-003',
    ...over,
  };
}

function evidence(over: Partial<SpecEvidenceForAdequacy> = {}): SpecEvidenceForAdequacy {
  return {
    workItemId: 'WI-101',
    planSlug: 'reconnect-plan',
    specId: 'SPEC-003-01',
    specRevision: 1,
    specFingerprint: 'sha256:spec-v1',
    evidenceKind: 'coverage-census',
    evidenceRef: 'surface:reconnect',
    fingerprints: {
      sourceFingerprint: 'git:abc',
      testFingerprint: 'sha256:test',
      fixtureFingerprint: 'sha256:fixture',
      rubricFingerprint: 'sha256:rubric',
      environmentFingerprint: 'node:24',
    },
    coverageEvidenceRef: 42,
    testRunId: 43,
    details: {
      adequacy: {
        fixtureCalibrated: true,
        falsifiable: true,
        testLayer: 'integration',
        pathReachable: true,
        oracleIndependent: true,
        collected: true,
        skipped: false,
        executed: true,
        outcome: 'passed',
        targeted: true,
        coverageRungs: { l3: true, l4: false },
      },
    },
    currentness: {
      overall: 'current',
      dimensions: {
        spec: 'current',
        source: 'current',
        test: 'current',
        fixture: 'current',
        rubric: 'current',
        environment: 'current',
        coverageEvidence: 'current',
        testRun: 'current',
      },
      staleReasons: [],
      unknownReasons: [],
    },
    ...over,
  };
}

describe('spec-test-adequacy per-clause evaluator', () => {
  it('produces a complete scorecards:emit draft for a current L3 feature proof', () => {
    const result = evaluateSpecTestAdequacy({ clause: clause(), evidence: [evidence()], planClass: 'feature' });
    expect(result.verdict).toBe('pass');
    expect(result.requiredProofFloor).toBe('l3');
    expect(result.wouldBlock).toEqual([]);
    expect(result.scorecardDraft).toMatchObject({
      rubricRef: 'spec-test-adequacy',
      subject: { kind: 'plan', ref: 'reconnect-plan#SPEC-003-01@1' },
      terminal: true,
    });
    expect(Object.keys(result.ratings)).toHaveLength(8);
    expect(result.ratings['correct-layer'].rating).toBe('pass');
    expect(result.ratings['execution-integrity'].rating).toBe('pass');
  });

  it('requires targeted L4 for high-risk, bugfix, migration, and mutation-required clauses', () => {
    expect(requiredProofFloor(clause({ behaviorClass: 'authorization' }), 'feature')).toBe('l4');
    expect(requiredProofFloor(clause(), 'bugfix')).toBe('l4');
    expect(requiredProofFloor(clause(), 'migration')).toBe('l4');
    expect(requiredProofFloor(clause({ mutationRequired: true }), 'feature')).toBe('l4');

    const result = evaluateSpecTestAdequacy({
      clause: clause({ behaviorClass: 'concurrency' }),
      evidence: [evidence()],
      planClass: 'feature',
    });
    expect(result.verdict).toBe('fail');
    expect(result.ratings['plan-class-risk-floor']).toMatchObject({ rating: 'fail' });
    expect(result.wouldBlock).toContain('plan-class-risk-floor');
  });

  it('accepts exact targeted mutation proof and only a justified current approved L4 waiver', () => {
    const highRisk = clause({ behaviorClass: 'concurrency' });
    const mutation = evidence({
      evidenceKind: 'mutation',
      evidenceRef: 'mutant:drop-dedupe',
      details: {
        adequacy: {
          falsifiable: true,
          oracleIndependent: true,
          collected: true,
          skipped: false,
          executed: true,
          outcome: 'killed',
          targeted: true,
        },
      },
    });
    const proved = evaluateSpecTestAdequacy({
      clause: highRisk,
      evidence: [evidence(), mutation],
      planClass: 'feature',
    });
    expect(proved.ratings['plan-class-risk-floor'].rating).toBe('pass');

    const waived = evaluateSpecTestAdequacy({
      clause: clause({
        behaviorClass: 'concurrency',
        exemption: {
          testAdequacyWaivers: {
            l4: {
              justification: 'The external transport cannot be mutated in this environment.',
              approvalRef: 'D-099',
              expiresAt: '2026-09-01T00:00:00.000Z',
            },
          },
        },
      }),
      evidence: [evidence()],
      planClass: 'feature',
      now: new Date('2026-08-20T00:00:00.000Z'),
    });
    expect(waived.ratings['plan-class-risk-floor']).toMatchObject({ rating: 'waived' });
    expect(waived.verdict).toBe('pass');

    const expired = evaluateSpecTestAdequacy({
      clause: clause({
        behaviorClass: 'concurrency',
        exemption: {
          testAdequacyWaivers: {
            l4: {
              justification: 'The external transport cannot be mutated in this environment.',
              approvalRef: 'D-099',
              expiresAt: '2026-08-19T00:00:00.000Z',
            },
          },
        },
      }),
      evidence: [evidence()],
      planClass: 'feature',
      now: new Date('2026-08-20T00:00:00.000Z'),
    });
    expect(expired.ratings['plan-class-risk-floor'].rating).toBe('fail');
  });

  it('fails stale proof and reports unknown metadata without converting it to pass', () => {
    const stale = evidence({
      currentness: {
        ...evidence().currentness,
        overall: 'stale',
        staleReasons: ['source-stale'],
      },
    });
    const staleResult = evaluateSpecTestAdequacy({ clause: clause(), evidence: [stale], planClass: 'feature' });
    expect(staleResult.ratings.freshness.rating).toBe('fail');
    expect(staleResult.verdict).toBe('fail');

    const incomplete = evidence({ details: { adequacy: { coverageRungs: { l3: true } } } });
    const unknown = evaluateSpecTestAdequacy({ clause: clause(), evidence: [incomplete], planClass: 'feature' });
    expect(unknown.ratings['execution-integrity'].rating).toBe('unknown');
    expect(unknown.ratings['oracle-independence'].rating).toBe('unknown');
    expect(unknown.verdict).toBe('fail');
  });

  it('never lets evidence for another revision establish traceability', () => {
    const historical = evidence({ specRevision: 0 });
    const result = evaluateSpecTestAdequacy({ clause: clause(), evidence: [historical], planClass: 'feature' });
    expect(result.ratings.traceability.rating).toBe('fail');
    expect(result.evidenceRefs).toEqual([]);
  });
});
