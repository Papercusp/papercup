import { describe, expect, it } from 'vitest';
import type { GitPipelineSnapshot } from '../../git-pipeline-stats';
import { checkpointProducerCertificate, observeCheckpointProducer } from './checkpoint-verified-wait';
import { classifyVerifiedWaitTimeout } from './verified-wait';

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

  it('does not call a configured routine with no observed run stalled', async () => {
    const current = snapshot({ activeRun: null });
    const certificate = checkpointProducerCertificate({
      pipeline: 'papercusp',
      ownerId: 'su-1',
      issuedAtMs: 1_500,
      expectedCadenceMs: 5_000,
      verificationDeadlineMs: 2_000,
      snapshot: current,
    });
    const observed = await observeCheckpointProducer(certificate, { snapshot: async () => current });
    expect(observed).toMatchObject({
      producerPresent: true,
      state: 'unknown',
      evidence: { producerState: 'unknown', routineActive: true, candidate: null },
    });
    expect(classifyVerifiedWaitTimeout(certificate, { ...observed, checkedAtMs: 2_000 })).toMatchObject({
      classification: 'unknown',
      nextAction: 're-await',
    });
  });

  it('labels a running routine with no candidate as expected idle', async () => {
    const current = snapshot({
      activeRun: { active: false, candidate: null, startedAtMs: null, elapsedSec: null },
      routines: {
        gitSync: null,
        greenCheckpoint: {
          name: 'green-checkpoint',
          active: true,
          cron: null,
          lastFiredAtMs: null,
          nextFireAtMs: null,
          pause: null,
        },
        releaseTrigger: null,
      },
    });
    const certificate = checkpointProducerCertificate({
      pipeline: 'papercusp',
      ownerId: 'su-1',
      issuedAtMs: 1_500,
      expectedCadenceMs: 5_000,
      verificationDeadlineMs: 2_000,
      snapshot: current,
    });
    const observed = await observeCheckpointProducer(certificate, { snapshot: async () => current });
    expect(observed).toMatchObject({ state: 'idle', evidence: { producerState: 'idle' } });
    expect(classifyVerifiedWaitTimeout(certificate, { ...observed, checkedAtMs: 2_000 })).toMatchObject({
      classification: 'expected-idle',
      nextAction: 're-await',
    });
  });

  it('EI-21045433666635330: a candidate-bound wait whose probe produced NO reading at all is unknown, never stalled', async () => {
    // activeRun is entirely null here -- the probe never observed anything (a
    // skipped/unresolvable root, a swallowed probe exception) -- as distinct from the
    // "run disappears" test below, where activeRun is a real object confirming a
    // negative reading. A candidate-bound wait must not fall through to the
    // timestamp-staleness heuristic (and possibly "stalled"/takeover) on an absent
    // observation the same way it correctly would not for an unbound wait.
    const current = snapshot({ activeRun: null });
    const certificate = checkpointProducerCertificate({
      pipeline: 'papercusp',
      candidateSha: 'ed20de6d',
      ownerId: 'su-1',
      issuedAtMs: 1_500,
      expectedCadenceMs: 5_000,
      verificationDeadlineMs: 2_000,
      snapshot: current,
    });
    const observed = await observeCheckpointProducer(certificate, { snapshot: async () => current });
    expect(observed.state).toBe('unknown');
    expect(classifyVerifiedWaitTimeout(certificate, { ...observed, checkedAtMs: 2_000 })).toMatchObject({
      classification: 'unknown',
      nextAction: 're-await',
    });
  });

  it('EI-20971831715218093: a candidate-bound wait with no checkpoint candidate/run at all is unknown, never stalled', async () => {
    // activeRun IS observed here (unlike the EI-21045433666635330 case above) but
    // carries no candidate -- the checkpoint mechanism has not started judging
    // anything. That reading previously fell through to the timestamp-staleness
    // heuristic and could misread an intentionally quiescent producer (e.g. one
    // waiting behind a live, unrelated affected-test verifier task) as "stalled",
    // recommending an owner-takeover that would provoke duplicate checkpoint work.
    // No candidate/run existing is not evidence THIS candidate's run stalled --
    // it may simply not have started yet.
    const current = snapshot({
      activeRun: { active: false, candidate: null, startedAtMs: null, elapsedSec: null },
      routines: {
        gitSync: null,
        greenCheckpoint: {
          name: 'green-checkpoint',
          active: true,
          cron: null,
          lastFiredAtMs: null,
          nextFireAtMs: null,
          pause: null,
        },
        releaseTrigger: null,
      },
    });
    const certificate = checkpointProducerCertificate({
      pipeline: 'papercusp',
      candidateSha: 'abc1',
      ownerId: 'su-1',
      issuedAtMs: 1_500,
      expectedCadenceMs: 5_000,
      verificationDeadlineMs: 2_000,
      snapshot: current,
    });
    const observed = await observeCheckpointProducer(certificate, { snapshot: async () => current });
    expect(observed.state).toBe('unknown');
    expect(classifyVerifiedWaitTimeout(certificate, { ...observed, checkedAtMs: 2_000 })).toMatchObject({
      classification: 'unknown',
      nextAction: 're-await',
    });
  });

  it('keeps a candidate-bound wait on the stalled path once a DIFFERENT candidate is the one being judged', async () => {
    // Distinct from the case above: here activeRun.candidate is non-null, so the
    // checkpoint mechanism DID pick something up -- just not the candidate this
    // wait names. That is real evidence our candidate was skipped/superseded, so
    // the old stalled/absent (timestamp-staleness) diagnosis still applies.
    const current = snapshot({
      activeRun: { active: false, candidate: 'def456', startedAtMs: null, elapsedSec: null },
      routines: {
        gitSync: null,
        greenCheckpoint: {
          name: 'green-checkpoint',
          active: true,
          cron: null,
          lastFiredAtMs: null,
          nextFireAtMs: null,
          pause: null,
        },
        releaseTrigger: null,
      },
    });
    const certificate = checkpointProducerCertificate({
      pipeline: 'papercusp',
      candidateSha: 'abc1',
      ownerId: 'su-1',
      issuedAtMs: 1_500,
      expectedCadenceMs: 5_000,
      verificationDeadlineMs: 2_000,
      snapshot: current,
    });
    const observed = await observeCheckpointProducer(certificate, { snapshot: async () => current });
    expect(observed.state).toBeUndefined();
    expect(classifyVerifiedWaitTimeout(certificate, { ...observed, checkedAtMs: 2_000 })).toMatchObject({
      classification: 'stalled',
      nextAction: 'wake-owner-or-takeover',
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
