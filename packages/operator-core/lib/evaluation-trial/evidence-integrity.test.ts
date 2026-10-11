import { describe, expect, it } from 'vitest';

import { sealEvidence, type PreservedEvidence } from './evidence';
import { replayTrialEvidence, verifyEvidence, type WorkloadCompletionRequirements } from './integrity';
import { createHash } from 'node:crypto';
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

describe('declared workload completion integrity', () => {
  const hash = (text: string) => createHash('sha256').update(text).digest('hex');
  const context = 'Permitted frozen context: dependency A is ready.';
  const requirements = (): WorkloadCompletionRequirements => ({
    artifacts: [{ id: 'answer.txt', minBytes: 1, sha256: hash('answer') }],
    transitions: [{ id: 'finish', subjectRef: 'WI-fixture', from: 'wip', to: 'done' }],
    context: [{ id: 'dependency-context', consumer: 'solver', sha256: hash(context) }],
    downstream: { id: 'answer-correctness', value: true, graderRef: 'deterministic-answer-v1' },
  });
  function fixture() {
    const t = trial();
    const identity = computeTrialIdentity(t);
    const metadata = { trialBindingHash: identity.bindingHash, runId: t.lineage.runId, receiptRef: 'fixture:resolved-ledger-receipt' };
    const preserved: PreservedEvidence = { privacy: 'internal', artifacts: [
      { id: 'answer.txt', mediaType: 'text/plain', bytes: 6, sha256: hash('answer'), ref: 'fixture:answer' },
    ], trajectory: [
      { index: 0, kind: 'input', role: 'solver', content: context, metadata: { ...metadata, contextId: 'dependency-context' } },
      { index: 1, kind: 'tool-result', name: 'work_items:get', content: 'durable done state', metadata: {
        ...metadata, durableTransition: { id: 'finish', subjectRef: 'WI-fixture', from: 'wip', to: 'done' },
      } },
      { index: 2, kind: 'tool-result', name: 'deterministic-answer-grader', content: 'correct', metadata: {
        ...metadata, workloadOutcome: { id: 'answer-correctness', value: true, graderRef: 'deterministic-answer-v1' },
      } },
    ] };
    const contents = [{ id: 'answer.txt', ref: 'fixture:answer', content: Buffer.from('answer') }];
    const verify = (value = preserved, completion = requirements(), resolvedArtifactContents = contents) => {
      // Re-sealing mutations isolates completion semantics from generic corruption.
      const sealed = sealEvidence(value);
      return verifyEvidence({ trial: t, expectedIdentity: identity, evidence: value, manifest: sealed.manifest,
        envelope: sealed.envelope, completionRequirements: completion, resolvedArtifactContents });
    };
    return { preserved, verify, contents };
  }

  it('checks artifacts, actual input bytes, durable transitions and downstream outcome together', () => {
    const { verify } = fixture();
    expect(verify()).toMatchObject({ ok: true, findings: [] });
    expect(verify().completionRequirementsHash).toMatch(/^[a-f0-9]{64}$/);
    const changed = requirements(); changed.downstream.value = false;
    expect(verify(undefined, changed).completionRequirementsHash).not.toBe(verify().completionRequirementsHash);
  });

  it('refuses a process-exit-zero record even when its own evidence is correctly sealed', () => {
    const { verify } = fixture();
    const exited: PreservedEvidence = { privacy: 'internal', artifacts: [], trajectory: [
      { index: 0, kind: 'tool-result', name: 'process', content: 'exit=0', metadata: { exitCode: 0 } },
    ] };
    expect(verify(exited).findings.map(f => f.kind)).toEqual(expect.arrayContaining([
      'completion-artifact-missing', 'context-delivery-mismatch', 'durable-transition-missing', 'downstream-outcome-missing',
    ]));
  });

  it.each(['absent', 'changed', 'truncated', 'duplicate', 'foreign-ref'])
    ('checks resolved completion artifact bytes rather than trusting descriptors: %s', defect => {
      const { verify, contents } = fixture();
      let resolved = contents;
      if (defect === 'absent') resolved = [];
      if (defect === 'changed') resolved = [{ ...contents[0], content: Buffer.from('wrong!') }];
      if (defect === 'truncated') resolved = [{ ...contents[0], content: Buffer.from('ans') }];
      if (defect === 'duplicate') resolved = [contents[0], contents[0]];
      if (defect === 'foreign-ref') resolved = [{ ...contents[0], ref: 'fixture:other-arm-answer' }];
      // The evidence, seal and declared descriptor are all unchanged.
      expect(verify(undefined, undefined, resolved).findings.map(f => f.kind)).toContain('completion-artifact-missing');
    });

  it('forwards resolved workload artifact bytes through replay', () => {
    const { preserved, contents } = fixture(); const t = trial(); const sealed = sealEvidence(preserved);
    const input = { trial: t, expectedIdentity: computeTrialIdentity(t), evidence: preserved,
      manifest: sealed.manifest, envelope: sealed.envelope, completionRequirements: requirements() };
    expect(replayTrialEvidence({ ...input, resolvedArtifactContents: contents }).ok).toBe(true);
    expect(replayTrialEvidence(input).integrity.findings.map(f => f.kind)).toContain('completion-artifact-missing');
  });

  it.each(['wrong-bytes', 'retrieved-only', 'wrong-consumer', 'foreign-run', 'foreign-binding', 'missing-receipt', 'duplicate-input'])
    ('refuses context delivery defect %s', defect => {
      const { preserved, verify } = fixture(); const input = preserved.trajectory[0];
      if (defect === 'wrong-bytes') input.content += 'changed';
      if (defect === 'retrieved-only') input.kind = 'tool-result';
      if (defect === 'wrong-consumer') input.role = 'another-solver';
      if (defect === 'foreign-run') input.metadata!.runId = 'another-run';
      if (defect === 'foreign-binding') input.metadata!.trialBindingHash = 'foreign';
      if (defect === 'missing-receipt') delete input.metadata!.receiptRef;
      if (defect === 'duplicate-input') preserved.trajectory.push({ ...input, index: 3 });
      expect(verify().findings.map(f => f.kind)).toContain('context-delivery-mismatch');
    });

  it.each(['missing-artifact', 'empty-artifact', 'wrong-artifact', 'duplicate-artifact', 'wrong-transition', 'transition-before-input', 'wrong-outcome', 'outcome-before-transition'])
    ('refuses declared completion defect %s', defect => {
      const { preserved, verify } = fixture();
      if (defect === 'missing-artifact') preserved.artifacts = [];
      if (defect === 'empty-artifact') preserved.artifacts[0].bytes = 0;
      if (defect === 'wrong-artifact') preserved.artifacts[0].sha256 = hash('wrong');
      if (defect === 'duplicate-artifact') preserved.artifacts.push({ ...preserved.artifacts[0] });
      if (defect === 'wrong-transition') preserved.trajectory[1].metadata!.durableTransition = { id: 'finish', subjectRef: 'WI-other', from: 'wip', to: 'done' };
      if (defect === 'wrong-outcome') preserved.trajectory[2].metadata!.workloadOutcome = { ...requirements().downstream, value: false };
      if (defect === 'transition-before-input') {
        [preserved.trajectory[0], preserved.trajectory[1]] = [preserved.trajectory[1], preserved.trajectory[0]];
        preserved.trajectory.forEach((step, index) => { step.index = index; });
      }
      if (defect === 'outcome-before-transition') {
        [preserved.trajectory[1], preserved.trajectory[2]] = [preserved.trajectory[2], preserved.trajectory[1]];
        preserved.trajectory.forEach((step, index) => { step.index = index; });
      }
      expect(verify().ok).toBe(false);
    });

  it('refuses an empty completion contract or an unbound trial', () => {
    const { preserved, verify } = fixture(); const empty = requirements(); empty.artifacts = [];
    expect(verify(undefined, empty).findings.map(f => f.kind)).toContain('completion-contract-invalid');
    const sealed = sealEvidence(preserved);
    expect(verifyEvidence({ evidence: preserved, manifest: sealed.manifest, envelope: sealed.envelope,
      completionRequirements: requirements() }).findings.map(f => f.kind)).toContain('identity-mismatch');
  });

  it('preserves completion checks through the existing replay entry point', () => {
    const { preserved } = fixture(); preserved.artifacts = [];
    const sealed = sealEvidence(preserved); const t = trial();
    expect(replayTrialEvidence({ trial: t, expectedIdentity: computeTrialIdentity(t), evidence: preserved,
      manifest: sealed.manifest, envelope: sealed.envelope, completionRequirements: requirements() }).integrity.findings
      .map(f => f.kind)).toContain('completion-artifact-missing');
  });

  function dependencyFixture() {
    const { preserved, verify } = fixture();
    const dependencyContext = 'Observed dependency result: answer';
    const first = { id: 'dependency-finish', subjectRef: 'WI-dependency', from: 'wip', to: 'done', afterContextIds: ['dependency-context'] };
    const completion: WorkloadCompletionRequirements = {
      ...requirements(),
      transitions: [first, { ...requirements().transitions[0], afterContextIds: ['result-context'] }],
      context: [...requirements().context, {
        id: 'result-context', consumer: 'solver', sha256: hash(dependencyContext), afterTransitionId: first.id,
      }],
    };
    const receipt = preserved.trajectory[1];
    preserved.trajectory.splice(1, 0,
      { ...receipt, metadata: { ...receipt.metadata, durableTransition: first } },
      { ...preserved.trajectory[0], content: dependencyContext,
        metadata: { ...receipt.metadata, contextId: 'result-context' } });
    preserved.trajectory.forEach((step, index) => { step.index = index; });
    return { preserved, verify, completion };
  }

  it('accepts dependency completion followed by consumed result context and dependent completion', () => {
    const { verify, completion } = dependencyFixture();
    expect(verify(undefined, completion)).toMatchObject({ ok: true, findings: [] });
  });

  it('refuses declared transitions observed in reverse order', () => {
    const { preserved, verify } = fixture();
    const start = { id: 'start', subjectRef: 'WI-fixture', from: 'open', to: 'wip' };
    const completion = requirements();
    completion.transitions.unshift(start);
    // Correct subject/states, receipts and context; only the order is wrong.
    const receipt = preserved.trajectory[1];
    preserved.trajectory.splice(2, 0, { ...receipt, metadata: { ...receipt.metadata, durableTransition: start } });
    preserved.trajectory.forEach((step, index) => { step.index = index; });
    expect(verify(undefined, completion).findings.map(f => f.kind)).toContain('durable-transition-missing');
  });

  it('refuses dependency-result context delivered before its producing transition', () => {
    const { preserved, verify, completion } = dependencyFixture();
    [preserved.trajectory[1], preserved.trajectory[2]] = [preserved.trajectory[2], preserved.trajectory[1]];
    preserved.trajectory.forEach((step, index) => { step.index = index; });
    expect(verify(undefined, completion).findings.map(f => f.kind)).toContain('context-delivery-mismatch');
  });

  it.each(['unknown-context', 'duplicate-context', 'unknown-transition', 'cyclic-dependency'])
    ('refuses completion prerequisite defect %s', defect => {
      const { verify, completion } = dependencyFixture();
      if (defect === 'unknown-context') completion.transitions[0].afterContextIds = ['missing-context'];
      if (defect === 'duplicate-context') completion.transitions[0].afterContextIds = ['dependency-context', 'dependency-context'];
      if (defect === 'unknown-transition') completion.context[1].afterTransitionId = 'missing-transition';
      if (defect === 'cyclic-dependency') completion.transitions[0].afterContextIds = ['result-context'];
      expect(verify(undefined, completion).findings.map(f => f.kind)).toContain('completion-contract-invalid');
    });
});
