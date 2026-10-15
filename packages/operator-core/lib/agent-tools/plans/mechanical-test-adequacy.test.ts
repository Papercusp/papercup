import { describe, expect, it } from 'vitest';
import type { MutationDescriptor } from '@papercusp/test-config/mutation-descriptor';
import { evaluateMechanicalTestAdequacy } from './mechanical-test-adequacy';
import type { SpecEvidenceForAdequacy } from './spec-test-adequacy';

const file = 'src/guard.test.ts';
const clause = { planSlug: 'mechanical', specId: 'R-3', revision: 2, contentHash: 'spec' };
const mutation: MutationDescriptor = {
  schemaVersion: 1, probeInvocationId: 'probe', leg: 'mutant', mode: 'copy-out',
  subjectPath: 'src/guard.ts', mutateExpression: 's/reject/accept/', againstCommit: null,
  subjectBeforeSha256: 'a'.repeat(64), subjectAfterSha256: 'b'.repeat(64),
  mutantDiff: '-reject\n+accept', mutantDiffTruncated: false,
  testCommandSha256: 'c'.repeat(64), testFileSha256: 'd'.repeat(64),
};

function proof(kind: 'test' | 'mutation', id = kind === 'test' ? 1 : 2): SpecEvidenceForAdequacy {
  return {
    id, workItemId: 'WI-1', planSlug: clause.planSlug, specId: clause.specId,
    specRevision: clause.revision, specFingerprint: clause.contentHash,
    evidenceKind: kind, evidenceRef: `run:${id}`, testRunId: id, coverageEvidenceRef: null,
    fingerprints: { sourceFingerprint: 's', testFingerprint: 't', fixtureFingerprint: null,
      rubricFingerprint: null, environmentFingerprint: null },
    testRunExecution: { status: kind === 'test' ? 'pass' : 'fail', passed: kind === 'test' ? 1 : 0,
      failed: kind === 'test' ? 0 : 1, skipped: 0, collectionFailed: false, filePath: file },
    testRunProvenance: { filePath: file, source: kind === 'test' ? 'local' : 'mutation-probe',
      commitSha: 'e'.repeat(40), worktreeDirty: false,
      ...(kind === 'mutation' ? { mutationPhase: 'mutant', mutation,
        mutationBaseline: { testRunId: 3, status: 'pass', passed: 1, failed: 0, skipped: 0,
          collectionFailed: false, mutation: { ...mutation, leg: 'baseline' } } } : {}) },
    details: { currentMeasurement: { schemaVersion: 1, kind: 'repo-files',
      sourcePaths: ['src/guard.ts'], testPaths: [file] } },
    currentness: { comparisonSupplied: true, provenance: 'server-measured', overall: 'current',
      dimensions: { spec: 'current', source: 'current', test: 'current', fixture: 'not-applicable',
        rubric: 'not-applicable', environment: 'not-applicable', coverageEvidence: 'not-applicable', testRun: 'current' },
      staleReasons: [], unknownReasons: [] },
  };
}

function grade(evidence = [proof('test'), proof('mutation')], files = [file]) {
  return evaluateMechanicalTestAdequacy({ clause, evidence,
    sourceBarTestRequirements: { status: 'required', files } });
}

describe('mechanical test adequacy', () => {
  it('accepts current named passing runs and a calibrated caught mutant without a card', () => {
    expect(grade()).toMatchObject({ applicable: true, verdict: 'pass', gaps: [],
      passingTestBindingIds: { [file]: 1 }, caughtMutantBindingIds: [2] });
  });

  it('requires a passing run for every named file', () => {
    expect(grade(undefined, [file, 'src/other.test.ts'])).toMatchObject({ verdict: 'fail' });
  });

  it('requires a caught mutant even when the clause does not request one separately', () => {
    expect(grade([proof('test')])).toMatchObject({ verdict: 'fail', caughtMutantBindingIds: [] });
  });

  it.each(['test', 'mutation'] as const)('rechecks currentness of the %s proof', kind => {
    const rows = [proof('test'), proof('mutation')];
    rows.find(row => row.evidenceKind === kind)!.currentness.overall = 'stale';
    expect(grade(rows)).toMatchObject({ verdict: 'fail' });
  });

  it('rejects caller-replayed freshness instead of treating it as a measured pass', () => {
    const row = proof('test');
    row.currentness.provenance = 'replayed-snapshot';
    expect(grade([row, proof('mutation')])).toMatchObject({ verdict: 'fail' });
  });

  it.each(['failed', 'skipped', 'collectionFailed'] as const)('rejects a %s named run', defect => {
    const row = proof('test');
    if (defect === 'collectionFailed') row.testRunExecution!.collectionFailed = true;
    else row.testRunExecution![defect] = 1;
    expect(grade([row, proof('mutation')])).toMatchObject({ verdict: 'fail' });
  });

  it.each(['unlinked', 'outside-source', 'uncaught', 'other-file'] as const)('rejects an %s mutant', defect => {
    const row = proof('mutation');
    if (defect === 'unlinked') row.testRunProvenance!.mutationBaseline = null;
    if (defect === 'outside-source') row.details.currentMeasurement = {
      schemaVersion: 1, kind: 'repo-files', sourcePaths: ['src/other.ts'], testPaths: [file] };
    if (defect === 'uncaught') Object.assign(row.testRunExecution!, { status: 'pass', passed: 1, failed: 0 });
    if (defect === 'other-file') row.testRunProvenance!.filePath = 'src/other.test.ts';
    expect(grade([proof('test'), row])).toMatchObject({ verdict: 'fail' });
  });

  it.each(['planSlug', 'specId', 'specFingerprint'] as const)('does not cross-credit a different %s', field => {
    const row = proof('test');
    row[field] = 'other';
    expect(grade([row, proof('mutation')])).toMatchObject({ verdict: 'fail' });
  });

  it('keeps non-test checks on the existing evaluator path', () => {
    expect(evaluateMechanicalTestAdequacy({ clause, evidence: [],
      sourceBarTestRequirements: { status: 'not-required' } })).toEqual({ applicable: false });
  });
});
