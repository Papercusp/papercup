/**
 * Tests for the signed webhook inbox + payment-provider adapter seam (P-010; D-025).
 *
 * The inbox is the fail-closed front door: the properties under test are that an
 * unauthenticated delivery is refused BEFORE it can occupy the store, that an
 * exact replay is a harmless duplicate, and that a replay whose bytes differ is
 * refused as `replay-mismatch` rather than silently overwriting history.
 *
 * The adapter here is a stub — `payment-adapters/stripe.test.ts` covers a real one.
 */
import { describe, expect, it } from 'vitest';
import type { LedgerEvent } from './commerce-ledger';
import {
  type NormalizeVerdict,
  type PaymentProviderAdapter,
  type SignatureVerdict,
  type WebhookRequest,
  headerLookup,
  ingestWebhook,
  memoryWebhookInboxStore,
  webhookBodyDigest,
} from './webhook-inbox';

const ledgerEvent = (id: string): LedgerEvent => ({
  ledgerEventId: id,
  kind: 'order.paid',
  occurredAtMs: 1_000,
  source: { provider: 'stub', providerEventId: 'evt_1' },
  payload: { orderId: 'order-1' },
});

interface StubOptions {
  signature?: SignatureVerdict;
  normalize?: (rawBody: string) => NormalizeVerdict;
}

function stubAdapter(opts: StubOptions = {}): PaymentProviderAdapter & { verifyCalls: number; normalizeCalls: number } {
  const adapter = {
    provider: 'stub',
    verifyCalls: 0,
    normalizeCalls: 0,
    verifySignature(_request: WebhookRequest): SignatureVerdict {
      adapter.verifyCalls += 1;
      return opts.signature ?? { ok: true };
    },
    normalize(rawBody: string, _receivedAtMs: number): NormalizeVerdict {
      adapter.normalizeCalls += 1;
      if (opts.normalize) return opts.normalize(rawBody);
      return {
        ok: true,
        webhook: { providerEventId: 'evt_1', providerEventType: 'checkout.session.completed', occurredAtMs: 1_000, events: [ledgerEvent('led-1')] },
      };
    },
  };
  return adapter;
}

const request = (rawBody = '{"id":"evt_1"}', nowMs = 5_000): WebhookRequest => ({ rawBody, headers: { 'Stripe-Signature': 'sig' }, nowMs });

describe('headerLookup', () => {
  it('matches header names case-insensitively', () => {
    const headers = { 'Stripe-Signature': 'abc', 'Content-Type': 'application/json' };
    expect(headerLookup(headers, 'stripe-signature')).toBe('abc');
    expect(headerLookup(headers, 'STRIPE-SIGNATURE')).toBe('abc');
    expect(headerLookup(headers, 'Stripe-Signature')).toBe('abc');
  });

  it('returns null for an absent header', () => {
    expect(headerLookup({ a: '1' }, 'missing')).toBeNull();
  });
});

describe('webhookBodyDigest', () => {
  it('is stable for identical bytes and differs for any change', () => {
    expect(webhookBodyDigest('{"a":1}')).toBe(webhookBodyDigest('{"a":1}'));
    expect(webhookBodyDigest('{"a":1}')).not.toBe(webhookBodyDigest('{"a":2}'));
    // whitespace is a byte difference — signatures cover raw bytes, so this must matter
    expect(webhookBodyDigest('{"a":1}')).not.toBe(webhookBodyDigest('{"a": 1}'));
  });
});

describe('memoryWebhookInboxStore', () => {
  it('keys records by (provider, providerEventId)', async () => {
    const store = memoryWebhookInboxStore();
    const base = { providerEventType: null, bodyDigest: 'd', receivedAtMs: 1, outcome: 'accepted' as const, rejectionCode: null, ledgerEventIds: [] };
    await store.put({ ...base, provider: 'a', providerEventId: 'evt_1' });
    await store.put({ ...base, provider: 'b', providerEventId: 'evt_1' });

    expect(await store.get('a', 'evt_1')).toMatchObject({ provider: 'a' });
    expect(await store.get('b', 'evt_1')).toMatchObject({ provider: 'b' });
    expect(await store.get('a', 'evt_2')).toBeNull();
    expect(store.records()).toHaveLength(2);
  });
});

describe('ingestWebhook — fail-closed signature', () => {
  it('refuses an unauthenticated delivery and NEVER records it', async () => {
    const adapter = stubAdapter({ signature: { ok: false, code: 'bad-signature', detail: 'hmac mismatch' } });
    const store = memoryWebhookInboxStore();

    const result = await ingestWebhook({ adapter, store, request: request() });

    expect(result).toMatchObject({ outcome: 'rejected', code: 'bad-signature', providerEventId: null });
    expect(store.records()).toEqual([]);
  });

  it('does not even parse the body when the signature fails', async () => {
    const adapter = stubAdapter({ signature: { ok: false, code: 'missing-signature', detail: 'no header' } });
    await ingestWebhook({ adapter, store: memoryWebhookInboxStore(), request: request() });

    expect(adapter.verifyCalls).toBe(1);
    expect(adapter.normalizeCalls).toBe(0);
  });

  it.each(['missing-secret', 'missing-signature', 'malformed-signature', 'bad-signature', 'stale-timestamp'] as const)(
    'propagates the %s refusal code without storing anything',
    async (code) => {
      const store = memoryWebhookInboxStore();
      const result = await ingestWebhook({ adapter: stubAdapter({ signature: { ok: false, code, detail: code } }), store, request: request() });
      expect(result).toMatchObject({ outcome: 'rejected', code });
      expect(store.records()).toEqual([]);
    },
  );
});

