import { describe, expect, it } from 'vitest';
import {
  FLEET_LIFECYCLE_BASELINE_AXIS_IDS,
  FLEET_LIFECYCLE_BASELINE_FIXTURE_V1,
  FLEET_LIFECYCLE_BASELINE_V1_CONTRACTS,
  replayFleetLifecycleBaseline,
} from './fleet-lifecycle-baseline';

describe('fleet lifecycle writer-defined baseline fixture', () => {
  it('covers every requested lifecycle axis exactly once with an owner and source units', () => {
    expect(FLEET_LIFECYCLE_BASELINE_V1_CONTRACTS.map((axis) => axis.id)).toEqual(
      FLEET_LIFECYCLE_BASELINE_AXIS_IDS,
    );
    expect(new Set(FLEET_LIFECYCLE_BASELINE_V1_CONTRACTS.map((axis) => axis.id)).size).toBe(
      FLEET_LIFECYCLE_BASELINE_AXIS_IDS.length,
    );
    for (const axis of FLEET_LIFECYCLE_BASELINE_V1_CONTRACTS) {
      expect(axis.writer.length).toBeGreaterThan(0);
      expect(Object.keys(axis.units).length).toBeGreaterThan(0);
      expect(axis.residualOwner).toMatch(/^P-\d{3}$/);
    }
  });

  it('freezes the fresh writer readings without turning them into thresholds', () => {
    expect(FLEET_LIFECYCLE_BASELINE_FIXTURE_V1).toMatchObject({
      schemaVersion: 'fleet-lifecycle-baseline-v1',
      capturedAt: '2026-08-27T04:32:41.476Z',
      boundary: { since: '2026-08-27T00:00:00.000Z' },
      axes: {
        bootStages: { status: 'partial', values: { sessions: 478, sessionsWithRealAgentCall: 418 } },
        wakeRegistration: { status: 'measured', values: { ownerWake: 0 } },
        schedulerPull: { status: 'measured', values: { pulls: 700, nonOkRows: 13 } },
        checkpointProgress: { status: 'partial', values: { heldNonterminal: 68, withCheckpointBody: 57 } },
        completionAuthority: { status: 'measured', values: { terminalTotal: 49916, gateJudged: 13896 } },
        directedBacklog: { status: 'measured', values: { inScopeAgents: 57, agentsWithUnansweredDirected: 4 } },
        compactionProof: { status: 'partial', values: { executableProbeFramework: true, fullProofWriter: false } },
      },
    });
  });

  it('keeps unavailable outcome writers unknown instead of manufacturing clean zeroes', () => {
    for (const id of ['claimDisposition', 'eventDuplication', 'proxyMutationOutcome'] as const) {
      expect(FLEET_LIFECYCLE_BASELINE_FIXTURE_V1.axes[id]).toMatchObject({
        status: 'unknown',
        values: null,
        reason: expect.any(String),
      });
    }
    // A real measured zero remains distinguishable from an unavailable axis.
    expect(FLEET_LIFECYCLE_BASELINE_FIXTURE_V1.axes.wakeRegistration.values?.ownerWake).toBe(0);
  });

  it('fails an omitted replay leg to explicit unknown without borrowing its contract coverage label', () => {
    const replay = replayFleetLifecycleBaseline({
      capturedAt: '2026-08-27T05:00:00.000Z',
      boundary: { since: '2026-08-27T04:00:00.000Z', scope: 'fixture' },
      readings: {
        schedulerPull: { status: 'measured', values: { pulls: 1 } },
      },
    });

    expect(replay.axes.schedulerPull).toMatchObject({ status: 'measured', values: { pulls: 1 } });
    expect(replay.axes.bootStages).toMatchObject({
      baselineCoverage: 'partial',
      status: 'unknown',
      values: null,
      reason: 'fixture-reading-missing',
    });
  });
});
