import { describe, expect, it, vi } from 'vitest';
import { createStripeBillingClient, stripeKeyMode, type StripePaymentLineagePin } from './stripe-billing-client';

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
    if (result.ok) {
      expect(Object.isFrozen(result.evidence.transactions)).toBe(true);
      expect(Object.isFrozen(result.evidence.transactions[0].source)).toBe(true);
      expect(result.evidence.transactions[0].status).toBe('available');
    }
    const queries = r.fetchImpl.mock.calls.slice(1).map(call => new URL(String(call[0])).searchParams);
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

describe('authenticated original payment and reversal lineage', () => {
  const pin: StripePaymentLineagePin = { accountId: 'acct_A', customerId: 'cus_A', organizationId: ORG,
    chargeId: 'ch_A', chargeBalanceTransactionId: 'txn_Charge', source: { kind: 'refund', id: 're_A' } };
  const charge = { object: 'charge', id: 'ch_A', customer: 'cus_A', livemode: true, currency: 'usd',
    status: 'succeeded', paid: true, captured: true, amount: 100, amount_captured: 100, amount_refunded: 40,
    balance_transaction: 'txn_Charge', receipt_email: 'private@example.com', metadata: { secret: 'private' } };
  const refund = { object: 'refund', id: 're_A', charge: 'ch_A', amount: 40, currency: 'usd',
    status: 'succeeded', balance_transaction: 'txn_Refund', failure_balance_transaction: null,
    destination_details: { private: 'private' } };
  const dispute = { object: 'dispute', id: 'du_A', charge: 'ch_A', amount: 100, currency: 'usd', livemode: true,
    status: 'won', balance_transactions: [{ id: 'txn_Dispute' }, { id: 'txn_Reinstated' }], evidence: { private: 'private' } };
  const bt = (id: string, source: string, type: string, amount: number, fee = 0) => ({
    object: 'balance_transaction', id, source, type, amount, fee, net: amount - fee,
    currency: 'usd', created: 1, available_on: 2, status: 'available', description: 'private',
  });
  function reader(overrides: Record<string, unknown> = {}, responseOptions: { status?: number; requestId?: string | null } = {}) {
    const responses: Record<string, unknown> = {
      '/account': { object: 'account', id: 'acct_A' },
      '/customers/cus_A': { object: 'customer', id: 'cus_A', livemode: true, metadata: { organizationId: ORG } },
      '/charges/ch_A': charge, '/refunds/re_A': refund, '/disputes/du_A': dispute,
      '/balance_transactions/txn_Charge': bt('txn_Charge', 'ch_A', 'charge', 100, 3),
      '/balance_transactions/txn_Refund': bt('txn_Refund', 're_A', 'refund', -40),
      '/balance_transactions/txn_Failure': bt('txn_Failure', 're_A', 'refund_failure', 40),
      '/balance_transactions/txn_Dispute': bt('txn_Dispute', 'du_A', 'adjustment', -100, 15),
      '/balance_transactions/txn_Reinstated': bt('txn_Reinstated', 'du_A', 'adjustment', 100), ...overrides,
    };
    const fetchImpl = vi.fn(async (url: string | URL, _init?: RequestInit) => {
      const body = responses[new URL(String(url)).pathname.slice('/v1'.length)];
      return new Response(JSON.stringify(body ?? { error: 'private sk_live_key' }), {
        status: responseOptions.status ?? (body ? 200 : 404),
        headers: responseOptions.requestId === null ? {} : { 'request-id': responseOptions.requestId ?? 'req_Lineage' },
      });
    });
    const options = { secretKey: 'sk_live_key', fetchImpl: fetchImpl as typeof fetch, liveModeAllowed: true };
    const built = createStripeBillingClient(options);
    if (!built.ok) throw new Error('reader');
    return { client: built.client, fetchImpl, options };
  }
  const disputePin: StripePaymentLineagePin = { ...pin, source: { kind: 'dispute', id: 'du_A' } };

  it('retrieves the original receipt pins and refund debit without leaking private provider fields', async () => {
    const r = reader(); const result = await r.client.readPaymentLineage(pin);
    expect(result).toMatchObject({ ok: true, evidence: { accountId: 'acct_A', customerId: 'cus_A', organizationId: ORG,
      livemode: true, charge: { id: 'ch_A', capturedUsdCents: 100, refundedUsdCents: 40,
        balanceTransaction: { id: 'txn_Charge', source: 'ch_A', amount: 100, fee: 3, net: 97 } },
      source: { kind: 'refund', id: 're_A', status: 'succeeded', amountUsdCents: 40,
        balanceTransactions: [{ id: 'txn_Refund', source: 're_A', amount: -40, net: -40 }] },
      evidenceRef: expect.stringMatching(/^stripe-lineage:[a-f0-9]{64}$/) } });
    expect(r.fetchImpl.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      '/v1/account', '/v1/customers/cus_A', '/v1/refunds/re_A', '/v1/charges/ch_A',
      '/v1/balance_transactions/txn_Charge', '/v1/balance_transactions/txn_Refund',
    ]);
    for (const [, init] of r.fetchImpl.mock.calls) expect(init).toEqual({ method: 'GET', redirect: 'error', headers: { authorization: 'Bearer sk_live_key' } });
    expect(JSON.stringify(result)).not.toMatch(/private|receipt_email|destination_details|sk_live/);
    if (result.ok) {
      expect(Object.isFrozen(result.evidence.charge.balanceTransaction)).toBe(true);
      expect(Object.isFrozen(result.evidence.source.balanceTransactions)).toBe(true);
      expect(result.evidence.requestIds).toHaveLength(6);
    }
  });

  it('resolves a charge directly and preserves pending availability instead of declaring cash available', async () => {
    const original = bt('txn_Charge', 'ch_A', 'charge', 100, 3);
    const result = await reader({ '/balance_transactions/txn_Charge': { ...original, status: 'pending' } }).client
      .readPaymentLineage({ ...pin, source: { kind: 'charge', id: 'ch_A' } });
    expect(result).toMatchObject({ ok: true, evidence: { source: { kind: 'charge', status: 'succeeded',
      balanceTransactions: [{ id: 'txn_Charge', status: 'pending' }] } } });
  });

  it('preserves both failed-refund debit and reinstatement instead of erasing the original movement', async () => {
    const result = await reader({ '/refunds/re_A': { ...refund, status: 'failed', failure_balance_transaction: 'txn_Failure' } })
      .client.readPaymentLineage(pin);
    expect(result).toMatchObject({ ok: true, evidence: { source: { status: 'failed', balanceTransactions: [
      { id: 'txn_Refund', amount: -40 }, { id: 'txn_Failure', amount: 40 },
    ] } } });
  });

  it.each(['pending', 'requires_action', 'failed', 'canceled'])('keeps an unposted %s refund explicit', async status => {
    const result = await reader({ '/refunds/re_A': { ...refund, status, balance_transaction: null } }).client.readPaymentLineage(pin);
    expect(result).toMatchObject({ ok: true, evidence: { source: { status, amountUsdCents: 40, balanceTransactions: [] } } });
  });

  it('binds a won dispute to its original charge while retaining debit, fee and reinstatement', async () => {
    const result = await reader().client.readPaymentLineage(disputePin);
    expect(result).toMatchObject({ ok: true, evidence: { source: { kind: 'dispute', status: 'won', balanceTransactions: [
      { id: 'txn_Dispute', amount: -100, fee: 15, net: -115 }, { id: 'txn_Reinstated', amount: 100, net: 100 },
    ] } } });
    expect(JSON.stringify(result)).not.toContain('private');
  });

  it.each(['warning_needs_response', 'under_review', 'won', 'lost', 'prevented'])('does not infer a posted movement from dispute status %s', async status => {
    expect(await reader({ '/disputes/du_A': { ...dispute, status, balance_transactions: [] } }).client.readPaymentLineage(disputePin))
      .toMatchObject({ ok: true, evidence: { source: { status, balanceTransactions: [] } } });
  });

  it.each([
    { '/account': { object: 'account', id: 'acct_B' } },
    { '/customers/cus_A': { object: 'customer', id: 'cus_A', livemode: true, metadata: { organizationId: 'foreign' } } },
    { '/refunds/re_A': { ...refund, charge: 'ch_B' } },
    { '/refunds/re_A': { ...refund, customer: 'cus_B' } },
    { '/charges/ch_A': { ...charge, customer: 'cus_B' } },
    { '/charges/ch_A': { ...charge, livemode: false } },
    { '/charges/ch_A': { ...charge, balance_transaction: 'txn_Other' } },
    { '/balance_transactions/txn_Charge': bt('txn_Charge', 'ch_B', 'charge', 100, 3) },
    { '/balance_transactions/txn_Refund': bt('txn_Refund', 're_B', 'refund', -40) },
  ])('refuses foreign account, org, customer, receipt or movement substitutions', async overrides => {
    expect(await reader(overrides).client.readPaymentLineage(pin)).toMatchObject({ ok: false, code: 'malformed-response' });
  });

  it.each([
    { currency: 'eur' }, { paid: false }, { captured: false }, { status: 'failed' }, { amount_captured: 0 },
    { amount_captured: 101 }, { amount_refunded: 101 }, { amount_captured: 0.5 }, { id: 'ch_B' },
  ])('refuses unsupported or unbacked original charge accounting', async change => {
    expect(await reader({ '/charges/ch_A': { ...charge, ...change } }).client.readPaymentLineage(pin))
      .toMatchObject({ ok: false, detail: 'stripe original charge pin mismatch' });
  });

  it.each([
    { '/refunds/re_A': { ...refund, status: 'unknown' } },
    { '/refunds/re_A': { ...refund, balance_transaction: null } },
    { '/refunds/re_A': { ...refund, amount: 101 } },
    { '/refunds/re_A': { ...refund, status: 'failed' } },
    { '/refunds/re_A': { ...refund, failure_balance_transaction: 'txn_Failure' } },
    { '/refunds/re_A': { ...refund, status: 'failed', failure_balance_transaction: 'txn_Refund' } },
    { '/balance_transactions/txn_Refund': bt('txn_Refund', 're_A', 'refund', -41) },
    { '/balance_transactions/txn_Refund': { ...bt('txn_Refund', 're_A', 'refund', -40), net: -39 } },
    { '/balance_transactions/txn_Charge': bt('txn_Charge', 'ch_A', 'charge', 101, 3) },
  ])('refuses incomplete, duplicate or numerically inconsistent refund movements', async overrides => {
    expect(await reader(overrides).client.readPaymentLineage(pin)).toMatchObject({ ok: false, code: 'malformed-response' });
  });

  it.each([
    { ...dispute, charge: 'ch_B' }, { ...dispute, livemode: false }, { ...dispute, status: 'unknown' },
    { ...dispute, balance_transactions: null }, { ...dispute, balance_transactions: ['txn_Dispute', 'txn_Dispute'] },
    { ...dispute, balance_transactions: ['txn_Charge'] }, { ...dispute, balance_transactions: ['txn_bad/path'] },
    { ...dispute, balance_transactions: ['txn_Dispute', 'txn_Reinstated', 'txn_Extra'] },
  ])('refuses foreign or incomplete dispute references before accepting a census', async d => {
    expect(await reader({ '/disputes/du_A': d }).client.readPaymentLineage(disputePin)).toMatchObject({ ok: false });
  });

  it('supports expanded references but retrieves accounting afresh instead of trusting embedded accounting', async () => {
    const result = await reader({ '/refunds/re_A': { ...refund, charge: { id: 'ch_A' }, balance_transaction: { id: 'txn_Refund', amount: 999 } },
      '/charges/ch_A': { ...charge, customer: { id: 'cus_A' }, balance_transaction: { id: 'txn_Charge', amount: 999 } } })
      .client.readPaymentLineage(pin);
    expect(result).toMatchObject({ ok: true, evidence: { source: { balanceTransactions: [{ amount: -40 }] } } });
  });

  it('refuses URL-shaped pins before any provider read', async () => {
    const r = reader();
    expect(await r.client.readPaymentLineage({ ...pin, source: { kind: 'refund', id: 're_A/other' } })).toMatchObject({ ok: false });
    expect(r.fetchImpl).not.toHaveBeenCalled();
  });

  it('snapshots nested reversal pins and credentials across awaits', async () => {
    const r = reader(); const input = { ...pin, source: { kind: 'refund' as const, id: 're_A' } };
    const pending = r.client.readPaymentLineage(input);
    input.chargeId = 'ch_B'; input.source.id = 're_B'; r.options.secretKey = 'sk_live_changed';
    expect(await pending).toMatchObject({ ok: true, evidence: { charge: { id: 'ch_A' }, source: { id: 're_A' } } });
    for (const [, init] of r.fetchImpl.mock.calls) expect(init?.headers).toEqual({ authorization: 'Bearer sk_live_key' });
  });

  it('discards partial provenance on a later failure and sanitizes errors/missing request IDs', async () => {
    const r = reader({ '/balance_transactions/txn_Refund': null });
    const failed = await r.client.readPaymentLineage(pin);
    expect(failed).toMatchObject({ ok: false, code: 'provider-error', status: 404 });
    expect(failed).not.toHaveProperty('evidence');
    expect(JSON.stringify(failed)).not.toMatch(/private|sk_live/);
    expect(await reader({}, { requestId: null }).client.readPaymentLineage(pin)).toMatchObject({ ok: false, code: 'malformed-response' });
  });
});
