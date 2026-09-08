import { describe, expect, it } from 'vitest';
import type { FleetLaneHealth, FleetLaneHealthUnavailable } from '../../fleet/lane-health';
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
      planScoped: false,
    },
  };
}

describe('buildClaimableNowAggregate (WI-41164 / P-002)', () => {
  it('binds a measured count to the exact caller-neutral fleet population', () => {
    const aggregate = buildClaimableNowAggregate({
      fleet: 'observability-fleet',
      requestedHarness: 'papercusp',
      laneHealth: laneHealth(5),
      fleetPaused: false,
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
    expect(aggregate.interpretation).toMatchObject({
      state: 'claimable',
      exactness: { status: 'exact' },
      evidence: { fleetPaused: false },
    });
    expect(aggregate.population.note).toContain('caller-neutral FLEET population');
    expect(aggregate.population.note).toContain('assigneeScoped:null');
    expect(aggregate.population.note).toContain('release-cooldown and reserved-plan-lane floors');
    expect(aggregate.population.note).toContain('different count even when passed this exact spec+harness');
  });

  it('keeps the resolved population and an in-band reason when one family is unmeasured', () => {
    const aggregate = buildClaimableNowAggregate({
      fleet: 'observability-fleet',
      requestedHarness: 'papercusp',
      laneHealth: laneHealth(null),
      fleetPaused: false,
    });

    expect(aggregate).toMatchObject({
      value: null,
      population: {
        fleet: 'observability-fleet',
        spec: { ref: 'fleet-lane@4', assigneeScoped: null },
        basis: 'issue+feature-family',
      },
      unknown: { code: 'not-measured', detail: expect.stringContaining('do not read') },
      interpretation: { state: 'unknown', exactness: { status: 'unknown' } },
    });
  });

  it('retains the requested fleet+harness even when the spec resolver returns no measurement', () => {
    expect(
      buildClaimableNowAggregate({
        fleet: 'observability-fleet',
        requestedHarness: 'papercusp',
        laneHealth: null,
        fleetPaused: false,
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
      interpretation: { state: 'unknown', exactness: { status: 'unknown' } },
    });
  });

  it('preserves a resolved population, typed cause, and exact recovery call when the issue read is skipped', () => {
    const unavailable: FleetLaneHealthUnavailable = {
      code: 'issue-family-budget-insufficient',
      stage: 'issue-family',
      detail: 'The 750ms caller budget is below the safe-start floor, so the aggregate was not launched.',
      recoverVia:
        'work_items:claimable {"harness":"papercusp","spec":"observability-fleet","breakdownOnly":true}',
      spec: {
        ref: 'fleet-lane@4',
        specId: 'fleet-lane',
        revision: 4,
        matchedBy: 'fleet-slug',
        harness: 'papercusp',
        assigneeScoped: null,
        planScoped: false,
      },
      basis: 'issue+feature-family',
    };

    const aggregate = buildClaimableNowAggregate({
      fleet: 'observability-fleet',
      requestedHarness: 'papercusp',
      laneHealth: null,
      unavailable,
      fleetPaused: false,
    });

    expect(aggregate).toMatchObject({
      value: null,
      population: {
        harness: 'papercusp',
        spec: { ref: 'fleet-lane@4', matchedBy: 'fleet-slug', assigneeScoped: null },
        basis: 'issue+feature-family',
      },
      unknown: {
        code: 'issue-family-budget-insufficient',
        detail: expect.stringContaining('aggregate was not launched'),
        recoverVia: unavailable.recoverVia,
      },
      interpretation: { state: 'unknown' },
    });
    expect(aggregate.population.note).toContain(unavailable.recoverVia);
  });

  it.each([
    {
      name: 'an intentionally empty non-plan spec',
      planScoped: false,
      matchedByFilter: 0,
      excluded: {},
      fleetPaused: false,
      state: 'spec-empty',
    },
    {
      name: 'an empty exact-plan lane',
      planScoped: true,
      matchedByFilter: 0,
      excluded: {},
      fleetPaused: false,
      state: 'drained',
    },
    {
      name: 'a floor-gated lane',
      planScoped: false,
      matchedByFilter: 5,
      excluded: { claimHold: 5 },
      fleetPaused: false,
      state: 'floor-gated',
    },
    {
      name: 'a paused lane even when rows would otherwise be claimable',
      planScoped: false,
      matchedByFilter: 5,
      excluded: {},
      fleetPaused: true,
      state: 'paused',
    },
  ])('makes $name machine-distinct', ({ planScoped, matchedByFilter, excluded, fleetPaused, state }) => {
    const lane = laneHealth(0);
    lane.spec.planScoped = planScoped;
    lane.effective = {
      claimable: fleetPaused ? 3 : 0,
      matchedByFilter,
      excluded: excluded as Record<string, number>,
      basis: 'issue+feature-family',
    };
    const aggregate = buildClaimableNowAggregate({
      fleet: 'observability-fleet',
      requestedHarness: 'papercusp',
      laneHealth: lane,
      fleetPaused,
    });

    expect(aggregate.interpretation).toMatchObject({
      state,
      exactness: { status: 'exact' },
      evidence: { fleetPaused, matchedByFilter, excluded },
    });
  });

  it('refuses to invent a floor cause when zero has no active exclusion evidence', () => {
    const lane = laneHealth(0);
    lane.effective = {
      claimable: 0,
      matchedByFilter: 3,
      excluded: {},
      basis: 'issue+feature-family',
    };
    const aggregate = buildClaimableNowAggregate({
      fleet: 'observability-fleet',
      laneHealth: lane,
      fleetPaused: false,
    });
    expect(aggregate.interpretation).toMatchObject({ state: 'unknown', exactness: { status: 'unknown' } });
  });
});
