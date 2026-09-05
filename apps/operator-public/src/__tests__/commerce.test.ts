/**
 * Commerce webhook intake + entitlement read, end to end (P-010; D-025).
 *
 * These run against REAL SQLite with the real migrations applied (see
 * `sqlite-d1.ts`), because the feature's central promise is a database
 * constraint — `UNIQUE (provider, provider_event_id)` — that a SQL-string fake
 * cannot enforce.
 *
 * Signatures are computed independently with `node:crypto`, never via the
 * adapter's own `computeStripeSignature`.
 */

import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildApi } from '../routes/index.ts';
import type { Env } from '../env.ts';
import { makeEnv } from './fake-d1.ts';
import { makeSqliteDb } from './sqlite-d1.ts';

const SIGNING_FIXTURE = 'cupboard-fixture-signing-material';

function sign(rawBody: string, timestampSec: number, material = SIGNING_FIXTURE): string {
  const mac = createHmac('sha256', material).update(`${timestampSec}.${rawBody}`, 'utf8').digest('hex');
  return `t=${timestampSec},v1=${mac}`;
}

function harness(overrides: Partial<Env> = {}) {
  const { db, raw } = makeSqliteDb();
  const { env } = makeEnv({ STRIPE_WEBHOOK_SECRET: SIGNING_FIXTURE, ...overrides });
  env.DB = db;
  return { api: buildApi(), env, raw };
}

const NOW_SEC = Math.floor(Date.now() / 1000);

function stripeBody(over: Record<string, unknown> = {}, object: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: 'evt_1',
    type: 'checkout.session.completed',
    created: NOW_SEC,
    data: {
      object: {
        id: 'cs_1',
        payment_status: 'paid',
        amount_total: 2500,
        currency: 'usd',
        payment_intent: 'pi_1',
        metadata: { orderId: 'order-1' },
        ...object,
      },
    },
    ...over,
  });
}

/** The operator's own facts: the order exists before Stripe confirms payment. */
function seedOrder(raw: ReturnType<typeof makeSqliteDb>['raw']): void {
  const rows: Array<[string, string, number, string, string, string]> = [
    ['seed-1', 'product.defined', 1_000, 'operator', '{"productId":"prod-1","skuRef":"sku-1","creatorId":"creator-1","title":"A Pot"}', 'null'],
    ['seed-2', 'offer.defined', 2_000, 'operator', '{"offerId":"offer-1","productId":"prod-1","pricingModel":"one-time","price":{"amountMinor":2500,"currency":"USD"}}', 'null'],
    ['seed-3', 'order.created', 3_000, 'operator', '{"orderId":"order-1","offerId":"offer-1","buyerId":"buyer-1"}', 'null'],
  ];
  for (const [id, kind, at, provider, payload] of rows) {
    raw
      .prepare(
        'INSERT INTO commerce_ledger_events (ledger_event_id, kind, occurred_at_ms, provider, provider_event_id, payload_json) VALUES (?, ?, ?, ?, NULL, ?)',
      )
      .run(id, kind, at, provider, payload);
  }
}

async function post(api: ReturnType<typeof buildApi>, env: Env, body: string, signature: string | null, provider = 'stripe') {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (signature) headers['Stripe-Signature'] = signature;
  return api.request(`/commerce/webhooks/${provider}`, { method: 'POST', headers, body }, env);
}

