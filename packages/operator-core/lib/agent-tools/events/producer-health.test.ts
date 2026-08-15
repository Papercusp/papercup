import { describe, expect, it, vi } from 'vitest';

const snapshot = vi.hoisted(() => vi.fn());
vi.mock('../../git-pipeline-stats', () => ({ gitPipelineSnapshot: snapshot }));

import { resolveProducerHealthCertificate } from './producer-health';

describe('raw wait producer-health adapter', () => {
  it('reads authoritative checkpoint state and derives identity, ownership, cadence, and deadline', async () => {
    snapshot.mockResolvedValueOnce({
      slug: 'papercusp',
      generatedAtMs: 9_000,
      routines: {
        gitSync: null,
        greenCheckpoint: { name: 'green-checkpoint', active: true, cron: null, lastFiredAtMs: 7_500, nextFireAtMs: null },
        releaseTrigger: null,
      },
      activeRun: { active: true, candidate: 'abc123', startedAtMs: 8_000, elapsedSec: 1 },
      recent: [],
    });

    await expect(
      resolveProducerHealthCertificate({
        producerHealth: {
          kind: 'green-checkpoint',
          pipeline: 'papercusp',
          candidate_sha: 'abc1',
          expected_cadence_sec: 120,
          work_item_id: 'WI-1',
        },
        subscriberId: 'su-waiter',
        timeoutSec: 30,
        nowMs: 10_000,
      }),
    ).resolves.toMatchObject({
      producer: { kind: 'green-checkpoint', id: 'abc123' },
      owner: { ownerId: 'su-waiter', workItemId: 'WI-1' },
      issuedAtMs: 10_000,
      lastProgressAtMs: 8_000,
      expectedCadenceMs: 120_000,
      verificationDeadlineMs: 40_000,
      details: { pipeline: 'papercusp', candidateSha: 'abc1' },
    });
    expect(snapshot).toHaveBeenCalledWith('papercusp', { includeActiveRun: true });
  });

  it('rejects an unknown pipeline instead of registering a cross-wired verified wait', async () => {
    snapshot.mockResolvedValueOnce({
      slug: 'not-a-pipeline',
      generatedAtMs: 9_000,
      routines: { gitSync: null, greenCheckpoint: null, releaseTrigger: null },
      activeRun: null,
      recent: [],
    });

    await expect(
      resolveProducerHealthCertificate({
        producerHealth: {
          kind: 'green-checkpoint',
          pipeline: 'not-a-pipeline',
          expected_cadence_sec: 120,
        },
        subscriberId: 'su-waiter',
      }),
    ).rejects.toThrow('unknown green-checkpoint pipeline: not-a-pipeline');
  });
});
