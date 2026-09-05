/**
 * Tests for the provider-neutral commerce ledger (P-010; D-025, D-028).
 *
 * The reducer is pure, so everything here is exercised directly with no I/O.
 * The invariants under test are the ones that make an entitlement trustworthy
 * independent of which provider produced the fact:
 *   - an entitlement exists only because an order reached `paid`;
 *   - a FULL refund revokes it, a PARTIAL one does not;
 *   - a refund never exceeds what was paid;
 *   - the fold is deterministic regardless of input order;
 *   - a replay is idempotent, and two different facts under one id are quarantined.
 */
import { describe, expect, it } from 'vitest';
import {
  LEDGER_EVENT_KINDS,
  type LedgerEvent,
  type LedgerEventKind,
  type LedgerState,
  type Money,
  entitlementIdFor,
  hasActiveEntitlement,
  isMoney,
  ledgerEventDigest,
  moneyEquals,
  reduceLedger,
  serializeLedgerState,
  validateLedgerEvent,
} from './commerce-ledger';

const USD = (amountMinor: number): Money => ({ amountMinor, currency: 'USD' });

let seq = 0;
function ev(
  kind: LedgerEventKind,
  payload: Record<string, unknown>,
  opts: { id?: string; at?: number; provider?: string; providerEventId?: string | null } = {},
): LedgerEvent {
  seq += 1;
  return {
    ledgerEventId: opts.id ?? `evt-${String(seq).padStart(4, '0')}`,
    kind,
    occurredAtMs: opts.at ?? seq * 1000,
    source: { provider: opts.provider ?? 'stripe', providerEventId: opts.providerEventId ?? null },
    payload,
  };
}

/** product + offer + order + paid — the happy path every refund test builds on. */
function paidOrderEvents(price = 5000): LedgerEvent[] {
  return [
    ev('product.defined', { productId: 'prod-1', skuRef: 'sku-1', creatorId: 'creator-1', title: 'A Thing' }, { at: 1_000 }),
    ev('offer.defined', { offerId: 'offer-1', productId: 'prod-1', pricingModel: 'one-time', price: USD(price) }, { at: 2_000 }),
    ev('order.created', { orderId: 'order-1', offerId: 'offer-1', buyerId: 'buyer-1' }, { at: 3_000 }),
    ev('order.paid', { orderId: 'order-1' }, { at: 4_000 }),
  ];
}

const codesOf = (state: LedgerState): string[] => state.rejected.map((r) => r.code);

describe('isMoney / moneyEquals', () => {
  it('accepts integer minor units with an ISO-4217 code', () => {
    expect(isMoney(USD(0))).toBe(true);
    expect(isMoney(USD(1234))).toBe(true);
  });

  it('rejects floats, negatives, and malformed currencies', () => {
    expect(isMoney({ amountMinor: 12.5, currency: 'USD' })).toBe(false);
    expect(isMoney({ amountMinor: -1, currency: 'USD' })).toBe(false);
    expect(isMoney({ amountMinor: 100, currency: 'usd' })).toBe(false);
    expect(isMoney({ amountMinor: 100, currency: 'DOLLAR' })).toBe(false);
    expect(isMoney(null)).toBe(false);
    expect(isMoney([100, 'USD'])).toBe(false);
  });

  it('compares amount and currency together', () => {
    expect(moneyEquals(USD(100), USD(100))).toBe(true);
    expect(moneyEquals(USD(100), { amountMinor: 100, currency: 'EUR' })).toBe(false);
  });
});