describe('POST /commerce/webhooks/:provider — authentication', () => {
  it('refuses an unsigned delivery with 401 and records NOTHING', async () => {
    const { api, env, raw } = harness();
    const res = await post(api, env, stripeBody(), null);
    expect(res.status).toBe(401);
    expect((await res.json() as { error: string }).error).toBe('missing-signature');
    expect(raw.prepare('SELECT COUNT(*) AS n FROM commerce_webhook_inbox').get()).toMatchObject({ n: 0 });
  });

  it('refuses a delivery signed with the wrong material, and stores nothing', async () => {
    const { api, env, raw } = harness();
    const body = stripeBody();
    const res = await post(api, env, body, sign(body, NOW_SEC, 'the-wrong-material'));
    expect(res.status).toBe(401);
    expect((await res.json() as { error: string }).error).toBe('bad-signature');
    expect(raw.prepare('SELECT COUNT(*) AS n FROM commerce_webhook_inbox').get()).toMatchObject({ n: 0 });
  });

  it('refuses a signature outside the timestamp tolerance', async () => {
    const { api, env } = harness();
    const stale = NOW_SEC - 3600;
    const body = stripeBody();
    const res = await post(api, env, body, sign(body, stale));
    expect(res.status).toBe(401);
    expect((await res.json() as { error: string }).error).toBe('stale-timestamp');
  });

  it('fails CLOSED with 503 when the deployment has no signing secret configured', async () => {
    const { api, env } = harness({ STRIPE_WEBHOOK_SECRET: undefined });
    const body = stripeBody();
    const res = await post(api, env, body, sign(body, NOW_SEC));
    expect(res.status).toBe(503);
    expect((await res.json() as { error: string }).error).toBe('provider_not_configured');
  });

  it('404s an unknown provider, distinctly from an unconfigured one', async () => {
    const { api, env } = harness();
    const body = stripeBody();
    const res = await post(api, env, body, sign(body, NOW_SEC), 'paypal');
    expect(res.status).toBe(404);
    expect((await res.json() as { error: string }).error).toBe('unknown_provider');
  });
});

describe('POST /commerce/webhooks/:provider — ingestion', () => {
  it('accepts a signed payment, appends ledger events, and projects an entitlement', async () => {
    const { api, env, raw } = harness();
    seedOrder(raw);
    const body = stripeBody();

    const res = await post(api, env, body, sign(body, NOW_SEC));
    expect(res.status).toBe(200);
    const json = await res.json() as { outcome: string; ledger_event_ids: string[] };
    expect(json.outcome).toBe('accepted');
    expect(json.ledger_event_ids).toEqual(['stripe:evt_1:0']);

    expect(raw.prepare("SELECT state, refunded_minor FROM commerce_orders WHERE order_id = 'order-1'").get())
      .toMatchObject({ state: 'paid', refunded_minor: 0 });
    expect(raw.prepare("SELECT state, buyer_id, product_id FROM commerce_entitlements WHERE entitlement_id = 'ent:order-1'").get())
      .toMatchObject({ state: 'active', buyer_id: 'buyer-1', product_id: 'prod-1' });
    expect(raw.prepare('SELECT outcome FROM commerce_webhook_inbox').get()).toMatchObject({ outcome: 'accepted' });
  });

  it('treats an exact re-delivery as a duplicate and grants nothing further', async () => {
    const { api, env, raw } = harness();
    seedOrder(raw);
    const body = stripeBody();
    const signature = sign(body, NOW_SEC);

    expect((await post(api, env, body, signature)).status).toBe(200);
    const replay = await post(api, env, body, signature);
    expect(replay.status).toBe(200);
    expect((await replay.json() as { outcome: string }).outcome).toBe('duplicate');

    // The UNIQUE(provider, provider_event_id) constraint is the durable half.
    expect(raw.prepare('SELECT COUNT(*) AS n FROM commerce_webhook_inbox').get()).toMatchObject({ n: 1 });
    expect(raw.prepare('SELECT COUNT(*) AS n FROM commerce_entitlements').get()).toMatchObject({ n: 1 });
  });

  it('refuses a replay of the same event id whose BYTES differ', async () => {
    const { api, env, raw } = harness();
    seedOrder(raw);
    const first = stripeBody();
    await post(api, env, first, sign(first, NOW_SEC));

    // Same Stripe event id, tampered amount, correctly signed for the new bytes.
    const tampered = stripeBody({}, { amount_total: 100 });
    const res = await post(api, env, tampered, sign(tampered, NOW_SEC));
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe('replay-mismatch');
    expect(raw.prepare("SELECT amount_minor FROM commerce_orders WHERE order_id = 'order-1'").get())
      .toMatchObject({ amount_minor: 2500 });
  });

  it('202s an authenticated event that carries no ledger meaning', async () => {
    const { api, env, raw } = harness();
    const body = stripeBody({ type: 'customer.created' }, {});
    const res = await post(api, env, body, sign(body, NOW_SEC));
    expect(res.status).toBe(202);
    expect((await res.json() as { outcome: string }).outcome).toBe('ignored');
    expect(raw.prepare('SELECT outcome FROM commerce_webhook_inbox').get()).toMatchObject({ outcome: 'ignored' });
  });

  it('revokes the entitlement when a full refund arrives', async () => {
    const { api, env, raw } = harness();
    seedOrder(raw);
    const paid = stripeBody();
    await post(api, env, paid, sign(paid, NOW_SEC));

    const refund = JSON.stringify({
      id: 'evt_refund_1',
      type: 'charge.refunded',
      created: NOW_SEC + 10,
      data: {
        object: {
          id: 'ch_1',
          metadata: { orderId: 'order-1' },
          currency: 'usd',
          refunds: { data: [{ id: 're_1', status: 'succeeded', amount: 2500, currency: 'usd' }] },
        },
      },
    });
    const res = await post(api, env, refund, sign(refund, NOW_SEC));
    expect(res.status).toBe(200);

    expect(raw.prepare("SELECT state, refunded_minor FROM commerce_orders WHERE order_id = 'order-1'").get())
      .toMatchObject({ state: 'refunded', refunded_minor: 2500 });
    expect(raw.prepare("SELECT state, revoke_reason FROM commerce_entitlements WHERE entitlement_id = 'ent:order-1'").get())
      .toMatchObject({ state: 'revoked', revoke_reason: 'refunded' });
  });
});

