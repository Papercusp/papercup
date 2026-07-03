import fc from 'fast-check';
import { describe, it, expect } from 'vitest';
import {
  MODEL_CLASSES,
  decideModelClassRoute,
  evaluateRoutedClaimAuthority,
  type HostRouteSignals,
} from './model-class-routing';
import type { AxisCap, BudgetEnvelope, WorkOffer } from './offer-budget';
import type { HostAvailability } from './claim-authority';

/**
 * Property invariants for P-207 model-class routing: a route only ever names
 * axes the envelope draws; the composed gate's grants cover exactly the chosen
 * axis; routing can only NARROW what the D-007 gate would admit (it never
 * fabricates capacity); and the whole surface is total (no throw) on arbitrary
 * class strings / tolerances / signals.
 */

const capArb = (unit: AxisCap['unit']): fc.Arbitrary<AxisCap> =>
  fc.record({
    cap: fc.integer({ min: 0, max: 10_000 }),
    unit: fc.constant(unit),
    maxPerCall: fc.oneof(fc.constant(null), fc.integer({ min: 1, max: 500 })),
  });

const envelopeArb: fc.Arbitrary<BudgetEnvelope> = fc.record({
  remote: fc.option(capArb('usd-micros'), { nil: null }),
  local: fc.option(capArb('slots'), { nil: null }),
});

const classArb = fc.oneof(
  fc.constantFrom(...MODEL_CLASSES),
  fc.string({ maxLength: 20 }), // arbitrary junk — parse must fail closed, never throw
);

const toleranceArb = fc.oneof(
  fc.constant(null),
  fc.constant(undefined),
  fc.double({ noNaN: false, min: -1_000, max: 100_000 }),
);

const signalsArb: fc.Arbitrary<HostRouteSignals> = fc.record({
  localIndicativeLatencyMs: fc.option(fc.integer({ min: 0, max: 60_000 }), { nil: null }),
});

const hostArb: fc.Arbitrary<HostAvailability> = fc.record({
  remote: fc.option(
    fc.record({ allotmentRemaining: fc.integer({ min: 0, max: 5_000 }), liveHeadroom: fc.integer({ min: 0, max: 5_000 }) }),
    { nil: null },
  ),
  local: fc.option(
    fc.record({ allotmentRemaining: fc.integer({ min: 0, max: 8 }), liveHeadroom: fc.integer({ min: 0, max: 8 }) }),
    { nil: null },
  ),
});

const offerArb: fc.Arbitrary<WorkOffer> = fc
  .record({ modelClass: classArb, budget: envelopeArb, latencyToleranceMs: toleranceArb })
  .map(({ modelClass, budget, latencyToleranceMs }) => ({
    offerId: 'ofr',
    fleetSlug: 'f',
    publisherRef: 'p',
    billedTo: 'b',
    modelClass,
    priority: 0,
    isolationReqs: [],
    budget,
    publishedAt: 0,
    ttlMs: 1,
    ...(latencyToleranceMs !== undefined ? { latencyToleranceMs } : {}),
  }));

describe('P-207 routing properties', () => {
  it('total + sound: never throws; routed axes are unique and ⊆ the drawn envelope axes', () => {
    fc.assert(
      fc.property(offerArb, signalsArb, (offer, signals) => {
        const d = decideModelClassRoute(offer, signals);
        if (!d.ok) return; // refusals are the fail-closed lane
        expect(new Set(d.axes).size).toBe(d.axes.length);
        for (const axis of d.axes) expect(offer.budget[axis]).not.toBeNull();
      }),
    );
  });

  it('a class outside the vocabulary NEVER routes (fail-closed on arbitrary strings)', () => {
    fc.assert(
      fc.property(offerArb, signalsArb, (offer, signals) => {
        if ((MODEL_CLASSES as readonly string[]).includes(offer.modelClass)) return;
        const d = decideModelClassRoute(offer, signals);
        expect(!d.ok && d.refusal.code).toBe('unknown_model_class');
      }),
    );
  });

  it('composed gate: grants exist iff claimable, and cover EXACTLY the chosen axis', () => {
    fc.assert(
      fc.property(offerArb, hostArb, signalsArb, (offer, host, signals) => {
        const r = evaluateRoutedClaimAuthority(offer, host, signals);
        if (!r.ok) return;
        if (r.axis === null) {
          expect(r.grants).toEqual([]); // free unmetered task
          return;
        }
        expect(r.grants.map((g) => g.axis)).toEqual([r.axis]);
        // Routing never fabricates capacity: the chosen axis's grant is bounded
        // by BOTH the envelope and the host's two-layer availability.
        const want = offer.budget[r.axis]!;
        const avail = host[r.axis]!;
        expect(r.grants[0]!.effectiveCap.cap).toBeLessThanOrEqual(want.cap);
        expect(r.grants[0]!.effectiveCap.cap).toBeLessThanOrEqual(
          Math.max(0, Math.min(avail.allotmentRemaining, avail.liveHeadroom)),
        );
      }),
    );
  });

  it("'frontier-remote' NEVER lands on the local axis; 'local-small' never on remote", () => {
    fc.assert(
      fc.property(offerArb, hostArb, signalsArb, (offer, host, signals) => {
        const cls = offer.modelClass;
        if (cls !== 'frontier-remote' && cls !== 'local-small') return;
        const r = evaluateRoutedClaimAuthority(offer, host, signals);
        if (!r.ok || r.axis === null) return;
        expect(r.axis).toBe(cls === 'frontier-remote' ? 'remote' : 'local');
      }),
    );
  });
});
