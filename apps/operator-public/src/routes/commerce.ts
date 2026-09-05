/**
 * Commerce webhook intake + entitlement read (shared-pot DAO plan P-010; D-025).
 *
 * The Worker is a TRANSPORT here, not a decision-maker. It hands the raw body and
 * headers to the shared `ingestWebhook`, which verifies the signature BEFORE
 * parsing, normalizes through a `PaymentProviderAdapter`, and enforces
 * idempotency; the Worker only chooses the adapter, supplies the D1 store, and
 * maps the result to a status code. No Stripe field name and no ledger rule
 * appears in this file.
 *
 * Fail-closed: an unconfigured provider secret is a 503 (we cannot authenticate,
 * so we must not accept), and every signature refusal is a 401 that is never
 * recorded — an unauthenticated request must not be able to fill the inbox.
 */

import { Hono } from 'hono';
import type { Env } from '../env.ts';
import { ingestWebhook } from '@papercusp/operator-core/lib/cupboard/webhook-inbox';
import type { PaymentProviderAdapter } from '@papercusp/operator-core/lib/cupboard/webhook-inbox';
import {
  buildStripeCheckoutSessionParams,
  createStripeAdapter,
  createStripeCheckoutSession,
  STRIPE_PROVIDER,
} from '@papercusp/operator-core/lib/cupboard/payment-adapters/stripe';
import { AuthError, resolveGithubBearer } from '../auth.ts';
import { reduceLedger } from '@papercusp/operator-core/lib/cupboard/commerce-ledger';
import type { LedgerEvent, Order } from '@papercusp/operator-core/lib/cupboard/commerce-ledger';
import { appendLedgerEvents, d1WebhookInboxStore, listActiveEntitlements, loadLedgerEvents, projectLedger } from '../commerce-store.ts';

/** Signature refusals — the request never proved who it was. */
const SIGNATURE_REFUSALS = new Set([
  'missing-secret',
  'missing-signature',
  'malformed-signature',
  'bad-signature',
  'stale-timestamp',
]);

/**
 * Resolve the adapter for a provider slug. Secrets come from the environment,
 * never a tree file. An unknown provider and an unconfigured one are DIFFERENT
 * answers: 404 means "we do not speak that provider", 503 means "we do, but this
 * deployment cannot authenticate it yet".
 */
function resolveAdapter(provider: string, env: Env): { adapter: PaymentProviderAdapter } | { error: 'unknown' | 'unconfigured' } {
  if (provider !== STRIPE_PROVIDER) return { error: 'unknown' };
  const secret = env.STRIPE_WEBHOOK_SECRET;
  if (typeof secret !== 'string' || !secret) return { error: 'unconfigured' };
  return { adapter: createStripeAdapter({ webhookSecret: secret }) };
}

/** Fields a checkout-session request must carry, after parsing. */
interface CheckoutRequest {
  buyerOrgId: string;
  offerId: string;
  successUrl: string;
  cancelUrl: string;
  idempotencyKey: string;
  quantity: number;
}

type CheckoutParse = { ok: true; value: CheckoutRequest } | { ok: false; code: string; detail: string };

function parseCheckoutRequest(raw: unknown): CheckoutParse {
  if (typeof raw !== 'object' || raw === null) return { ok: false, code: 'invalid_request', detail: 'body must be a JSON object' };
  const body = raw as Record<string, unknown>;
  const required = ['buyerOrgId', 'offerId', 'successUrl', 'cancelUrl', 'idempotencyKey'] as const;
  for (const field of required) {
    const value = body[field];
    if (typeof value !== 'string' || !value.trim()) return { ok: false, code: 'invalid_request', detail: `${field} must be a non-empty string` };
  }
  // Only quantity 1 is expressible: `buildStripeCheckoutSessionParams` hard-codes
  // `line_items[0].quantity = 1` and refuses unless the order amount equals the
  // offer price exactly, so a quantity>1 order cannot be built without changing
  // that shared builder. Refusing loudly beats silently charging for one seat.
  const quantity = body.quantity === undefined ? 1 : body.quantity;
  if (quantity !== 1) return { ok: false, code: 'unsupported_quantity', detail: 'only quantity 1 is supported by the current Checkout builder' };
  return {
    ok: true,
    value: {
      buyerOrgId: String(body.buyerOrgId),
      offerId: String(body.offerId),
      successUrl: String(body.successUrl),
      cancelUrl: String(body.cancelUrl),
      idempotencyKey: String(body.idempotencyKey),
      quantity: 1,
    },
  };
}

