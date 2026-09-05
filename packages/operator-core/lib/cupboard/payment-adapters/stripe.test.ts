/**
 * Tests for the Stripe `PaymentProviderAdapter` (P-010; D-025).
 *
 * The adapter is deliberately SDK-free, so its signature scheme is a claim about
 * Stripe's documented format rather than something a library guarantees. Every
 * signature vector here is therefore computed INDEPENDENTLY with `node:crypto`
 * (`HMAC-SHA256` over `${t}.${rawBody}`) rather than by calling the module's own
 * `computeStripeSignature` — a test that signs with the code under test would
 * pass even if the scheme were wrong.
 *
 * The signing material below is deliberately low-entropy dictionary text, NOT a
 * `whsec_`-shaped literal: a realistic-looking fixture trips the secrets guard
 * and, worse, the pot-git publish guard, whose baseline never advances past a
 * refused range. HMAC does not care, so the fixture should not look real.
 *
 * The other two properties under test are the ones a provider boundary exists to
 * enforce: the refusal ladder is ordered (missing → malformed → bad → stale), and
 * no Stripe field name escapes normalization — every mapping is asserted as a
 * provider-neutral `LedgerEvent`.
 */
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { hasActiveEntitlement, reduceLedger, type Offer, type Order, type Product } from '../commerce-ledger';
import { ingestWebhook, memoryWebhookInboxStore, type WebhookRequest } from '../webhook-inbox';
import {
  buildStripeCheckoutSessionParams,
  computeStripeSignature,
  createStripeAdapter,
  parseStripeSignatureHeader,
  STRIPE_DEFAULT_TOLERANCE_SEC,
  STRIPE_PROVIDER,
} from './stripe';

const ENDPOINT_SIGNING_FIXTURE = 'stripe-fixture-signing-material';
const OTHER_SIGNING_FIXTURE = 'a-different-signing-material';

/** Independent vector: never routed through the module under test. */
function hmac(material: string, timestampSec: number, rawBody: string): string {
  return createHmac('sha256', material).update(`${timestampSec}.${rawBody}`, 'utf8').digest('hex');
}

function signedRequest(rawBody: string, opts: { material?: string; timestampSec?: number; nowMs?: number; headerName?: string } = {}): WebhookRequest {
  const timestampSec = opts.timestampSec ?? 1_760_000_000;
  const material = opts.material ?? ENDPOINT_SIGNING_FIXTURE;
  return {
    rawBody,
    headers: { [opts.headerName ?? 'Stripe-Signature']: `t=${timestampSec},v1=${hmac(material, timestampSec, rawBody)}` },
    nowMs: opts.nowMs ?? timestampSec * 1000,
  };
}

const adapter = createStripeAdapter({ webhookSecret: ENDPOINT_SIGNING_FIXTURE });

/** A minimal Stripe event envelope; `object` is the `data.object` under test. */
function stripeEvent(type: string, object: Record<string, unknown>, over: Record<string, unknown> = {}): string {
  return JSON.stringify({ id: 'evt_test_1', type, created: 1_760_000_000, data: { object }, ...over });
}

function normalizeOk(body: string) {
  const verdict = adapter.normalize(body, 0);
  if (!verdict.ok) throw new Error(`expected normalize to succeed, got ${verdict.code}: ${verdict.detail}`);
  return verdict.webhook;
}

