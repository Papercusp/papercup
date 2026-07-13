import { describe, expect, it } from 'vitest';
import type { PipelinePosition } from './git-pipeline-position';
import type { DeployStatus } from './release-deploy-launch';
import { buildReleaseTrace, classifyReleaseWake, type ReleaseTraceInput } from './release-trace';

const sha = 'a'.repeat(40);
const green = sha;
const deployed = sha;

function position(over: Partial<PipelinePosition> = {}): PipelinePosition {
  return {
    input: { path: null, sha },
    repoRoot: '/repo',
    submodule: null,
    targetSha: sha,
    targetShortSha: sha.slice(0, 9),
    targetSubject: 'test',
    dirtyUncommitted: false,
    positions: { committedLocal: true, onStaging: true, inMain: true, deployed: true },
    deployedSha: deployed,
    gate: { stalled: false, consecutiveReds: 0, lastGreenAtMs: 1, fireStale: false, fireStaleReason: null },
    verdictProvenance: {
      lastGreenSha: green,
      lastGreenShortSha: green.slice(0, 9),
      lastGreenAgeMs: 1,
      mainFastForwarded: true,
      deployedBehindGreenPin: 0,
      deployOrigin: 'gate-green',
    },
    gitSyncLastStatus: 'ok',
    runtime: null,
    summary: 'ok',
    notes: [],
    ...over,
  };
}

function deploy(over: Partial<DeployStatus> = {}): DeployStatus {
  return {
    gate: {
      green: true,
      consecutiveReds: 0,
      stalled: false,
      fireStale: false,
      fireStaleReason: null,
      lastGreenAtMs: 1,
      verdictStale: false,
      verdictStaleReason: null,
      lastFixerStatus: null,
      lastFixerCandidate: null,
      flakyWorkspaces: [],
    },
    deploy: {
      deployedSha: deployed,
      stagingHeadSha: sha,
      greenPinSha: green,
      deployedBehindStaging: 0,
      greenPinBehindStaging: 0,
      deployedBehindGreenPin: 0,
      greenPinAtStagingHead: true,
      deployedAtMs: 1,
    },
    canTriggerGreen: false,
    nothingToDeploy: true,
    state: 'up-to-date',
    recommendation: 'done',
    summary: 'done',
    errors: [],
    ...over,
  };
}

function input(over: Partial<ReleaseTraceInput> = {}): ReleaseTraceInput {
  return {
    position: position(),
    deploy: deploy(),
    pipeline: 'papercusp',
    inspectedKeys: [
      `release:deployed:${sha}`,
      'release:deploy-failed',
      'release:green:papercusp',
      'green-checkpoint:red:papercusp',
    ],
    awaits: [],
    wakes: [],
    snapshotGeneration: 10,
    gate: {
      state: 'up-to-date',
      authoritative: true,
      consecutiveReds: 0,
      failingTests: [],
      fireStale: false,
      fireStaleReason: null,
      verdictStale: false,
      verdictStaleReason: null,
    },
    ...over,
  };
}

describe('release trace wake lineage', () => {
  it('calls an exact deploy-key wake current even without a payload SHA', () => {
    expect(
      classifyReleaseWake(sha, [
        {
          event: `release:deployed:${sha}`,
          deliveryId: 1,
          status: 'delivered',
          channel: 'resume',
          createdAt: '2026-01-01T00:00:00Z',
          deliveredAt: null,
          observedSha: null,
        },
      ]).verdict,
    ).toBe('current');
  });
  it('rejects a crossed gate wake for another SHA as stale', () => {
    expect(
      classifyReleaseWake(sha, [
        {
          event: 'release:green:papercusp',
          deliveryId: 1,
          status: 'delivered',
          channel: 'resume',
          createdAt: '2026-01-01T00:00:00Z',
          deliveredAt: null,
          observedSha: 'b'.repeat(40),
        },
      ]).verdict,
    ).toBe('stale');
  });
  it('does not manufacture a wake when no delivery exists', () =>
    expect(classifyReleaseWake(sha, []).verdict).toBe('none'));
});

