import { describe, expect, it } from 'vitest';
import type { MutationDescriptor } from '@papercusp/test-config/mutation-descriptor';
import type { SpecClauseRevision } from './spec-clauses-store';
import { evaluateSpecTestAdequacy, type SpecEvidenceForAdequacy } from './spec-test-adequacy';

const file = 'test/mutation-provenance.test.ts';
const failedCase = 'guard > rejects broken behavior';
const mutation: MutationDescriptor = {
  schemaVersion: 1, probeInvocationId: 'invocation-001', leg: 'mutant', mode: 'copy-out',
  subjectPath: 'src/guard.ts', mutateExpression: 's/reject/accept/', againstCommit: null,
  subjectBeforeSha256: 'a'.repeat(64), subjectAfterSha256: 'b'.repeat(64),
  mutantDiff: '-reject\n+accept', mutantDiffTruncated: false,
  testCommandSha256: 'c'.repeat(64), testFileSha256: 'd'.repeat(64),
};
const clause: SpecClauseRevision = {
  planSlug: 'mutation-plan', specId: 'SPEC-001', sourceValId: null, currentRevision: 1,
  revision: 1, planItemId: 'P-008', behavior: 'Caught mutations have linked calibration.',
  behaviorClass: 'happy-path', requiredEvidence: [], requiredTestLayers: ['unit'],
  mutationRequired: true, lifecycleStatus: 'active', supersedes: null, exemption: null,
  falsifier: null, contentHash: 'spec-hash', createdBy: 'test', createdAt: '2026-10-11',
  acceptedBy: null, acceptedAt: null, acceptanceRef: null,
};

function proof(kind: 'test' | 'mutation'): SpecEvidenceForAdequacy {
  return {
    workItemId: 'WI-1', planSlug: clause.planSlug, specId: clause.specId, specRevision: 1,
    specFingerprint: clause.contentHash, evidenceKind: kind, evidenceRef: `test-run:${kind}`,
    fingerprints: { sourceFingerprint: 'source', testFingerprint: 'test',
      fixtureFingerprint: 'fixture', rubricFingerprint: null, environmentFingerprint: null },
    coverageEvidenceRef: null, testRunId: kind === 'test' ? 1 : 2,
    testRunExecution: { status: kind === 'test' ? 'pass' : 'fail',
      passed: kind === 'test' ? 1 : 0, failed: kind === 'test' ? 0 : 1, skipped: 0,
      collectionFailed: false, testLayer: 'unit', passedCaseTitles: kind === 'test' ? [failedCase] : [] },
    testRunProvenance: { filePath: file, commitSha: 'e'.repeat(40), worktreeDirty: false,
      ...(kind === 'mutation' ? {
        source: 'mutation-probe', mutationPhase: 'mutant', mutation,
        mutationFailureLines: [`${failedCase}: expected rejection`], mutationFailedCaseTitles: [failedCase],
        mutationBaseline: { testRunId: 3, status: 'pass', passed: 1, failed: 0, skipped: 0,
          collectionFailed: false, mutation: { ...mutation, leg: 'baseline' } },
      } : {}) },
    details: { adequacy: { collected: true, skipped: false, executed: true,
      outcome: kind === 'test' ? 'passed' : 'caught', falsifiable: kind === 'mutation',
      testLayer: 'unit', targeted: clause.specId,
      testCases: [failedCase], fixtureCalibrated: true, pathReachable: true, oracleIndependent: true } },
    currentness: { comparisonSupplied: true, provenance: 'server-measured', overall: 'current',
      dimensions: { spec: 'current', source: 'current', test: 'current', fixture: 'current',
        rubric: 'current', environment: 'current', coverageEvidence: 'current', testRun: 'current' },
      staleReasons: [], unknownReasons: [] },
  };
}

function rating(row: SpecEvidenceForAdequacy) {
  return evaluateSpecTestAdequacy({ clause, evidence: [proof('test'), row], classRef: 'plan-class-feature-ship' })
    .ratings.falsifiability;
}

describe('ledger-derived mutation catches (R-7)', () => {
  it.each(['baseline', 'copy-baseline'])('credits a named failed case with a linked %s pass', leg => {
    const row = proof('mutation'); row.testRunProvenance!.mutationBaseline!.mutation.leg = leg;
    expect(rating(row).rating).toBe('pass');
  });

  it.each(['missing', 'invocation', 'subject', 'leg', 'failed', 'skipped', 'collection', 'zero', 'self'])
    ('does not credit an invalid calibration: %s', defect => {
      const row = proof('mutation'); const p = row.testRunProvenance!; const b = p.mutationBaseline!;
      if (defect === 'missing') p.mutationBaseline = null;
      if (defect === 'invocation') b.mutation.probeInvocationId = 'different-001';
      if (defect === 'subject') b.mutation.subjectBeforeSha256 = 'f'.repeat(64);
      if (defect === 'leg') b.mutation.leg = 'mutant';
      if (defect === 'failed') b.failed = 1;
      if (defect === 'skipped') b.skipped = 1;
      if (defect === 'collection') b.collectionFailed = true;
      if (defect === 'zero') b.passed = 0;
      if (defect === 'self') b.testRunId = row.testRunId!;
      expect(rating(row).rating).toBe('unknown');
    });

  it('rejects load-only failures even when a human tail claims an assertion', () => {
    const row = proof('mutation'); row.testRunProvenance!.mutationFailedCaseTitles = [];
    expect(rating(row).rating).toBe('unknown');
  });

  it('rates a contradicting binder outcome unknown', () => {
    const row = proof('mutation'); (row.details.adequacy as Record<string, unknown>).outcome = 'survived';
    expect(rating(row).rating).toBe('unknown');
  });

  it('preserves pre-descriptor proof with an explicit legacy linkage label', () => {
    const row = proof('mutation'); delete row.testRunProvenance!.mutation;
    delete row.testRunProvenance!.mutationBaseline;
    expect(rating(row).rating).toBe('pass');
    expect(rating(row).evidence).toContain('mutationLinkage=unverified-legacy');
  });
});

describe('grader-visible mutation provenance (R-8)', () => {
  it('reports the invocation, commit, subject, mutation, failed cases and re-aim ledger coverage', () => {
    const row = proof('mutation'); row.details.reaim = { survivorTestRunIds: [7, 8], reason: 'different fault' };
    const visible = rating(row).evidence;
    for (const value of ['mutationLeg="mutant"', 'probeInvocationId="invocation-001"', 'e'.repeat(40),
      'mutationSubjectPath="src/guard.ts"', 'mutationExpression="s/reject/accept/"', failedCase,
      'mutationBaselineTestRunId=3', '"survivorTestRunIds":[7,8]',
      'mutationReaimCoverage=ledgered-mutant-leg-rows-only']) expect(visible).toContain(value);
  });

  it('shows the full historical commit in place of a mutation expression', () => {
    const row = proof('mutation'); row.testRunProvenance!.mutation = {
      ...mutation, mode: 'historical', mutateExpression: null, againstCommit: 'f'.repeat(40),
    };
    expect(rating(row).evidence).toContain(`mutationAgainstCommit="${'f'.repeat(40)}"`);
  });
});