describe('validateLedgerEvent', () => {
  it('accepts a well-formed event', () => {
    const result = validateLedgerEvent(ev('order.paid', { orderId: 'order-1' }));
    expect(result.ok).toBe(true);
  });

  it.each([
    ['a non-object', 'not-an-event'],
    ['an array', []],
    ['null', null],
  ])('rejects %s', (_label, raw) => {
    const result = validateLedgerEvent(raw);
    expect(result).toMatchObject({ ok: false, code: 'invalid-event' });
  });

  it('requires a non-blank ledgerEventId', () => {
    expect(validateLedgerEvent({ ...ev('order.paid', {}), ledgerEventId: '   ' })).toMatchObject({ ok: false, code: 'invalid-event' });
  });

  it('rejects an unsupported kind', () => {
    const result = validateLedgerEvent({ ...ev('order.paid', {}), kind: 'order.teleported' });
    expect(result).toMatchObject({ ok: false, code: 'invalid-event' });
    if (!result.ok) expect(result.detail).toContain('order.teleported');
  });

  it('requires a finite, non-negative occurredAtMs', () => {
    expect(validateLedgerEvent({ ...ev('order.paid', {}), occurredAtMs: -1 })).toMatchObject({ ok: false });
    expect(validateLedgerEvent({ ...ev('order.paid', {}), occurredAtMs: Number.NaN })).toMatchObject({ ok: false });
  });

  it('requires source.provider and a string-or-null providerEventId', () => {
    expect(validateLedgerEvent({ ...ev('order.paid', {}), source: { provider: '', providerEventId: null } })).toMatchObject({ ok: false });
    expect(validateLedgerEvent({ ...ev('order.paid', {}), source: { provider: 'stripe', providerEventId: 42 } })).toMatchObject({ ok: false });
  });

  it('requires an object payload', () => {
    expect(validateLedgerEvent({ ...ev('order.paid', {}), payload: [] })).toMatchObject({ ok: false });
  });

  it('covers every declared kind', () => {
    for (const kind of LEDGER_EVENT_KINDS) {
      expect(validateLedgerEvent({ ...ev('order.paid', {}), kind }).ok).toBe(true);
    }
  });
});

describe('reduceLedger — entitlement lifecycle', () => {
  it('grants an entitlement addressed by the order when the order is paid', () => {
    const state = reduceLedger(paidOrderEvents());
    expect(state.rejected).toEqual([]);
    expect(state.orders.get('order-1')?.state).toBe('paid');
    const ent = state.entitlements.get(entitlementIdFor('order-1'));
    expect(ent).toMatchObject({ orderId: 'order-1', productId: 'prod-1', buyerId: 'buyer-1', state: 'active', revokedAtMs: null });
    expect(hasActiveEntitlement(state, 'buyer-1', 'prod-1')).toBe(true);
  });

  it('does not grant an entitlement for an order that never reached paid', () => {
    const events = paidOrderEvents().slice(0, 3);
    const state = reduceLedger(events);
    expect(state.entitlements.size).toBe(0);
    expect(hasActiveEntitlement(state, 'buyer-1', 'prod-1')).toBe(false);
  });

  it('treats a second order.paid as a no-op rather than minting a second entitlement', () => {
    const state = reduceLedger([...paidOrderEvents(), ev('order.paid', { orderId: 'order-1' }, { at: 5_000 })]);
    expect(state.rejected).toEqual([]);
    expect(state.entitlements.size).toBe(1);
  });

  it('revokes the entitlement on a FULL refund', () => {
    const state = reduceLedger([
      ...paidOrderEvents(5000),
      ev('refund.succeeded', { refundId: 'ref-1', orderId: 'order-1', amount: USD(5000) }, { at: 6_000 }),
    ]);
    expect(state.rejected).toEqual([]);
    expect(state.orders.get('order-1')).toMatchObject({ state: 'refunded', refundedMinor: 5000 });
    expect(state.entitlements.get(entitlementIdFor('order-1'))).toMatchObject({ state: 'revoked', revokeReason: 'refunded', revokedAtMs: 6_000 });
    expect(hasActiveEntitlement(state, 'buyer-1', 'prod-1')).toBe(false);
  });

  it('KEEPS the entitlement active on a PARTIAL refund', () => {
    const state = reduceLedger([
      ...paidOrderEvents(5000),
      ev('refund.succeeded', { refundId: 'ref-1', orderId: 'order-1', amount: USD(2000) }, { at: 6_000 }),
    ]);
    expect(state.rejected).toEqual([]);
    expect(state.orders.get('order-1')).toMatchObject({ state: 'partially-refunded', refundedMinor: 2000 });
    expect(state.entitlements.get(entitlementIdFor('order-1'))?.state).toBe('active');
    expect(hasActiveEntitlement(state, 'buyer-1', 'prod-1')).toBe(true);
  });

  it('revokes once partial refunds cumulatively reach the full amount', () => {
    const state = reduceLedger([
      ...paidOrderEvents(5000),
      ev('refund.succeeded', { refundId: 'ref-1', orderId: 'order-1', amount: USD(2000) }, { at: 6_000 }),
      ev('refund.succeeded', { refundId: 'ref-2', orderId: 'order-1', amount: USD(3000) }, { at: 7_000 }),
    ]);
    expect(state.rejected).toEqual([]);
    expect(state.orders.get('order-1')).toMatchObject({ state: 'refunded', refundedMinor: 5000 });
    expect(state.entitlements.get(entitlementIdFor('order-1'))?.state).toBe('revoked');
  });

  it('revokes explicitly via entitlement.revoked and records the reason', () => {
    const state = reduceLedger([
      ...paidOrderEvents(),
      ev('entitlement.revoked', { entitlementId: entitlementIdFor('order-1'), reason: 'chargeback' }, { at: 6_000 }),
    ]);
    expect(state.rejected).toEqual([]);
    expect(state.entitlements.get(entitlementIdFor('order-1'))).toMatchObject({ state: 'revoked', revokeReason: 'chargeback' });
  });

  it('scopes hasActiveEntitlement to the right buyer and product', () => {
    const state = reduceLedger(paidOrderEvents());
    expect(hasActiveEntitlement(state, 'buyer-2', 'prod-1')).toBe(false);
    expect(hasActiveEntitlement(state, 'buyer-1', 'prod-2')).toBe(false);
  });
});

