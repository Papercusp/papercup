import { describe, expect, it } from 'vitest';

import { sealEvidence, type PreservedEvidence } from './evidence';
import { replayTrialEvidence, verifyEvidence } from './integrity';
import { deriveJudgeView } from './judge-view';
import { EVALUATION_TRIAL_CONTRACT_VERSION, computeTrialIdentity } from './identity';
import type { EvaluationTrial } from './schema';

function trial(): EvaluationTrial {
  return {
    contractVersion: EVALUATION_TRIAL_CONTRACT_VERSION,
    subject: { family: 'llm-testing', corpus: 'operator', taskId: 'su-S11', taskRevision: 'scenario-1' },
    system: {
      modelId: 'model-a',
      modelVersion: null,
      harnessVersion: 'h1',
      harnessGitSha: null,
      environmentFingerprint: null,
    },
    configuration: { configHash: 'cfg-1', seed: 1, arm: null, matrixIndex: 0, budgets: { capped: false, breaches: [] } },
    grader: { kind: 'llm-judge', family: 'llm-testing', version: 'grader-1', judgeModel: 'judge-a' },
    outcome: { status: 'passed', resolved: true, score: 1, infraFailure: false, errors: [] },
    usage: { tokensIn: null, tokensOut: null, tokensTotal: null, costUsd: null },
    evidence: { trajectoryRef: 'traj', trajectoryKind: 'transcript-zstd', privacy: 'internal', contentHash: null },
    lineage: { runId: 'run-1', sourceRef: 'llm-testing:run-1' },
    startedAt: '2026-08-26T00:00:00.000Z',
    finishedAt: '2026-08-26T00:01:00.000Z',
  };
}

function evidence(): PreservedEvidence {
  return {
    privacy: 'internal',
    environment: { os: 'linux', runtime: 'node-26', gitSha: 'a'.repeat(40), env: { SAFE: '1' } },
    trajectory: [
      { index: 0, kind: 'input', at: '2026-08-26T00:00:00.000Z', role: 'user', content: 'solve it' },
      { index: 1, kind: 'tool-call', at: '2026-08-26T00:00:10.000Z', name: 'bash', content: 'npm test' },
      { index: 2, kind: 'tool-result', at: '2026-08-26T00:00:20.000Z', name: 'bash', content: 'pass' },
    ],
    artifacts: [
      { id: 'b.log', mediaType: 'text/plain', bytes: 1, sha256: 'b'.repeat(64), ref: 'artifact://b' },
      { id: 'a.log', mediaType: 'text/plain', bytes: 1, sha256: 'a'.repeat(64), ref: 'artifact://a' },
    ],
    submission: 'diff --git a/file b/file',
    rawGraderOutput: '{"score":1}',
  };
}

describe('evidence sealing and replay integrity', () => {
  it('keeps trajectory order significant while artifact order is a set', () => {
    const base = sealEvidence(evidence()).manifest.rootHash;

    const reorderedTrajectory = evidence();
    reorderedTrajectory.trajectory = [...reorderedTrajectory.trajectory].reverse();
    expect(sealEvidence(reorderedTrajectory).manifest.rootHash).not.toBe(base);

    const reorderedArtifacts = evidence();
    reorderedArtifacts.artifacts = [...reorderedArtifacts.artifacts].reverse();
    expect(sealEvidence(reorderedArtifacts).manifest.rootHash).toBe(base);
  });

  it('distinguishes not-recorded from recorded-absent evidence slots', () => {
    const notRecorded = evidence();
    delete notRecorded.submission;
    const recordedAbsent = evidence();
    recordedAbsent.submission = null;

    expect(sealEvidence(notRecorded).manifest.rootHash).not.toBe(sealEvidence(recordedAbsent).manifest.rootHash);
  });

  it('reports corruption, missing artifacts, unsealed envelopes, and identity mismatch distinctly', () => {
    const sealed = sealEvidence(evidence());
    const corrupted = evidence();
    corrupted.submission = 'different submission';

    const report = verifyEvidence({
      manifest: sealed.manifest,
      evidence: corrupted,
      envelope: { contentHash: undefined },
      trial: trial(),
      expectedIdentity: { ...computeTrialIdentity(trial()), bindingHash: '0'.repeat(64) },
      unresolvedRefs: ['artifact://missing'],
    });

    expect(report.ok).toBe(false);
    expect(report.findings.map((f) => f.kind)).toEqual(
      expect.arrayContaining(['evidence-corrupt', 'artifact-missing', 'evidence-unsealed', 'identity-mismatch']),
    );
  });

  it('replays the derived judge view byte-for-byte when evidence and stored view match', () => {
    const preserved = evidence();
    const sealed = sealEvidence(preserved);
    const t = { ...trial(), evidence: { ...trial().evidence, contentHash: sealed.manifest.rootHash } };
    const view = deriveJudgeView(t, preserved, sealed.manifest);

    const replay = replayTrialEvidence({
      trial: t,
      evidence: preserved,
      manifest: sealed.manifest,
      envelope: t.evidence,
      expectedIdentity: computeTrialIdentity(t),
      storedJudgeView: view,
    });

    expect(replay.ok).toBe(true);
    expect(replay.judgeViewReproduced).toBe(true);
  });
});
