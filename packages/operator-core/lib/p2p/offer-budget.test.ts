import { describe, it, expect } from 'vitest';
import {
  type AxisCap,
  type BudgetEnvelope,
  clampEnvelopeToLocal,
  createLedger,
  reserve,
  commit,
  release,
  remaining,
  isExhausted,
  resolveOfferLiveness,
  isOfferExpired,
  emptyPublisherWindow,
  recordAndCheckPublisherRate,
  decideWindDown,
  reserveRefusalToWindDown,
} from './offer-budget';

const usd = (cap: number, maxPerCall: number | null = null): AxisCap => ({ cap, unit: 'usd-micros', maxPerCall });
const slots = (cap: number, maxPerCall: number | null = null): AxisCap => ({ cap, unit: 'slots', maxPerCall });

describe('clampEnvelopeToLocal — local always wins', () => {
  it('clamps a greedy offer down to the host allotment', () => {
    const offer: BudgetEnvelope = { remote: usd(5_000_000), local: null };
    const local: BudgetEnvelope = { remote: usd(1_000_000), local: slots(4) };
    const out = clampEnvelopeToLocal(offer, local);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.clamped.remote!.cap).toBe(1_000_000);
    expect(out.clamped.local).toBeNull(); // offer didn't request the local axis
    expect(out.notes.find((n) => n.axis === 'remote')!.capReduced).toBe(true);
  });

  it('adopts the host max-per-call clamp when the offer has none (H11)', () => {
    const offer: BudgetEnvelope = { remote: usd(1_000_000, null), local: null };
    const local: BudgetEnvelope = { remote: usd(1_000_000, 100_000), local: null };
    const out = clampEnvelopeToLocal(offer, local);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.clamped.remote!.maxPerCall).toBe(100_000);
    expect(out.notes.find((n) => n.axis === 'remote')!.maxPerCallTightened).toBe(true);
  });

  it('refuses an axis the host never allotted (M11)', () => {
    const offer: BudgetEnvelope = { remote: null, local: slots(2) };
    const local: BudgetEnvelope = { remote: usd(1_000_000), local: null };
    const out = clampEnvelopeToLocal(offer, local);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe('budget_axis_unavailable');
    expect(out.axis).toBe('local');
  });

  it('refuses a unit mismatch (H14)', () => {
    const offer: BudgetEnvelope = { remote: { cap: 100, unit: 'tokens', maxPerCall: null }, local: null };
    const local: BudgetEnvelope = { remote: usd(100), local: null };
    const out = clampEnvelopeToLocal(offer, local);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe('budget_unit_mismatch');
  });
});

describe('reservation ledger (H11) — the worked scenario', () => {
  it('reserves, exhausts, clamps per call, commits with refund, releases', () => {
    let s = createLedger(usd(1000, 400)); // cap 1000, max-per-call 400
    expect(remaining(s)).toBe(1000);

    const r1 = reserve(s, 400, 'c1');
    expect(r1.ok).toBe(true);
    if (r1.ok) s = r1.state;
    const r2 = reserve(s, 400, 'c2');
    expect(r2.ok).toBe(true);
    if (r2.ok) s = r2.state;
    expect(remaining(s)).toBe(200); // 1000 - 800 in-flight

    // a third 400 call cannot fit (only 200 left) — graceful exhaustion, not a crash
    const r3 = reserve(s, 400, 'c3');
    expect(r3.ok).toBe(false);
    if (!r3.ok) expect(r3.code).toBe('budget_exhausted');

    // an oversized single call is refused by the clamp regardless of remaining
    const rBig = reserve(createLedger(usd(1000, 400)), 500, 'big');
    expect(rBig.ok).toBe(false);
    if (!rBig.ok) expect(rBig.code).toBe('max_per_call_exceeded');

    // settle c1 for only 350 → refunds 50; release c2 entirely
    const cm = commit(s, 'c1', 350);
    expect(cm.ok).toBe(true);
    if (cm.ok) {
      s = cm.state;
      expect(cm.committedAmount).toBe(350);
    }
    expect(remaining(s)).toBe(1000 - 350 - 400); // committed 350 + c2 still in-flight 400 → 250
    s = release(s, 'c2');
    expect(remaining(s)).toBe(650); // only the 350 committed remains spent
    expect(s.committed).toBe(350);
  });

  it('cannot commit more than reserved (no over-spend past the envelope)', () => {
    let s = createLedger(usd(1000));
    const r = reserve(s, 300, 'c1');
    if (r.ok) s = r.state;
    const bad = commit(s, 'c1', 400);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.code).toBe('commit_exceeds_reservation');
  });

  it('maps a budget_exhausted refusal to a wind-down decision; max-per-call does NOT wind down', () => {
    expect(reserveRefusalToWindDown('budget_exhausted', 'remote')!.cause).toBe('budget_exhausted');
    expect(reserveRefusalToWindDown('max_per_call_exceeded', 'remote')).toBeNull();
    // fully spending the cap leaves the axis exhausted
    const r = reserve(createLedger(usd(10)), 10, 'a');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = commit(r.state, 'a');
    expect(c.ok).toBe(true);
    if (c.ok) expect(isExhausted(c.state)).toBe(true);
  });
});