describe('parseStripeSignatureHeader', () => {
  const sig = 'a'.repeat(64);

  it('parses a timestamp and one v1 signature', () => {
    expect(parseStripeSignatureHeader(`t=1700000000,v1=${sig}`)).toEqual({ timestamp: 1_700_000_000, signatures: [sig] });
  });

  it('collects every v1 signature, so a key rotation window still verifies', () => {
    const second = 'b'.repeat(64);
    expect(parseStripeSignatureHeader(`t=1,v1=${sig},v1=${second}`)?.signatures).toEqual([sig, second]);
  });

  it('lower-cases signatures so a hex-case difference is not a mismatch', () => {
    expect(parseStripeSignatureHeader(`t=1,v1=${'A'.repeat(64)}`)?.signatures).toEqual(['a'.repeat(64)]);
  });

  it('tolerates whitespace around the parts', () => {
    expect(parseStripeSignatureHeader(` t=42 , v1=${sig} `)).toEqual({ timestamp: 42, signatures: [sig] });
  });

  it('ignores unknown schemes such as the retired v0', () => {
    expect(parseStripeSignatureHeader(`t=1,v0=${sig},v1=${sig}`)?.signatures).toEqual([sig]);
  });

  it('refuses a header with no timestamp', () => {
    expect(parseStripeSignatureHeader(`v1=${sig}`)).toBeNull();
  });

  it('refuses a header with no v1 signature', () => {
    expect(parseStripeSignatureHeader('t=1700000000')).toBeNull();
  });

  it('refuses a non-integer or negative timestamp rather than coercing it', () => {
    expect(parseStripeSignatureHeader(`t=not-a-number,v1=${sig}`)).toBeNull();
    expect(parseStripeSignatureHeader(`t=-1,v1=${sig}`)).toBeNull();
    expect(parseStripeSignatureHeader(`t=1.5,v1=${sig}`)).toBeNull();
  });

  it('drops a v1 value that is not exactly 64 hex characters', () => {
    expect(parseStripeSignatureHeader('t=1,v1=deadbeef')).toBeNull();
    expect(parseStripeSignatureHeader(`t=1,v1=${'z'.repeat(64)}`)).toBeNull();
  });
});

describe('computeStripeSignature', () => {
  it('is HMAC-SHA256 over `${t}.${rawBody}` with the endpoint signing material', () => {
    const body = '{"id":"evt_1"}';
    expect(computeStripeSignature(ENDPOINT_SIGNING_FIXTURE, 1_700_000_000, body)).toBe(hmac(ENDPOINT_SIGNING_FIXTURE, 1_700_000_000, body));
  });

  it('covers the timestamp, so replaying a body under a new t invalidates the old signature', () => {
    const body = '{"id":"evt_1"}';
    expect(computeStripeSignature(ENDPOINT_SIGNING_FIXTURE, 1, body)).not.toBe(computeStripeSignature(ENDPOINT_SIGNING_FIXTURE, 2, body));
  });

  it('covers the raw body byte-for-byte, so re-serialized JSON does not verify', () => {
    expect(computeStripeSignature(ENDPOINT_SIGNING_FIXTURE, 1, '{"a":1}')).not.toBe(computeStripeSignature(ENDPOINT_SIGNING_FIXTURE, 1, '{"a": 1}'));
  });
});

