import { describe, expect, it } from 'vitest';
import type { LedgerEvent } from './commerce-ledger';
import {
  CREDIT_MICROS_PER_USD_MINOR,
  microchargeChannelForCreditReservation,
  PREPAID_CREDIT_OFFER_ID,
  PREPAID_CREDIT_PRODUCT_ID,
  PREPAID_CREDIT_SKU_REF,
  PREPAID_CREDIT_TOP_UP,
  prepaidCreditCatalogEvents,
  reducePrepaidCredits,
  type PrepaidCreditEvent,
} from './prepaid-credits';

const principal = 'gh:123';

function topUpEvents(over: { secondPaid?: boolean; refund?: boolean; refundFirst?: boolean } = {}): LedgerEvent[] {
  const catalog = prepaidCreditCatalogEvents(1);
  const created: LedgerEvent = {
    ledgerEventId: 'evt:order-created:topup-1',
    kind: 'order.created',
    occurredAtMs: 10,
    source: { provider: 'stripe', providerEventId: null },
    payload: {
      orderId: 'topup-1',
      offerId: PREPAID_CREDIT_OFFER_ID,
      buyerId: principal,
      amount: PREPAID_CREDIT_TOP_UP,
    },
  };
  const paid: LedgerEvent = {
    ledgerEventId: 'stripe:evt_paid_1:0',
    kind: 'order.paid',
    occurredAtMs: 20,
    source: { provider: 'stripe', providerEventId: 'evt_paid_1' },
    payload: {
      orderId: 'topup-1',
      amount: PREPAID_CREDIT_TOP_UP,
      providerRef: 'pi_1',
    },
  };
  const refund: LedgerEvent = {
    ledgerEventId: 'stripe:evt_refund_1:0',
    kind: 'refund.succeeded',
    occurredAtMs: over.refundFirst ? 15 : 30,
    source: { provider: 'stripe', providerEventId: 'evt_refund_1' },
    payload: {
      refundId: 're_1',
      orderId: 'topup-1',
      amount: { amountMinor: 400, currency: 'USD' },
      providerRef: 're_1',
    },
  };
  return [
    ...catalog,
    created,
    paid,
    ...(over.secondPaid
      ? [
          {
            ...paid,
            ledgerEventId: 'stripe:evt_paid_retry:0',
            occurredAtMs: 21,
            source: { provider: 'stripe', providerEventId: 'evt_paid_retry' },
          },
        ]
      : []),
    ...(over.refund ? [refund] : []),
  ];
}

function creditEvent(
  creditEventId: string,
  kind: PrepaidCreditEvent['kind'],
  occurredAtMs: number,
  payload: Record<string, unknown>,
): PrepaidCreditEvent {
  return { creditEventId, kind, occurredAtMs, principalId: principal, payload };
}

describe('prepaid credit catalog', () => {
  it('defines one fixed one-time Stripe top-up SKU for the existing Checkout route', () => {
    const [product, offer] = prepaidCreditCatalogEvents(5);
    expect(product.payload).toMatchObject({
      productId: PREPAID_CREDIT_PRODUCT_ID,
      skuRef: PREPAID_CREDIT_SKU_REF,
    });
    expect(offer.payload).toEqual({
      offerId: PREPAID_CREDIT_OFFER_ID,
      productId: PREPAID_CREDIT_PRODUCT_ID,
      pricingModel: 'one-time',
      price: PREPAID_CREDIT_TOP_UP,
    });
  });
});

