import { describe, expect, it } from 'vitest';
import { createStripeBillingClient, stripeKeyMode } from './stripe-billing-client';

interface Call { url: string; headers: Record<string, string>; form: URLSearchParams }

function fakeFetch(responses: Array<{ status?: number; body: unknown }>) {
  const calls: Call[] = [];
  const impl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), headers: init?.headers as Record<string, string>, form: new URLSearchParams(String(init?.body)) });
    const next = responses.shift() ?? { status: 500, body: {} };
    return new Response(JSON.stringify(next.body), { status: next.status ?? 200 });
  }) as typeof fetch;
  return { impl, calls };
}

const ORG = '11111111-2222-4333-8444-555555555555';

describe('stripeKeyMode / live-mode gate', () => {
  it('classifies keys without echoing them', () => {
    expect(stripeKeyMode('sk_test_abc')).toBe('test');
    expect(stripeKeyMode('rk_live_abc')).toBe('live');
    expect(stripeKeyMode('pk_test_abc')).toBeNull();
  });

  it('refuses a live key unless the owner-authority flag is on; test keys always construct', () => {
    const { impl } = fakeFetch([]);
    expect(createStripeBillingClient({ secretKey: 'sk_live_x', fetchImpl: impl, liveModeAllowed: false })).toEqual({ ok: false, code: 'live_mode_not_allowed' });
    const live = createStripeBillingClient({ secretKey: 'sk_live_x', fetchImpl: impl, liveModeAllowed: true });
    expect(live.ok && live.client.livemode).toBe(true);
    const test = createStripeBillingClient({ secretKey: 'sk_test_x', fetchImpl: impl, liveModeAllowed: false });
    expect(test.ok && test.client.livemode).toBe(false);
    expect(createStripeBillingClient({ secretKey: 'garbage', fetchImpl: impl, liveModeAllowed: true })).toEqual({ ok: false, code: 'invalid_secret_key' });
  });
});

describe('requests', () => {
  function client(responses: Array<{ status?: number; body: unknown }>) {
    const fake = fakeFetch(responses);
    const built = createStripeBillingClient({ secretKey: 'sk_test_key', fetchImpl: fake.impl, liveModeAllowed: false });
    if (!built.ok) throw new Error('client');
    return { client: built.client, calls: fake.calls };
  }

  it('creates one customer per org with an org-scoped idempotency key', async () => {
    const { client: c, calls } = client([{ body: { id: 'cus_123' } }]);
    expect(await c.createCustomer({ organizationId: ORG, email: 'a@example.com' })).toEqual({ ok: true, customerId: 'cus_123' });
    expect(calls[0]!.url).toBe('https://api.stripe.com/v1/customers');
    expect(calls[0]!.headers['idempotency-key']).toBe(`papercusp-org-customer:${ORG}`);
    expect(calls[0]!.form.get('metadata[organizationId]')).toBe(ORG);
    expect(calls[0]!.form.has('name')).toBe(false);
  });

  it('starts a subscription Checkout carrying the org on the session AND the subscription', async () => {
    const { client: c, calls } = client([{ body: { id: 'cs_1', url: 'https://checkout.stripe.com/c/cs_1' } }]);
    const result = await c.createSubscriptionCheckout({
      customerId: 'cus_1', organizationId: ORG, priceId: 'price_team',
      successUrl: 'https://app.example/billing?checkout=success', cancelUrl: 'https://app.example/billing?checkout=canceled',
      idempotencyKey: 'k1',
    });
    expect(result).toEqual({ ok: true, sessionId: 'cs_1', url: 'https://checkout.stripe.com/c/cs_1' });
    const form = calls[0]!.form;
    expect(form.get('mode')).toBe('subscription');
    expect(form.get('customer')).toBe('cus_1');
    expect(form.get('line_items[0][price]')).toBe('price_team');
    expect(form.get('subscription_data[metadata][organizationId]')).toBe(ORG);
    expect(form.get('client_reference_id')).toBe(ORG);
    expect(calls[0]!.headers['idempotency-key']).toBe('k1');
  });

  it('opens a customer-portal session and surfaces provider errors without echoing the body', async () => {
    const { client: c, calls } = client([
      { body: { url: 'https://billing.stripe.com/p/session_1' } },
      { status: 400, body: { error: { message: 'No such customer' } } },
    ]);
    expect(await c.createPortalSession({ customerId: 'cus_1', returnUrl: 'https://app.example/billing' })).toEqual({ ok: true, url: 'https://billing.stripe.com/p/session_1' });
    expect(calls[0]!.url).toBe('https://api.stripe.com/v1/billing_portal/sessions');
    expect(await c.createPortalSession({ customerId: 'cus_x', returnUrl: 'https://app.example/billing' })).toEqual({ ok: false, code: 'provider-error', status: 400, detail: 'No such customer' });
  });

  it('a response without the expected id is malformed, not success', async () => {
    const { client: c } = client([{ body: { object: 'customer' } }]);
    expect(await c.createCustomer({ organizationId: ORG })).toMatchObject({ ok: false, code: 'malformed-response' });
  });
});