describe('stripe adapter — verifySignature', () => {
  const body = '{"id":"evt_1"}';

  it('accepts a correctly signed request', () => {
    expect(adapter.verifySignature(signedRequest(body))).toEqual({ ok: true });
  });

  it('matches the header case-insensitively', () => {
    expect(adapter.verifySignature(signedRequest(body, { headerName: 'STRIPE-SIGNATURE' })).ok).toBe(true);
    expect(adapter.verifySignature(signedRequest(body, { headerName: 'stripe-signature' })).ok).toBe(true);
  });

  it('refuses when no signing material is configured, before looking at the request', () => {
    const unconfigured = createStripeAdapter({ webhookSecret: '' });
    const verdict = unconfigured.verifySignature(signedRequest(body));
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.code).toBe('missing-secret');
  });

  it('refuses a request with no signature header', () => {
    const verdict = adapter.verifySignature({ rawBody: body, headers: {}, nowMs: 1_760_000_000_000 });
    expect(verdict.ok === false && verdict.code).toBe('missing-signature');
  });

  it('refuses a malformed header without reaching the HMAC comparison', () => {
    const verdict = adapter.verifySignature({ rawBody: body, headers: { 'Stripe-Signature': 'garbage' }, nowMs: 1_760_000_000_000 });
    expect(verdict.ok === false && verdict.code).toBe('malformed-signature');
  });

  it('refuses a signature produced with different signing material', () => {
    const verdict = adapter.verifySignature(signedRequest(body, { material: OTHER_SIGNING_FIXTURE }));
    expect(verdict.ok === false && verdict.code).toBe('bad-signature');
  });

  it('refuses a signature over different bytes than the body delivered', () => {
    const forged = signedRequest('{"id":"evt_other"}');
    const verdict = adapter.verifySignature({ ...forged, rawBody: body });
    expect(verdict.ok === false && verdict.code).toBe('bad-signature');
  });

  it('accepts a timestamp exactly at the tolerance boundary, in both directions', () => {
    const t = 1_760_000_000;
    expect(adapter.verifySignature(signedRequest(body, { timestampSec: t, nowMs: (t + STRIPE_DEFAULT_TOLERANCE_SEC) * 1000 })).ok).toBe(true);
    expect(adapter.verifySignature(signedRequest(body, { timestampSec: t, nowMs: (t - STRIPE_DEFAULT_TOLERANCE_SEC) * 1000 })).ok).toBe(true);
  });

  it('refuses a validly signed request one second past the tolerance', () => {
    const t = 1_760_000_000;
    const stale = adapter.verifySignature(signedRequest(body, { timestampSec: t, nowMs: (t + STRIPE_DEFAULT_TOLERANCE_SEC + 1) * 1000 }));
    expect(stale.ok === false && stale.code).toBe('stale-timestamp');
    const future = adapter.verifySignature(signedRequest(body, { timestampSec: t, nowMs: (t - STRIPE_DEFAULT_TOLERANCE_SEC - 1) * 1000 }));
    expect(future.ok === false && future.code).toBe('stale-timestamp');
  });

  it('honours a caller-supplied tolerance', () => {
    const strict = createStripeAdapter({ webhookSecret: ENDPOINT_SIGNING_FIXTURE, toleranceSec: 5 });
    const t = 1_760_000_000;
    expect(strict.verifySignature(signedRequest(body, { timestampSec: t, nowMs: (t + 5) * 1000 })).ok).toBe(true);
    const verdict = strict.verifySignature(signedRequest(body, { timestampSec: t, nowMs: (t + 6) * 1000 }));
    expect(verdict.ok === false && verdict.code).toBe('stale-timestamp');
  });

  it('reports a bad signature rather than staleness when both are wrong', () => {
    const t = 1_760_000_000;
    const verdict = adapter.verifySignature(signedRequest(body, { material: OTHER_SIGNING_FIXTURE, timestampSec: t, nowMs: (t + 10_000) * 1000 }));
    expect(verdict.ok === false && verdict.code).toBe('bad-signature');
  });
});

describe('stripe adapter — normalize envelope', () => {
  it('refuses a body that is not JSON, with no provider event id to record', () => {
    const verdict = adapter.normalize('not json', 0);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && [verdict.code, verdict.providerEventId]).toEqual(['malformed-body', null]);
  });

  it('refuses JSON that is not an object', () => {
    expect(adapter.normalize('[]', 0).ok).toBe(false);
    expect(adapter.normalize('"evt"', 0).ok).toBe(false);
  });

  it('refuses an envelope missing id, type, created or data.object', () => {
    for (const body of [
      JSON.stringify({ type: 'x', created: 1, data: { object: {} } }),
      JSON.stringify({ id: 'evt_1', created: 1, data: { object: {} } }),
      JSON.stringify({ id: 'evt_1', type: 'x', data: { object: {} } }),
      JSON.stringify({ id: 'evt_1', type: 'x', created: 1 }),
    ]) {
      const verdict = adapter.normalize(body, 0);
      expect(verdict.ok === false && verdict.code).toBe('malformed-body');
    }
  });

  it('still reports the provider event id when the rest of the envelope is malformed, so the inbox can record the refusal', () => {
    const verdict = adapter.normalize(JSON.stringify({ id: 'evt_bad', type: 'x', created: 1 }), 0);
    expect(verdict.ok === false && verdict.providerEventId).toBe('evt_bad');
  });

  it('converts the Stripe `created` second-stamp into milliseconds', () => {
    expect(normalizeOk(stripeEvent('customer.created', {}, { created: 1_700_000_000 })).occurredAtMs).toBe(1_700_000_000_000);
  });

  it('authenticates an irrelevant event type into zero ledger events rather than refusing it', () => {
    const webhook = normalizeOk(stripeEvent('customer.subscription.trial_will_end', { id: 'sub_1' }));
    expect(webhook.events).toEqual([]);
    expect(webhook.providerEventType).toBe('customer.subscription.trial_will_end');
  });

  it('addresses every emitted event by the provider event id and its index', () => {
    const webhook = normalizeOk(
      stripeEvent('charge.refunded', {
        id: 'ch_1',
        metadata: { orderId: 'order-1' },
        currency: 'usd',
        refunds: { data: [{ id: 're_1', status: 'succeeded', amount: 100, currency: 'usd' }, { id: 're_2', status: 'succeeded', amount: 200, currency: 'usd' }] },
      }),
    );
    expect(webhook.events.map((e) => e.ledgerEventId)).toEqual(['stripe:evt_test_1:0', 'stripe:evt_test_1:1']);
    expect(webhook.events.every((e) => e.source.provider === STRIPE_PROVIDER && e.source.providerEventId === 'evt_test_1')).toBe(true);
  });
});