describe('reduceLedger — money and transition rejections', () => {
  it('rejects a refund that exceeds the order', () => {
    const state = reduceLedger([
      ...paidOrderEvents(5000),
      ev('refund.succeeded', { refundId: 'ref-1', orderId: 'order-1', amount: USD(5001) }, { at: 6_000 }),
    ]);
    expect(codesOf(state)).toEqual(['refund-exceeds-order']);
    expect(state.orders.get('order-1')?.state).toBe('paid');
  });

  it('rejects a refund that exceeds the order CUMULATIVELY', () => {
    const state = reduceLedger([
      ...paidOrderEvents(5000),
      ev('refund.succeeded', { refundId: 'ref-1', orderId: 'order-1', amount: USD(4000) }, { at: 6_000 }),
      ev('refund.succeeded', { refundId: 'ref-2', orderId: 'order-1', amount: USD(2000) }, { at: 7_000 }),
    ]);
    expect(codesOf(state)).toEqual(['refund-exceeds-order']);
    expect(state.orders.get('order-1')?.refundedMinor).toBe(4000);
  });

  it('rejects a currency mismatch between refund and order', () => {
    const state = reduceLedger([
      ...paidOrderEvents(5000),
      ev('refund.succeeded', { refundId: 'ref-1', orderId: 'order-1', amount: { amountMinor: 5000, currency: 'EUR' } }, { at: 6_000 }),
    ]);
    expect(codesOf(state)).toEqual(['currency-mismatch']);
  });

  it('rejects an order.paid whose amount disagrees with the order', () => {
    const state = reduceLedger([...paidOrderEvents(5000).slice(0, 3), ev('order.paid', { orderId: 'order-1', amount: USD(4999) }, { at: 4_000 })]);
    expect(codesOf(state)).toEqual(['amount-mismatch']);
  });

  it('rejects an order.created whose amount disagrees with the offer price', () => {
    const state = reduceLedger([
      ...paidOrderEvents(5000).slice(0, 2),
      ev('order.created', { orderId: 'order-1', offerId: 'offer-1', buyerId: 'buyer-1', amount: USD(1) }, { at: 3_000 }),
    ]);
    expect(codesOf(state)).toEqual(['amount-mismatch']);
  });

  it('requires a free offer to price at zero', () => {
    const state = reduceLedger([
      ev('product.defined', { productId: 'prod-1', skuRef: 'sku-1', creatorId: 'creator-1', title: 'A Thing' }, { at: 1_000 }),
      ev('offer.defined', { offerId: 'offer-free', productId: 'prod-1', pricingModel: 'free', price: USD(1) }, { at: 2_000 }),
    ]);
    expect(codesOf(state)).toEqual(['amount-mismatch']);
  });

  it('rejects a non-integer price as invalid-money', () => {
    const state = reduceLedger([
      ev('product.defined', { productId: 'prod-1', skuRef: 'sku-1', creatorId: 'creator-1', title: 'A Thing' }, { at: 1_000 }),
      ev('offer.defined', { offerId: 'offer-1', productId: 'prod-1', pricingModel: 'one-time', price: { amountMinor: 19.99, currency: 'USD' } }, { at: 2_000 }),
    ]);
    expect(codesOf(state)).toEqual(['invalid-money']);
  });

  it('rejects an order against an inactive offer', () => {
    const state = reduceLedger([
      ev('product.defined', { productId: 'prod-1', skuRef: 'sku-1', creatorId: 'creator-1', title: 'A Thing' }, { at: 1_000 }),
      ev('offer.defined', { offerId: 'offer-1', productId: 'prod-1', pricingModel: 'one-time', price: USD(100), active: false }, { at: 2_000 }),
      ev('order.created', { orderId: 'order-1', offerId: 'offer-1', buyerId: 'buyer-1' }, { at: 3_000 }),
    ]);
    expect(codesOf(state)).toEqual(['inactive-offer']);
  });

  it('rejects facts that reference unknown entities', () => {
    const state = reduceLedger([
      ev('offer.defined', { offerId: 'offer-x', productId: 'nope', pricingModel: 'one-time', price: USD(1) }, { at: 1_000 }),
      ev('order.created', { orderId: 'order-x', offerId: 'nope', buyerId: 'buyer-1' }, { at: 2_000 }),
      ev('order.paid', { orderId: 'nope' }, { at: 3_000 }),
      ev('refund.failed', { refundId: 'nope' }, { at: 4_000 }),
      ev('payout.paid', { payoutId: 'nope' }, { at: 5_000 }),
      ev('entitlement.revoked', { entitlementId: 'nope' }, { at: 6_000 }),
    ]);
    expect(codesOf(state)).toEqual(['unknown-product', 'unknown-offer', 'unknown-order', 'unknown-refund', 'unknown-payout', 'unknown-entitlement']);
  });

  it('refuses to refund an order that was never paid', () => {
    const state = reduceLedger([
      ...paidOrderEvents(5000).slice(0, 3),
      ev('refund.succeeded', { refundId: 'ref-1', orderId: 'order-1', amount: USD(10) }, { at: 5_000 }),
    ]);
    expect(codesOf(state)).toEqual(['invalid-transition']);
  });

  it('refuses to pay an order that already failed', () => {
    const state = reduceLedger([
      ...paidOrderEvents().slice(0, 3),
      ev('order.failed', { orderId: 'order-1' }, { at: 4_000 }),
      ev('order.paid', { orderId: 'order-1' }, { at: 5_000 }),
    ]);
    expect(codesOf(state)).toEqual(['invalid-transition']);
    expect(state.orders.get('order-1')?.state).toBe('failed');
    expect(state.entitlements.size).toBe(0);
  });

  it('refuses to re-create an existing order', () => {
    const state = reduceLedger([
      ...paidOrderEvents().slice(0, 3),
      ev('order.created', { orderId: 'order-1', offerId: 'offer-1', buyerId: 'buyer-2' }, { at: 5_000 }),
    ]);
    expect(codesOf(state)).toEqual(['invalid-transition']);
    expect(state.orders.get('order-1')?.buyerId).toBe('buyer-1');
  });

  it('reports a structurally invalid event without aborting the fold', () => {
    const state = reduceLedger([{ ledgerEventId: 'bad-1', kind: 'order.paid' }, ...paidOrderEvents()]);
    expect(codesOf(state)).toEqual(['invalid-event']);
    expect(state.rejected[0]).toMatchObject({ ledgerEventId: 'bad-1', kind: 'order.paid' });
    expect(state.orders.get('order-1')?.state).toBe('paid');
  });
});

