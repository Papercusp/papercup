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
          owner_id: 'su-producer',
          work_item_id: 'WI-1',
        },
        subscriberId: 'su-waiter',
        timeoutSec: 30,
        nowMs: 10_000,
      }),
    ).resolves.toMatchObject({
      producer: { kind: 'green-checkpoint', id: 'abc123' },
      owner: { ownerId: 'su-producer', workItemId: 'WI-1' },
      issuedAtMs: 10_000,
      lastProgressAtMs: 8_000,
      expectedCadenceMs: 120_000,
      verificationDeadlineMs: 40_000,
      details: { pipeline: 'papercusp', candidateSha: 'abc1' },
    });
    expect(snapshot).toHaveBeenCalledWith('papercusp', { includeActiveRun: true });
  });

  it('preserves unknown producer ownership instead of assigning the subscriber as owner', async () => {
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
          expected_cadence_sec: 120,
        },
        subscriberId: 'su-waiter',
        nowMs: 10_000,
      }),
    ).resolves.toMatchObject({ owner: { ownerId: null, workItemId: null } });
  });

  it('rejects an unknown pipeline instead of registering a cross-wired verified wait', async () => {
    snapshot.mockResolvedValueOnce({
      slug: 'not-a-pipeline',
      generatedAtMs: 9_000,
      routines: { gitSync: null, greenCheckpoint: null, releaseTrigger: null },
      activeRun: null,
      recent: [],
    }).mockResolvedValueOnce({
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
          pipeline: 'green-checkpoint',
          expected_cadence_sec: 120,
        },
        subscriberId: 'su-waiter',
      }),
    ).rejects.toThrow(
      'unknown green-checkpoint pipeline: green-checkpoint. Use the sanitized integration-root basename from the event key (for example "papercusp" in release:green:papercusp), not the routine name "green-checkpoint"; no wait was registered.',
    );

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