describe('stripe adapter — checkout session mappings', () => {
  const session = (over: Record<string, unknown> = {}) => ({
    id: 'cs_1',
    payment_status: 'paid',
    amount_total: 2500,
    currency: 'usd',
    payment_intent: 'pi_1',
    metadata: { orderId: 'order-1' },
    ...over,
  });

  it('maps a paid checkout session to order.paid with normalized money', () => {
    const [event, ...rest] = normalizeOk(stripeEvent('checkout.session.completed', session())).events;
    expect(rest).toEqual([]);
    expect(event.kind).toBe('order.paid');
    expect(event.payload).toEqual({ orderId: 'order-1', amount: { amountMinor: 2500, currency: 'USD' }, providerRef: 'pi_1' });
  });

  it('ignores a completed session that is not yet paid, leaving the async event to grant', () => {
    expect(normalizeOk(stripeEvent('checkout.session.completed', session({ payment_status: 'unpaid' }))).events).toEqual([]);
  });

  it('maps an async payment success to order.paid', () => {
    const [event] = normalizeOk(stripeEvent('checkout.session.async_payment_succeeded', session({ payment_status: 'unpaid' }))).events;
    expect(event.kind).toBe('order.paid');
  });

  it('falls back to client_reference_id when metadata carries no orderId', () => {
    const [event] = normalizeOk(stripeEvent('checkout.session.completed', session({ metadata: {}, client_reference_id: 'order-ref' }))).events;
    expect(event.payload.orderId).toBe('order-ref');
  });

  it('prefers metadata.orderId over client_reference_id', () => {
    const [event] = normalizeOk(stripeEvent('checkout.session.completed', session({ client_reference_id: 'order-other' }))).events;
    expect(event.payload.orderId).toBe('order-1');
  });

  it('falls back to the session id when no payment intent is present', () => {
    const [event] = normalizeOk(stripeEvent('checkout.session.completed', session({ payment_intent: null }))).events;
    expect(event.payload.providerRef).toBe('cs_1');
  });

  it('refuses a paid session that carries no order reference', () => {
    const verdict = adapter.normalize(stripeEvent('checkout.session.completed', session({ metadata: {} })), 0);
    expect(verdict.ok === false && verdict.code).toBe('missing-order-ref');
  });

  it('refuses a non-integer, negative or non-ISO-4217 amount rather than coercing it', () => {
    for (const over of [{ amount_total: 25.5 }, { amount_total: -1 }, { amount_total: '2500' }, { currency: 'dollars' }]) {
      const verdict = adapter.normalize(stripeEvent('checkout.session.completed', session(over)), 0);
      expect(verdict.ok === false && verdict.code).toBe('invalid-amount');
    }
  });

  it('maps a failed or expired session to the matching order transition', () => {
    expect(normalizeOk(stripeEvent('checkout.session.async_payment_failed', session())).events[0].kind).toBe('order.failed');
    expect(normalizeOk(stripeEvent('payment_intent.payment_failed', { id: 'pi_1', metadata: { orderId: 'order-1' } })).events[0].kind).toBe('order.failed');
    expect(normalizeOk(stripeEvent('checkout.session.expired', session())).events[0].kind).toBe('order.canceled');
  });

  it('refuses a failure event with no order reference, so it cannot silently vanish', () => {
    const verdict = adapter.normalize(stripeEvent('payment_intent.payment_failed', { id: 'pi_1' }), 0);
    expect(verdict.ok === false && verdict.code).toBe('missing-order-ref');
  });
});

