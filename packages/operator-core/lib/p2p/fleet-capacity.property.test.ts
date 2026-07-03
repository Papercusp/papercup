/**
 * P-206 fleet capacity view — PROPERTY suite (fast-check).
 *
 *  1. FLEET-SCOPED EXACTNESS: the aggregate remaining per (axis,unit) equals the
 *     sum of members' remainders FOR THAT FLEET ONLY — a member's other-fleet
 *     remainders never leak in — and every total is non-negative.
 *  2. MONOTONICITY: adding a member never DECREASES any aggregate (remaining per
 *     key, lease count, free slots, health counts) — capacity only accrues.
 *  3. UNIT SAFETY (H14): a same-axis unit disagreement is kept in separate per-unit
 *     entries and flagged; amounts are never cross-summed.
 *  4. STRUCTURAL: the view carries exactly the fleet-scoped fields — never an
 *     account total.
 *
 * Constructive arbitraries — no fc.pre / .filter.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import type { AdvertisedCapacity } from './metering-ledger';
import { aggregateFleetCapacity, type MemberCapacityReport } from './fleet-capacity';

const FLEETS = ['f/a', 'f/b'] as const;
const AXES = ['remote', 'local'] as const;

// A member ad over fleets f/a,f/b with a consistent unit per axis (remote=usd-micros, local=slot-seconds).
const memberArb: fc.Arbitrary<MemberCapacityReport> = fc
  .record({
    hostRef: fc.string({ minLength: 1, maxLength: 6 }).map((s) => `host:${s}`),
    rems: fc.array(
      fc.record({
        fleetSlug: fc.constantFrom(...FLEETS),
        axis: fc.constantFrom(...AXES),
        remaining: fc.integer({ min: 1, max: 5000 }),
      }),
      { maxLength: 8 },
    ),
    leaseAmts: fc.array(fc.record({ fleetSlug: fc.constantFrom(...FLEETS), amount: fc.integer({ min: 1, max: 1000 }) }), { maxLength: 5 }),
    slotsFree: fc.integer({ min: 0, max: 32 }),
    health: fc.record({ offersPending: fc.integer({ min: 0, max: 20 }), offersClaimed: fc.integer({ min: 0, max: 20 }), offersStalled: fc.integer({ min: 0, max: 20 }) }),
  })
  .map((r): MemberCapacityReport => {
    const unitFor = (axis: string) => (axis === 'remote' ? ('usd-micros' as const) : ('slot-seconds' as const));
    const advertised: AdvertisedCapacity = {
      hostRef: r.hostRef,
      fleetRemainders: r.rems.map((x) => ({ fleetSlug: x.fleetSlug, axis: x.axis, remaining: x.remaining, unit: unitFor(x.axis) })),
      leaseGrants: r.leaseAmts.map((x, i) => ({ leaseId: `L${i}`, fleetSlug: x.fleetSlug, axis: 'remote' as const, amount: x.amount, unit: 'usd-micros' as const })),
    };
    return { advertised, slotsFree: r.slotsFree, health: r.health };
  });

const VIEW_KEYS = ['activeLeaseCount', 'activeLeasedByAxis', 'fleetSlug', 'health', 'memberCount', 'perMember', 'remainingByAxis', 'totalSlotsFree', 'unitConflicts'].sort();

describe('P-206 property — fleet-scoped exactness', () => {
  it('aggregate remaining per (axis,unit) = sum of members FOR THAT FLEET only; non-negative', () => {
    fc.assert(
      fc.property(fc.array(memberArb, { maxLength: 12 }), fc.constantFrom(...FLEETS), (members, fleet) => {
        const v = aggregateFleetCapacity(fleet, members);
        // Independently compute expected per (axis,unit) for THIS fleet only.
        const expected = new Map<string, number>();
        for (const m of members) {
          for (const r of m.advertised.fleetRemainders) {
            if (r.fleetSlug !== fleet) continue;
            const k = `${r.axis} ${r.unit}`;
            expected.set(k, (expected.get(k) ?? 0) + r.remaining);
          }
        }
        const got = new Map(v.remainingByAxis.map((e) => [`${e.axis} ${e.unit}`, e.amount]));
        expect(got).toEqual(expected);
        for (const e of v.remainingByAxis) expect(e.amount).toBeGreaterThanOrEqual(0);
        // lease count == number of this-fleet lease grants across members
        const expectedLeases = members.reduce((s, m) => s + m.advertised.leaseGrants.filter((g) => g.fleetSlug === fleet).length, 0);
        expect(v.activeLeaseCount).toBe(expectedLeases);
        expect(Object.keys(v).sort()).toEqual(VIEW_KEYS);
      }),
      { numRuns: 400 },
    );
  });
});

describe('P-206 property — monotonicity (capacity only accrues)', () => {
  it('adding a member never decreases any aggregate', () => {
    fc.assert(
      fc.property(fc.array(memberArb, { maxLength: 10 }), memberArb, fc.constantFrom(...FLEETS), (base, extra, fleet) => {
        const a = aggregateFleetCapacity(fleet, base);
        const b = aggregateFleetCapacity(fleet, [...base, extra]);
        expect(b.totalSlotsFree).toBeGreaterThanOrEqual(a.totalSlotsFree);
        expect(b.activeLeaseCount).toBeGreaterThanOrEqual(a.activeLeaseCount);
        expect(b.memberCount).toBe(a.memberCount + 1);
        expect(b.health.offersPending).toBeGreaterThanOrEqual(a.health.offersPending);
        expect(b.health.offersClaimed).toBeGreaterThanOrEqual(a.health.offersClaimed);
        expect(b.health.offersStalled).toBeGreaterThanOrEqual(a.health.offersStalled);
        // every (axis,unit) present in `a` has a >= amount in `b`
        const bMap = new Map(b.remainingByAxis.map((e) => [`${e.axis} ${e.unit}`, e.amount]));
        for (const e of a.remainingByAxis) {
          expect(bMap.get(`${e.axis} ${e.unit}`) ?? 0).toBeGreaterThanOrEqual(e.amount);
        }
      }),
      { numRuns: 300 },
    );
  });
});

describe('P-206 property — H14 unit safety', () => {
  it('a same-axis unit disagreement is flagged and kept in separate entries (never cross-summed)', () => {
    // Two members: same fleet+axis, DIFFERENT units.
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1000 }), fc.integer({ min: 1, max: 1000 }), (aAmt, bAmt) => {
        const members: MemberCapacityReport[] = [
          { advertised: { hostRef: 'host:a', fleetRemainders: [{ fleetSlug: 'f/a', axis: 'remote', remaining: aAmt, unit: 'usd-micros' }], leaseGrants: [] } },
          { advertised: { hostRef: 'host:b', fleetRemainders: [{ fleetSlug: 'f/a', axis: 'remote', remaining: bAmt, unit: 'tokens' }], leaseGrants: [] } },
        ];
        const v = aggregateFleetCapacity('f/a', members);
        expect(v.unitConflicts).toContain('remote');
        const usd = v.remainingByAxis.find((e) => e.axis === 'remote' && e.unit === 'usd-micros')!;
        const tok = v.remainingByAxis.find((e) => e.axis === 'remote' && e.unit === 'tokens')!;
        expect(usd.amount).toBe(aAmt);
        expect(tok.amount).toBe(bAmt); // separate — never aAmt+bAmt in one entry
      }),
      { numRuns: 200 },
    );
  });
});