describe('GET /commerce/entitlements', () => {
  it('requires a buyer', async () => {
    const { api, env } = harness();
    const res = await api.request('/commerce/entitlements', {}, env);
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe('buyer_required');
  });

  it('serves only ACTIVE entitlements, and only the asking buyer’s', async () => {
    const { api, env, raw } = harness();
    seedOrder(raw);
    const body = stripeBody();
    await post(api, env, body, sign(body, NOW_SEC));

    const mine = await api.request('/commerce/entitlements?buyer=buyer-1', {}, env);
    expect(mine.status).toBe(200);
    const json = await mine.json() as { buyer: string; entitlements: Array<{ product_id: string; state: string }> };
    expect(json.buyer).toBe('buyer-1');
    expect(json.entitlements).toHaveLength(1);
    expect(json.entitlements[0]).toMatchObject({ product_id: 'prod-1', state: 'active' });

    const other = await api.request('/commerce/entitlements?buyer=buyer-2', {}, env);
    expect((await other.json() as { entitlements: unknown[] }).entitlements).toEqual([]);
  });

  it('stops serving an entitlement once it is revoked', async () => {
    const { api, env, raw } = harness();
    seedOrder(raw);
    const paid = stripeBody();
    await post(api, env, paid, sign(paid, NOW_SEC));
    raw.prepare("UPDATE commerce_entitlements SET state = 'revoked' WHERE entitlement_id = 'ent:order-1'").run();

    const res = await api.request('/commerce/entitlements?buyer=buyer-1', {}, env);
    expect((await res.json() as { entitlements: unknown[] }).entitlements).toEqual([]);
  });
});

describe('migration 019 schema', () => {
  it('enforces UNIQUE(provider, provider_event_id) on the webhook inbox', () => {
    const { raw } = makeSqliteDb();
    const insert = () =>
      raw
        .prepare(
          "INSERT INTO commerce_webhook_inbox (provider, provider_event_id, provider_event_type, body_digest, received_at_ms, outcome, rejection_code, ledger_event_ids_json) VALUES ('stripe', 'evt_1', 'x', 'digest', 1, 'accepted', NULL, '[]')",
        )
        .run();
    insert();
    expect(insert).toThrow(/UNIQUE/i);
  });

  it('rejects an outcome outside the accepted/ignored/rejected set', () => {
    const { raw } = makeSqliteDb();
    expect(() =>
      raw
        .prepare(
          "INSERT INTO commerce_webhook_inbox (provider, provider_event_id, provider_event_type, body_digest, received_at_ms, outcome, rejection_code, ledger_event_ids_json) VALUES ('stripe', 'evt_2', 'x', 'digest', 1, 'maybe', NULL, '[]')",
        )
        .run(),
    ).toThrow(/CHECK/i);
  });
});