describe('stripe adapter — refund mappings', () => {
  const charge = (over: Record<string, unknown> = {}) => ({ id: 'ch_1', metadata: { orderId: 'order-1' }, currency: 'usd', amount_refunded: 500, ...over });

  it('emits one refund.succeeded per succeeded refund in the charge', () => {
    const events = normalizeOk(
      stripeEvent('charge.refunded', charge({ refunds: { data: [{ id: 're_1', status: 'succeeded', amount: 300, currency: 'usd' }] } })),
    ).events;
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('refund.succeeded');
    expect(events[0].payload).toEqual({ refundId: 're_1', orderId: 'order-1', amount: { amountMinor: 300, currency: 'USD' }, providerRef: 're_1' });
  });

  it('skips refund rows that have not succeeded', () => {
    const events = normalizeOk(
      stripeEvent('charge.refunded', charge({ refunds: { data: [{ id: 're_1', status: 'pending', amount: 300, currency: 'usd' }, { id: 're_2', status: 'succeeded', amount: 100, currency: 'usd' }] } })),
    ).events;
    expect(events.map((e) => e.payload.refundId)).toEqual(['re_2']);
  });

  it('falls back to the charge total when the refunds list is absent or empty', () => {
    for (const over of [{}, { refunds: { data: [] } }]) {
      const [event] = normalizeOk(stripeEvent('charge.refunded', charge(over))).events;
      expect(event.payload).toEqual({ refundId: 'ch_1:refund', orderId: 'order-1', amount: { amountMinor: 500, currency: 'USD' }, providerRef: 'ch_1' });
    }
  });

  it('refuses a charge refund with no order reference', () => {
    const verdict = adapter.normalize(stripeEvent('charge.refunded', charge({ metadata: {} })), 0);
    expect(verdict.ok === false && verdict.code).toBe('missing-order-ref');
  });

  it('refuses a refund row whose amount is not integer minor units', () => {
    const verdict = adapter.normalize(stripeEvent('charge.refunded', charge({ refunds: { data: [{ id: 're_1', status: 'succeeded', amount: 3.5, currency: 'usd' }] } })), 0);
    expect(verdict.ok === false && verdict.code).toBe('invalid-amount');
  });

  it('maps a standalone refund update by its status', () => {
    const refund = (status: string) => stripeEvent('refund.updated', { id: 're_1', status, amount: 400, currency: 'usd', metadata: { orderId: 'order-1' } });
    expect(normalizeOk(refund('succeeded')).events[0].kind).toBe('refund.succeeded');
    expect(normalizeOk(refund('failed')).events[0].kind).toBe('refund.failed');
    expect(normalizeOk(refund('canceled')).events[0].kind).toBe('refund.failed');
    expect(normalizeOk(refund('pending')).events).toEqual([]);
  });

  it('accepts the charge.refund.updated alias for the same shape', () => {
    const events = normalizeOk(stripeEvent('charge.refund.updated', { id: 're_1', status: 'failed' })).events;
    expect(events[0].kind).toBe('refund.failed');
  });

  it('allows a refund failure with no order reference, since the refund id already identifies it', () => {
    const [event] = normalizeOk(stripeEvent('refund.updated', { id: 're_1', status: 'failed' })).events;
    expect(event.payload).toEqual({ refundId: 're_1' });
  });

  it('refuses a succeeded refund update with no order reference', () => {
    const verdict = adapter.normalize(stripeEvent('refund.updated', { id: 're_1', status: 'succeeded', amount: 400, currency: 'usd' }), 0);
    expect(verdict.ok === false && verdict.code).toBe('missing-order-ref');
  });

  it('refuses a refund object with no id', () => {
    const verdict = adapter.normalize(stripeEvent('refund.updated', { status: 'succeeded' }), 0);
    expect(verdict.ok === false && verdict.code).toBe('malformed-body');
  });
});

