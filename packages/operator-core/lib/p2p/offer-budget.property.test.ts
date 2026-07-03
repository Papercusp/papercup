import fc from 'fast-check';
import { describe, it, expect } from 'vitest';
import {
  type AxisCap,
  type BudgetUnit,
  type LedgerState,
  clampAxisToLocal,
  clampEnvelopeToLocal,
  createLedger,
  reserve,
  commit,
  release,
  remaining,
  reservedTotal,
  isExhausted,
  minNullable,
  resolveOfferLiveness,
  isOfferExpired,
  emptyPublisherWindow,
  recordAndCheckPublisherRate,
  decideWindDown,
  type WindDownCause,
} from './offer-budget';

/**
 * Property invariants for the P-107 budget contract. The hand-picked rows in
 * offer-budget.test.ts show the shapes; these assert the load-bearing
 * guarantees hold for EVERY input: no over-spend (H11), local-always-wins
 * clamp, fail-safe liveness (H12), and the publisher rate cap (H16).
 */

const UNITS: BudgetUnit[] = ['usd-micros', 'tokens', 'slot-seconds', 'slots'];

const axisCap = (maxCap: number): fc.Arbitrary<AxisCap> =>
  fc.record({
    cap: fc.integer({ min: 0, max: maxCap }),
    unit: fc.constantFrom(...UNITS),
    maxPerCall: fc.oneof(fc.constant(null), fc.integer({ min: 1, max: maxCap })),
  });

// ─── clamp: LOCAL ALWAYS WINS ────────────────────────────────────────────────

describe('clampAxisToLocal (property)', () => {
  it('effective cap = min(offer, local) and never exceeds either', () => {
    fc.assert(
      fc.property(axisCap(1_000_000), axisCap(1_000_000), (offer, local) => {
        const local2 = { ...local, unit: offer.unit }; // same unit for the axis-level clamp
        const eff = clampAxisToLocal(offer, local2);
        expect(eff.cap).toBe(Math.min(offer.cap, local2.cap));
        expect(eff.cap).toBeLessThanOrEqual(local2.cap); // LOCAL WINS — host cap is always a ceiling
        expect(eff.cap).toBeLessThanOrEqual(offer.cap);
        expect(eff.unit).toBe(local2.unit);
        // max-per-call is the TIGHTER of the two (null = no clamp)
        expect(eff.maxPerCall).toBe(minNullable(offer.maxPerCall, local2.maxPerCall));
      }),
    );
  });

  it('is idempotent: clamping the clamped value against the same local is a no-op', () => {
    fc.assert(
      fc.property(axisCap(1_000_000), axisCap(1_000_000), (offer, local) => {
        const local2 = { ...local, unit: offer.unit };
        const once = clampAxisToLocal(offer, local2);
        const twice = clampAxisToLocal(once, local2);
        expect(twice.cap).toBe(once.cap);
        expect(twice.maxPerCall).toBe(once.maxPerCall);
      }),
    );
  });
});

describe('clampEnvelopeToLocal (property)', () => {
  it('every clamped axis is <= the host local cap (LOCAL WINS), and unrequested axes stay null', () => {
    fc.assert(
      fc.property(
        fc.record({ cap: fc.integer({ min: 0, max: 1_000_000 }), maxPerCall: fc.constant(null) }),
        fc.record({ cap: fc.integer({ min: 0, max: 1_000_000 }), maxPerCall: fc.constant(null) }),
        fc.boolean(),
        (offerRemote, localRemote, offerWantsLocal) => {
          const unit: BudgetUnit = 'usd-micros';
          const offer = {
            remote: { cap: offerRemote.cap, unit, maxPerCall: offerRemote.maxPerCall } as AxisCap,
            local: offerWantsLocal ? ({ cap: 10, unit: 'slots', maxPerCall: null } as AxisCap) : null,
          };
          const local = {
            remote: { cap: localRemote.cap, unit, maxPerCall: localRemote.maxPerCall } as AxisCap,
            local: { cap: 5, unit: 'slots', maxPerCall: null } as AxisCap,
          };
          const out = clampEnvelopeToLocal(offer, local);
          expect(out.ok).toBe(true);
          if (!out.ok) return;
          expect(out.clamped.remote).not.toBeNull();
          expect(out.clamped.remote!.cap).toBeLessThanOrEqual(local.remote!.cap);
          expect(out.clamped.remote!.cap).toBeLessThanOrEqual(offer.remote!.cap);
          if (offerWantsLocal) {
            expect(out.clamped.local!.cap).toBe(5); // min(10 offer, 5 local) → local wins
          } else {
            expect(out.clamped.local).toBeNull(); // unrequested axis untouched
          }
        },
      ),
    );
  });

  it('refuses an axis the host has not allotted (M11 default-zero)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1000 }), (cap) => {
        const offer = { remote: { cap, unit: 'usd-micros', maxPerCall: null } as AxisCap, local: null };
        const local = { remote: null, local: null }; // host allotted nothing
        const out = clampEnvelopeToLocal(offer, local);
        expect(out.ok).toBe(false);
        if (out.ok) return;
        expect(out.code).toBe('budget_axis_unavailable');
        expect(out.axis).toBe('remote');
      }),
    );
  });

  it('refuses a unit mismatch (H14 — no cross-unit compare)', () => {
    const offer = { remote: { cap: 100, unit: 'tokens', maxPerCall: null } as AxisCap, local: null };
    const local = { remote: { cap: 100, unit: 'usd-micros', maxPerCall: null } as AxisCap, local: null };
    const out = clampEnvelopeToLocal(offer, local);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe('budget_unit_mismatch');
  });
});

