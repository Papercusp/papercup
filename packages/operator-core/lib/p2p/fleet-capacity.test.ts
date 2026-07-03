/**
 * P-206 fleet capacity view — EXAMPLE-based unit tests.
 *
 * Drives the aggregation (fleet-scoped remaining/lease sums, free slots, m13
 * health, H14 unit-conflict handling) + the advisory scheduling hints with
 * hand-built member ads. Generated invariants live in fleet-capacity.property.test.ts.
 */
import { describe, it, expect } from 'vitest';
import type { AdvertisedCapacity } from './metering-ledger';
import {
  aggregateFleetCapacity,
  hasStrandedWork,
  fleetHasHeadroom,
  rankPlacementCandidates,
  type MemberCapacityReport,
} from './fleet-capacity';

function ad(hostRef: string, remainders: AdvertisedCapacity['fleetRemainders'], leases: AdvertisedCapacity['leaseGrants'] = []): AdvertisedCapacity {
  return { hostRef, fleetRemainders: remainders, leaseGrants: leases };
}

describe('aggregateFleetCapacity — fleet-scoped sums', () => {
  const members: MemberCapacityReport[] = [
    {
      advertised: ad('host:h1', [
        { fleetSlug: 'f/a', axis: 'remote', remaining: 700, unit: 'usd-micros' },
        { fleetSlug: 'f/a', axis: 'local', remaining: 60, unit: 'slot-seconds' },
        { fleetSlug: 'f/b', axis: 'remote', remaining: 999, unit: 'usd-micros' }, // OTHER fleet — must not leak
      ], [{ leaseId: 'L1', fleetSlug: 'f/a', axis: 'remote', amount: 100, unit: 'usd-micros' }]),
      slotsFree: 4,
      health: { offersPending: 2, offersClaimed: 1, offersStalled: 0 },
    },
    {
      advertised: ad('host:h2', [
        { fleetSlug: 'f/a', axis: 'remote', remaining: 300, unit: 'usd-micros' },
      ], [
        { leaseId: 'L2', fleetSlug: 'f/a', axis: 'remote', amount: 50, unit: 'usd-micros' },
        { leaseId: 'L3', fleetSlug: 'f/b', axis: 'remote', amount: 77, unit: 'usd-micros' }, // OTHER fleet
      ]),
      slotsFree: 2,
      health: { offersPending: 1, offersClaimed: 0, offersStalled: 3 },
    },
  ];

  it('sums remaining per (axis,unit) scoped strictly to the target fleet', () => {
    const v = aggregateFleetCapacity('f/a', members);
    const byKey = Object.fromEntries(v.remainingByAxis.map((e) => [`${e.axis}:${e.unit}`, e.amount]));
    expect(byKey['remote:usd-micros']).toBe(1000); // 700 + 300 (f/b's 999 excluded)
    expect(byKey['local:slot-seconds']).toBe(60);
    expect(v.memberCount).toBe(2);
  });

  it('sums active leases scoped to the fleet (f/b lease excluded)', () => {
    const v = aggregateFleetCapacity('f/a', members);
    expect(v.activeLeaseCount).toBe(2); // L1 + L2 (L3 is f/b)
    expect(v.activeLeasedByAxis).toEqual([{ axis: 'remote', unit: 'usd-micros', amount: 150 }]);
  });

  it('sums free slots and m13 health across members', () => {
    const v = aggregateFleetCapacity('f/a', members);
    expect(v.totalSlotsFree).toBe(6);
    expect(v.health).toEqual({ offersPending: 3, offersClaimed: 1, offersStalled: 3 });
    expect(hasStrandedWork(v)).toBe(true); // offersStalled 3 > 0
  });

  it('exposes a per-member drill-down (a stalled host stays individually visible)', () => {
    const v = aggregateFleetCapacity('f/a', members);
    const h2 = v.perMember.find((m) => m.hostRef === 'host:h2')!;
    expect(h2.leaseCount).toBe(1); // only L2 for f/a
    expect(h2.health.offersStalled).toBe(3);
    expect(h2.remainingByAxis).toEqual([{ axis: 'remote', unit: 'usd-micros', amount: 300 }]);
  });

  it('carries exactly the fleet-scoped fields — no account total', () => {
    const v = aggregateFleetCapacity('f/a', members);
    expect(Object.keys(v).sort()).toEqual(
      ['activeLeaseCount', 'activeLeasedByAxis', 'fleetSlug', 'health', 'memberCount', 'perMember', 'remainingByAxis', 'totalSlotsFree', 'unitConflicts'].sort(),
    );
  });
});

describe('aggregateFleetCapacity — H14 unit conflicts never cross-sum', () => {
  it('keeps same-axis different-unit amounts separate and flags the axis', () => {
    const members: MemberCapacityReport[] = [
      { advertised: ad('host:h1', [{ fleetSlug: 'f/a', axis: 'remote', remaining: 100, unit: 'usd-micros' }]) },
      { advertised: ad('host:h2', [{ fleetSlug: 'f/a', axis: 'remote', remaining: 5, unit: 'tokens' }]) },
    ];
    const v = aggregateFleetCapacity('f/a', members);
    expect(v.remainingByAxis).toEqual(
      expect.arrayContaining([
        { axis: 'remote', unit: 'usd-micros', amount: 100 },
        { axis: 'remote', unit: 'tokens', amount: 5 },
      ]),
    );
    expect(v.unitConflicts).toEqual(['remote']); // never summed 100 + 5
  });
});

describe('advisory scheduling hints', () => {
  const members: MemberCapacityReport[] = [
    { advertised: ad('host:h1', [{ fleetSlug: 'f/a', axis: 'remote', remaining: 200, unit: 'usd-micros' }]), slotsFree: 1 },
    { advertised: ad('host:h2', [{ fleetSlug: 'f/a', axis: 'remote', remaining: 800, unit: 'usd-micros' }]), slotsFree: 9 },
    { advertised: ad('host:h3', [{ fleetSlug: 'f/a', axis: 'remote', remaining: 0, unit: 'usd-micros' }]), slotsFree: 5 },
  ];

  it('fleetHasHeadroom reflects any positive remaining on the axis', () => {
    const v = aggregateFleetCapacity('f/a', members);
    expect(fleetHasHeadroom(v, 'remote')).toBe(true);
    expect(fleetHasHeadroom(v, 'local')).toBe(false);
  });

  it('rankPlacementCandidates orders by headroom desc and drops zero-headroom hosts', () => {
    const v = aggregateFleetCapacity('f/a', members);
    const ranked = rankPlacementCandidates(v, 'remote');
    expect(ranked.map((r) => r.hostRef)).toEqual(['host:h2', 'host:h1']); // h3 (0 headroom) dropped
  });
});

describe('aggregateFleetCapacity — empty / no-match', () => {
  it('an empty member list yields a fully-zeroed view', () => {
    const v = aggregateFleetCapacity('f/a', []);
    expect(v).toMatchObject({
      memberCount: 0,
      remainingByAxis: [],
      activeLeasedByAxis: [],
      activeLeaseCount: 0,
      totalSlotsFree: 0,
      health: { offersPending: 0, offersClaimed: 0, offersStalled: 0 },
      unitConflicts: [],
      perMember: [],
    });
    expect(hasStrandedWork(v)).toBe(false);
  });
});