describe('stripe adapter — payout mappings', () => {
  const payout = (over: Record<string, unknown> = {}) => ({ id: 'po_1', amount: 9_000, currency: 'usd', metadata: { creatorId: 'creator-1' }, ...over });

  it('maps payout.created with the creator and amount', () => {
    const [event] = normalizeOk(stripeEvent('payout.created', payout())).events;
    expect(event.kind).toBe('payout.created');
    expect(event.payload).toEqual({ payoutId: 'po_1', creatorId: 'creator-1', amount: { amountMinor: 9_000, currency: 'USD' }, providerRef: 'po_1' });
  });

  it('falls back to the payout destination when metadata carries no creator', () => {
    const [event] = normalizeOk(stripeEvent('payout.created', payout({ metadata: {}, destination: 'acct_1' }))).events;
    expect(event.payload.creatorId).toBe('acct_1');
  });

  it('refuses payout.created with no creator reference', () => {
    const verdict = adapter.normalize(stripeEvent('payout.created', payout({ metadata: {} })), 0);
    expect(verdict.ok === false && verdict.code).toBe('missing-order-ref');
  });

  it('maps payout.paid and payout.failed without re-stating the terms', () => {
    for (const [type, kind] of [['payout.paid', 'payout.paid'], ['payout.failed', 'payout.failed']] as const) {
      const [event] = normalizeOk(stripeEvent(type, payout())).events;
      expect(event.kind).toBe(kind);
      expect(event.payload).toEqual({ payoutId: 'po_1', providerRef: 'po_1' });
    }
  });

  it('refuses a payout with no id or a non-integer amount', () => {
    expect(adapter.normalize(stripeEvent('payout.paid', payout({ id: null })), 0).ok).toBe(false);
    const bad = adapter.normalize(stripeEvent('payout.paid', payout({ amount: 1.5 })), 0);
    expect(bad.ok === false && bad.code).toBe('invalid-amount');
  });
});

describe('buildStripeCheckoutSessionParams', () => {
  const product: Product = { productId: 'prod-1', skuRef: 'sku-1', creatorId: 'creator-1', title: 'A Pot', active: true };
  const offer: Offer = { offerId: 'offer-1', productId: 'prod-1', pricingModel: 'one-time', price: { amountMinor: 2500, currency: 'USD' }, active: true };
  const order: Order = {
    orderId: 'order-1',
    offerId: 'offer-1',
    productId: 'prod-1',
    buyerId: 'buyer-1',
    amount: { amountMinor: 2500, currency: 'USD' },
    state: 'pending',
    provider: null,
    providerRef: null,
    refundedMinor: 0,
    createdAtMs: 1,
    updatedAtMs: 1,
  };
  const build = (over: { order?: Partial<Order>; offer?: Partial<Offer> } = {}) =>
    buildStripeCheckoutSessionParams({
      order: { ...order, ...over.order },
      offer: { ...offer, ...over.offer },
      product,
      successUrl: 'https://example.test/ok',
      cancelUrl: 'https://example.test/no',
    });

  it('carries the order id across the provider boundary in both documented places', () => {
    const result = build();
    if (!result.ok) throw new Error(`expected a build, got ${result.code}`);
    expect(result.params.client_reference_id).toBe('order-1');
    expect(result.params.metadata).toEqual({ orderId: 'order-1', offerId: 'offer-1', productId: 'prod-1', buyerId: 'buyer-1' });
    expect(result.params.payment_intent_data).toEqual({ metadata: { orderId: 'order-1' } });
  });

  it('lower-cases the currency and passes integer minor units through unchanged', () => {
    const result = build();
    if (!result.ok) throw new Error('expected a build');
    const [item] = result.params.line_items as Array<{ quantity: number; price_data: Record<string, unknown> }>;
    expect(item.quantity).toBe(1);
    expect(item.price_data.currency).toBe('usd');
    expect(item.price_data.unit_amount).toBe(2500);
    expect(item.price_data.product_data).toEqual({ name: 'A Pot', metadata: { skuRef: 'sku-1', productId: 'prod-1' } });
  });

  it('builds a subscription session with a recurring price and no payment-intent metadata', () => {
    const result = build({ offer: { pricingModel: 'subscription' } });
    if (!result.ok) throw new Error('expected a build');
    expect(result.params.mode).toBe('subscription');
    const [item] = result.params.line_items as Array<{ price_data: Record<string, unknown> }>;
    expect(item.price_data.recurring).toEqual({ interval: 'month' });
    expect(result.params.payment_intent_data).toBeUndefined();
  });

  it('refuses pricing models that do not go through Checkout', () => {
    for (const pricingModel of ['free', 'per-use'] as const) {
      const result = build({ offer: { pricingModel, price: { amountMinor: 0, currency: 'USD' } }, order: { amount: { amountMinor: 0, currency: 'USD' } } });
      expect(result.ok === false && result.code).toBe('unsupported-pricing-model');
    }
  });

  it('refuses an order whose amount or currency has drifted from the offer', () => {
    expect(build({ order: { amount: { amountMinor: 2400, currency: 'USD' } } })).toMatchObject({ ok: false, code: 'amount-mismatch' });
    expect(build({ order: { amount: { amountMinor: 2500, currency: 'EUR' } } })).toMatchObject({ ok: false, code: 'amount-mismatch' });
  });

  it('refuses a zero-amount Checkout session', () => {
    const result = build({ offer: { price: { amountMinor: 0, currency: 'USD' } }, order: { amount: { amountMinor: 0, currency: 'USD' } } });
    expect(result.ok === false && result.code).toBe('zero-amount');
  });
});

