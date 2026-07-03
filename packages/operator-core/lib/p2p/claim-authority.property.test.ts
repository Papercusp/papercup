import fc from 'fast-check';
import { describe, it, expect } from 'vitest';
import {
  type AxisAvailability,
  type HostAvailability,
  axisAvailable,
  axisForResourceKind,
  buildClaimLedgers,
  claimRefusalToReceiptFields,
  evaluateClaimAuthority,
} from './claim-authority';
import { type BudgetEnvelope, type WorkOffer, reserve, remaining } from './offer-budget';

/**
 * Property invariants for the D-007 host-gateway claim gate (P-202): claimable
 * iff min(allotment-remaining, live headroom) > 0 per drawn axis, and the
 * effective cap it hands back never exceeds ANY of {offer envelope, allotment,
 * headroom} — so the P-107 ledger it seeds can never over-draw.
 */

const offerWith = (budget: BudgetEnvelope): WorkOffer => ({
  offerId: 'ofr',
  fleetSlug: 'f',
  publisherRef: 'p',
  billedTo: 'b',
  modelClass: 'any',
  priority: 0,
  isolationReqs: [],
  budget,
  publishedAt: 0,
  ttlMs: 1_000,
});

const availability = (): fc.Arbitrary<AxisAvailability> =>
  fc.record({ allotmentRemaining: fc.integer({ min: 0, max: 100_000 }), liveHeadroom: fc.integer({ min: 0, max: 100_000 }) });

const optionalAvail = (): fc.Arbitrary<AxisAvailability | null> => fc.oneof(fc.constant(null), availability());

const optionalAxisCap = () =>
  fc.oneof(
    fc.constant(null),
    fc.record({
      cap: fc.integer({ min: 0, max: 100_000 }),
      unit: fc.constant('usd-micros' as const),
      maxPerCall: fc.oneof(fc.constant(null), fc.integer({ min: 1, max: 100_000 })),
    }),
  );

describe('axisAvailable (property)', () => {
  it('= max(0, min(allotmentRemaining, liveHeadroom))', () => {
    fc.assert(
      fc.property(fc.integer({ min: -100, max: 1000 }), fc.integer({ min: -100, max: 1000 }), (a, h) => {
        expect(axisAvailable({ allotmentRemaining: a, liveHeadroom: h })).toBe(Math.max(0, Math.min(a, h)));
      }),
    );
  });
});

describe('evaluateClaimAuthority (property)', () => {
  it('claimable iff every drawn axis is served AND min(allotment, headroom) >= 1', () => {
    fc.assert(
      fc.property(optionalAxisCap(), optionalAxisCap(), optionalAvail(), optionalAvail(), (remoteCap, localCap, remoteAv, localAv) => {
        const offer = offerWith({
          remote: remoteCap as BudgetEnvelope['remote'],
          local: localCap ? ({ ...localCap, unit: 'slots' } as BudgetEnvelope['local']) : null,
        });
        const host: HostAvailability = { remote: remoteAv, local: localAv };
        const res = evaluateClaimAuthority(offer, host);

        const drawn: Array<['remote' | 'local', typeof remoteAv]> = [];
        if (offer.budget.remote) drawn.push(['remote', remoteAv]);
        if (offer.budget.local) drawn.push(['local', localAv]);

        const expectClaimable = drawn.every(([, av]) => av != null && Math.min(Math.max(0, av.allotmentRemaining), Math.max(0, av.liveHeadroom)) >= 1);
        expect(res.claimable).toBe(expectClaimable);
      }),
    );
  });

  it('every granted effective cap <= offer cap AND <= allotment AND <= headroom (no over-draw)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 100_000 }), availability(), (offerCap, av) => {
        const offer = offerWith({ remote: { cap: offerCap, unit: 'usd-micros', maxPerCall: null }, local: null });
        const res = evaluateClaimAuthority(offer, { remote: av, local: null });
        if (!res.claimable) {
          // only reason to refuse a single served axis: available < 1
          expect(Math.min(av.allotmentRemaining, av.liveHeadroom)).toBeLessThan(1);
          return;
        }
        const g = res.grants.find((x) => x.axis === 'remote')!;
        expect(g.available).toBe(Math.min(av.allotmentRemaining, av.liveHeadroom));
        expect(g.effectiveCap.cap).toBeLessThanOrEqual(offerCap);
        expect(g.effectiveCap.cap).toBeLessThanOrEqual(av.allotmentRemaining);
        expect(g.effectiveCap.cap).toBeLessThanOrEqual(av.liveHeadroom);
        expect(g.effectiveCap.cap).toBe(Math.min(offerCap, av.allotmentRemaining, av.liveHeadroom));
      }),
    );
  });

  it('a served-but-short axis reports the BINDING layer (policy first)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 5 }), fc.integer({ min: 0, max: 5 }), (allot, headroom) => {
        fc.pre(Math.min(allot, headroom) < 1); // force a refusal
        const offer = offerWith({ remote: { cap: 1000, unit: 'usd-micros', maxPerCall: null }, local: null });
        const res = evaluateClaimAuthority(offer, { remote: { allotmentRemaining: allot, liveHeadroom: headroom }, local: null });
        expect(res.claimable).toBe(false);
        if (res.claimable) return;
        const r = res.refusals.find((x) => x.axis === 'remote')!;
        expect(r.code).toBe(allot < 1 ? 'no_allotment_remaining' : 'no_live_headroom');
      }),
    );
  });
});

describe('buildClaimLedgers composition with P-107 (property)', () => {
  it('a ledger seeded from a grant can reserve up to `available` and no more', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 50_000 }), fc.integer({ min: 1, max: 50_000 }), fc.integer({ min: 1, max: 50_000 }), (offerCap, allot, headroom) => {
        const offer = offerWith({ remote: { cap: offerCap, unit: 'usd-micros', maxPerCall: null }, local: null });
        const res = evaluateClaimAuthority(offer, { remote: { allotmentRemaining: allot, liveHeadroom: headroom }, local: null });
        expect(res.claimable).toBe(true);
        if (!res.claimable) return;
        const ledgers = buildClaimLedgers(res.grants);
        const remoteLedger = ledgers.remote!;
        const cap = Math.min(offerCap, allot, headroom);
        expect(remaining(remoteLedger)).toBe(cap);
        // exactly-cap reserves; cap+1 is refused → the claim can never over-draw the tightest bound
        expect(reserve(remoteLedger, cap, 'a').ok).toBe(true);
        const over = reserve(remoteLedger, cap + 1, 'b');
        expect(over.ok).toBe(false);
      }),
    );
  });
});

describe('axisForResourceKind + receipt mapping', () => {
  it('account → remote, gpu → local', () => {
    expect(axisForResourceKind('account')).toBe('remote');
    expect(axisForResourceKind('gpu')).toBe('local');
  });

  it('claimRefusalToReceiptFields always maps to a work-offer:claim receipt on the same axis', () => {
    fc.assert(
      fc.property(fc.constantFrom('remote' as const, 'local' as const), fc.constantFrom('axis_not_served' as const, 'no_allotment_remaining' as const, 'no_live_headroom' as const), (axis, code) => {
        const fields = claimRefusalToReceiptFields({ axis, code, available: 0, detail: 'x' });
        expect(fields.action).toBe('work-offer:claim');
        expect(fields.budgetAxis).toBe(axis);
        expect(fields.refusal.code).toBe(code);
      }),
    );
  });
});
