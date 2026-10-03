import { describe, expect, it } from 'vitest';
import {
  LEARNING_PRODUCERS,
  adaptCalibrationOutput,
  adaptGymOutput,
  adaptRedQueenOutput,
  adaptRegretOutput,
  adaptScoutOutput,
  adaptTransferOutput,
  canRetireLegacyWriter,
  contractArtifactRefs,
  evaluateLifecycleParity,
  type ProducerLifecycleInput,
} from './lifecycle-adapter';

const baseInput = (verdict: ProducerLifecycleInput['verdict'] = 'accept'): ProducerLifecycleInput => ({
  candidate: {
    id: 'candidate-1', version: 'v2', parentVersion: 'v1', variantHash: 'variant-hash',
    actor: { kind: 'agent', id: 'agent-1' }, potScope: { potId: 'pot-1', workspaceId: 'ws-1' }, createdAt: '2026-09-05T00:00:00.000Z',
  },
  experiment: {
    batteryId: 'battery-1', testId: 'replay', baselineId: 'baseline', challengerId: 'candidate-1', taskHash: 'task-hash', modelHash: 'model-hash', promptHash: 'prompt-hash', rubricHash: 'rubric-hash', codeHash: 'code-hash', repeats: 2, startedAt: '2026-09-05T00:00:00.000Z', completedAt: '2026-09-05T00:01:00.000Z',
  },
  evidence: [
    { id: 'objective-1', kind: 'objective', status: 'pass', coverage: { required: 2, measured: 2 }, artifactRefs: ['legacy:objective-1'], recordedAt: '2026-09-05T00:01:00.000Z' },
    { id: 'regression-1', kind: 'regression', status: 'pass', coverage: { required: 2, measured: 2 }, artifactRefs: ['legacy:regression-1'], recordedAt: '2026-09-05T00:01:00.000Z' },
  ],
  spend: { requestedUsd: 2, reservedUsd: 2, usedUsd: 1.5, unsettledUsd: 0, settledAt: '2026-09-05T00:01:00.000Z' },
  verdict,
  authority: { kind: 'system', id: 'lifecycle-adapter-test' },
  reason: 'measured evidence satisfies the common lifecycle',
  decidedAt: '2026-09-05T00:01:00.000Z',
  outcomes: [{ status: 'matured', measuredAt: '2026-09-05T00:01:00.000Z', value: 1, artifactRefs: ['legacy:objective-1'] }],
});

