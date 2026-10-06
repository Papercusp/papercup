import { describe, expect, it, vi } from 'vitest';
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
    const refused = createStripeBillingClient({ secretKey: 'sk_live_x', fetchImpl: impl, liveModeAllowed: false });
    expect(refused).toEqual({
      ok: false,
      code: 'live_mode_not_allowed',
      // WI-10005197: the refusal says what compared, what lifts it, and who can make that true.
      refusal: {
        observed: { keyMode: 'live', liveModeAllowed: 'false' },
        liftsWhen: expect.stringContaining('papercusp-hosted-billing-live-mode'),
        whoCanMakeItTrue: ['owner'],
      },
    });
    // The contract is secret-free: the key itself is never in the observed values.
    expect(JSON.stringify(refused)).not.toContain('sk_live_x');
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

  it('sends an explicit portal configuration only when one is configured', async () => {
    const { client: c, calls } = client([
      { body: { url: 'https://billing.stripe.com/p/session_2' } },
      { body: { url: 'https://billing.stripe.com/p/session_3' } },
    ]);
    await c.createPortalSession({ customerId: 'cus_1', returnUrl: 'https://app.example/billing', configurationId: 'bpc_123' });
    await c.createPortalSession({ customerId: 'cus_1', returnUrl: 'https://app.example/billing', configurationId: null });
    expect(calls[0]!.form.get('configuration')).toBe('bpc_123');
    expect(calls[1]!.form.has('configuration')).toBe(false);
  });

  it('a response without the expected id is malformed, not success', async () => {
    const { client: c } = client([{ body: { object: 'customer' } }]);
    expect(await c.createCustomer({ organizationId: ORG })).toMatchObject({ ok: false, code: 'malformed-response' });
  });
});