describe('buildReleaseTrace', () => {
  it('reports exact tested/deployed parity for a green live SHA', () => {
    const out = buildReleaseTrace(input());
    expect(out.testedDeployedParity).toMatchObject({ ok: true, targetSha: sha, testedSha: sha, deployedSha: sha });
    expect(out.constraints).toEqual([]);
    expect(out.nextVerb).toBeNull();
  });
  it('returns one safe green-pin deploy trigger when main is ahead of live', () => {
    const out = buildReleaseTrace(
      input({
        position: position({ positions: { committedLocal: true, onStaging: true, inMain: true, deployed: false } }),
        deploy: deploy({ canTriggerGreen: true, nothingToDeploy: false, state: 'green-deployable' }),
      }),
    );
    expect(out.nextVerb).toMatchObject({ name: 'release:deploy', args: { op: 'trigger', confirm: true } });
  });
  it('names authoritative gate failures and never recommends force', () => {
    const gate = {
      state: 'gate-red' as const,
      authoritative: true,
      consecutiveReds: 2,
      failingTests: ['x.test.ts'],
      fireStale: false,
      fireStaleReason: null,
      verdictStale: false,
      verdictStaleReason: null,
    };
    const out = buildReleaseTrace(
      input({
        position: position({ positions: { committedLocal: true, onStaging: true, inMain: false, deployed: false } }),
        gate,
      }),
    );
    expect(out.gate.failingTests).toEqual(['x.test.ts']);
    expect(out.constraints.map((c) => c.code)).toContain('no-force-past-red');
    expect(out.nextVerb?.name).toBe('testing:flakiness');
  });
  it('suppresses stale failing-test authority and asks for a fresh checkpoint', () => {
    const gate = {
      state: 'gate-verdict-stale' as const,
      authoritative: false,
      consecutiveReds: 3,
      failingTests: [],
      fireStale: false,
      fireStaleReason: null,
      verdictStale: true,
      verdictStaleReason: 'superseded pin',
    };
    const out = buildReleaseTrace(
      input({
        position: position({ positions: { committedLocal: true, onStaging: true, inMain: false, deployed: false } }),
        gate,
      }),
    );
    expect(out.constraints.map((c) => c.code)).toContain('gate-verdict-stale');
    expect(out.nextVerb?.name).toBe('release:checkpoint-run');
  });
  it('returns runtime activation instead of deploy advice for staging-tree hosts', () => {
    const out = buildReleaseTrace(
      input({
        position: position({
          runtime: {
            host: 'gateway',
            releasePipelineApplies: false,
            restartTarget: 'gateway',
            activation: 'restart gateway',
          },
        }),
      }),
    );
    expect(out.nextVerb).toMatchObject({ name: 'dev:restart', args: { target: 'gateway', confirm: true } });
    expect(out.constraints.map((c) => c.code)).toContain('runtime-not-release-carried');
  });
  it('treats dirty path lineage as blocking even when its prior commit deployed', () => {
    const out = buildReleaseTrace(input({ position: position({ dirtyUncommitted: true }) }));
    expect(out.nextVerb?.name).toBe('git-sync:await');
    expect(out.constraints.map((c) => c.code)).toContain('dirty-path');
  });
  it('flags a force-deployed lineage as not tested/deployed parity authority', () => {
    const out = buildReleaseTrace(
      input({
        position: position({ verdictProvenance: { ...position().verdictProvenance, deployOrigin: 'ahead-of-gate' } }),
      }),
    );
    expect(out.constraints.map((c) => c.code)).toContain('deployed-ahead-of-gate');
    expect(out.nextVerb?.name).toBe('release:checkpoint-run');
  });
  it('carries active registered awaits and a full-snapshot generation resync', () => {
    const out = buildReleaseTrace(
      input({
        consumerGeneration: 9,
        awaits: [
          {
            event: `release:deployed:${sha}`,
            awaitId: 7,
            subscriberId: 'su-x',
            state: 'registered',
            registeredAt: '2026-01-01T00:00:00Z',
            firedAt: null,
            firedReason: null,
            observedSha: null,
          },
        ],
      }),
    );
    expect(out.awaits.activeRegistrations).toBe(1);
    expect(out.awaits.inspectedKeys).toContain(`release:deployed:${sha}`);
    expect(out.resync).toMatchObject({ required: true, consumerGeneration: 9, authoritativeGeneration: 10 });
  });
});
