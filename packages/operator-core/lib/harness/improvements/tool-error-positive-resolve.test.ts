import { describe, expect, it } from 'vitest';
import {
  decideToolFailurePositiveRepair,
  parseToolFailureRepairEvidence,
  toolFailureRepairEvidenceOf,
  type ToolFailureRepairCandidate,
} from './tool-error-positive-resolve';

const candidate: Required<ToolFailureRepairCandidate> = {
  watchdogKey: 'repeated-tool-error:work_items:get:structural:column-initiative-does-not-exist',
  classKey: 'repeated-tool-error-class:work_items:get:structural:schema-42~field-initiative:runtime-7',
  contractFingerprint: 'schema-42~field-initiative',
  deployedRevision: 'runtime-7',
};

const contractChange = {
  classKey: candidate.classKey,
  kind: 'contract-change' as const,
  contractFingerprint: candidate.contractFingerprint,
  fromRevision: 'runtime-7',
  toRevision: 'runtime-8',
  changeRef: 'commit:abc1234 / deployed:runtime-8',
};

const positiveProbe = {
  classKey: candidate.classKey,
  kind: 'positive-probe' as const,
  contractFingerprint: candidate.contractFingerprint,
  deployedRevision: 'runtime-7',
  probeRef: 'probe:work_items:get:initiative-field',
  passed: true as const,
};

describe('toolFailureRepairEvidenceOf', () => {
  it('reads only the durable nested repair-evidence payload', () => {
    expect(toolFailureRepairEvidenceOf({ toolFailureProbation: { repairEvidence: positiveProbe } })).toEqual(positiveProbe);
    expect(toolFailureRepairEvidenceOf({ repairEvidence: positiveProbe })).toBeNull();
  });

  it('rejects revision-only and failed-probe assertions', () => {
    expect(parseToolFailureRepairEvidence({ classKey: candidate.classKey, deployedRevision: 'runtime-8' })).toBeNull();
    expect(parseToolFailureRepairEvidence({ ...positiveProbe, passed: false })).toBeNull();
    expect(parseToolFailureRepairEvidence({ ...contractChange, changeRef: '' })).toBeNull();
  });
});

describe('decideToolFailurePositiveRepair', () => {
  it('rejects non-tool-error sources and missing class identity', () => {
    expect(decideToolFailurePositiveRepair({ ...candidate, watchdogKey: 'smoke-fail:x' }, positiveProbe)).toMatchObject({
      resolve: false,
      reason: 'not-repeated-tool-error',
    });
    expect(decideToolFailurePositiveRepair({ ...candidate, classKey: undefined }, positiveProbe)).toMatchObject({
      resolve: false,
      reason: 'no-class-key',
    });
  });

  it('requires exact class and contract identity, never a tool-wide repair', () => {
    expect(decideToolFailurePositiveRepair(candidate, { ...positiveProbe, classKey: 'repeated-tool-error-class:other-tool' })).toMatchObject({
      resolve: false,
      reason: 'class-key-mismatch',
    });
    expect(decideToolFailurePositiveRepair(candidate, { ...positiveProbe, contractFingerprint: 'schema-42~field-limit' })).toMatchObject({
      resolve: false,
      reason: 'contract-fingerprint-mismatch',
    });
  });

  it('accepts an explicit deployed contract change for the exact failing revision', () => {
    const decision = decideToolFailurePositiveRepair(candidate, contractChange);
    expect(decision.resolve).toBe(true);
    expect(decision.reason).toContain('exact class');
    expect(decision.completionRef).toContain('commit:abc1234');
    expect(decision.evidence).toMatchObject({ verifiedHow: 'already-passing', addedTests: false });
  });

  it('accepts a passing positive probe without requiring a revision change', () => {
    const decision = decideToolFailurePositiveRepair(candidate, positiveProbe);
    expect(decision.resolve).toBe(true);
    expect(decision.evidence?.testsRun).toContain('positive probe');
  });

  it('rejects revision-only evidence and a change for another failing revision', () => {
    expect(decideToolFailurePositiveRepair(candidate, {
      ...contractChange,
      // The explicit ref alone cannot turn a revision mismatch into proof for this filing.
      fromRevision: 'runtime-6',
    })).toMatchObject({ resolve: false, reason: 'contract-change-not-for-failing-revision' });
    expect(decideToolFailurePositiveRepair(candidate, {
      ...contractChange,
      fromRevision: 'runtime-7',
      toRevision: 'runtime-7',
    })).toMatchObject({ resolve: false, reason: 'contract-change-did-not-change-revision' });
  });

  it('rejects a positive probe recorded for another failing revision', () => {
    expect(decideToolFailurePositiveRepair(candidate, {
      ...positiveProbe,
      // The class and contract strings alone are not enough when the probe claims
      // to have exercised a different deployed revision.
      deployedRevision: 'runtime-8',
    })).toMatchObject({ resolve: false, reason: 'positive-probe-not-for-failing-revision' });
  });
});
