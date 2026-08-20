import { describe, expect, it } from 'vitest';
import type { GitPipelineSnapshot } from '../../git-pipeline-stats';
import { checkpointProducerCertificate, observeCheckpointProducer } from './checkpoint-verified-wait';

function snapshot(overrides: Partial<GitPipelineSnapshot> = {}): GitPipelineSnapshot {
  return {
    slug: 'papercusp',
    generatedAtMs: 2_000,
    routines: {
      gitSync: null,
      greenCheckpoint: { name: 'green-checkpoint', active: true, cron: null, lastFiredAtMs: 1_200, nextFireAtMs: null },
      releaseTrigger: null,
    },
    activeRun: { active: true, candidate: 'abc123', startedAtMs: 1_100, elapsedSec: 1 },
    recent: [],
    ...overrides,
  } as GitPipelineSnapshot;
}

describe('checkpoint verified-wait producer adapter', () => {
  it('captures producer identity, ownership, cadence, and baseline progress', () => {
    expect(
      checkpointProducerCertificate({
        pipeline: 'papercusp',
        candidateSha: 'abc1',
        ownerId: 'su-1',
        workItemId: 'WI-1',
        issuedAtMs: 1_500,
        expectedCadenceMs: 5_000,
        verificationDeadlineMs: 6_500,
        snapshot: snapshot(),
      }),
    ).toMatchObject({
      producer: { kind: 'green-checkpoint', id: 'abc123' },
      owner: { ownerId: 'su-1', workItemId: 'WI-1' },
      lastProgressAtMs: 1_100,
      expectedCadenceMs: 5_000,
      verificationDeadlineMs: 6_500,
      details: { pipeline: 'papercusp', candidateSha: 'abc1' },
    });
  });

  it('observes an active producer without fabricating completion', async () => {
    const certificate = checkpointProducerCertificate({
      pipeline: 'papercusp', ownerId: 'su-1', issuedAtMs: 1_500,
      expectedCadenceMs: 5_000, verificationDeadlineMs: 2_000, snapshot: snapshot(),
    });
    await expect(observeCheckpointProducer(certificate, { snapshot: async () => snapshot() })).resolves.toMatchObject({
      producerPresent: true,
      completedAtMs: null,
      lastProgressAtMs: 1_100,
    });
  });

  it('uses the advancing active-run heartbeat instead of immutable startedAtMs', async () => {
    const active = {
      active: true,
      candidate: 'abc123',
      startedAtMs: 1_100,
      progressAtMs: 9_000,
      elapsedSec: 480,
    };
    const current = snapshot({ activeRun: active });
    const certificate = checkpointProducerCertificate({
      pipeline: 'papercusp',
      ownerId: 'su-1',
      issuedAtMs: 1_500,
      expectedCadenceMs: 5_000,
      verificationDeadlineMs: 2_000,
      snapshot: current,
    });
    expect(certificate.lastProgressAtMs).toBe(9_000);
    await expect(observeCheckpointProducer(certificate, { snapshot: async () => current })).resolves.toMatchObject({
      producerPresent: true,
      lastProgressAtMs: 9_000,
    });
  });

  it('recognizes a matching verdict after the certificate was issued', async () => {
    const certificate = checkpointProducerCertificate({
      pipeline: 'papercusp', candidateSha: 'abc1', ownerId: 'su-1', issuedAtMs: 1_500,
      expectedCadenceMs: 5_000, verificationDeadlineMs: 2_000, snapshot: snapshot(),
    });
    const withVerdict = snapshot({
      recent: [{ id: '1', kind: 'green_checkpoint', status: 'advanced', detail: { candidate: 'abc123' }, createdAtMs: 1_900 }],
    });
    await expect(observeCheckpointProducer(certificate, { snapshot: async () => withVerdict })).resolves.toMatchObject({
      completedAtMs: 1_900,
      lastFireAtMs: 1_900,
      evidence: { verdictStatus: 'advanced' },
    });
  });

  it('classifies an inactive missing routine as an absent producer observation', async () => {
    const certificate = checkpointProducerCertificate({
      pipeline: 'papercusp', ownerId: 'su-1', issuedAtMs: 1_500,
      expectedCadenceMs: 5_000, verificationDeadlineMs: 2_000, snapshot: snapshot(),
    });
    const absent = snapshot({ activeRun: { active: false, candidate: null, startedAtMs: null, elapsedSec: null }, routines: { gitSync: null, greenCheckpoint: null, releaseTrigger: null } });
    await expect(observeCheckpointProducer(certificate, { snapshot: async () => absent })).resolves.toMatchObject({
      producerPresent: false,
      completedAtMs: null,
    });
  });
});