describe('P-011 common candidate/evidence/decision lifecycle', () => {
  it('preserves discovery output without inventing promotion evidence for any producer', () => {
    const adapters = [adaptScoutOutput, adaptGymOutput, adaptCalibrationOutput, adaptTransferOutput, adaptRegretOutput, adaptRedQueenOutput];
    for (const [index, adapt] of adapters.entries()) {
      const result = adapt({
        stage: 'observation', workspaceId: 'ws-1', sourceRef: `${LEARNING_PRODUCERS[index]}:source-1`,
        recordedAt: '2026-10-03T00:00:00.000Z',
        source: { status: 'accepted', model_spec: null, budget_spent_usd: null, signal_origin: 'drill' },
      });
      expect(result).toMatchObject({
        producer: LEARNING_PRODUCERS[index], stage: 'observation', contract: null, promotionAllowed: false,
        source: { status: 'accepted', model_spec: null, budget_spent_usd: null, signal_origin: 'drill' },
        missing: ['candidate', 'experiment', 'evidence', 'spend', 'decision'],
      });
    }
  });

  it('hashes the actual source consistently and excludes the previous receipt', () => {
    const input = {
      stage: 'observation' as const, workspaceId: 'ws-1', sourceRef: 'gym:source-1',
      recordedAt: '2026-10-03T00:00:00.000Z', source: { status: 'pending', pins: { b: 2, a: 1 } },
    };
    const first = adaptGymOutput(input);
    expect(adaptGymOutput({ ...input, source: { pins: { a: 1, b: 2 }, status: 'pending', learning_lifecycle: first } }).sourceHash).toBe(first.sourceHash);
    expect(adaptGymOutput({ ...input, source: { ...input.source, status: 'accepted' } }).sourceHash).not.toBe(first.sourceHash);
  });

  it('adapts every producer through the same validated contract', () => {
    const adapters = [adaptScoutOutput, adaptGymOutput, adaptCalibrationOutput, adaptTransferOutput, adaptRegretOutput, adaptRedQueenOutput];
    expect(LEARNING_PRODUCERS).toEqual(['scout', 'gym', 'calibration', 'transfer', 'regret', 'red-queen']);
    for (const [index, adapt] of adapters.entries()) {
      const result = adapt(baseInput());
      expect(result.producer).toBe(LEARNING_PRODUCERS[index]);
      expect(result.validation).toEqual({ ok: true, errors: [] });
      expect(result.contract.contractVersion).toBe('1');
      expect(result.contract.decision.verdict).toBe('accepted');
    }
  });

  it('preserves partial evaluation through later writes, marks changed source stale, and never allows promotion', () => {
    const input = { stage: 'observation' as const, workspaceId: 'ws-1', sourceRef: 'transfer:lesson',
      recordedAt: '2026-10-03T00:00:00Z', source: { status: 'passed', last_battery_id: 'actual-battery' } };
    const evaluation = { experiment: { batteryId: 'actual-battery', codeHash: null }, reservation: { id: 'actual-reservation', status: 'open' } };
    const first = adaptTransferOutput({ ...input, evaluation });
    expect(first).toMatchObject({ evaluation, evaluationCurrent: true, contract: null, promotionAllowed: false });
    const linked = adaptTransferOutput({ ...input, source: { ...input.source, memory_id: 'memory', learning_lifecycle: first } });
    expect(linked).toMatchObject({ evaluation, evaluationCurrent: false, contract: null, promotionAllowed: false });
    const next = adaptTransferOutput({ ...input, source: { status: 'error', learning_lifecycle: linked } });
    expect(next.evaluation).toEqual(evaluation);
    expect(next.evaluationSourceHash).toBe(first.sourceHash);
    expect(next.evaluationCurrent).toBe(false);
  });

  it('maps rejection and inconclusive producer outputs without allowing activation', () => {
    const rejected = adaptGymOutput(baseInput('reject'));
    expect(rejected.validation.ok).toBe(true);
    expect(rejected.contract.decision.verdict).toBe('rejected');
    const inconclusive = adaptScoutOutput(baseInput('inconclusive'));
    expect(inconclusive.validation.ok).toBe(true);
    expect(inconclusive.contract.decision.verdict).toBe('inconclusive');
  });

  it('fails closed when an accepted producer has incomplete or failed evidence', () => {
    const input = baseInput();
    input.evidence = [{ ...input.evidence[0]!, status: 'not-measured', coverage: { required: 2, measured: 1 } }];
    const result = adaptTransferOutput(input);
    expect(result.validation.ok).toBe(false);
    expect(result.validation.errors).toEqual(expect.arrayContaining([
      'accepted decision has not-measured evidence: objective-1',
      'accepted decision has incomplete evidence: objective-1',
    ]));
  });

  it('requires artifact identity and evidence-kind parity before legacy retirement', () => {
    const contract = adaptRegretOutput(baseInput()).contract;
    const parity = evaluateLifecycleParity({
      producer: 'regret', contract,
      legacyArtifactRefs: ['legacy:objective-1', 'legacy:regression-1'],
      requiredEvidenceKinds: ['objective', 'regression'],
    });
    expect(parity.ok).toBe(true);
    expect(contractArtifactRefs(contract)).toEqual(['legacy:objective-1', 'legacy:regression-1']);
    expect(canRetireLegacyWriter({ parity, remainingLegacyWrites: 1 })).toBe(false);
    expect(canRetireLegacyWriter({ parity, remainingLegacyWrites: 0 })).toBe(true);
  });

  it('keeps a missing legacy artifact or evidence kind from looking like parity', () => {
    const contract = adaptRedQueenOutput(baseInput()).contract;
    const parity = evaluateLifecycleParity({ producer: 'red-queen', contract, legacyArtifactRefs: ['legacy:drill-1'], requiredEvidenceKinds: ['probe'] });
    expect(parity.ok).toBe(false);
    expect(parity.missingArtifactRefs).toEqual(['legacy:drill-1']);
    expect(parity.missingEvidenceKinds).toEqual(['probe']);
    expect(canRetireLegacyWriter({ parity, remainingLegacyWrites: 0 })).toBe(false);
  });
});