// ─── ledger: NO OVER-SPEND across any op sequence (H11) ───────────────────────

type LedgerOp =
  | { t: 'reserve'; amount: number }
  | { t: 'commit'; pick: number; actualFrac: number }
  | { t: 'release'; pick: number };

const ledgerOp = (maxCap: number): fc.Arbitrary<LedgerOp> =>
  fc.oneof(
    fc.record({ t: fc.constant('reserve' as const), amount: fc.integer({ min: 0, max: maxCap + 50 }) }),
    fc.record({ t: fc.constant('commit' as const), pick: fc.nat({ max: 20 }), actualFrac: fc.double({ min: 0, max: 1, noNaN: true }) }),
    fc.record({ t: fc.constant('release' as const), pick: fc.nat({ max: 20 }) }),
  );

function assertLedgerInvariant(s: LedgerState) {
  // THE guarantee: never over-spend, in-flight reservations included.
  expect(s.committed).toBeGreaterThanOrEqual(0);
  expect(reservedTotal(s)).toBeGreaterThanOrEqual(0);
  expect(s.committed + reservedTotal(s)).toBeLessThanOrEqual(s.cap);
  expect(remaining(s)).toBeGreaterThanOrEqual(0);
  // every open reservation respects the max-per-call clamp
  if (s.maxPerCall != null) {
    for (const k in s.reservations) expect(s.reservations[k]!).toBeLessThanOrEqual(s.maxPerCall);
  }
}

describe('BudgetLedger (property) — no over-spend', () => {
  it('committed + in-flight <= cap after ANY reserve/commit/release sequence', () => {
    fc.assert(
      fc.property(axisCap(1000), fc.array(ledgerOp(1000), { maxLength: 40 }), (axis, ops) => {
        let s = createLedger(axis);
        assertLedgerInvariant(s);
        let counter = 0;
        let prevCommitted = 0;
        for (const op of ops) {
          const openIds = Object.keys(s.reservations);
          if (op.t === 'reserve') {
            const id = `r${counter++}`;
            const before = remaining(s);
            const res = reserve(s, op.amount, id);
            if (res.ok) {
              // a successful reserve must have been affordable + within the clamp
              expect(op.amount).toBeLessThanOrEqual(before);
              if (s.maxPerCall != null) expect(op.amount).toBeLessThanOrEqual(s.maxPerCall);
              s = res.state;
            } else {
              // a refusal is only ever exhaustion / clamp / bad-amount / dup — state unchanged
              expect(['invalid_amount', 'duplicate_reservation', 'max_per_call_exceeded', 'budget_exhausted']).toContain(res.code);
              if (res.code === 'budget_exhausted') expect(op.amount).toBeGreaterThan(before);
              if (res.code === 'max_per_call_exceeded') expect(op.amount).toBeGreaterThan(s.maxPerCall!);
            }
          } else if (op.t === 'commit') {
            if (openIds.length === 0) continue;
            const id = openIds[op.pick % openIds.length]!;
            const reserved = s.reservations[id]!;
            const actual = Math.floor(reserved * op.actualFrac);
            const res = commit(s, id, actual);
            expect(res.ok).toBe(true);
            if (res.ok) {
              expect(res.committedAmount).toBeLessThanOrEqual(reserved); // never over the envelope
              s = res.state;
            }
          } else {
            if (openIds.length === 0) continue;
            const id = openIds[op.pick % openIds.length]!;
            s = release(s, id);
          }
          assertLedgerInvariant(s);
          expect(s.committed).toBeGreaterThanOrEqual(prevCommitted); // committed only ever grows
          prevCommitted = s.committed;
        }
      }),
    );
  });

  it('reserve is exact at the boundary: exactly-remaining succeeds, remaining+1 is refused', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 10_000 }), (cap) => {
        const s = createLedger({ cap, unit: 'usd-micros', maxPerCall: null });
        const okExact = reserve(s, cap, 'a');
        expect(okExact.ok).toBe(true);
        const over = reserve(s, cap + 1, 'b');
        expect(over.ok).toBe(false);
        if (!over.ok) expect(over.code).toBe('budget_exhausted');
      }),
    );
  });

  it('releasing a reservation restores exactly the reserved amount to remaining', () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 10_000 }), fc.integer({ min: 1, max: 9999 }), (cap, want) => {
        const amount = Math.min(want, cap);
        const s = createLedger({ cap, unit: 'tokens', maxPerCall: null });
        const before = remaining(s);
        const r = reserve(s, amount, 'x');
        if (!r.ok) return;
        expect(remaining(r.state)).toBe(before - amount);
        const back = release(r.state, 'x');
        expect(remaining(back)).toBe(before);
      }),
    );
  });
});