describe('authenticated account cash evidence', () => {
  const pin = { accountId: 'acct_A', customerId: 'cus_A', organizationId: ORG };
  const account = { object: 'account', id: 'acct_A' };
  const customer = { object: 'customer', id: 'cus_A', livemode: true, metadata: { organizationId: ORG } };
  const balance = { object: 'balance', livemode: true,
    available: [{ currency: 'usd', amount: 50 }], pending: [{ currency: 'usd', amount: 900 }] };
  function reader(bodies: unknown[] = [account, customer, balance], headers = true, status = 200) {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(bodies.shift()), {
      status, headers: headers ? { 'request-id': 'req_Proof' } : {},
    })) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
    const options = { secretKey: 'sk_live_key', fetchImpl, liveModeAllowed: true };
    const result = createStripeBillingClient(options);
    if (!result.ok) throw new Error('reader');
    return { client: result.client, fetchImpl, options };
  }

  it('pins credential account and org customer, preserving available and pending cash separately', async () => {
    const r = reader();
    const result = await r.client.readAccountCash(pin);
    expect(result).toMatchObject({ ok: true, evidence: { ...pin, livemode: true,
      availableUsdCents: 50, pendingUsdCents: 900, requestIds: ['req_Proof', 'req_Proof', 'req_Proof'],
      evidenceRef: expect.stringMatching(/^stripe-cash:[a-f0-9]{64}$/) } });
    expect(r.fetchImpl.mock.calls.map((c: unknown[]) => c[0])).toEqual([
      'https://api.stripe.com/v1/account', 'https://api.stripe.com/v1/customers/cus_A', 'https://api.stripe.com/v1/balance',
    ]);
    for (const [, init] of r.fetchImpl.mock.calls) expect(init).toEqual({ method: 'GET', redirect: 'error', headers: { authorization: 'Bearer sk_live_key' } });
    if (result.ok) { expect(Object.isFrozen(result.evidence)).toBe(true); expect(Object.isFrozen(result.evidence.requestIds)).toBe(true); }
    expect(JSON.stringify(result)).not.toContain('sk_live_key');
  });

  it('refuses a foreign credential account before reading customer or balance', async () => {
    const r = reader([{ ...account, id: 'acct_B' }]);
    expect(await r.client.readAccountCash(pin)).toMatchObject({ ok: false, detail: 'stripe account pin mismatch' });
    expect(r.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    { ...customer, id: 'cus_B' }, { ...customer, livemode: false }, { ...customer, deleted: true },
    { ...customer, metadata: { organizationId: 'other' } }, { ...customer, metadata: null },
  ])('refuses unbound, test, deleted or foreign-org customers', async c => {
    const r = reader([account, c]);
    expect(await r.client.readAccountCash(pin)).toMatchObject({ ok: false, detail: 'stripe customer pin mismatch' });
    expect(r.fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each([
    { ...balance, livemode: false }, { ...balance, available: null }, { ...balance, pending: null },
    { ...balance, available: [{ currency: 'usd', amount: '50' }] },
    { ...balance, available: [{ currency: 'usd', amount: 0.1 }] },
    { ...balance, available: [{ currency: 'usd', amount: Number.MAX_SAFE_INTEGER + 1 }] },
    { ...balance, available: [{ currency: 'usd', amount: 1 }, { currency: 'usd', amount: 2 }] },
    { ...balance, available: [{ currency: 'usd', amount: 1 }, { currency: 'eur', amount: 'unknown' }] },
  ])('refuses malformed or wrong-mode balance populations', async b => {
    expect(await reader([account, customer, b]).client.readAccountCash(pin)).toMatchObject({ ok: false, detail: 'unverified stripe cash balance' });
  });

  it('keeps negative available cash and ignores foreign currency as USD backing', async () => {
    const b = { ...balance, available: [{ currency: 'usd', amount: -5 }, { currency: 'eur', amount: 1000 }] };
    expect(await reader([account, customer, b]).client.readAccountCash(pin))
      .toMatchObject({ ok: true, evidence: { availableUsdCents: -5, pendingUsdCents: 900 } });
    expect(await reader([account, customer, { ...balance, available: [] }]).client.readAccountCash(pin))
      .toMatchObject({ ok: true, evidence: { availableUsdCents: 0 } });
  });

  it('refuses missing request provenance and sanitizes failed provider reads', async () => {
    expect(await reader([account], false).client.readAccountCash(pin)).toMatchObject({ ok: false, code: 'malformed-response' });
    const result = await reader([{ error: { message: 'sk_live_key private payload' } }], true, 401).client.readAccountCash(pin);
    expect(result).toMatchObject({ ok: false, code: 'provider-error', status: 401 });
    expect(JSON.stringify(result)).not.toContain('sk_live_key');
  });

  it('pins composition credentials and request scope before asynchronous provider reads', async () => {
    const r = reader();
    const input = { ...pin };
    const pending = r.client.readAccountCash(input);
    input.customerId = 'cus_B'; input.organizationId = 'other';
    r.options.secretKey = 'sk_live_changed';
    const result = await pending;
    expect(result).toMatchObject({ ok: true, evidence: pin });
    expect(r.fetchImpl.mock.calls[1][0]).toBe('https://api.stripe.com/v1/customers/cus_A');
    for (const [, init] of r.fetchImpl.mock.calls) expect(init.headers.authorization).toBe('Bearer sk_live_key');
  });

  const transaction = (id = 'txn_A', overrides: Record<string, unknown> = {}) => ({
    object: 'balance_transaction', id, type: 'charge', amount: 100, fee: 3, net: 97,
    currency: 'usd', created: 1, available_on: 2, status: 'available',
    source: { id: 'ch_A', object: 'charge', customer: 'cus_A', metadata: { purpose: 'prepaid-credits' } }, ...overrides,
  });
  const page = (data: unknown[], has_more = false) => ({ object: 'list', data, has_more });

  it('reads every page across all customers/types/currencies, preserving unknown obligations and provenance', async () => {
    const first = transaction(); const second = transaction('txn_B', { type: 'new_provider_obligation', currency: 'eur' });
    const r = reader([account, page([first], true), page([second])]);
    const result = await r.client.readAccountTransactions({ accountId: 'acct_A' });
    expect(result).toMatchObject({ ok: true, evidence: { accountId: 'acct_A', transactions: [first, second],
      requestIds: ['req_Proof', 'req_Proof', 'req_Proof'], evidenceRef: expect.stringMatching(/^stripe-census:[a-f0-9]{64}$/) } });
    const queries = r.fetchImpl.mock.calls.slice(1).map(([url]: [string]) => new URL(url).searchParams);
    expect(queries[0].get('starting_after')).toBeNull();
    expect(queries[1].get('starting_after')).toBe('txn_A');
    for (const q of queries) {
      expect([...q.keys()]).toEqual(expect.arrayContaining(['limit', 'expand[]']));
      expect(q.getAll('expand[]')).toEqual(['data.source', 'data.source.invoice']);
      for (const filter of ['customer', 'source', 'currency', 'type', 'created[gte]']) expect(q.has(filter)).toBe(false);
    }
  });

  it('accepts an explicitly empty complete account but refuses an empty nonterminal page', async () => {
    expect(await reader([account, page([])]).client.readAccountTransactions({ accountId: 'acct_A' }))
      .toMatchObject({ ok: true, evidence: { transactions: [] } });
    expect(await reader([account, page([], true)]).client.readAccountTransactions({ accountId: 'acct_A' }))
      .toMatchObject({ ok: false, detail: 'incomplete stripe transaction page' });
  });

  it('refuses a repeated cursor/transaction and discards a truncated census', async () => {
    expect(await reader([account, page([transaction()], true), page([transaction()])])
      .client.readAccountTransactions({ accountId: 'acct_A' })).toMatchObject({ ok: false, detail: 'invalid or duplicate stripe transaction' });
    expect(await reader([account, page([transaction()], true)]).client.readAccountTransactions({ accountId: 'acct_A', maxPages: 1 }))
      .toMatchObject({ ok: false, detail: 'stripe transaction census exceeds page budget' });
  });

  it.each([
    { id: 'txn_bad/path' }, { net: 98 }, { amount: '100' }, { fee: -1 }, { status: 'unknown' },
    { currency: 'USD' }, { created: -1 }, { available_on: null }, { object: 'charge' },
  ])('rejects malformed transaction accounting or availability', async change => {
    expect(await reader([account, page([transaction('txn_A', change)])]).client.readAccountTransactions({ accountId: 'acct_A' }))
      .toMatchObject({ ok: false, detail: 'invalid or duplicate stripe transaction' });
  });

  it('does not return partial evidence when a later page fails', async () => {
    const r = reader([account, page([transaction()], true)]);
    expect(await r.client.readAccountTransactions({ accountId: 'acct_A' })).toMatchObject({ ok: false });
  });
});
