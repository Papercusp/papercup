import { describe, expect, it } from 'vitest';

import { sealEvidence, type PreservedEvidence } from './evidence';
import { EVALUATION_TRIAL_CONTRACT_VERSION, computeTrialIdentity } from './identity';
import { toInspectCompatibleEvaluation, toOpenTelemetryOpenInferenceTrace } from './portable';
import type { EvaluationTrial } from './schema';

const trial: EvaluationTrial = {
  contractVersion: EVALUATION_TRIAL_CONTRACT_VERSION,
  subject: { family: 'llm-testing', corpus: 'operator', taskId: 'task', taskRevision: 'scenario' },
  system: { modelId: 'model-a', modelVersion: '2026-08-01', harnessVersion: 'h1', harnessGitSha: 'a'.repeat(40), environmentFingerprint: 'env' },
  configuration: { configHash: 'cfg', seed: 7, arm: 'arm-a', matrixIndex: 0, budgets: { tokens: 100, capped: false, breaches: [] } },
  grader: { kind: 'llm-judge', family: 'rubric', version: 'v1', judgeModel: 'judge-model' },
  outcome: { status: 'passed', resolved: true, score: 1, infraFailure: false, errors: [] },
  usage: { tokensIn: 1, tokensOut: 2, tokensTotal: 3 },
  evidence: { trajectoryRef: 'traj://1', trajectoryKind: 'transcript-zstd', privacy: 'internal' },
  lineage: { runId: 'run-1', groupId: 'group-1', repeat: 7, sourceRef: 'llm-testing:run-1' },
  startedAt: '2026-08-26T00:00:00.000Z',
  finishedAt: '2026-08-26T00:00:01.000Z',
};

const evidence: PreservedEvidence = {
  privacy: 'internal',
  environment: { os: 'linux', runtime: 'node-26', raw: { cpu: 'x86_64' } },
  trajectory: [
    { index: 0, kind: 'input', role: 'user', content: 'full prompt' },
    { index: 1, kind: 'model-output', role: 'assistant', content: 'full answer' },
  ],
  artifacts: [{ id: 'report.json', mediaType: 'application/json', bytes: 17, sha256: 'c'.repeat(64), ref: 'artifact://report' }],
  submission: 'full submission',
  rawGraderOutput: '{"raw":true}',
};

describe('portable evaluation evidence adapters', () => {
  it('projects an Inspect-compatible view without losing the canonical payload', () => {
    const manifest = sealEvidence(evidence).manifest;
    const projected = toInspectCompatibleEvaluation(trial, evidence, manifest);
    const identity = computeTrialIdentity(trial);

    expect(projected.sample.id).toBe(identity.trialKey);
    expect(projected.sample.metadata.evidenceRootHash).toBe(manifest.rootHash);
    expect(projected.messages.map((m) => m.content)).toEqual(['full prompt', 'full answer']);
    expect(projected.files).toEqual([
      { name: 'report.json', ref: 'artifact://report', mediaType: 'application/json', bytes: 17, sha256: 'c'.repeat(64) },
    ]);
    expect(projected.papercusp).toEqual({ trial, evidence, manifest });
  });

  it('projects OTEL/OpenInference spans and carries exact trajectory content plus canonical evidence', () => {
    const manifest = sealEvidence(evidence).manifest;
    const projected = toOpenTelemetryOpenInferenceTrace(trial, evidence, manifest);
    const span = projected.resourceSpans[0].scopeSpans[0].spans[0];

    expect(span.attributes['papercusp.evidence_root_hash']).toBe(manifest.rootHash);
    expect(span.attributes['openinference.span.kind']).toBe('CHAIN');
    expect(span.events.map((event) => event.attributes['papercusp.step.content'])).toEqual(['full prompt', 'full answer']);
    expect(projected.papercusp).toEqual({ trial, evidence, manifest });
  });
});