describe('reduceLedger — payout lifecycle', () => {
  it('folds a payout from created to paid', () => {
    const state = reduceLedger([
      ev('payout.created', { payoutId: 'po-1', creatorId: 'creator-1', amount: USD(4200) }, { at: 1_000 }),
      ev('payout.paid', { payoutId: 'po-1', providerRef: 'tr_123' }, { at: 2_000 }),
    ]);
    expect(state.rejected).toEqual([]);
    expect(state.payouts.get('po-1')).toMatchObject({ state: 'paid', providerRef: 'tr_123', amount: USD(4200) });
  });

  it('treats an identical payout.created replay as a no-op but rejects changed terms', () => {
    const same = reduceLedger([
      ev('payout.created', { payoutId: 'po-1', creatorId: 'creator-1', amount: USD(100) }, { id: 'a', at: 1_000 }),
      ev('payout.created', { payoutId: 'po-1', creatorId: 'creator-1', amount: USD(100) }, { id: 'b', at: 2_000 }),
    ]);
    expect(same.rejected).toEqual([]);

    const changed = reduceLedger([
      ev('payout.created', { payoutId: 'po-1', creatorId: 'creator-1', amount: USD(100) }, { id: 'a', at: 1_000 }),
      ev('payout.created', { payoutId: 'po-1', creatorId: 'creator-1', amount: USD(999) }, { id: 'b', at: 2_000 }),
    ]);
    expect(codesOf(changed)).toEqual(['invalid-transition']);
    expect(changed.payouts.get('po-1')?.amount.amountMinor).toBe(100);
  });

  it('refuses to move a paid payout to failed', () => {
    const state = reduceLedger([
      ev('payout.created', { payoutId: 'po-1', creatorId: 'creator-1', amount: USD(100) }, { at: 1_000 }),
      ev('payout.paid', { payoutId: 'po-1' }, { at: 2_000 }),
      ev('payout.failed', { payoutId: 'po-1' }, { at: 3_000 }),
    ]);
    expect(codesOf(state)).toEqual(['invalid-transition']);
    expect(state.payouts.get('po-1')?.state).toBe('paid');
  });
});