describe('reducePrepaidCredits', () => {
  const grant = PREPAID_CREDIT_TOP_UP.amountMinor * CREDIT_MICROS_PER_USD_MINOR;

  it('grants only after an applied Stripe webhook fact with a provider event id', () => {
    const beforePaid = reducePrepaidCredits(topUpEvents().slice(0, 3));
    expect(beforePaid.balances.size).toBe(0);

    const paid = reducePrepaidCredits(topUpEvents());
    expect(paid.balances.get(principal)).toMatchObject({
      availableMicros: grant,
      grantedMicros: grant,
      debtMicros: 0,
    });

    const forged = topUpEvents().map((event) =>
      event.kind === 'order.paid'
        ? { ...event, source: { provider: 'stripe', providerEventId: null } }
        : event,
    );
    expect(reducePrepaidCredits(forged).balances.size).toBe(0);
  });

  it('grants once when Stripe announces the same paid order under a second webhook id', () => {
    const state = reducePrepaidCredits(topUpEvents({ secondPaid: true }));
    expect(state.balances.get(principal)?.availableMicros).toBe(grant);
    expect(state.applied.filter((id) => id === 'stripe-topup:topup-1')).toHaveLength(1);
  });

  it('reverses a refund deterministically even when input delivery order is reversed', () => {
    const chronological = reducePrepaidCredits(topUpEvents({ refund: true }));
    const reversedInput = reducePrepaidCredits(
      [...topUpEvents({ refund: true })].reverse(),
    );
    expect(chronological.balances.get(principal)).toEqual(
      reversedInput.balances.get(principal),
    );
    expect(chronological.balances.get(principal)).toMatchObject({
      availableMicros: grant - 4_000_000,
      reversedMicros: 4_000_000,
      debtMicros: 0,
    });
  });

  it('records refund shortfall as debt and refuses a negative spendable balance', () => {
    const reserve = creditEvent('credit:reserve:1', 'credit.reserved', 25, {
      reservationId: 'reservation-1',
      channelId: 'channel-1',
      amountMicros: 8_000_000,
    });
    const settle = creditEvent('credit:settle:1', 'credit.settled', 26, {
      reservationId: 'reservation-1',
      committedMicros: 8_000_000,
    });
    const state = reducePrepaidCredits(
      topUpEvents({ refund: true }),
      [reserve, settle],
    );
    expect(state.balances.get(principal)).toMatchObject({
      availableMicros: 0,
      debtMicros: 2_000_000,
      spentMicros: 8_000_000,
      reversedMicros: 4_000_000,
    });

    const refused = reducePrepaidCredits(topUpEvents({ refund: true }), [
      reserve,
      settle,
      creditEvent('credit:reserve:2', 'credit.reserved', 40, {
        reservationId: 'reservation-2',
        channelId: 'channel-2',
        amountMicros: 1,
      }),
    ]);
    expect(refused.rejected.at(-1)).toMatchObject({ code: 'negative-balance' });
    expect(refused.balances.get(principal)?.availableMicros).toBe(0);
  });

  it('funds a microcharge escrow and releases unused reservation on settlement', () => {
    const reserve = creditEvent('credit:reserve:1', 'credit.reserved', 25, {
      reservationId: 'reservation-1',
      channelId: 'channel-1',
      amountMicros: 5_000_000,
    });
    const reserved = reducePrepaidCredits(topUpEvents(), [reserve]);
    const channel = microchargeChannelForCreditReservation(
      reserved,
      'reservation-1',
    );
    expect(channel.ok && channel.channel.escrowMicros).toBe(5_000_000n);

    const settled = reducePrepaidCredits(topUpEvents(), [
      reserve,
      creditEvent('credit:settle:1', 'credit.settled', 30, {
        reservationId: 'reservation-1',
        committedMicros: 3_000_000,
      }),
    ]);
    expect(settled.balances.get(principal)).toMatchObject({
      availableMicros: grant - 3_000_000,
      reservedMicros: 0,
      spentMicros: 3_000_000,
    });
    expect(settled.reservations.get('reservation-1')).toMatchObject({
      state: 'settled',
      committedMicros: 3_000_000,
    });
  });

  it('treats exact credit-event replay as a duplicate and conflicting replay as rejected', () => {
    const reserve = creditEvent('credit:reserve:1', 'credit.reserved', 25, {
      reservationId: 'reservation-1',
      channelId: 'channel-1',
      amountMicros: 100,
    });
    const state = reducePrepaidCredits(topUpEvents(), [
      reserve,
      reserve,
      { ...reserve, payload: { ...reserve.payload, amountMicros: 101 } },
    ]);
    expect(state.duplicates).toEqual(['credit:reserve:1']);
    expect(state.rejected).toContainEqual(
      expect.objectContaining({ code: 'duplicate-conflict' }),
    );
    expect(state.balances.get(principal)?.reservedMicros).toBe(100);
  });
});
