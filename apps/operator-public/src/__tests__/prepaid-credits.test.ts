/**
 * Stripe-funded prepaid credits through the shipped Worker doors (P-030).
 *
 * These tests use the real Hono routes and every real SQLite migration. Only
 * GitHub's external bearer lookup and Stripe's outbound Checkout call are
 * mocked; webhook signatures are computed independently from the adapter.
 */
import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CREDIT_MICROS_PER_USD_MINOR,
  PREPAID_CREDIT_OFFER_ID,
  PREPAID_CREDIT_PRODUCT_ID,
  PREPAID_CREDIT_TOP_UP,
} from '@papercusp/operator-core/lib/cupboard/prepaid-credits.ts';
import { buildApi } from '../routes/index.ts';
import type { Env } from '../env.ts';
import { makeEnv } from './fake-d1.ts';
import { makeSqliteDb } from './sqlite-d1.ts';

const auth = vi.hoisted(() => ({ resolveGithubBearer: vi.fn() }));
vi.mock('../auth.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../auth.ts')>();
  return { ...actual, resolveGithubBearer: auth.resolveGithubBearer };
});

const STRIPE_WEBHOOK_SECRET = 'prepaid-credit-signing-material';
const CREDIT_GRANT =
  PREPAID_CREDIT_TOP_UP.amountMinor * CREDIT_MICROS_PER_USD_MINOR;

function sign(rawBody: string, timestampSec = Math.floor(Date.now() / 1000)): string {
  const digest = createHmac('sha256', STRIPE_WEBHOOK_SECRET)
    .update(`${timestampSec}.${rawBody}`, 'utf8')
    .digest('hex');
  return `t=${timestampSec},v1=${digest}`;
}

function stripeStub() {
  const calls: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
  const fetchImpl = (async (url: unknown, init: RequestInit = {}) => {
    calls.push({
      url: String(url),
      body: String(init.body ?? ''),
      headers: (init.headers ?? {}) as Record<string, string>,
    });
    return new Response(
      JSON.stringify({
        id: `cs_prepaid_${calls.length}`,
        url: `https://checkout.test/prepaid/${calls.length}`,
      }),
      { status: 200 },
    );
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function harness() {
  const { db, raw } = makeSqliteDb();
  const stripe = stripeStub();
  const { env } = makeEnv({
    STRIPE_SECRET_KEY: 'test-stripe-secret',
    STRIPE_WEBHOOK_SECRET,
  });
  env.DB = db;
  return {
    api: buildApi({ fetchImpl: stripe.fetchImpl }),
    env,
    raw,
    stripe,
  };
}

function bearerJson(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  };
}

async function postStripe(
  api: ReturnType<typeof buildApi>,
  env: Env,
  body: string,
) {
  return api.request(
    '/commerce/webhooks/stripe',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Stripe-Signature': sign(body),
      },
      body,
    },
    env,
  );
}

async function grantCredits(
  api: ReturnType<typeof buildApi>,
  env: Env,
  idempotencyKey = 'prepaid-top-up-1',
) {
  const checkout = await api.request(
    '/commerce/checkout-sessions',
    bearerJson({
      buyerOrgId: 'gh:42',
      offerId: PREPAID_CREDIT_OFFER_ID,
      successUrl: 'https://example.test/prepaid/success',
      cancelUrl: 'https://example.test/prepaid/cancel',
      idempotencyKey,
    }),
    env,
  );
  expect(checkout.status).toBe(201);
  const checkoutBody = (await checkout.json()) as {
    orderId: string;
    providerSessionId: string;
    url: string;
  };

  const createdSec = Math.floor(Date.now() / 1000) + 2;
  const paidBody = JSON.stringify({
    id: `evt_paid_${idempotencyKey}`,
    type: 'checkout.session.completed',
    created: createdSec,
    data: {
      object: {
        id: checkoutBody.providerSessionId,
        payment_status: 'paid',
        amount_total: PREPAID_CREDIT_TOP_UP.amountMinor,
        currency: PREPAID_CREDIT_TOP_UP.currency.toLowerCase(),
        payment_intent: `pi_${idempotencyKey}`,
        metadata: { orderId: checkoutBody.orderId },
      },
    },
  });
  const paid = await postStripe(api, env, paidBody);
  expect(paid.status).toBe(200);
  expect(await paid.json()).toMatchObject({ outcome: 'accepted' });
  return { ...checkoutBody, paidBody, createdSec };
}

