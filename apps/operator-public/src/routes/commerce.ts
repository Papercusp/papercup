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
import { createStripeAdapter, STRIPE_PROVIDER } from '@papercusp/operator-core/lib/cupboard/payment-adapters/stripe';
import { appendLedgerEvents, d1WebhookInboxStore, listActiveEntitlements, projectLedger } from '../commerce-store.ts';

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

export function commerceRoute(): Hono<{ Bindings: Env }> {
  const route = new Hono<{ Bindings: Env }>();

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
