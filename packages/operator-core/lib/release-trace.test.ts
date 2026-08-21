import { describe, expect, it } from 'vitest';
import type { PipelinePosition } from './git-pipeline-position';
import type { DeployStatus } from './release-deploy-launch';
import {
  buildReleaseTrace,
  classifyReleaseWake,
  type ReleaseTraceGate,
  type ReleaseTraceInput,
} from './release-trace';

const sha = 'a'.repeat(40);
const green = sha;
const deployed = sha;

function position(over: Partial<PipelinePosition> = {}): PipelinePosition {
  return {
    input: { path: null, sha },
    // WI-9974 made this REQUIRED. `[]` is correct here rather than a silencer:
    // these fixtures describe a sha-only probe, and a sha-only probe identifies
    // no path, so there is no file whose generation any host could be running.
    runtimeGenerations: [],
    repoRoot: '/repo',
    submodule: null,
    // EI-18715870370005934 made this REQUIRED on PipelinePosition. `null` is the
    // semantically correct value here, not just a compiler-silencer: these fixtures
    // describe a superproject path, so no gitlink substitution happened and the sha
    // asked about IS the sha the positions describe.
    submodulePin: null,
    targetSha: sha,
    targetShortSha: sha.slice(0, 9),
    targetSubject: 'test',
    dirtyUncommitted: false,
    positions: { committedLocal: true, onStaging: true, inMain: true, deployed: true },
    positionsUnknown: [],
    // WI-6646 made these REQUIRED on PipelinePosition. Both values are semantically
    // correct here rather than compiler-silencers: this fixture names no `marker`, so
    // there is no per-leg marker verdict to report, and no leg is a newer-commit artifact.
    positionsMarker: null,
    positionsNewerCommit: [],
    // P-007 made this REQUIRED on PipelinePosition, and empty is the semantically
    // correct value rather than a compiler-silencer: these fixtures describe a fully
    // measured pipeline, so no verdict leg is degraded.
    verdictUnknown: [],
    deployedSha: deployed,
    gate: {
      stalled: false,
      consecutiveReds: 0,
      lastGreenAtMs: 1,
      fireStale: false,
      fireStaleReason: null,
      // EI-19325520469216548 made these REQUIRED on PipelinePosition['gate']; false/null is
      // the semantically correct default here, not a compiler-silencer — this fixture
      // describes a fully-measured, non-stale verdict.
      verdictStale: false,
      verdictStaleReason: null,
      verdictStaleReasonCode: null,
      candidateAgeMs: null,
      commitsBehindTip: null,
      observedCandidate: null,
      // EI-19405864032365760 made this REQUIRED for the same reason: `null` says this gate
      // RENDERED a verdict (no preflight abort recorded), which is what this fixture describes.
      inconclusive: null,
    },
    verdictProvenance: {
      lastGreenSha: green,
      lastGreenShortSha: green.slice(0, 9),
      lastGreenAgeMs: 1,
      mainFastForwarded: true,
      deployedBehindGreenPin: 0,
      deployOrigin: 'gate-green',
    },
    gitSyncLastStatus: 'ok',
    gitSync: {
      status: 'ok',
      lastSyncedAtMs: 1,
      syncAgeMs: 0,
      consecutiveErrorTicks: 0,
      pushedRepos: [],
      mergedRepos: [],
      conflicts: [],
      errors: [],
      pushMode: 'push',
    },
    // git-pipeline-agent-state-2026-07-26 P-001 made this REQUIRED. Empty is correct
    // for these fixtures: they assert release-trace's own lineage logic, which reads
    // `positions`/`verdictProvenance` and never the stage table.
    stages: [],
    runtime: null,
    runtimes: null,
    // P-003 (2e1280dcd1) made `serving` REQUIRED on PipelinePosition. All-null is the
    // correct value here for the same reason `runtime`/`runtimes` are null: these
    // fixtures assert release-trace's own LINEAGE logic (`positions` /
    // `verdictProvenance`), and never probe a live process. `unknownReason` states
    // that explicitly rather than leaving a bare null that reads as "probed, found
    // nothing" — the distinction ServingTruth exists to preserve.
    serving: {
      host: null,
      unit: null,
      pid: null,
      startedAtMs: null,
      codeAsOfMs: null,
      codeAsOfSource: null,
      startedSinceCodeChange: null,
      behindMin: null,
      restartLever: null,
      restartSupersededBy: null,
      unknownReason: { code: 'not-measured', detail: 'fixture: no serving probe (lineage-only test)' },
    },
    // P-004 made `changeInCandidate` REQUIRED. All-null is the correct value here for the
    // same reason `serving` is: these fixtures assert release-trace's own LINEAGE logic and
    // never resolve a gate candidate. Nulls mean "not measured" — the three-valued verdict
    // exists precisely so an unmeasured containment can never be read as a confirmed one.
    changeInCandidate: {
      judgingSha: null,
      judgingContainsPath: null,
      nextCandidateSha: null,
      nextContainsPath: null,
      missingReason: null,
      // EI-18797292094433710 added marker containment on the same three-valued
      // principle as the fields above: no marker was supplied by these fixtures,
      // so null is "not measured" rather than a measured absence.
      markerJudging: null,
      markerNext: null,
      detail: null,
    },
    // P-006 made `sweepExposure` REQUIRED. `dirtyUncommitted` is false in this fixture, so
    // "not exposed" is the semantically correct value, not a compiler-silencer: a clean
    // path has nothing for the next git-sync tick to sweep.
    sweepExposure: {
      exposed: false,
      dirtyPathCount: null,
      dirtyPathSample: [],
      nextSweepInMs: null,
      detail: null,
    },
    // P-005 made these REQUIRED. null/null is correct here for the same reason as above:
    // these fixtures carry an empty `stages` table, so there is no pending stage to derive
    // a blocker from — and null/null is the honest reading of that ("nothing pending"),
    // not a placeholder.
    blockedOn: null,
    nextAction: null,
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
      failingTests: [],
      lastVerdict: null,
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
    deployInFlight: null,
    deployTerminal: null,
    checkpointRunInFlight: null,
    releaseTrigger: {
      active: true,
      pause: null,
      blocked: false,
      blockReason: null,
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
    requesterId: 'su-x',
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
          subscriberId: 'su-x',
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
          subscriberId: 'su-x',
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
    expect(out.testedDeployedParity).toMatchObject({
      ok: true,
      state: 'matched',
      targetSha: sha,
      testedSha: sha,
      deployedSha: sha,
    });
    expect(out.constraints).toEqual([]);
    expect(out.nextVerb).toBeNull();
  });
  it('accepts a target contained in a newer matching green/deployed pin', () => {
    const newer = 'c'.repeat(40);
    const out = buildReleaseTrace(
      input({
        position: position({
          deployedSha: newer,
          verdictProvenance: {
            ...position().verdictProvenance,
            lastGreenSha: newer,
            deployOrigin: 'gate-green',
          },
        }),
      }),
    );
    expect(out.testedDeployedParity).toMatchObject({
      ok: true,
      targetSha: sha,
      testedSha: newer,
      deployedSha: newer,
    });
    expect(out.ok).toBe(true);
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

  it('uses exact local gate provenance before directing recovery to origin/staging', () => {
    const out = buildReleaseTrace(
      input({
        position: position({
          positions: { committedLocal: true, onStaging: false, inMain: false, deployed: false },
          gate: { ...position().gate, observedCandidate: sha },
        }),
        gate: {
          state: 'gate-red',
          authoritative: true,
          consecutiveReds: 1,
          failingTests: ['x.test.ts'],
          fireStale: false,
          fireStaleReason: null,
          verdictStale: false,
          verdictStaleReason: null,
          observedCandidate: sha,
        },
      }),
    );

    expect(out.gate.observedCandidate).toBe(sha);
    expect(out.constraints.find((c) => c.code === 'not-on-origin-staging')?.summary).toContain(
      'local green-checkpoint already judged',
    );
    expect(out.constraints.find((c) => c.code === 'not-on-origin-staging')?.summary).not.toContain(
      'cannot test it',
    );
    expect(out.nextVerb?.name).toBe('testing:flakiness');
  });

  it('keeps stale exact-candidate recovery on the gate path, not the publication wait path', () => {
    const out = buildReleaseTrace(
      input({
        position: position({
          positions: { committedLocal: true, onStaging: false, inMain: false, deployed: false },
          gate: { ...position().gate, observedCandidate: sha },
        }),
        gate: {
          state: 'gate-verdict-stale',
          authoritative: false,
          consecutiveReds: 5,
          failingTests: [],
          fireStale: false,
          fireStaleReason: null,
          verdictStale: true,
          verdictStaleReason: 'stale candidate was re-tested at tip',
          observedCandidate: sha,
        },
      }),
    );

    expect(out.nextVerb).toMatchObject({ name: 'release:checkpoint-run' });
    expect(out.nextVerb?.name).not.toBe('git-sync:await');
  });

  it('still awaits origin/staging when no verdict covers the requested candidate', () => {
    const out = buildReleaseTrace(
      input({
        position: position({
          positions: { committedLocal: true, onStaging: false, inMain: false, deployed: false },
          gate: { ...position().gate, observedCandidate: 'b'.repeat(40) },
        }),
      }),
    );

    expect(out.constraints.find((c) => c.code === 'not-on-origin-staging')?.summary).toContain(
      'cannot test it',
    );
    expect(out.nextVerb).toMatchObject({ name: 'git-sync:await', args: { sha } });
  });

  // EI-18672078222841101 — the stampede. Three agents read a red here within 15 minutes and
  // each was told to go classify the failures, with nothing saying a fixer already held them.
  describe('a red that someone already owns', () => {
    const redGate = (redOwner?: ReleaseTraceGate['redOwner']) => ({
      state: 'gate-red' as const,
      authoritative: true,
      consecutiveReds: 2,
      failingTests: ['x.test.ts'],
      fireStale: false,
      fireStaleReason: null,
      verdictStale: false,
      verdictStaleReason: null,
      redOwner,
    });
    const onStaging = position({
      positions: { committedLocal: true, onStaging: true, inMain: false, deployed: false },
    });

    const liveCanonicalOwner = {
      eventKey: 'gate-red-streak:papercusp',
      workItem: 'WI-39450',
      claimState: 'held',
      unknown: null,
      takenBy: 'su-live-gate-owner',
      takenAt: '2026-08-20T10:00:00Z',
      expiresAt: null,
      holderSessionState: 'live',
      duplicates: [],
      thread: {},
    } as unknown as NonNullable<PipelinePosition['gate']['ownership']>;

    it('prefers a live canonical gate singleton over an obsolete fixer owner-gone', () => {
      const out = buildReleaseTrace(
        input({
          position: position({
            positions: { committedLocal: true, onStaging: true, inMain: false, deployed: false },
            gate: { ...position().gate, ownership: liveCanonicalOwner },
          }),
          gate: redGate({
            state: 'owner-gone',
            covered: false,
            spawnId: 'obsolete-fixer',
            ownerSignature: 'x.test.ts',
            ageMs: 90 * 60_000,
            label: 'UNOWNED — obsolete release-fixer is CONFIRMED GONE.',
          }),
        }),
      );

      expect(out.gate.redOwner).toMatchObject({
        state: 'owned-live',
        covered: true,
        ownerSignature: 'gate-red-streak:papercusp',
      });
      expect(out.gate.redOwner?.label).toContain('WI-39450');
      expect(out.gate.redOwner?.label).not.toContain('CONFIRMED GONE');
      expect(out.nextVerb?.name).toBe('checkpoint:await');
      expect(out.constraints.find((c) => c.code === 'gate-red')?.summary).toContain('WI-39450');
      expect(out.constraints.find((c) => c.code === 'gate-red')?.summary).not.toContain('CONFIRMED GONE');
    });

    it('prefers a measured live run-lock executor even when the singleton projection is absent', () => {
      const out = buildReleaseTrace(
        input({
          position: position({
            positions: { committedLocal: true, onStaging: true, inMain: false, deployed: false },
            gate: {
              ...position().gate,
              checkpointRunInFlight: {
                active: true,
                activeSource: 'run-lock',
                candidate: 'checkpoint-candidate',
                startedAtMs: 123,
                elapsedSec: 213,
                asOfAgeMs: 0,
              },
            },
          }),
          gate: redGate({
            state: 'owner-gone',
            covered: false,
            spawnId: 'obsolete-fixer',
            ownerSignature: 'x.test.ts',
            ageMs: 90 * 60_000,
            label: 'UNOWNED — obsolete release-fixer is CONFIRMED GONE.',
          }),
        }),
      );

      expect(out.gate.redOwner).toMatchObject({ state: 'owned-live', covered: true });
      expect(out.gate.redOwner?.label).toContain('checkpoint-candidate');
      expect(out.gate.redOwner?.label).not.toContain('CONFIRMED GONE');
    });

    it('sends a reader to await the outcome instead of opening a second diagnosis', () => {
      const out = buildReleaseTrace(
        input({
          position: onStaging,
          gate: redGate({
            state: 'owned-live',
            covered: true,
            spawnId: 'spawn-77',
            ownerSignature: 'x.test.ts',
            ageMs: 20 * 60_000,
            label: 'OWNED — release-fixer spawn-77 has been on this exact failure since 20m ago and is alive.',
          }),
        }),
      );
      expect(out.nextVerb?.name).toBe('checkpoint:await');
      expect(out.nextVerb?.reason).toContain('spawn-77');
      // The red is still a blocker and force is still refused — this narrows WHO investigates,
      // it does not soften the gate.
      expect(out.constraints.map((c) => c.code)).toContain('gate-red');
      expect(out.constraints.map((c) => c.code)).toContain('no-force-past-red');
      expect(out.constraints.find((c) => c.code === 'gate-red')?.summary).toContain('spawn-77');
    });

    it('still sends a reader to diagnose when the recorded fixer is CONFIRMED GONE', () => {
      // The property that keeps "a red gate is everyone's problem" intact: an uncovered red
      // must still recruit whoever reads it, or this fix trades a stampede for a stalled gate.
      const out = buildReleaseTrace(
        input({
          position: onStaging,
          gate: redGate({
            state: 'owner-gone',
            covered: false,
            spawnId: 'spawn-77',
            ownerSignature: 'x.test.ts',
            ageMs: 90 * 60_000,
            label: 'UNOWNED — release-fixer spawn-77 was dispatched 2h ago but is CONFIRMED GONE.',
          }),
        }),
      );
      expect(out.nextVerb?.name).toBe('testing:flakiness');
      expect(out.nextVerb?.reason).toContain('CONFIRMED GONE');
    });

    it('renders byte-identically to before when no ownership is supplied', () => {
      const without = buildReleaseTrace(input({ position: onStaging, gate: redGate(undefined) }));
      const nulled = buildReleaseTrace(input({ position: onStaging, gate: redGate(null) }));
      expect(without.nextVerb?.name).toBe('testing:flakiness');
      expect(JSON.stringify(nulled.constraints)).toBe(JSON.stringify(without.constraints));
      expect(without.constraints.find((c) => c.code === 'gate-red')?.summary).not.toMatch(/OWNED|UNOWNED/);
    });
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
  it('awaits an active checkpoint instead of recommending a duplicate stale-verdict run', () => {
    const candidate = 'b'.repeat(40);
    const out = buildReleaseTrace(
      input({
        position: position({ positions: { committedLocal: true, onStaging: true, inMain: false, deployed: false } }),
        gate: {
          state: 'gate-verdict-stale',
          authoritative: false,
          consecutiveReds: 3,
          failingTests: [],
          fireStale: false,
          fireStaleReason: null,
          verdictStale: true,
          verdictStaleReason: 'superseded pin',
          checkpointRunInFlight: {
            active: true,
            candidate,
            activeSource: 'run-lock',
            startedAtMs: 123,
            elapsedSec: 42,
            asOfAgeMs: null,
          },
        },
      }),
    );

    expect(out.nextVerb).toMatchObject({ name: 'checkpoint:await', args: { pipeline: 'papercusp' } });
    expect(out.nextVerb?.args).not.toHaveProperty('candidateSha');
    expect(out.nextVerb?.reason).toContain(candidate);
  });
  it('EI-12457: on staging with no red verdict yet, awaits the gate bound to the exact candidate SHA', () => {
    const out = buildReleaseTrace(
      input({
        position: position({ positions: { committedLocal: true, onStaging: true, inMain: false, deployed: false } }),
      }),
    );
    // The candidate is still on staging, gate not red/stale — the safe next step is to
    // await the gate, and the await must be bound to THIS exact candidate (candidateSha)
    // so a stale verdict for a different, superseded SHA can never wake the caller.
    expect(out.nextVerb).toMatchObject({
      name: 'checkpoint:await',
      args: { pipeline: 'papercusp', candidateSha: sha },
    });
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
  it('carries both exact tested and deployed SHAs into the live-verification write', () => {
    const out = buildReleaseTrace(input({ workItem: 'F-123' }));
    expect(out.nextVerb).toMatchObject({
      name: 'work_items:set_live_verified',
      args: { id: 'F-123', testedSha: sha, deployedSha: sha },
    });
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
  it('does not classify another subscriber’s crossed wake as this caller’s stale wake', () => {
    const out = buildReleaseTrace(
      input({
        wakes: [
          {
            event: 'release:green:papercusp',
            deliveryId: 9,
            subscriberId: 'su-peer',
            status: 'delivered',
            channel: 'resume',
            createdAt: '2026-01-01T00:00:00Z',
            deliveredAt: null,
            observedSha: 'b'.repeat(40),
          },
        ],
      }),
    );
    expect(out.staleWake.verdict).toBe('none');
  });
});