describe('prepaid-credit Worker production door', () => {
  beforeEach(() => {
    auth.resolveGithubBearer.mockReset();
    auth.resolveGithubBearer.mockResolvedValue({ id: 42, login: 'credit-owner' });
  });

  it('installs the fixed top-up SKU, grants after a signed webhook exactly once, and reads the authenticated balance', async () => {
    const { api, env, raw, stripe } = harness();
    const granted = await grantCredits(api, env);

    expect(stripe.calls).toHaveLength(1);
    expect(stripe.calls[0].body).toContain(
      `line_items%5B0%5D%5Bprice_data%5D%5Bunit_amount%5D=${PREPAID_CREDIT_TOP_UP.amountMinor}`,
    );
    expect(
      raw
        .prepare(
          'SELECT product_id FROM commerce_products WHERE product_id = ?',
        )
        .get(PREPAID_CREDIT_PRODUCT_ID),
    ).toMatchObject({ product_id: PREPAID_CREDIT_PRODUCT_ID });
    expect(
      raw
        .prepare(
          'SELECT offer_id, amount_minor, currency FROM commerce_offers WHERE offer_id = ?',
        )
        .get(PREPAID_CREDIT_OFFER_ID),
    ).toMatchObject({
      offer_id: PREPAID_CREDIT_OFFER_ID,
      amount_minor: PREPAID_CREDIT_TOP_UP.amountMinor,
      currency: PREPAID_CREDIT_TOP_UP.currency,
    });

    expect(
      raw
        .prepare(
          'SELECT available_micros, granted_micros FROM prepaid_credit_balances WHERE principal_id = ?',
        )
        .get('gh:42'),
    ).toMatchObject({
      available_micros: CREDIT_GRANT,
      granted_micros: CREDIT_GRANT,
    });

    const duplicate = await postStripe(api, env, granted.paidBody);
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toMatchObject({ outcome: 'duplicate' });
    expect(
      raw
        .prepare(
          'SELECT available_micros, granted_micros FROM prepaid_credit_balances WHERE principal_id = ?',
        )
        .get('gh:42'),
    ).toMatchObject({
      available_micros: CREDIT_GRANT,
      granted_micros: CREDIT_GRANT,
    });

    const balance = await api.request(
      '/commerce/prepaid-credits/balance',
      { headers: { Authorization: 'Bearer test-token' } },
      env,
    );
    expect(balance.status).toBe(200);
    expect(await balance.json()).toEqual({
      principalId: 'gh:42',
      balance: {
        principalId: 'gh:42',
        availableMicros: CREDIT_GRANT,
        reservedMicros: 0,
        spentMicros: 0,
        debtMicros: 0,
        grantedMicros: CREDIT_GRANT,
        reversedMicros: 0,
        updatedAtMs: granted.createdSec * 1000,
      },
    });
  });

  it('projects refunds and chargebacks in event-time order and refuses spending after full reversal', async () => {
    const { api, env, raw } = harness();
    const granted = await grantCredits(api, env);

    // Delivered first but timestamped later: the reducer must not depend on
    // arrival order when the earlier chargeback lands afterwards.
    const refundBody = JSON.stringify({
      id: 'evt_prepaid_refund',
      type: 'charge.refunded',
      created: granted.createdSec + 20,
      data: {
        object: {
          id: 'ch_prepaid',
          metadata: { orderId: granted.orderId },
          currency: 'usd',
          refunds: {
            data: [
              {
                id: 're_prepaid',
                status: 'succeeded',
                amount: 400,
                currency: 'usd',
              },
            ],
          },
        },
      },
    });
    expect((await postStripe(api, env, refundBody)).status).toBe(200);

    const disputeBody = JSON.stringify({
      id: 'evt_prepaid_dispute',
      type: 'charge.dispute.created',
      created: granted.createdSec + 10,
      data: {
        object: {
          id: 'dp_prepaid',
          amount: 600,
          currency: 'usd',
          status: 'needs_response',
          metadata: { orderId: granted.orderId },
        },
      },
    });
    expect((await postStripe(api, env, disputeBody)).status).toBe(200);

    expect(
      raw
        .prepare(
          'SELECT available_micros, debt_micros, reversed_micros FROM prepaid_credit_balances WHERE principal_id = ?',
        )
        .get('gh:42'),
    ).toMatchObject({
      available_micros: 0,
      debt_micros: 0,
      reversed_micros: CREDIT_GRANT,
    });

    const refused = await api.request(
      '/commerce/prepaid-credits/reservations',
      bearerJson({
        reservationId: 'after-reversal',
        channelId: 'channel-after-reversal',
        amountMicros: 1,
      }),
      env,
    );
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: 'negative-balance' });
    expect(
      raw.prepare('SELECT COUNT(*) AS n FROM prepaid_credit_events').get(),
    ).toMatchObject({ n: 0 });
  });

  it('funds microcharge reservations idempotently, settles/releases them, and refuses double-spend or channel reuse', async () => {
    const { api, env, raw } = harness();
    await grantCredits(api, env);

    const firstReservation = {
      reservationId: 'reservation-1',
      channelId: 'channel-1',
      amountMicros: 5_000_000,
    };
    const reserved = await api.request(
      '/commerce/prepaid-credits/reservations',
      bearerJson(firstReservation),
      env,
    );
    expect(reserved.status).toBe(201);
    expect(await reserved.json()).toMatchObject({
      replayed: false,
      balance: { availableMicros: 5_000_000, reservedMicros: 5_000_000 },
      reservation: {
        reservationId: 'reservation-1',
        channelId: 'channel-1',
        state: 'open',
      },
      channel: {
        channelId: 'channel-1',
        escrowMicros: '5000000',
        committedMicros: '0',
      },
    });

    const replay = await api.request(
      '/commerce/prepaid-credits/reservations',
      bearerJson(firstReservation),
      env,
    );
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ replayed: true });
    expect(
      raw.prepare('SELECT COUNT(*) AS n FROM prepaid_credit_events').get(),
    ).toMatchObject({ n: 1 });

    const channelConflict = await api.request(
      '/commerce/prepaid-credits/reservations',
      bearerJson({
        reservationId: 'reservation-channel-conflict',
        channelId: 'channel-1',
        amountMicros: 1,
      }),
      env,
    );
    expect(channelConflict.status).toBe(409);
    expect(await channelConflict.json()).toMatchObject({
      error: 'reservation-conflict',
    });

    const settled = await api.request(
      '/commerce/prepaid-credits/reservations/reservation-1/settle',
      bearerJson({ committedMicros: 3_000_000 }),
      env,
    );
    expect(settled.status).toBe(201);
    expect(await settled.json()).toMatchObject({
      balance: {
        availableMicros: 7_000_000,
        reservedMicros: 0,
        spentMicros: 3_000_000,
      },
      reservation: {
        reservationId: 'reservation-1',
        state: 'settled',
        committedMicros: 3_000_000,
      },
    });

    const secondReserved = await api.request(
      '/commerce/prepaid-credits/reservations',
      bearerJson({
        reservationId: 'reservation-2',
        channelId: 'channel-2',
        amountMicros: 2_000_000,
      }),
      env,
    );
    expect(secondReserved.status).toBe(201);
    const released = await api.request(
      '/commerce/prepaid-credits/reservations/reservation-2/release',
      bearerJson({}),
      env,
    );
    expect(released.status).toBe(201);
    expect(await released.json()).toMatchObject({
      balance: {
        availableMicros: 7_000_000,
        reservedMicros: 0,
        spentMicros: 3_000_000,
      },
      reservation: {
        reservationId: 'reservation-2',
        state: 'released',
      },
    });

    const doubleSpend = await api.request(
      '/commerce/prepaid-credits/reservations',
      bearerJson({
        reservationId: 'reservation-too-large',
        channelId: 'channel-too-large',
        amountMicros: 7_000_001,
      }),
      env,
    );
    expect(doubleSpend.status).toBe(409);
    expect(await doubleSpend.json()).toMatchObject({
      error: 'negative-balance',
    });

    expect(
      raw
        .prepare(
          'SELECT state, committed_micros FROM prepaid_credit_reservations WHERE reservation_id = ?',
        )
        .get('reservation-1'),
    ).toMatchObject({ state: 'settled', committed_micros: 3_000_000 });
    expect(
      raw
        .prepare(
          'SELECT state, committed_micros FROM prepaid_credit_reservations WHERE reservation_id = ?',
        )
        .get('reservation-2'),
    ).toMatchObject({ state: 'released', committed_micros: 0 });
  });
});
