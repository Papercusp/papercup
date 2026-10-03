import { describe, expect, it } from 'vitest';
import { validateLearningContract, type LearningContract } from './types';

const baseContract = (overrides: Partial<LearningContract> = {}): LearningContract => ({
  contractVersion: '1',
  candidate: {
    id: 'candidate-1',
    version: 'v2',
    parentVersion: 'v1',
    variantHash: 'variant-hash',
    actor: { kind: 'agent', id: 'su-1', role: 'scout' },
    potScope: { potId: 'pot-1', workspaceId: 'workspace-1' },
    createdAt: '2026-09-04T00:00:00.000Z',
  },
  experiment: {
    batteryId: 'battery-1',
    testId: 'replay',
    baselineId: 'baseline',
    challengerId: 'candidate-1',
    taskHash: 'task-hash',
    modelHash: 'model-hash',
    promptHash: 'prompt-hash',
    rubricHash: 'rubric-hash',
    codeHash: 'code-hash',
    repeats: 3,
    startedAt: '2026-09-04T00:01:00.000Z',
    completedAt: '2026-09-04T00:02:00.000Z',
  },
  evidence: [
    {
      id: 'quality',
      kind: 'objective',
      status: 'pass',
      coverage: { required: 10, measured: 10 },
      artifactRefs: ['experiment:battery-1'],
      recordedAt: '2026-09-04T00:03:00.000Z',
    },
  ],
  spend: { requestedUsd: 2, reservedUsd: 2, usedUsd: 1.5, unsettledUsd: 0.5 },
  decision: {
    verdict: 'accepted',
    authority: { kind: 'system', id: 'gym-verdict' },
    reason: 'All required gates passed on the pinned battery.',
    evidenceIds: ['quality'],
    decidedAt: '2026-09-04T00:04:00.000Z',
  },
  activation: {
    version: 'v2',
    parentVersion: 'v1',
    rollbackVersion: 'v1',
    exposure: { population: 'pot-1', percentage: 10 },
    activatedAt: '2026-09-04T00:05:00.000Z',
  },
  outcomes: [{ status: 'pending' }],
  ...overrides,
});

describe('validateLearningContract', () => {
  it('accepts a complete evidence-backed candidate lifecycle', () => {
    expect(validateLearningContract(baseContract())).toEqual({ ok: true, errors: [] });
  });

  it('retains unknown execution pins while refusing their acceptance and activation', () => {
    const contract = baseContract({ experiment: { ...baseContract().experiment,
      modelHash: null, promptHash: null, codeHash: null } });
    expect(validateLearningContract(contract)).toMatchObject({ ok: false, errors: expect.arrayContaining([
      'experiment.modelHash must be non-empty', 'experiment.promptHash must be non-empty',
      'experiment.codeHash must be non-empty',
    ]) });
  });

  it('fails closed when an accepted candidate has incomplete or unmeasured evidence', () => {
    const result = validateLearningContract(
      baseContract({
        evidence: [
          {
            id: 'regression',
            kind: 'regression',
            status: 'not-measured',
            coverage: { required: 4, measured: 0 },
            artifactRefs: ['probe:run-1'],
            recordedAt: '2026-09-04T00:03:00.000Z',
          },
        ],
        decision: {
          ...baseContract().decision,
          evidenceIds: ['regression'],
        },
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        'accepted decision has not-measured evidence: regression',
        'accepted decision has incomplete evidence: regression',
      ]),
    );
  });

  it('rejects alternate or unsafe lifecycle edges', () => {
    const result = validateLearningContract(
      baseContract({
        experiment: { ...baseContract().experiment, baselineId: 'candidate-1', challengerId: 'candidate-1' },
        spend: { requestedUsd: 1, reservedUsd: 2, usedUsd: 2, unsettledUsd: 1 },
        decision: { ...baseContract().decision, evidenceIds: ['missing'] },
        activation: { ...baseContract().activation!, rollbackVersion: '' },
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        'experiment baseline and challenger must differ',
        'spend.reservedUsd cannot exceed requestedUsd',
        'spend.usedUsd + unsettledUsd cannot exceed reservedUsd',
        'decision references unknown evidence: missing',
        'activation.rollbackVersion must be non-empty',
      ]),
    );
  });

  it('requires an accepted decision before activation', () => {
    const result = validateLearningContract(
      baseContract({ decision: { ...baseContract().decision, verdict: 'inconclusive' } }),
    );
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('activation requires an accepted decision');
  });
});