describe('ingestWebhook — accepted vs ignored', () => {
  it('accepts an authenticated delivery that yields ledger events', async () => {
    const store = memoryWebhookInboxStore();
    const result = await ingestWebhook({ adapter: stubAdapter(), store, request: request() });

    expect(result.outcome).toBe('accepted');
    if (result.outcome !== 'accepted') throw new Error('expected accepted');
    expect(result.events.map((e) => e.ledgerEventId)).toEqual(['led-1']);
    expect(result.record).toMatchObject({
      provider: 'stub',
      providerEventId: 'evt_1',
      providerEventType: 'checkout.session.completed',
      outcome: 'accepted',
      rejectionCode: null,
      ledgerEventIds: ['led-1'],
    });
    expect(store.records()).toHaveLength(1);
  });

  it('IGNORES an authenticated delivery that is irrelevant to the ledger, but still records it', async () => {
    const adapter = stubAdapter({
      normalize: () => ({ ok: true, webhook: { providerEventId: 'evt_1', providerEventType: 'invoice.voided', occurredAtMs: 1_000, events: [] } }),
    });
    const store = memoryWebhookInboxStore();

    const result = await ingestWebhook({ adapter, store, request: request() });

    expect(result.outcome).toBe('ignored');
    expect(store.records()).toHaveLength(1);
    expect(store.records()[0]).toMatchObject({ outcome: 'ignored', ledgerEventIds: [] });
  });

  it('records the receipt time and body digest on the stored record', async () => {
    const store = memoryWebhookInboxStore();
    const body = '{"id":"evt_1","v":7}';
    await ingestWebhook({ adapter: stubAdapter(), store, request: request(body, 9_999) });

    expect(store.records()[0]).toMatchObject({ receivedAtMs: 9_999, bodyDigest: webhookBodyDigest(body) });
  });
});

describe('ingestWebhook — idempotency', () => {
  it('treats an exact replay as a duplicate and returns the ORIGINAL record', async () => {
    const store = memoryWebhookInboxStore();
    const first = await ingestWebhook({ adapter: stubAdapter(), store, request: request('{"id":"evt_1"}', 1_000) });
    const second = await ingestWebhook({ adapter: stubAdapter(), store, request: request('{"id":"evt_1"}', 2_000) });

    expect(first.outcome).toBe('accepted');
    expect(second.outcome).toBe('duplicate');
    if (second.outcome !== 'duplicate') throw new Error('expected duplicate');
    // the original receipt time survives — a replay must not rewrite the record
    expect(second.record.receivedAtMs).toBe(1_000);
    expect(store.records()).toHaveLength(1);
  });

  it('REFUSES a replay of the same event id whose bytes differ', async () => {
    const store = memoryWebhookInboxStore();
    await ingestWebhook({ adapter: stubAdapter(), store, request: request('{"id":"evt_1","amount":100}') });

    const forged = await ingestWebhook({ adapter: stubAdapter(), store, request: request('{"id":"evt_1","amount":999}') });

    expect(forged).toMatchObject({ outcome: 'rejected', code: 'replay-mismatch', providerEventId: 'evt_1' });
    // the original record is untouched
    expect(store.records()).toHaveLength(1);
    expect(store.records()[0]).toMatchObject({ bodyDigest: webhookBodyDigest('{"id":"evt_1","amount":100}'), outcome: 'accepted' });
  });

  it('scopes idempotency per provider, so two providers may share an event id', async () => {
    const store = memoryWebhookInboxStore();
    const a = stubAdapter();
    const b = { ...stubAdapter(), provider: 'other' } as PaymentProviderAdapter;

    expect((await ingestWebhook({ adapter: a, store, request: request() })).outcome).toBe('accepted');
    expect((await ingestWebhook({ adapter: b, store, request: request() })).outcome).toBe('accepted');
    expect(store.records()).toHaveLength(2);
  });
});

describe('ingestWebhook — normalize refusals', () => {
  it('records an authenticated-but-unparseable delivery ONCE, under its event id', async () => {
    const adapter = stubAdapter({ normalize: () => ({ ok: false, code: 'missing-order-ref', detail: 'no orderId', providerEventId: 'evt_1' }) });
    const store = memoryWebhookInboxStore();

    const first = await ingestWebhook({ adapter, store, request: request() });
    const second = await ingestWebhook({ adapter, store, request: request() });

    expect(first).toMatchObject({ outcome: 'rejected', code: 'missing-order-ref', providerEventId: 'evt_1' });
    expect(second).toMatchObject({ outcome: 'rejected', code: 'missing-order-ref' });
    expect(store.records()).toHaveLength(1);
    expect(store.records()[0]).toMatchObject({ outcome: 'rejected', rejectionCode: 'missing-order-ref', providerEventType: null, ledgerEventIds: [] });
  });

  it('does NOT record a refusal that carries no provider event id', async () => {
    const adapter = stubAdapter({ normalize: () => ({ ok: false, code: 'malformed-body', detail: 'not json', providerEventId: null }) });
    const store = memoryWebhookInboxStore();

    const result = await ingestWebhook({ adapter, store, request: request() });

    expect(result).toMatchObject({ outcome: 'rejected', code: 'malformed-body', providerEventId: null });
    expect(store.records()).toEqual([]);
  });

  it('does not overwrite an ACCEPTED record with a later rejection under the same id', async () => {
    const store = memoryWebhookInboxStore();
    await ingestWebhook({ adapter: stubAdapter(), store, request: request() });

    const rejecting = stubAdapter({ normalize: () => ({ ok: false, code: 'invalid-amount', detail: 'bad', providerEventId: 'evt_1' }) });
    await ingestWebhook({ adapter: rejecting, store, request: request() });

    expect(store.records()).toHaveLength(1);
    expect(store.records()[0]).toMatchObject({ outcome: 'accepted', rejectionCode: null });
  });
});