// ─── liveness (H12) — fail safe ──────────────────────────────────────────────

describe('resolveOfferLiveness (property)', () => {
  it('an explicit cancel signal always wins', () => {
    fc.assert(
      fc.property(fc.integer(), fc.integer(), fc.integer({ min: 0, max: 1_000_000 }), (last, now, ttl) => {
        expect(resolveOfferLiveness({ cancelSignalSeen: true, lastConfirmedAt: last, now, livenessTtlMs: ttl })).toBe('cancelled');
      }),
    );
  });

  it('without cancel: age beyond TTL winds down, within TTL stays live, skew stays live', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1_000_000 }), fc.integer({ min: 1, max: 1_000_000 }), fc.integer({ min: 0, max: 2_000_000 }), (last, ttl, delta) => {
        const now = last + delta;
        const got = resolveOfferLiveness({ cancelSignalSeen: false, lastConfirmedAt: last, now, livenessTtlMs: ttl });
        expect(got).toBe(delta > ttl ? 'wind-down' : 'live');
        // backwards clock (skew) never winds down
        const skew = resolveOfferLiveness({ cancelSignalSeen: false, lastConfirmedAt: last, now: last - 1, livenessTtlMs: ttl });
        expect(skew).toBe('live');
      }),
    );
  });

  it('a non-positive TTL (no confirmation window) winds down when not cancelled', () => {
    fc.assert(
      fc.property(fc.integer(), fc.integer(), (last, now) => {
        expect(resolveOfferLiveness({ cancelSignalSeen: false, lastConfirmedAt: last, now, livenessTtlMs: 0 })).toBe('wind-down');
      }),
    );
  });
});

describe('isOfferExpired (property)', () => {
  it('expired iff now - publishedAt > ttlMs (boundary exclusive)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1_000_000 }), fc.integer({ min: 0, max: 1_000_000 }), fc.integer({ min: 0, max: 2_000_000 }), (publishedAt, ttlMs, delta) => {
        const now = publishedAt + delta;
        expect(isOfferExpired({ publishedAt, ttlMs }, now)).toBe(delta > ttlMs);
      }),
    );
  });
});

// ─── publisher rate cap (H16) ────────────────────────────────────────────────

describe('recordAndCheckPublisherRate (property)', () => {
  it('accepted offers within any sliding window never exceed maxOffers', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 6 }),
        fc.integer({ min: 10, max: 1000 }),
        fc.array(fc.integer({ min: 0, max: 50 }), { minLength: 1, maxLength: 60 }),
        (maxOffers, windowMs, gaps) => {
          let state = emptyPublisherWindow();
          const accepted: number[] = [];
          let now = 0;
          for (const gap of gaps) {
            now += gap;
            const r = recordAndCheckPublisherRate(state, now, { windowMs, maxOffers });
            state = r.state;
            if (r.ok) accepted.push(now);
          }
          // for every accepted stamp, the count of accepted stamps in (t-window, t] <= maxOffers
          for (const t of accepted) {
            const inWindow = accepted.filter((u) => u > t - windowMs && u <= t).length;
            expect(inWindow).toBeLessThanOrEqual(maxOffers);
          }
        },
      ),
    );
  });
});

// ─── wind-down taxonomy (X8) ─────────────────────────────────────────────────

describe('decideWindDown (property)', () => {
  it('only an explicit cancel is an excused breach; everything else is a refusal', () => {
    const causes: WindDownCause[] = ['budget_exhausted', 'cancelled', 'liveness_unconfirmable', 'offer_expired'];
    fc.assert(
      fc.property(fc.constantFrom(...causes), (cause) => {
        const d = decideWindDown(cause);
        expect(d.receiptKind).toBe(cause === 'cancelled' ? 'excused-breach' : 'refusal');
        expect(d.cause).toBe(cause);
      }),
    );
  });
});

// ─── exhaustion flag ─────────────────────────────────────────────────────────

describe('isExhausted (property)', () => {
  it('exhausted iff remaining < minViableCall', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1000 }), fc.integer({ min: 0, max: 1000 }), fc.integer({ min: 1, max: 100 }), (cap, spend, minViable) => {
        let s = createLedger({ cap, unit: 'tokens', maxPerCall: null });
        const r = reserve(s, Math.min(spend, cap), 'a');
        if (r.ok) {
          const c = commit(r.state, 'a');
          if (c.ok) s = c.state;
        }
        expect(isExhausted(s, minViable)).toBe(remaining(s) < minViable);
      }),
    );
  });
});
