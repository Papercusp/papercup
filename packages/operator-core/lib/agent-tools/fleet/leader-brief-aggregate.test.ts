import { describe, expect, it } from 'vitest';
import type { FleetLaneHealth } from '../../fleet/lane-health';
import { buildClaimableNowAggregate } from './leader-brief-aggregate';

function laneHealth(claimable: number | null): FleetLaneHealth {
  return {
    claimable: 2,
    matchedByFilter: 7,
    excluded: { taken: 5 },
    issueFamily: { claimable: 2, matchedByFilter: 7, excluded: { taken: 5 } },
    featureFamily: { claimable, matchedByFilter: null, excluded: null },
    effective: {
      claimable: claimable == null ? null : claimable + 2,
      matchedByFilter: null,
      excluded: null,
      basis: 'issue+feature-family',
    },
    familyReachability: { issue: true, feature: true },
    spec: {
      ref: 'fleet-lane@4',
      specId: 'fleet-lane',
      revision: 4,
      matchedBy: 'fleet',
      harness: 'papercusp',
      assigneeScoped: null,
    },
  };
}

describe('buildClaimableNowAggregate (WI-41164 / P-002)', () => {
  it('binds a measured count to the exact caller-neutral fleet population', () => {
    const aggregate = buildClaimableNowAggregate({
      fleet: 'observability-fleet',
      requestedHarness: 'papercusp',
      laneHealth: laneHealth(5),
    });

    expect(aggregate).toMatchObject({
      value: 7,
      population: {
        kind: 'fleet-claim-spec',
        fleet: 'observability-fleet',
        harness: 'papercusp',
        spec: { ref: 'fleet-lane@4', revision: 4, assigneeScoped: null },
        basis: 'issue+feature-family',
      },
    });
    expect(aggregate).not.toHaveProperty('unknown');
  });

  it('keeps the resolved population and an in-band reason when one family is unmeasured', () => {
    const aggregate = buildClaimableNowAggregate({
      fleet: 'observability-fleet',
      requestedHarness: 'papercusp',
      laneHealth: laneHealth(null),
    });

    expect(aggregate).toMatchObject({
      value: null,
      population: {
        fleet: 'observability-fleet',
        spec: { ref: 'fleet-lane@4', assigneeScoped: null },
        basis: 'issue+feature-family',
      },
      unknown: { code: 'not-measured', detail: expect.stringContaining('do not read') },
    });
  });

  it('retains the requested fleet+harness even when the spec resolver returns no measurement', () => {
    expect(
      buildClaimableNowAggregate({
        fleet: 'observability-fleet',
        requestedHarness: 'papercusp',
        laneHealth: null,
      }),
    ).toMatchObject({
      value: null,
      population: {
        kind: 'fleet-claim-spec',
        fleet: 'observability-fleet',
        harness: 'papercusp',
        spec: null,
        basis: null,
      },
      unknown: { code: 'not-measured' },
    });
  });
});