describe('liveness (H12) + expiry (H16)', () => {
  it('cancel → cancelled, stale → wind-down, fresh → live', () => {
    expect(resolveOfferLiveness({ cancelSignalSeen: true, lastConfirmedAt: 0, now: 10, livenessTtlMs: 100 })).toBe('cancelled');
    expect(resolveOfferLiveness({ cancelSignalSeen: false, lastConfirmedAt: 0, now: 250, livenessTtlMs: 100 })).toBe('wind-down');
    expect(resolveOfferLiveness({ cancelSignalSeen: false, lastConfirmedAt: 0, now: 50, livenessTtlMs: 100 })).toBe('live');
  });

  it('unclaimed-offer TTL is exclusive at the boundary', () => {
    const offer = { publishedAt: 1000, ttlMs: 500 };
    expect(isOfferExpired(offer, 1500)).toBe(false); // exactly TTL — still live
    expect(isOfferExpired(offer, 1501)).toBe(true);
  });
});

describe('publisher rate cap (H16)', () => {
  it('caps offers-per-window and lets the window slide', () => {
    let st = emptyPublisherWindow();
    const win = { windowMs: 1000, maxOffers: 2 };
    const a = recordAndCheckPublisherRate(st, 0, win);
    expect(a.ok).toBe(true);
    st = a.state;
    const b = recordAndCheckPublisherRate(st, 100, win);
    expect(b.ok).toBe(true);
    st = b.state;
    const c = recordAndCheckPublisherRate(st, 200, win); // 3rd within the 1000ms window → refused
    expect(c.ok).toBe(false);
    if (!c.ok) expect(c.code).toBe('publisher_rate_exceeded');
    st = c.state;
    // at t=1200 both t=0 and t=100 (and the refused t=200 never recorded) are outside (1200-1000=200]
    const d = recordAndCheckPublisherRate(st, 1201, win);
    expect(d.ok).toBe(true);
  });
});

// The receipt for a wind-down is emitted by foreign-supervision.ts
// windDownForeignSession (covered in foreign-supervision.test.ts). These pin the
// pure decision it consumes: the X8 receipt kind and the axis it carries.
describe('decideWindDown — X8 receipt kind', () => {
  it('a budget-exhaustion wind-down is a refusal carrying the axis', () => {
    const d = decideWindDown('budget_exhausted', { axis: 'remote' });
    expect(d.cause).toBe('budget_exhausted');
    expect(d.receiptKind).toBe('refusal');
    expect(d.axis).toBe('remote');
    expect(d.detail).toContain('remote-axis budget exhausted');
  });

  it('a cancellation wind-down is an excused breach with no axis', () => {
    const d = decideWindDown('cancelled');
    expect(d.receiptKind).toBe('excused-breach');
    expect(d.axis).toBeNull();
  });

  it('every non-cancel cause is a plain refusal, and an explicit detail wins', () => {
    for (const cause of ['liveness_unconfirmable', 'offer_expired', 'quota_exceeded'] as const) {
      expect(decideWindDown(cause).receiptKind).toBe('refusal');
    }
    expect(decideWindDown('offer_expired', { detail: 'custom' }).detail).toBe('custom');
  });
});