describe('stripe → inbox → ledger', () => {
  /** The operator's own facts, recorded before Stripe ever confirms a payment. */
  const seed = [
    { ledgerEventId: 'seed:1', kind: 'product.defined', occurredAtMs: 1_000, source: { provider: 'operator', providerEventId: null }, payload: { productId: 'prod-1', skuRef: 'sku-1', creatorId: 'creator-1', title: 'A Pot' } },
    { ledgerEventId: 'seed:2', kind: 'offer.defined', occurredAtMs: 2_000, source: { provider: 'operator', providerEventId: null }, payload: { offerId: 'offer-1', productId: 'prod-1', pricingModel: 'one-time', price: { amountMinor: 2500, currency: 'USD' } } },
    { ledgerEventId: 'seed:3', kind: 'order.created', occurredAtMs: 3_000, source: { provider: 'operator', providerEventId: null }, payload: { orderId: 'order-1', offerId: 'offer-1', buyerId: 'buyer-1' } },
  ];
  const paidBody = JSON.stringify({
    id: 'evt_paid_1',
    type: 'checkout.session.completed',
    created: 1_760_000_000,
    data: { object: { id: 'cs_1', payment_status: 'paid', amount_total: 2500, currency: 'usd', payment_intent: 'pi_1', metadata: { orderId: 'order-1' } } },
  });

  it('turns a signed Stripe delivery into an active entitlement', async () => {
    const store = memoryWebhookInboxStore();
    const result = await ingestWebhook({ adapter, store, request: signedRequest(paidBody) });
    expect(result.outcome).toBe('accepted');
    if (result.outcome !== 'accepted') throw new Error('expected acceptance');

    const state = reduceLedger([...seed, ...result.events]);
    expect(state.rejected).toEqual([]);
    expect(state.orders.get('order-1')?.state).toBe('paid');
    expect(hasActiveEntitlement(state, 'buyer-1', 'prod-1')).toBe(true);
  });

  it('never records an unauthenticated delivery, so a forged body cannot fill the inbox', async () => {
    const store = memoryWebhookInboxStore();
    const forged: WebhookRequest = { rawBody: paidBody, headers: { 'Stripe-Signature': `t=1760000000,v1=${'0'.repeat(64)}` }, nowMs: 1_760_000_000_000 };
    const result = await ingestWebhook({ adapter, store, request: forged });
    expect(result.outcome).toBe('rejected');
    expect(store.records()).toEqual([]);
  });

  it('treats an exact re-delivery as a duplicate that grants nothing further', async () => {
    const store = memoryWebhookInboxStore();
    const request = signedRequest(paidBody);
    await ingestWebhook({ adapter, store, request });
    const replay = await ingestWebhook({ adapter, store, request });
    expect(replay.outcome).toBe('duplicate');
    expect(store.records()).toHaveLength(1);
  });
});
