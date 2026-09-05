import { describe, expect, it } from 'vitest';
import type { PipelinePosition } from './git-pipeline-position';
import type { DeployStatus } from './release-deploy-launch';
import { buildReleaseTrace, classifyReleaseWake, type ReleaseTraceGate, type ReleaseTraceInput } from './release-trace';
import { projectCheckpointQualificationState } from './release/checkpoint-qualification-transaction';

const sha = 'a'.repeat(40);
const green = sha;
const deployed = sha;
const NO_QUALIFICATION = projectCheckpointQualificationState(null, 0);

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
    // P-002 made the resolver-owned assessments REQUIRED. This lineage-only fixture
    // does not probe a serving process or gate candidate, so those conclusions stay
    // unavailable; the gate, deployed-sha, and main/staging readings are fully measured.
    assessments: {
      pipelinePosition: null,
      gateVerdict: 'passing-current',
      gateCandidate: null,
      gateOwnership: null,
      deployedSha: 'process-unverified',
      mainBehindStaging: 'caught-up',
    },
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
      // WI-1752145: the verdict's own vintage. `null` is correct here rather than a
      // timestamp — this fixture asserts nothing about age, and null means UNKNOWN
      // vintage, which is precisely what a fixture that does not model a clock knows.
      verdictObservedAtMs: null,
      verdictStaleReason: null,
      verdictStaleReasonCode: null,
      candidateAgeMs: null,
      commitsBehindTip: null,
      observedCandidate: null,
      // EI-19405864032365760 made this REQUIRED for the same reason: `null` says this gate
      // RENDERED a verdict (no preflight abort recorded), which is what this fixture describes.
      inconclusive: null,
      candidateFailures: null,
      ownerBrief: null, qualification: NO_QUALIFICATION,
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
      skippedPaths: [],
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
      // WI-2141731: nothing was probed, so NEITHER evidence source produced a
      // verdict — same reasoning as `unknownReason` above.
      evidence: null,
      reportedSha: null,
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
      submodule: null,
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
    manualRunAuthority: null,
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
    checkpoint: {
      state: 'idle',
      authority: 'live-probe',
      phase: null,
      blocker: null,
      verdictPending: false,
      probe: { status: 'ok', detail: null },
    },
    releaseTrigger: {
      active: true,
      pause: null,
      blocked: false,
      blockReason: null,
    },
    liveCertification: null,
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

  describe('exact fix-commit containment in the recorded gate candidate', () => {
    const observedCandidate = 'c'.repeat(40);

    it('projects the canonical contained verdict without a lever or gate-health prediction', () => {
      const out = buildReleaseTrace(
        input({
          position: position({
            verdictProvenance: {
              ...position().verdictProvenance,
              targetIncludedInObservedCandidate: true,
            },
          }),
          gate: { ...input().gate, observedCandidate },
        }),
      );

      expect(out.gate.fixCommitContainment).toEqual({
        fixSha: sha,
        observedCandidate,
        verdict: 'contained',
        reason: null,
      });
      expect(out.gate.fixCommitContainment).not.toHaveProperty('nextVerb');
      expect(out.gate.fixCommitContainment).not.toHaveProperty('shouldGreen');
      expect(out.gate.fixCommitContainment).not.toHaveProperty('recommendation');
    });

    it('keeps a measured miss distinct from an unreadable ancestry probe', () => {
      const withMeasurement = (targetIncludedInObservedCandidate: boolean | null) =>
        buildReleaseTrace(
          input({
            position: position({
              verdictProvenance: {
                ...position().verdictProvenance,
                targetIncludedInObservedCandidate,
              },
            }),
            gate: { ...input().gate, observedCandidate },
          }),
        ).gate.fixCommitContainment;

      expect(withMeasurement(false)).toEqual({
        fixSha: sha,
        observedCandidate,
        verdict: 'not_contained',
        reason: null,
      });
      expect(withMeasurement(null)).toEqual({
        fixSha: sha,
        observedCandidate,
        verdict: 'unknown',
        reason: 'ancestry-unreadable',
      });
    });
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
  it('reports green-pin ancestry separately from target presence on main', () => {
    const newer = 'c'.repeat(40);
    const out = buildReleaseTrace(
      input({
        position: position({
          deployedSha: newer,
          positions: { committedLocal: true, onStaging: true, inMain: true, deployed: true },
          verdictProvenance: {
            ...position().verdictProvenance,
            lastGreenSha: newer,
            targetIncludedInGreenPin: false,
            deployOrigin: 'ahead-of-gate',
          },
        }),
      }),
    );
    expect(out.target.presence.inMain).toBe(true);
    expect(out.greenPin).toMatchObject({ sha: newer, targetIncluded: false });
    expect(out.testedDeployedParity).toMatchObject({ state: 'target-not-included', ok: false });
    expect(out.constraints.map((constraint) => constraint.code)).toContain('target-not-green-pinned');
  });
  it('does not claim a staging-only target is in origin/main when the green pin excludes it', () => {
    const out = buildReleaseTrace(
      input({
        position: position({
          positions: { committedLocal: true, onStaging: true, inMain: false, deployed: false },
          verdictProvenance: {
            ...position().verdictProvenance,
            targetIncludedInGreenPin: false,
            deployOrigin: 'ahead-of-gate',
          },
        }),
      }),
    );

    const constraint = out.constraints.find((entry) => entry.code === 'target-not-green-pinned');
    expect(out.target.presence.inMain).toBe(false);
    expect(constraint?.summary).toBe(
      'The target is not in origin/main and is not contained by the recorded green pin; neither origin/main visibility nor green-pin containment proves gate testing.',
    );
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

  it('projects an exact repair-in-progress candidate as inconclusive over an older red gate', () => {
    const repairCandidate = sha.slice(0, 8);
    const inconclusive = {
      status: 'repair-in-progress',
      candidate: repairCandidate,
      detail: 'frozen repair fixer fixer-1 dispatched; no suite run',
      observedAtMs: 123,
    };
    const inherited = ['historical-red.test.ts', 'older-lint.test.ts'];
    const out = buildReleaseTrace(
      input({
        position: position({
          positions: { committedLocal: true, onStaging: true, inMain: false, deployed: false },
        }),
        gate: {
          ...input().gate,
          state: 'gate-red',
          authoritative: false,
          consecutiveReds: 18,
          failingTests: [],
          observedCandidate: 'older-candidate',
          recordedVerdict: 'not-green',
          inconclusive,
          inheritedRepairQueueFailingTests: inherited,
          inheritedRepairQueueFailingTestsSource: 'prior-gate-verdict',
        },
      }),
    );

    expect(out.gate.candidateVerdict).toMatchObject({
      state: 'inconclusive',
      status: 'inconclusive',
      green: null,
      candidate: repairCandidate,
      reason: 'repair-in-progress',
      detail: inconclusive.detail,
    });
    expect(out.gate.failingTests).toEqual([]);
    expect(out.gate.inheritedRepairQueueFailingTests).toEqual(inherited);
    expect(out.gate.inheritedRepairQueueFailingTestsSource).toBe('prior-gate-verdict');
    expect(out.constraints.map((c) => c.code)).toContain('gate-inconclusive');
    expect(out.constraints.map((c) => c.code)).not.toContain('gate-red');
    expect(out.constraints.map((c) => c.code)).not.toContain('no-force-past-red');
    expect(out.nextVerb).toMatchObject({
      name: 'checkpoint:await',
      args: { pipeline: 'papercusp', candidateSha: sha },
    });
    expect(out.nextVerb?.reason).not.toContain('testing:flakiness');
  });

  it('WI-41252 / D-066: an exact dependency-generation abort outranks the historical red fallback', () => {
    const inconclusive = {
      status: 'infra-inconclusive',
      candidate: sha,
      detail:
        'dependency-generation.sh exited 75: live node_modules changed during generation build; refusing a torn snapshot',
      observedAtMs: 456,
    };
    const out = buildReleaseTrace(
      input({
        position: position({
          positions: { committedLocal: true, onStaging: true, inMain: false, deployed: false },
        }),
        gate: {
          ...input().gate,
          state: 'gate-red',
          authoritative: true,
          consecutiveReds: 42,
          failingTests: [],
          observedCandidate: sha,
          recordedVerdict: null,
          inconclusive,
        },
      }),
    );

    expect(out.gate.candidateVerdict).toMatchObject({
      state: 'inconclusive',
      status: 'inconclusive',
      green: null,
      candidate: sha,
      reason: 'infra-inconclusive',
      detail: inconclusive.detail,
    });
    expect(out.constraints.map((c) => c.code)).toContain('gate-inconclusive');
    expect(out.constraints.map((c) => c.code)).not.toContain('gate-red');
    expect(out.constraints.map((c) => c.code)).not.toContain('no-force-past-red');
    expect(out.nextVerb?.name).toBe('checkpoint:await');
  });

  it('does not project a historical red while the exact candidate is actively being judged', () => {
    const checkpointRun = {
      active: true,
      activeSource: 'run-lock' as const,
      candidate: sha,
      startedAtMs: 123,
      elapsedSec: 42,
      asOfAgeMs: 0,
    };
    const out = buildReleaseTrace(
      input({
        position: position({
          positions: { committedLocal: true, onStaging: true, inMain: false, deployed: false },
          gate: { ...position().gate, checkpointRunInFlight: checkpointRun },
        }),
        gate: {
          ...input().gate,
          state: 'gate-red',
          authoritative: true,
          consecutiveReds: 4,
          failingTests: ['historical-red.test.ts'],
          observedCandidate: sha,
          recordedVerdict: null,
          checkpointRunInFlight: checkpointRun,
        },
      }),
    );

    expect(out.gate.candidateVerdict).toMatchObject({
      state: 'unknown',
      status: 'unknown',
      green: null,
      candidate: sha,
    });
    expect(out.gate.candidateVerdict.reason).toContain('checkpoint run');
    expect(out.nextVerb).toMatchObject({ name: 'checkpoint:await', args: { pipeline: 'papercusp' } });
  });

  describe("an `unknown` verdict names WHOSE verdict it is and hands back that candidate's re-read", () => {
    // The false-blocker class this closes: a PATH trace resolves `targetSha` to that path's
    // own latest commit, so the exact-SHA rail correctly declines to attribute the gate's
    // verdict to it. Three sessions of stable-candidate-related-gate-2026-08-23 read that
    // `unknown` as the gate failing to type its own state, producing two retracted findings
    // and a false ship blocker. `resync.nextVerb` re-reads the SAME target, so it cannot
    // break the loop; only a handle addressed to `observedCandidate` can.
    const otherCandidate = 'f369131625d4252f0c8202e75766b272a4abc3c2';

    it('points the caller at the candidate that owns the verdict instead of just refusing', () => {
      const out = buildReleaseTrace(
        input({
          gate: {
            ...input().gate,
            state: 'gate-red',
            authoritative: true,
            consecutiveReds: 61,
            recordedVerdict: 'not-green',
            observedCandidate: otherCandidate,
          },
        }),
      );

      expect(out.gate.candidateVerdict).toMatchObject({
        state: 'unknown',
        status: 'unknown',
        green: null,
        candidate: otherCandidate,
      });
      // The handle must address the OTHER candidate, never the traced target — re-reading
      // the target is precisely the move that kept three sessions stuck.
      expect(out.gate.candidateVerdict.rereadForCandidate).toEqual({
        name: 'release:trace',
        args: { sha: otherCandidate },
      });
      expect(out.gate.candidateVerdict.rereadForCandidate?.args.sha).not.toBe(sha);
      // and the reason must say it is the rail working, not a missing verdict
      expect(out.gate.candidateVerdict.reason).toContain(otherCandidate);
      expect(out.gate.candidateVerdict.reason).toContain('NOT an untyped or missing verdict');
    });

    it('offers no handle when the gate has recorded no candidate to compare against', () => {
      // Fail-closed: absent an observedCandidate there is no better subject to point at,
      // so the field must be null rather than a fabricated self-referential re-read.
      const out = buildReleaseTrace(
        input({
          gate: { ...input().gate, state: 'gate-red', authoritative: true, observedCandidate: null },
        }),
      );

      expect(out.gate.candidateVerdict.state).toBe('unknown');
      expect(out.gate.candidateVerdict.rereadForCandidate).toBeNull();
      expect(out.gate.candidateVerdict.reason).toContain('no observed candidate');
    });
  });

  describe('an exact-candidate recorded terminal verdict is immutable history', () => {
    // EI-21432980132792683 / EI-21433072117655298. Candidate 74027d.. was judged authoritative
    // exact RED and ratified terminal by stable-candidate-related-gate-2026-08-23#D-059/#D-060.
    // release:trace then reported it back as inconclusive/repair-in-progress with
    // nextVerb: checkpoint:await -- erasing the ratified fail-closed branch and stranding
    // readers on a verdict that can never arrive, because the candidate is already terminal.
    const terminalGate = (over: Partial<ReleaseTraceGate> = {}): Partial<ReleaseTraceGate> => ({
      ...input().gate,
      state: 'gate-red',
      consecutiveReds: 41,
      failingTests: [],
      observedCandidate: sha,
      recordedVerdict: 'not-green',
      ...over,
    });

    it('survives a later repair reservation naming the same candidate', () => {
      const out = buildReleaseTrace(
        input({
          gate: terminalGate({
            // `inconclusive` is by contract the latest attempt that rendered NO verdict, so it
            // cannot supersede one that did -- least of all for this very SHA.
            inconclusive: {
              status: 'repair-in-progress',
              candidate: sha,
              detail: 'root-fix fixer dispatched; no suite run',
              observedAtMs: 123,
            },
          }) as ReleaseTraceGate,
        }),
      );

      expect(out.gate.candidateVerdict).toMatchObject({ state: 'red', status: 'red', green: false, candidate: sha });
      expect(out.gate.candidateVerdict.reason).not.toBe('repair-in-progress');
      expect(out.constraints.map((c) => c.code)).not.toContain('gate-inconclusive');
      expect(out.nextVerb?.name).not.toBe('checkpoint:await');
    });

    it('survives the aggregate verdict going stale against newer staging', () => {
      const out = buildReleaseTrace(
        input({
          gate: terminalGate({
            state: 'gate-verdict-stale',
            // `authoritative` goes false precisely BECAUSE the verdict went stale, which is why
            // the fix reads the explicit writer marker instead of the authoritative+reds fallback.
            authoritative: false,
            verdictStale: true,
            verdictStaleReason: 'candidate-fossil; newer staging',
          }) as ReleaseTraceGate,
        }),
      );

      expect(out.gate.candidateVerdict).toMatchObject({ state: 'red', status: 'red', green: false, candidate: sha });
      // Staleness still governs the CURRENT TIP -- it just may not rewrite this SHA's own verdict.
      expect(out.constraints.map((c) => c.code)).toContain('gate-verdict-stale');
    });

    it('preserves a recorded green the same way, so the rule is about immutability not redness', () => {
      const out = buildReleaseTrace(
        input({
          gate: terminalGate({
            state: 'gate-verdict-stale',
            authoritative: false,
            consecutiveReds: 0,
            recordedVerdict: 'green',
            verdictStale: true,
            verdictStaleReason: 'superseded pin',
          }) as ReleaseTraceGate,
        }),
      );

      expect(out.gate.candidateVerdict).toMatchObject({ state: 'green', status: 'green', green: true });
    });

    it('CONTROL: a red recorded against a DIFFERENT candidate still yields to an exact repair reservation', () => {
      // Falsifiability control for the fix above: it must key on an exact-SHA match, never on
      // the mere presence of `recordedVerdict`. Without this, the fix would silently project an
      // unrelated candidate's red onto this one -- the opposite defect, and the behaviour the
      // 'projects an exact repair-in-progress candidate as inconclusive' test exists to protect.
      const out = buildReleaseTrace(
        input({
          gate: terminalGate({
            authoritative: false,
            observedCandidate: 'older-candidate',
            inconclusive: {
              status: 'repair-in-progress',
              candidate: sha,
              detail: 'frozen repair fixer dispatched; no suite run',
              observedAtMs: 123,
            },
          }) as ReleaseTraceGate,
        }),
      );

      expect(out.gate.candidateVerdict).toMatchObject({ state: 'inconclusive', reason: 'repair-in-progress' });
    });
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
    expect(out.constraints.find((c) => c.code === 'not-on-origin-staging')?.summary).not.toContain('cannot test it');
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

  it('awaits origin egress when a local commit is not yet on origin/staging', () => {
    const out = buildReleaseTrace(
      input({
        position: position({
          positions: { committedLocal: true, onStaging: false, inMain: false, deployed: false },
          gate: { ...position().gate, observedCandidate: 'b'.repeat(40) },
        }),
      }),
    );

    expect(out.constraints.find((c) => c.code === 'not-on-origin-staging')?.summary).toContain('cannot test it');
    expect(out.nextVerb).toMatchObject({
      name: 'events:await',
      args: { event: `git-sync:egressed:${sha}` },
    });
  });

  it('awaits an exact active detached repair verifier before origin publication', () => {
    const checkpointRun = {
      active: true,
      candidate: sha,
      activeSource: 'run-lock' as const,
      systemd: {
        scope: 'user' as const,
        argv: ['--user', 'show', 'unit.service', '--property=LoadState'],
        loadState: 'loaded',
        known: true,
        invocationId: 'invocation-123',
      },
      startedAtMs: 123,
      elapsedSec: 42,
      asOfAgeMs: 0,
    };
    const out = buildReleaseTrace(
      input({
        position: position({
          positions: { committedLocal: false, onStaging: false, inMain: false, deployed: false },
          gate: { ...position().gate, checkpointRunInFlight: checkpointRun },
        }),
        gate: { ...input().gate, checkpointRunInFlight: checkpointRun },
      }),
    );

    expect(out.constraints.find((c) => c.code === 'not-on-origin-staging')?.summary).toContain(
      'actively judging this exact detached candidate',
    );
    expect(out.constraints.find((c) => c.code === 'not-on-origin-staging')?.summary).not.toContain('cannot test it');
    expect(out.nextVerb).toMatchObject({ name: 'checkpoint:await', args: { pipeline: 'papercusp' } });
    expect(out.nextVerb?.reason).toContain(sha);
    expect(out.gate.checkpointRunInFlight?.systemd).toEqual(checkpointRun.systemd);
  });

  it('keeps an unrelated active verifier from masking the exact origin-egress wait', () => {
    const checkpointRun = {
      active: true,
      candidate: 'b'.repeat(40),
      activeSource: 'run-lock' as const,
      startedAtMs: 123,
      elapsedSec: 42,
      asOfAgeMs: 0,
    };
    const out = buildReleaseTrace(
      input({
        position: position({
          positions: { committedLocal: true, onStaging: false, inMain: false, deployed: false },
          gate: { ...position().gate, checkpointRunInFlight: checkpointRun },
        }),
        gate: { ...input().gate, checkpointRunInFlight: checkpointRun },
      }),
    );

    expect(out.nextVerb).toMatchObject({
      name: 'events:await',
      args: { event: `git-sync:egressed:${sha}` },
    });
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

      // P-008: COMPOSED, not substituted. The composite state is its own value so a
      // reader can tell "a human/agent holds the item" from "the automated fixer is on
      // it" — the previous contract asserted 'owned-live' here, which said the second
      // while meaning the first.
      expect(out.gate.redOwner).toMatchObject({
        state: 'owned-by-repair-holder',
        covered: true,
        // The fixer's OWN verdict and lineage survive the composition. The old
        // substitution nulled spawnId/ageMs and overwrote ownerSignature with the event
        // key, which destroyed the actionable half: a dead fixer beside a live holder is
        // a fixer that needs re-dispatching, and nobody could see it.
        fixerState: 'owner-gone',
        spawnId: 'obsolete-fixer',
        ownerSignature: 'x.test.ts',
      });
      expect(out.gate.redOwner?.repairOwner).toMatchObject({
        eventKey: 'gate-red-streak:papercusp',
        workItem: 'WI-39450',
        takenBy: 'su-live-gate-owner',
        live: true,
      });
      expect(out.gate.redOwner?.label).toContain('WI-39450');
      expect(out.gate.redOwner?.label).toMatch(/^OWNED/);
      // The dead fixer is now REPORTED rather than hidden — but explicitly as something
      // that does not make the red unowned.
      expect(out.gate.redOwner?.label).toContain('CONFIRMED GONE');
      expect(out.gate.redOwner?.label).toMatch(/does NOT mean this red is unowned/);
      expect(out.gate.redOwner?.label).not.toMatch(/Claim it before investigating/);
      expect(out.nextVerb?.name).toBe('checkpoint:await');
      // The constraint carries the same composed label, so it names the live holder AND
      // reports the dead fixer. The old assertion here forbade "CONFIRMED GONE" because
      // under substitution its only possible meaning was the stale "so claim this red";
      // composed, it is a second fact beside the owner, and the property that actually
      // matters is that the summary never invites a second claimant.
      const gateRed = () => out.constraints.find((c) => c.code === 'gate-red')?.summary ?? '';
      expect(gateRed()).toContain('WI-39450');
      expect(gateRed()).toContain('su-live-gate-owner');
      expect(gateRed()).not.toMatch(/Claim it before investigating/);
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

    it('prefers measured pre-lock process authority before a candidate is published', () => {
      const out = buildReleaseTrace(
        input({
          position: position({
            positions: { committedLocal: true, onStaging: true, inMain: false, deployed: false },
            gate: {
              ...position().gate,
              checkpointRunInFlight: {
                active: true,
                activeSource: 'process-authority',
                processAuthority: {
                  workspace: 'papercusp-workspace',
                  harness: 'papercusp',
                  cgroupPath: '/user.slice/run-u42.scope',
                  pid: 4242,
                },
                candidate: null,
                startedAtMs: 123,
                elapsedSec: 10,
                asOfAgeMs: null,
              },
            },
          }),
          gate: redGate({
            state: 'owner-gone',
            covered: false,
            spawnId: 'obsolete-fixer',
            ownerSignature: 'x.test.ts',
            ageMs: 90 * 60_000,
            label: 'obsolete fixer gone',
          }),
        }),
      );
      expect(out.gate.redOwner).toMatchObject({ state: 'owned-live', covered: true });
      expect(out.gate.redOwner?.label).toMatch(/gate-authorized checkpoint process/i);
    });

    it('keeps the D-016 paused-routine serializer authoritative over historical fixer lineage', () => {
      // Live shape observed on 2026-08-23: D-012/D-013 deliberately pauses the
      // routine while WI-40086's D-016 claim-hold/qualified-tip serializer owns
      // the gate-red-streak sequence. The inactive run-lock is measured idle;
      // it must not erase the separate live singleton ownership cell.
      const pausedRun = {
        active: false,
        activeSource: 'run-lock' as const,
        candidate: null,
        startedAtMs: null,
        elapsedSec: null,
        asOfAgeMs: 0,
      };
      const out = buildReleaseTrace(
        input({
          position: position({
            positions: { committedLocal: true, onStaging: true, inMain: false, deployed: false },
            gate: {
              ...position().gate,
              observedCandidate: sha,
              ownership: {
                assessment: 'held-live',
                eventKey: 'gate-red-streak:papercusp',
                workItem: 'WI-40086',
                claimState: 'held',
                unknown: null,
                takenBy: 'su-c58f545d-f8a4-4afe-b755-1bf613bd8083',
                takenAt: '2026-08-23T00:58:23.745Z',
                lastProgressAt: null,
                expiresAt: null,
                holderSessionState: 'live',
                duplicates: [],
                thread: { recent: [], shown: 0, total: 0, topics: [], unknown: null },
              },
              checkpointRunInFlight: pausedRun,
            },
          }),
          gate: {
            ...redGate({
              state: 'owner-gone',
              covered: false,
              spawnId: 'obsolete-fixer',
              ownerSignature: 'RED-35',
              ageMs: 90 * 60_000,
              label: 'UNOWNED — obsolete release-fixer is CONFIRMED GONE.',
            }),
            observedCandidate: sha,
            checkpointRunInFlight: pausedRun,
          },
        }),
      );

      // P-008: same composition contract as above — the live singleton outranks the
      // obsolete fixer, and outranks the paused-run serializer too, because naming the
      // specific owner is more actionable than "a run is up".
      expect(out.gate.redOwner).toMatchObject({
        state: 'owned-by-repair-holder',
        covered: true,
        fixerState: 'owner-gone',
        spawnId: 'obsolete-fixer',
        ownerSignature: 'RED-35',
      });
      expect(out.gate.redOwner?.repairOwner).toMatchObject({ workItem: 'WI-40086', live: true });
      expect(out.gate.redOwner?.label).toContain('WI-40086');
      expect(out.gate.redOwner?.label).toContain('su-c58f545d-f8a4-4afe-b755-1bf613bd8083');
      // lastProgressAt is null here and takenAt is parseable, so the lease anchors on the
      // claim stamp — an OLD claim with no progress must not read as freshly worked.
      expect(out.gate.redOwner?.repairOwner?.lastProgressAt).toBeNull();
      expect(out.gate.redOwner?.label).not.toMatch(/Claim it before investigating/);
      expect(out.nextVerb).toMatchObject({ name: 'checkpoint:await', args: { pipeline: 'papercusp' } });
      expect(out.nextVerb?.name).not.toBe('testing:flakiness');
      // Same composed-label contract as the case above.
      const gateRedSummary = () => out.constraints.find((c) => c.code === 'gate-red')?.summary ?? '';
      expect(gateRedSummary()).toContain('WI-40086');
      expect(gateRedSummary()).toContain('su-c58f545d-f8a4-4afe-b755-1bf613bd8083');
      expect(gateRedSummary()).not.toMatch(/Claim it before investigating/);
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
      expect(out.nextVerb).toMatchObject({ name: 'checkpoint:await', args: { pipeline: 'papercusp' } });
      expect(out.nextVerb?.args).not.toHaveProperty('candidateSha');
      expect(out.nextVerb?.reason).toContain('spawn-77');
      expect(out.nextVerb?.reason).toContain('already latched');
      expect(out.nextVerb?.reason).toContain('paced cadence');
      // The red is still a blocker and force is still refused — this narrows WHO investigates,
      // it does not soften the gate.
      expect(out.constraints.map((c) => c.code)).toContain('gate-red');
      expect(out.constraints.map((c) => c.code)).toContain('no-force-past-red');
      expect(out.constraints.find((c) => c.code === 'gate-red')?.summary).toContain('spawn-77');
    });

    it('does not bind the wait to a terminal red candidate whose producer is already idle', () => {
      const checkpointRun = {
        active: false,
        activeSource: 'run-lock' as const,
        candidate: null,
        startedAtMs: null,
        elapsedSec: null,
        asOfAgeMs: 0,
      };
      const out = buildReleaseTrace(
        input({
          position: position({
            positions: { committedLocal: true, onStaging: true, inMain: false, deployed: false },
            gate: { ...position().gate, observedCandidate: sha, checkpointRunInFlight: checkpointRun },
          }),
          gate: {
            ...redGate({
              state: 'owned-live',
              covered: true,
              spawnId: 'spawn-77',
              ownerSignature: 'x.test.ts',
              ageMs: 20 * 60_000,
              label: 'OWNED — release-fixer spawn-77 is alive for the terminal red.',
            }),
            observedCandidate: sha,
            checkpointRunInFlight: checkpointRun,
          },
        }),
      );

      expect(out.gate.candidateVerdict).toMatchObject({
        state: 'red',
        status: 'red',
        green: false,
        candidate: sha,
      });
      expect(out.nextVerb).toMatchObject({ name: 'checkpoint:await', args: { pipeline: 'papercusp' } });
      expect(out.nextVerb?.args).not.toHaveProperty('candidateSha');
      expect(out.nextVerb?.reason).toContain('already latched');
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

  it('EI-210996: classifies candidate-bound abnormal termination without a result marker as inconclusive and consumed', () => {
    const checkpointRun = {
      active: false,
      terminalMarker: false,
      terminalEvidence: {
        source: 'systemd-exec-stop-post' as const,
        candidate: sha.slice(0, 8),
        serviceResult: 'oom-kill',
        exitCode: 'killed',
        exitStatus: 'KILL',
        abnormal: true,
      },
      candidate: null,
      startedAtMs: null,
      elapsedSec: null,
      asOfAgeMs: 0,
    };
    const out = buildReleaseTrace(
      input({
        position: position({
          positions: { committedLocal: true, onStaging: true, inMain: false, deployed: false },
          gate: { ...position().gate, checkpointRunInFlight: checkpointRun },
        }),
        gate: { ...input().gate, checkpointRunInFlight: checkpointRun },
      }),
    );

    expect(out.constraints.find((c) => c.code === 'checkpoint-run-inconclusive')?.summary).toMatch(
      /explicitly INCONCLUSIVE, not red or green/,
    );
    expect(out.gate.consumedAuthority).toMatchObject({
      governingRef: 'stable-candidate-related-gate-2026-08-23#D-053',
      candidate: sha.slice(0, 8),
      status: 'consumed',
      retryAllowed: false,
    });
    expect(out.constraints).toContainEqual(
      expect.objectContaining({ code: 'checkpoint-authority-consumed', blocking: true }),
    );
    expect(out.nextVerb).toBeNull();
  });

  it('EI-21411776375901170: terminal marker does not restore retry after an exact abnormal D-053 terminal', () => {
    const checkpointRun = {
      active: false,
      terminalMarker: true,
      terminalEvidence: {
        source: 'systemd-exec-stop-post' as const,
        candidate: sha,
        serviceResult: 'oom-kill',
        exitCode: 'killed',
        exitStatus: 'KILL',
        abnormal: true,
      },
      candidate: null,
      startedAtMs: null,
      elapsedSec: null,
      asOfAgeMs: 0,
    };
    const out = buildReleaseTrace(
      input({
        position: position({
          positions: { committedLocal: true, onStaging: true, inMain: false, deployed: false },
          gate: { ...position().gate, checkpointRunInFlight: checkpointRun },
        }),
        gate: { ...input().gate, checkpointRunInFlight: checkpointRun },
      }),
    );

    expect(out.gate.consumedAuthority).toMatchObject({
      governingRef: 'stable-candidate-related-gate-2026-08-23#D-053',
      candidate: sha,
      status: 'consumed',
      retryAllowed: false,
      reason: expect.stringContaining('D-053 consumes its one-shot checkpoint authority'),
    });
    expect(out.constraints).toContainEqual(
      expect.objectContaining({ code: 'checkpoint-authority-consumed', blocking: true }),
    );
    expect(out.nextVerb).toBeNull();
  });

  it('EI-21103060581352507: refuses to await a candidate whose checkpoint was cancelled and has no producer', () => {
    const cancelledRun = {
      active: false,
      activeSource: 'run-lock' as const,
      candidate: null,
      startedAtMs: null,
      elapsedSec: null,
      asOfAgeMs: 0,
    };
    const cancelled = {
      status: 'cancelled',
      candidate: sha.slice(0, 8),
      detail: 'externally SIGTERMed before a result marker was published',
      observedAtMs: 123,
    };
    const out = buildReleaseTrace(
      input({
        position: position({
          positions: { committedLocal: true, onStaging: true, inMain: false, deployed: false },
          gate: { ...position().gate, checkpointRunInFlight: cancelledRun, inconclusive: cancelled },
        }),
        gate: {
          ...input().gate,
          checkpointRunInFlight: cancelledRun,
          inconclusive: cancelled,
        },
      }),
    );

    expect(out.constraints.find((c) => c.code === 'checkpoint-run-cancelled')?.summary).toMatch(
      /externally cancelled without a verdict/i,
    );
    expect(out.nextVerb).toMatchObject({ name: 'release:checkpoint-run', args: {} });
    expect(out.nextVerb?.reason).toMatch(/do not await a candidate-bound result/i);
  });
});

describe('EI-21456558908416090: withheld manual checkpoint-run authority', () => {
  /** The exact live shape: a stale gate verdict, which recommends release:checkpoint-run. */
  function staleGate(gateOver: Partial<ReleaseTraceGate> = {}) {
    return input({
      position: position({
        positions: { committedLocal: true, onStaging: true, inMain: false, deployed: false },
      }),
      gate: {
        ...input().gate,
        verdictStale: true,
        verdictStaleReason: 'no fire in 3h',
        ...gateOver,
      },
    });
  }

  const withheld = {
    withheld: true as const,
    governingRef: 'stable-candidate-related-gate-2026-08-23#D-061',
    source: 'manual-run-hold' as const,
    reason: "D-042's never-launch-a-duplicate survives this decision intact.",
  };

  // ── CONTROLS ───────────────────────────────────────────────────────────────
  // These two are PERMANENT falsifiability controls, not setup. Without them a
  // suppression that fired unconditionally — the easiest way to get this wrong, and one that
  // would silently blind every reader of a healthy pipeline — would pass the whole suite.

  it('CONTROL: with no withheld authority, a stale gate still recommends release:checkpoint-run', () => {
    const out = buildReleaseTrace(staleGate());
    expect(out.nextVerb).toMatchObject({ name: 'release:checkpoint-run' });
    expect(out.constraints.map((c) => c.code)).not.toContain('manual-checkpoint-authority-withheld');
  });

  it('CONTROL: withheld:false is authority GRANTED, not withheld', () => {
    const out = buildReleaseTrace(staleGate({ manualRunAuthority: { ...withheld, withheld: false } }));
    expect(out.nextVerb).toMatchObject({ name: 'release:checkpoint-run' });
  });

  it('CONTROL: a withheld authority with a blank governingRef does not suppress', () => {
    // An unattributable prohibition is how an unexplained frozen gate happens. It must not be
    // able to silently remove the recommendation with nothing naming who to ask.
    const out = buildReleaseTrace(staleGate({ manualRunAuthority: { ...withheld, governingRef: '   ' } }));
    expect(out.nextVerb).toMatchObject({ name: 'release:checkpoint-run' });
  });

  // ── THE DEFECT ─────────────────────────────────────────────────────────────

  it('suppresses the release:checkpoint-run recommendation and names the governing decision', () => {
    const out = buildReleaseTrace(staleGate({ manualRunAuthority: withheld }));

    expect(out.nextVerb?.name).not.toBe('release:checkpoint-run');
    expect(out.nextVerb).toMatchObject({ name: 'checkpoint:await', args: { pipeline: 'papercusp' } });
    // A bare null would teach the reader nothing and invite them to reach for the forbidden
    // verb from memory; the reply must say which decision withholds it.
    expect(out.nextVerb?.reason).toContain('stable-candidate-related-gate-2026-08-23#D-061');
    expect(out.nextVerb?.reason).toMatch(/MANUAL CHECKPOINT AUTHORITY WITHHELD/);
  });

  it('generalizes: any governing ref suppresses, not just the decision ids seen so far', () => {
    // The regression this whole item exists to prevent. The prior implementation typed
    // governingRef as the D-053 literal, so D-061 fell through. A future D-099 must not.
    const out = buildReleaseTrace(
      staleGate({
        manualRunAuthority: { ...withheld, governingRef: 'some-future-plan-2027-01-01#D-099' },
      }),
    );
    expect(out.nextVerb?.name).toBe('checkpoint:await');
    expect(out.nextVerb?.reason).toContain('some-future-plan-2027-01-01#D-099');
  });

  it('guards a SECOND recommendation site: the ahead-of-gate deployed lineage', () => {
    // Proves the guard sits at the boundary rather than on one branch. Four separate paths
    // can return release:checkpoint-run; a per-branch fix would leave three armed.
    const aheadOfGate = input({
      position: position({
        positions: { committedLocal: true, onStaging: true, inMain: true, deployed: true },
        verdictProvenance: {
          ...position().verdictProvenance,
          deployOrigin: 'ahead-of-gate',
        },
      }),
    });
    expect(buildReleaseTrace(aheadOfGate).nextVerb).toMatchObject({ name: 'release:checkpoint-run' });

    const guarded = buildReleaseTrace({
      ...aheadOfGate,
      gate: { ...aheadOfGate.gate, manualRunAuthority: withheld },
    });
    expect(guarded.nextVerb?.name).toBe('checkpoint:await');
  });

  it('reports the withholding as a NON-blocking constraint, so a green target still reads ok', () => {
    // `ok` means "this exact SHA is release-complete". A governance decision about who may fire
    // the gate by hand says nothing about that, so it must not flip a green, deployed,
    // parity-matched target to ok:false.
    const complete = input({
      position: position({
        positions: { committedLocal: true, onStaging: true, inMain: true, deployed: true },
      }),
      gate: { ...input().gate, manualRunAuthority: withheld },
    });
    const out = buildReleaseTrace(complete);

    expect(out.ok).toBe(true);
    expect(out.constraints).toContainEqual(
      expect.objectContaining({ code: 'manual-checkpoint-authority-withheld', blocking: false }),
    );
    expect(out.constraints.find((c) => c.code === 'manual-checkpoint-authority-withheld')?.summary).toMatch(
      /Scheduled gate fires are unaffected/,
    );
  });

  it('does not double-report when the in-module D-053 consumed authority already applies', () => {
    // The consumed authority raises its own BLOCKING constraint and suppresses the verb
    // entirely; adding a second, non-blocking constraint for the same fact would make one
    // prohibition read as two.
    const checkpointRun = {
      active: false,
      terminalMarker: true,
      terminalEvidence: {
        source: 'systemd-exec-stop-post' as const,
        candidate: sha,
        serviceResult: 'oom-kill',
        exitCode: 'killed',
        exitStatus: 'KILL',
        abnormal: true,
      },
      candidate: null,
      startedAtMs: null,
      elapsedSec: null,
      asOfAgeMs: 0,
    };
    const out = buildReleaseTrace(
      input({
        position: position({
          positions: { committedLocal: true, onStaging: true, inMain: false, deployed: false },
          gate: { ...position().gate, checkpointRunInFlight: checkpointRun },
        }),
        gate: { ...input().gate, checkpointRunInFlight: checkpointRun, manualRunAuthority: withheld },
      }),
    );

    expect(out.constraints).toContainEqual(
      expect.objectContaining({ code: 'checkpoint-authority-consumed', blocking: true }),
    );
    expect(out.constraints.map((c) => c.code)).not.toContain('manual-checkpoint-authority-withheld');
    expect(out.nextVerb).toBeNull();
  });
});