describe('reduceLedger — determinism and idempotency', () => {
  it('is deterministic regardless of input order', () => {
    const events = [
      ...paidOrderEvents(5000),
      ev('refund.succeeded', { refundId: 'ref-1', orderId: 'order-1', amount: USD(2000) }, { at: 6_000 }),
      ev('payout.created', { payoutId: 'po-1', creatorId: 'creator-1', amount: USD(3000) }, { at: 7_000 }),
      ev('payout.paid', { payoutId: 'po-1' }, { at: 8_000 }),
    ];
    const forward = serializeLedgerState(reduceLedger(events));
    const reversed = serializeLedgerState(reduceLedger([...events].reverse()));
    // a fixed, non-trivial permutation — no RNG, so a failure reproduces exactly
    const shuffled = serializeLedgerState(reduceLedger([events[5], events[0], events[3], events[6], events[1], events[4], events[2]]));

    expect(reversed).toEqual(forward);
    expect(shuffled).toEqual(forward);
    expect(forward.orders[0]).toMatchObject({ state: 'partially-refunded', refundedMinor: 2000 });
  });

  it('orders the fold by (occurredAtMs, ledgerEventId), not by array position', () => {
    const state = reduceLedger([
      ev('order.paid', { orderId: 'order-1' }, { at: 4_000 }),
      ev('order.created', { orderId: 'order-1', offerId: 'offer-1', buyerId: 'buyer-1' }, { at: 3_000 }),
      ev('offer.defined', { offerId: 'offer-1', productId: 'prod-1', pricingModel: 'one-time', price: USD(100) }, { at: 2_000 }),
      ev('product.defined', { productId: 'prod-1', skuRef: 'sku-1', creatorId: 'creator-1', title: 'A Thing' }, { at: 1_000 }),
    ]);
    expect(state.rejected).toEqual([]);
    expect(state.applied).toHaveLength(4);
    expect(state.entitlements.get(entitlementIdFor('order-1'))?.state).toBe('active');
  });

  it('breaks an occurredAtMs tie by ledgerEventId so the fold stays total', () => {
    const base = paidOrderEvents(5000);
    const build = (): LedgerState =>
      reduceLedger([
        ...base,
        ev('refund.succeeded', { refundId: 'ref-a', orderId: 'order-1', amount: USD(2500) }, { id: 'tie-a', at: 9_000 }),
        ev('refund.succeeded', { refundId: 'ref-b', orderId: 'order-1', amount: USD(2500) }, { id: 'tie-b', at: 9_000 }),
      ]);
    expect(serializeLedgerState(build())).toEqual(serializeLedgerState(build()));
    expect(build().orders.get('order-1')?.state).toBe('refunded');
  });

  it('treats an exact replay as a duplicate and applies it only once', () => {
    const events = paidOrderEvents();
    const replayed = [...events, { ...events[3] }];
    const state = reduceLedger(replayed);

    expect(state.rejected).toEqual([]);
    expect(state.duplicates).toEqual([events[3].ledgerEventId]);
    expect(state.applied.filter((id) => id === events[3].ledgerEventId)).toHaveLength(1);
    expect(serializeLedgerState(state)).toEqual(serializeLedgerState(reduceLedger(events)));
  });

  it('is idempotent under wholesale re-application of the entire stream', () => {
    const events = [...paidOrderEvents(5000), ev('refund.succeeded', { refundId: 'ref-1', orderId: 'order-1', amount: USD(5000) }, { at: 6_000 })];
    const once = serializeLedgerState(reduceLedger(events));
    const twice = serializeLedgerState(reduceLedger([...events, ...events.map((e) => ({ ...e }))]));
    expect(twice).toEqual(once);
  });

  it('QUARANTINES two different facts that claim the same ledgerEventId', () => {
    const original = ev('order.created', { orderId: 'order-1', offerId: 'offer-1', buyerId: 'buyer-1' }, { id: 'collide', at: 3_000 });
    const forged: LedgerEvent = { ...original, payload: { orderId: 'order-1', offerId: 'offer-1', buyerId: 'attacker' } };

    const state = reduceLedger([...paidOrderEvents().slice(0, 2), original, forged]);

    expect(codesOf(state)).toEqual(['duplicate-conflict']);
    expect(state.rejected[0]).toMatchObject({ ledgerEventId: 'collide', kind: 'order.created' });
    expect(state.applied.filter((id) => id === 'collide')).toHaveLength(1);
    // exactly one of the two facts survived — history was not rewritten
    expect(state.orders.get('order-1')?.buyerId).toBe('buyer-1');
  });

  it('digests differ for different facts and match for identical ones', () => {
    const a = ev('order.paid', { orderId: 'order-1' }, { id: 'x', at: 1 });
    const b = ev('order.paid', { orderId: 'order-2' }, { id: 'x', at: 1 });
    expect(ledgerEventDigest(a)).toBe(ledgerEventDigest({ ...a }));
    expect(ledgerEventDigest(a)).not.toBe(ledgerEventDigest(b));
  });
});

describe('serializeLedgerState', () => {
  it('returns key-sorted plain arrays for transport', () => {
    const state = reduceLedger([
      ev('product.defined', { productId: 'prod-b', skuRef: 'sku-b', creatorId: 'c', title: 'B' }, { at: 1_000 }),
      ev('product.defined', { productId: 'prod-a', skuRef: 'sku-a', creatorId: 'c', title: 'A' }, { at: 2_000 }),
    ]);
    const serialized = serializeLedgerState(state);
    expect(serialized.products.map((p) => p.productId)).toEqual(['prod-a', 'prod-b']);
    expect(Array.isArray(serialized.orders)).toBe(true);
  });
});
