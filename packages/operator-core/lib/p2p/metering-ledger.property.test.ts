/**
 * P-205 metering + contribution ledger — PROPERTY suite (fast-check).
 *
 *  1. SPEND ACCUMULATION: any sequence of same-unit draws on one (host,fleet,axis)
 *     sums EXACTLY to spentOn, and every counter is non-negative.
 *  2. CONTRIBUTION CAP (M22): for ANY sequence of credits with a per-user cap C,
 *     the per-user counter NEVER exceeds C, and credited never overshoots headroom.
 *  3. M22 per-USER-not-device: crediting one user across N calls (what would be N
 *     machines) equals a single cap-clamped credit of the total — device identity
 *     is structurally absent, so VMs cannot inflate reciprocity.
 *  4. PRIVACY: for ANY ledger + allotments + leases, the advertised view exposes
 *     ONLY fleet remainders (each in [0, cap]) + stripped lease grants, and its
 *     key-set is structurally incapable of carrying an account total / per-device /
 *     contribution field.
 *
 * Constructive arbitraries — no fc.pre / .filter.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import type { InferenceLease } from './inference-lease';
import {
  emptyMeteringLedger,
  recordSpend,
  spentOn,
  recordContribution,
  contributionOf,
  buildAdvertisedCapacity,
  type MeteringLedger,
} from './metering-ledger';

const HOSTS = ['host:h1', 'host:h2'] as const;
const FLEETS = ['f/a', 'f/b', 'f/c'] as const;
const AXES = ['remote', 'local'] as const;

describe('P-205 property — spend accumulation is exact and non-negative', () => {
  it('same-unit draws on one key sum exactly to spentOn', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 1, max: 10_000 }), { minLength: 1, maxLength: 40 }), (amounts) => {
        let l = emptyMeteringLedger();
        let sum = 0;
        for (const amount of amounts) {
          const r = recordSpend(l, { hostRef: 'host:h1', fleetSlug: 'f/a', axis: 'remote', amount, unit: 'usd-micros' });
          expect(r.ok).toBe(true);
          if (r.ok) {
            l = r.ledger;
            sum += amount;
            expect(r.total).toBe(sum);
          }
        }
        expect(spentOn(l, 'host:h1', 'f/a', 'remote')).toBe(sum);
        expect(spentOn(l, 'host:h1', 'f/a', 'remote')).toBeGreaterThanOrEqual(0);
      }),
      { numRuns: 300 },
    );
  });

  it('draws across many keys never cross-contaminate', () => {
    const drawArb = fc.record({
      hostRef: fc.constantFrom(...HOSTS),
      fleetSlug: fc.constantFrom(...FLEETS),
      axis: fc.constantFrom(...AXES),
      amount: fc.integer({ min: 1, max: 1000 }),
    });
    fc.assert(
      fc.property(fc.array(drawArb, { maxLength: 60 }), (draws) => {
        let l = emptyMeteringLedger();
        const expected = new Map<string, number>();
        for (const d of draws) {
          const r = recordSpend(l, { ...d, unit: 'usd-micros' });
          if (r.ok) {
            l = r.ledger;
            const k = `${d.hostRef}|${d.fleetSlug}|${d.axis}`;
            expected.set(k, (expected.get(k) ?? 0) + d.amount);
          }
        }
        for (const [k, v] of expected) {
          const [h, f, a] = k.split('|') as [string, string, (typeof AXES)[number]];
          expect(spentOn(l, h, f, a)).toBe(v);
        }
      }),
      { numRuns: 300 },
    );
  });
});

describe('P-205 property — contribution cap (M22) is never breached', () => {
  it('per-user counter never exceeds the cap; credited never overshoots headroom', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 5000 }), // perUserCap
        fc.array(fc.integer({ min: 1, max: 2000 }), { minLength: 1, maxLength: 30 }), // credits
        (cap, credits) => {
          let l = emptyMeteringLedger();
          for (const amount of credits) {
            const before = contributionOf(l, 'u', 'local');
            const r = recordContribution(l, { attestedUserId: 'u', axis: 'local', amount, unit: 'slot-seconds', perUserCap: cap });
            expect(r.ok).toBe(true);
            if (r.ok) {
              const headroom = Math.max(0, cap - before);
              expect(r.credited).toBe(Math.min(amount, headroom));
              expect(r.total).toBeLessThanOrEqual(cap);
              expect(r.capped).toBe(r.credited < amount);
              l = r.ledger;
            }
          }
          expect(contributionOf(l, 'u', 'local')).toBeLessThanOrEqual(cap);
        },
      ),
      { numRuns: 400 },
    );
  });

  it('per-USER not per-device: N split credits equal one cap-clamped total credit', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 5000 }), // cap
        fc.array(fc.integer({ min: 1, max: 1000 }), { minLength: 1, maxLength: 20 }), // credits from "different machines"
        (cap, credits) => {
          // Split across N calls (as if from N machines of one user).
          let split = emptyMeteringLedger();
          for (const amount of credits) {
            const r = recordContribution(split, { attestedUserId: 'user:5', axis: 'remote', amount, unit: 'usd-micros', perUserCap: cap });
            if (r.ok) split = r.ledger;
          }
          const total = credits.reduce((a, b) => a + b, 0);
          // Single credit of the sum, clamped to the same cap.
          let single = emptyMeteringLedger();
          const r = recordContribution(single, { attestedUserId: 'user:5', axis: 'remote', amount: total, unit: 'usd-micros', perUserCap: cap });
          if (r.ok) single = r.ledger;
          // Both land at min(total, cap): device identity never mattered.
          expect(contributionOf(split, 'user:5', 'remote')).toBe(Math.min(total, cap));
          expect(contributionOf(single, 'user:5', 'remote')).toBe(Math.min(total, cap));
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe('P-205 property — advertised view leaks nothing but fleet remainders + grants', () => {
  const allotmentArb = fc.record({
    fleetSlug: fc.constantFrom(...FLEETS),
    axis: fc.constantFrom(...AXES),
    cap: fc.integer({ min: 0, max: 5000 }),
  });
  const leaseArb: fc.Arbitrary<InferenceLease> = fc.record({
    leaseId: fc.string({ minLength: 1, maxLength: 6 }),
    fleetSlug: fc.constantFrom(...FLEETS),
    axis: fc.constantFrom(...AXES),
    amount: fc.integer({ min: 1, max: 1000 }),
    unit: fc.constant('usd-micros' as const),
    grantedAtReceiver: fc.integer({ min: 0, max: 10_000 }),
    ttlMs: fc.integer({ min: 1, max: 10_000 }),
    ownerEpoch: fc.integer({ min: 0, max: 10 }),
  });

  it('remainders in [0, cap]; only {hostRef, fleetRemainders, leaseGrants}; grants stripped', () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ fleetSlug: fc.constantFrom(...FLEETS), axis: fc.constantFrom(...AXES), amount: fc.integer({ min: 1, max: 4000 }) }), { maxLength: 30 }),
        fc.array(allotmentArb, { maxLength: 10 }),
        fc.array(leaseArb, { maxLength: 6 }),
        (draws, allotments, leases) => {
          let ledger: MeteringLedger = emptyMeteringLedger();
          for (const d of draws) {
            const r = recordSpend(ledger, { hostRef: 'host:h1', fleetSlug: d.fleetSlug, axis: d.axis, amount: d.amount, unit: 'usd-micros' });
            if (r.ok) ledger = r.ledger;
          }
          const adv = buildAdvertisedCapacity({
            hostRef: 'host:h1',
            ledger,
            allotments: allotments.map((a) => ({ ...a, unit: 'usd-micros' as const })),
            activeLeases: leases,
          });
          // Structural: exactly the three top-level keys — no account total / contribution / per-device field.
          expect(Object.keys(adv).sort()).toEqual(['fleetRemainders', 'hostRef', 'leaseGrants']);
          // Every remainder is bounded by its own allotment cap and never negative.
          expect(adv.fleetRemainders.length).toBe(allotments.length);
          for (let i = 0; i < adv.fleetRemainders.length; i++) {
            const rem = adv.fleetRemainders[i]!;
            expect(rem.remaining).toBeGreaterThanOrEqual(0);
            expect(rem.remaining).toBeLessThanOrEqual(allotments[i]!.cap);
            expect(Object.keys(rem).sort()).toEqual(['axis', 'fleetSlug', 'remaining', 'unit']);
          }
          // Grants carry ONLY the advertised fields (no grantedAtReceiver/ttlMs/ownerEpoch).
          expect(adv.leaseGrants.length).toBe(leases.length);
          for (const g of adv.leaseGrants) {
            expect(Object.keys(g).sort()).toEqual(['amount', 'axis', 'fleetSlug', 'leaseId', 'unit']);
          }
        },
      ),
      { numRuns: 400 },
    );
  });
});