/**
 * The order id IS the idempotency record.
 *
 * Deriving it from (buyer, offer, idempotencyKey) makes a replay resolve to the
 * SAME order without a separate key table, and — the part that matters — binds
 * the key to its buyer: two callers who happen to pick the same idempotencyKey
 * get different orders instead of one reading the other's. Web Crypto rather
 * than `node:crypto` so this is identical under workerd and Node.
 */
async function deriveOrderId(input: CheckoutRequest): Promise<string> {
  const material = `${input.buyerOrgId}\n${input.offerId}\n${input.idempotencyKey}`;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(material));
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `ord_${hex.slice(0, 32)}`;
}

/** The 422 codes the pure builder can refuse with, mapped to the wire contract. */
const BUILD_REFUSAL_CODES: Record<string, string> = {
  'unsupported-pricing-model': 'unsupported_pricing_model',
  'amount-mismatch': 'amount_mismatch',
  'zero-amount': 'zero_amount',
};

export function commerceRoute(options: { fetchImpl?: typeof fetch } = {}): Hono<{ Bindings: Env }> {
  const route = new Hono<{ Bindings: Env }>();
  // Injected so the checkout path is exercisable without network access; the
  // default is the runtime's own fetch, bound so workerd does not see an
  // illegal-invocation receiver.
  const fetchImpl: typeof fetch = options.fetchImpl ?? ((input, init) => fetch(input, init));

  route.post('/commerce/checkout-sessions', async (c) => {
    // Authenticate FIRST: this endpoint opens real orders and real Checkout
    // Sessions, so an anonymous caller must not even learn whether this
    // deployment has Stripe configured.
    //
    // ⚠ This establishes WHO is calling, not that they may act for
    // `buyerOrgId` — the Worker has no org-membership model yet, so any
    // authenticated user can still open an order naming any org. That
    // authorization gap is recorded on WI-2146343, not silently accepted.
    try {
      await resolveGithubBearer(c.req.raw);
    } catch (err) {
      if (err instanceof AuthError) return c.json({ error: 'unauthorized', reason: err.reason }, 401);
      throw err;
    }

    // Fail CLOSED, exactly like the webhook route: without a key we cannot
    // authenticate to Stripe, so we must not pretend to have created a session.
    const secretKey = c.env.STRIPE_SECRET_KEY;
    if (typeof secretKey !== 'string' || !secretKey) {
      return c.json({ error: 'provider_not_configured', detail: 'STRIPE_SECRET_KEY is not configured in this deployment' }, 503);
    }

    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_request', detail: 'body was not valid JSON' }, 400);
    }
    const parsed = parseCheckoutRequest(rawBody);
    if (!parsed.ok) {
      return c.json({ error: parsed.code, detail: parsed.detail }, parsed.code === 'unsupported_quantity' ? 422 : 400);
    }
    const request = parsed.value;

    const events = await loadLedgerEvents(c.env.DB);
    const state = reduceLedger(events);
    const orderId = await deriveOrderId(request);

    // Idempotent replay: the order already exists, so return the ORIGINAL
    // handle rather than opening a second Checkout Session. The provider ref
    // lives on the order; the URL is not reducer state, so it is read back from
    // the originating event's payload.
    const existingOrder = state.orders.get(orderId);
    if (existingOrder) {
      const origin = events.find((e) => e.kind === 'order.created' && (e.payload as { orderId?: unknown }).orderId === orderId);
      const url = origin ? (origin.payload as { checkoutUrl?: unknown }).checkoutUrl : undefined;
      return c.json(
        { orderId, providerSessionId: existingOrder.providerRef, url: typeof url === 'string' ? url : null, replayed: true },
        200,
      );
    }

    const offer = state.offers.get(request.offerId);
    if (!offer) return c.json({ error: 'unknown_offer', detail: `offer ${request.offerId} is not defined in the ledger` }, 404);
    if (!offer.active) return c.json({ error: 'inactive_offer', detail: `offer ${request.offerId} is inactive` }, 422);
    const product = state.products.get(offer.productId);
    if (!product) return c.json({ error: 'unknown_product', detail: `product ${offer.productId} is not defined in the ledger` }, 404);

    const now = Date.now();
    const order: Order = {
      orderId,
      offerId: offer.offerId,
      productId: offer.productId,
      buyerId: request.buyerOrgId,
      amount: offer.price,
      state: 'pending',
      provider: STRIPE_PROVIDER,
      providerRef: null,
      refundedMinor: 0,
      createdAtMs: now,
      updatedAtMs: now,
    };

    const built = buildStripeCheckoutSessionParams({
      order,
      offer,
      product,
      successUrl: request.successUrl,
      cancelUrl: request.cancelUrl,
    });
    if (!built.ok) {
      return c.json({ error: BUILD_REFUSAL_CODES[built.code] ?? 'invalid_request', detail: built.detail }, 422);
    }

    const session = await createStripeCheckoutSession({
      secretKey,
      params: built.params,
      fetchImpl,
      // Stripe's own idempotency covers the window our ledger cannot: between
      // the provider call and the append below. Scoped to the derived order id
      // so it is per-order, not per-client-string.
      idempotencyKey: orderId,
    });
    if (!session.ok) {
      return c.json({ error: 'provider_error', detail: session.detail }, 502);
    }

    // Recorded only AFTER the provider confirmed — a ledger order.created whose
    // session does not exist would be an order nothing can ever pay.
    const event: LedgerEvent = {
      ledgerEventId: `evt:order-created:${orderId}`,
      kind: 'order.created',
      occurredAtMs: now,
      source: { provider: STRIPE_PROVIDER, providerEventId: null },
      payload: {
        orderId,
        offerId: offer.offerId,
        buyerId: request.buyerOrgId,
        amount: offer.price,
        providerRef: session.sessionId,
        checkoutUrl: session.url,
      },
    };
    await appendLedgerEvents(c.env.DB, [event]);
    await projectLedger(c.env.DB);

    return c.json({ orderId, providerSessionId: session.sessionId, url: session.url }, 201);
  });

  route.post('/commerce/webhooks/:provider', async (c) => {
    const provider = c.req.param('provider');
    const resolved = resolveAdapter(provider, c.env);
    if ('error' in resolved) {
      return resolved.error === 'unknown'
        ? c.json({ error: 'unknown_provider', provider }, 404)
        : c.json({ error: 'provider_not_configured', provider }, 503);
    }

    // The signature covers the EXACT bytes sent — read the raw body, never a
    // re-serialized JSON round-trip, which would change them and never verify.
    const rawBody = await c.req.text();
    const headers: Record<string, string> = {};
    c.req.raw.headers.forEach((value, key) => {
      headers[key] = value;
    });

    const store = d1WebhookInboxStore(c.env.DB);
    const result = await ingestWebhook({
      adapter: resolved.adapter,
      store,
      request: { rawBody, headers, nowMs: Date.now() },
    });

    if (result.outcome === 'rejected') {
      const status = SIGNATURE_REFUSALS.has(result.code) ? 401 : 400;
      return c.json({ error: result.code, detail: result.detail, provider_event_id: result.providerEventId }, status);
    }
    if (result.outcome === 'duplicate') {
      return c.json({ outcome: 'duplicate', provider_event_id: result.providerEventId }, 200);
    }
    if (result.outcome === 'ignored') {
      return c.json({ outcome: 'ignored', provider_event_id: result.providerEventId }, 202);
    }

    await appendLedgerEvents(c.env.DB, result.events);
    await projectLedger(c.env.DB);
    return c.json(
      {
        outcome: 'accepted',
        provider_event_id: result.providerEventId,
        ledger_event_ids: result.events.map((e) => e.ledgerEventId),
      },
      200,
    );
  });

  route.get('/commerce/entitlements', async (c) => {
    const buyer = c.req.query('buyer');
    if (!buyer) return c.json({ error: 'buyer_required' }, 400);
    const entitlements = await listActiveEntitlements(c.env.DB, buyer);
    return c.json({ buyer, entitlements });
  });

  return route;
}
