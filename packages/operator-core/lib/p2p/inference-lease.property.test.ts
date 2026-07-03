/**
 * P-203 inference leases — PROPERTY suite (fast-check).
 *
 *  1. AUTHORITATIVE GATE (the load-bearing invariant): for ANY lease, gate,
 *     clock and high-water, revalidateAtClaim admits IFF the lease is un-expired
 *     AND epoch-fresh AND the gate admits. A lease can NEVER manufacture
 *     authorization the gate denies (leases advise, never replace).
 *  2. GRANT respects advisory capacity and stamps the receiver clock.
 *  3. BREACH classification: preemption is excused (no dent) IFF cause is
 *     preemption; every other cause dents.
 *
 * Constructive arbitraries — no fc.pre / .filter.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  grantLease,
  isLeaseExpired,
  isLeaseEpochFresh,
  revalidateAtClaim,
  classifyLeaseBreach,
  type InferenceLease,
  type LeaseBreachCause,
} from './inference-lease';

const leaseArb: fc.Arbitrary<InferenceLease> = fc.record({
  leaseId: fc.string({ minLength: 1, maxLength: 8 }),
  fleetSlug: fc.constantFrom('f/a', 'f/b'),
  axis: fc.constantFrom('remote' as const, 'local' as const),
  amount: fc.integer({ min: 1, max: 1000 }),
  unit: fc.constantFrom('usd-micros' as const, 'slots' as const),
  grantedAtReceiver: fc.integer({ min: 0, max: 10_000 }),
  ttlMs: fc.integer({ min: 1, max: 10_000 }),
  ownerEpoch: fc.integer({ min: 0, max: 10 }),
});

describe('P-203 property — revalidateAtClaim is the authoritative gate', () => {
  it('admits IFF un-expired AND epoch-fresh AND gate admits (leases never override)', () => {
    fc.assert(
      fc.property(
        leaseArb,
        fc.integer({ min: 0, max: 30_000 }), // nowReceiver
        fc.integer({ min: 0, max: 12 }), // ownerHighWaterEpoch
        fc.boolean(), // gate.admits
        (lease, nowReceiver, ownerHighWaterEpoch, gateAdmits) => {
          const r = revalidateAtClaim({
            lease,
            gate: { admits: gateAdmits, reason: gateAdmits ? undefined : 'no capacity' },
            nowReceiver,
            ownerHighWaterEpoch,
          });
          const expectedOk =
            !isLeaseExpired(lease, nowReceiver) &&
            isLeaseEpochFresh(lease, ownerHighWaterEpoch) &&
            gateAdmits;
          expect(r.ok).toBe(expectedOk);
          // A refusal always names the FIRST failing reason in the documented order.
          if (!r.ok) {
            if (isLeaseExpired(lease, nowReceiver)) expect(r.code).toBe('lease_expired');
            else if (!isLeaseEpochFresh(lease, ownerHighWaterEpoch)) expect(r.code).toBe('lease_epoch_stale');
            else expect(r.code).toBe('gate_refused');
          }
        },
      ),
      { numRuns: 500 },
    );
  });

  it('a valid lease NEVER admits when the gate refuses', () => {
    fc.assert(
      fc.property(leaseArb, (lease) => {
        // Force the lease valid: check at grant time with a fresh epoch.
        const r = revalidateAtClaim({
          lease,
          gate: { admits: false, reason: 'headroom exhausted' },
          nowReceiver: lease.grantedAtReceiver, // un-expired
          ownerHighWaterEpoch: lease.ownerEpoch, // fresh
        });
        expect(r.ok).toBe(false); // gate wins, always
      }),
      { numRuns: 200 },
    );
  });
});

describe('P-203 property — grant respects advisory capacity', () => {
  it('a granted lease never exceeds advisory remaining and stamps the receiver clock', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1000 }), // amount
        fc.integer({ min: 0, max: 1000 }), // advisoryRemaining
        fc.integer({ min: 0, max: 10_000 }), // nowReceiver
        fc.integer({ min: 1, max: 10_000 }), // ttlMs
        (amount, advisoryRemaining, nowReceiver, ttlMs) => {
          const r = grantLease(
            { leaseId: 'L', fleetSlug: 'f/a', axis: 'remote', amount, unit: 'usd-micros', ttlMs, ownerEpoch: 1 },
            { nowReceiver, advisoryRemaining },
          );
          if (amount <= advisoryRemaining) {
            expect(r.ok).toBe(true);
            if (r.ok) {
              expect(r.lease.amount).toBeLessThanOrEqual(advisoryRemaining);
              expect(r.lease.grantedAtReceiver).toBe(nowReceiver);
            }
          } else {
            expect(r).toMatchObject({ ok: false, code: 'no_advisory_capacity' });
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe('P-203 property — breach classification', () => {
  it('exactly preemption is excused; every other cause dents reliability', () => {
    const causes: LeaseBreachCause[] = ['preemption', 'host_reneged', 'host_unreachable', 'budget_exhausted'];
    fc.assert(
      fc.property(fc.constantFrom(...causes), (cause) => {
        const c = classifyLeaseBreach(cause);
        const isPreempt = cause === 'preemption';
        expect(c.dentsHostReliability).toBe(!isPreempt);
        expect(c.receiptKind).toBe(isPreempt ? 'excused-breach' : 'reliability-breach');
      }),
      { numRuns: 40 },
    );
  });
});
