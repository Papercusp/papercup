import { describe, expect, it } from 'vitest';

import { sealEvidence, type PreservedEvidence } from './evidence';
import { deriveJudgeView, verifyJudgeView } from './judge-view';
import { EVALUATION_TRIAL_CONTRACT_VERSION } from './identity';
import type { EvaluationTrial } from './schema';

const trial: EvaluationTrial = {
  contractVersion: EVALUATION_TRIAL_CONTRACT_VERSION,
  subject: { family: 'external-bench', corpus: 'suite', taskId: 'task', taskRevision: 'rev' },
  system: { modelId: 'model', modelVersion: null, harnessVersion: 'h', harnessGitSha: null, environmentFingerprint: null },
  configuration: { configHash: 'cfg', seed: 1, arm: null, matrixIndex: null, budgets: { capped: false, breaches: [] } },
  grader: { kind: 'deterministic', family: 'grader', version: '1', judgeModel: null },
  outcome: { status: 'failed', resolved: false, score: 0, infraFailure: false, errors: ['should not leak'] },
  usage: {},
  evidence: { privacy: 'internal' },
  lineage: { runId: 'run', sourceRef: 'external-bench:run' },
};

const evidence: PreservedEvidence = {
  privacy: 'internal',
  trajectory: [
    { index: 0, kind: 'input', role: 'user', content: '1234567890' },
    { index: 1, kind: 'model-output', role: 'assistant', content: 'abcdefghij' },
  ],
  artifacts: [{ id: 'out.txt', mediaType: 'text/plain', bytes: 4, sha256: 'f'.repeat(64), ref: 'artifact://out' }],
  submission: 'submission-abcdef',
  rawGraderOutput: 'grader-output-abcdef',
};

describe('compact judge view', () => {
  it('derives a bounded view from evidence and declares every omission', () => {
    const manifest = sealEvidence(evidence).manifest;
    const view = deriveJudgeView(trial, evidence, manifest, {
      maxSteps: 1,
      maxStepChars: 4,
      maxSubmissionChars: 5,
      maxGraderOutputChars: 6,
    });

    expect(view.steps).toHaveLength(1);
    expect(view.steps[0]).toMatchObject({ content: '1234', charsOmitted: 6 });
    expect(view.stepsOmitted).toBe(1);
    expect(view.charsOmitted).toBeGreaterThan(6);
    expect(view.complete).toBe(false);
    expect(view.derivedFrom).toBe(manifest.rootHash);
  });

  it('does not leak stored verdict fields into the judge input', () => {
    const view = deriveJudgeView(trial, evidence, sealEvidence(evidence).manifest);
    const json = JSON.stringify(view);

    expect(json).not.toContain('resolved');
    expect(json).not.toContain('failed');
    expect(json).not.toContain('score');
    expect(json).not.toContain('should not leak');
  });

  it('refuses a stored view whose content, evidence, or trial identity moved', () => {
    const manifest = sealEvidence(evidence).manifest;
    const view = deriveJudgeView(trial, evidence, manifest);
    const tampered = { ...view, steps: [{ ...view.steps[0], content: 'tampered' }] };
    const changedTrial = { ...trial, lineage: { ...trial.lineage, runId: 'other-run' } };

    expect(verifyJudgeView(tampered, changedTrial, { ...manifest, rootHash: '0'.repeat(64) }).failures.map((f) => f.kind)).toEqual(
      expect.arrayContaining(['view-hash-mismatch', 'evidence-mismatch', 'trial-mismatch']),
    );
  });
});
