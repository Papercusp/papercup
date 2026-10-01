/**
 * Hosted subscription billing — routes driven through the real runtime
 * composition (`createHostedBillingRuntime`), with every external collaborator
 * faked at its seam: the principal resolver, secret resolution, the billing
 * store, and Stripe's HTTP API (`fetchImpl`). Webhook deliveries are signed with
 * `computeStripeSignature`, the adapter's own primitive, whose correctness is
 * pinned independently against a known vector in `cupboard/payment-adapters/stripe.test.ts`.
 *
 * Store semantics (order independence, idempotency, atomicity) are proven
 * against real Postgres in `billing-store.integration.test.ts`; the in-memory
 * store here only has to be honest about the contract the routes rely on.
 *
 * stripe-subscription-signup-2026-10-01 P-005.
 */
import { describe, expect, it, vi } from 'vitest';
import { createHostedPrincipal, type HostedPermission } from '../auth/hosted-principal';
import type { HostedPrincipalResolution, HostedPrincipalResolver } from '../auth/hosted-principal-resolver';
import type {
  HostedBillingApplyOutcome,
  HostedBillingCustomer,
  HostedBillingStore,
} from '../auth/hosted/billing/billing-store';
import type { HostedSubscriptionSnapshot } from '../auth/hosted/billing/entitlement-seam';
import type { HostedBillingEvent } from '../auth/hosted/billing/stripe-billing-events';
import { computeStripeSignature } from '../cupboard/payment-adapters/stripe';
import { webhookBodyDigest } from '../cupboard/webhook-inbox';
import {
  HOSTED_BILLING_RUNTIME_MOUNTED_ROUTE_KEYS,
  createHostedBillingRuntime,
  parseHostedBillingPlans,
  parseStripePortalConfigurationId,
  readHostedBillingRuntimeConfiguration,
  type HostedBillingRuntimeConfiguration,
  type HostedBillingRuntimeDependencies,
} from './hosted-billing-runtime';

const ORG = '11111111-2222-4333-8444-555555555555';
const ORIGIN = 'https://app.example';
const WEBHOOK_SECRET = 'whsec_testsecret123';
const NOW = new Date('2026-10-01T12:00:00.000Z');

// ── fakes ───────────────────────────────────────────────────────────────────

class MemoryBillingStore implements HostedBillingStore {
  customers = new Map<string, HostedBillingCustomer>();
  subscription: HostedSubscriptionSnapshot | null = null;
  events = new Map<string, string>();
  applied: Array<{ event: HostedBillingEvent; expectedLivemode: boolean; planKey: string | null }> = [];
  rejected: Array<{ eventId: string; code: string }> = [];
  failReads = false;

  async customerFor(organizationId: string) {
    if (this.failReads) throw new Error('store down');
    return this.customers.get(organizationId) ?? null;
  }

  async recordCustomer(customer: HostedBillingCustomer) {
    const existing = this.customers.get(customer.organizationId);
    if (existing) return existing;
    this.customers.set(customer.organizationId, customer);
    return customer;
  }

  async currentSubscription(_organizationId: string, planKeyForPrice: (priceId: string | null) => string | null) {
    if (this.failReads) throw new Error('store down');
    return this.subscription && { ...this.subscription, planKey: planKeyForPrice(this.subscription.priceId) };
  }

  async applyEvent(input: Parameters<HostedBillingStore['applyEvent']>[0]): Promise<HostedBillingApplyOutcome> {
    const prior = this.events.get(input.event.eventId);
    if (prior !== undefined) {
      return prior === input.bodyDigest ? { outcome: 'duplicate', organizationId: ORG } : { outcome: 'replay-mismatch' };
    }
    this.events.set(input.event.eventId, input.bodyDigest);
    const first = input.event.facts[0];
    this.applied.push({
      event: input.event,
      expectedLivemode: input.expectedLivemode,
      planKey: first && first.kind === 'subscription' ? input.planKeyForPrice(first.priceId) : null,
    });
    return { outcome: 'applied', organizationId: ORG };
  }

  async recordRejectedEvent(input: Parameters<HostedBillingStore['recordRejectedEvent']>[0]) {
    const prior = this.events.get(input.eventId);
    if (prior !== undefined) return prior === input.bodyDigest ? 'duplicate' : 'replay-mismatch';
    this.events.set(input.eventId, input.bodyDigest);
    this.rejected.push({ eventId: input.eventId, code: input.code });
    return 'recorded';
  }
}

interface StripeCall { url: string; headers: Record<string, string>; form: URLSearchParams }

function fakeStripe(responses: Array<{ status?: number; body: unknown }> = []) {
  const calls: StripeCall[] = [];
  const impl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), headers: init?.headers as Record<string, string>, form: new URLSearchParams(String(init?.body)) });
    const next = responses.shift() ?? { status: 500, body: { error: { message: 'unexpected call' } } };
    return new Response(JSON.stringify(next.body), { status: next.status ?? 200 });
  }) as typeof fetch;
  return { impl, calls };
}

function principalFor(permissions: HostedPermission[]): HostedPrincipalResolution {
  return {
    ok: true,
    principal: createHostedPrincipal({
      workspaceId: 'control-plane',
      userId: 'user-1',
      activeOrganizationId: ORG,
      sessionId: 'sess-1',
      sessionVersion: 1,
      permissions,
    }),
    session: {} as never,
    membership: {} as never,
  };
}

/** Cookie value → resolution: `owner` manages billing, `member` only views, `revoked` lost membership. */
const resolvePrincipal: HostedPrincipalResolver = async (headers) => {
  const cookie = headers.get('cookie') ?? '';
  if (cookie.includes('session=owner')) return principalFor(['workspace:view', 'billing:manage']);
  if (cookie.includes('session=member')) return principalFor(['workspace:view']);
  if (cookie.includes('session=revoked')) return { ok: false, reason: 'membership_not_active' };
  if (cookie.includes('session=outage')) return { ok: false, reason: 'authority_unavailable' };
  return { ok: false, reason: 'session_cookie_missing' };
};

const SECRETS: Record<string, string> = {
  'env:STRIPE_TEST_KEY': 'sk_test_key123',
  'env:STRIPE_LIVE_KEY': 'sk_live_key123',
  'env:STRIPE_WEBHOOK': WEBHOOK_SECRET,
  'env:NOT_A_WHSEC': 'not-a-webhook-secret',
};

const CONFIG: HostedBillingRuntimeConfiguration = {
  publicOrigin: ORIGIN,
  stripeSecretKeyRef: 'env:STRIPE_TEST_KEY',
  stripeWebhookSecretRef: 'env:STRIPE_WEBHOOK',
  plans: [{ planKey: 'team', priceId: 'price_team', label: 'Team', description: 'For teams' }],
  stripePortalConfigurationId: 'bpc_123',
};

async function runtime(options: {
  config?: Partial<HostedBillingRuntimeConfiguration>;
  deps?: Partial<HostedBillingRuntimeDependencies>;
  stripe?: Array<{ status?: number; body: unknown }>;
} = {}) {
  const store = new MemoryBillingStore();
  const stripe = fakeStripe(options.stripe);
  const built = await createHostedBillingRuntime(
    { ...CONFIG, ...options.config },
    {
      resolvePrincipal,
      resolveSecret: async (ref) => {
        const value = SECRETS[ref];
        if (value === undefined) throw new Error(`unknown ref ${ref}`);
        return value;
      },
      store,
      fetchImpl: stripe.impl,
      clock: () => NOW,
      ...options.deps,
    },
  );
  return { ...built, store, stripe };
}

const post = (init: { cookie?: string; origin?: string | null; body?: unknown } = {}) => {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (init.cookie) headers.set('cookie', `session=${init.cookie}`);
  if (init.origin !== null) headers.set('origin', init.origin ?? ORIGIN);
  return { method: 'POST', headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) };
};

const get = (cookie?: string): RequestInit => ({ headers: cookie ? { cookie: `session=${cookie}` } : {} });

function signedWebhook(rawBody: string, secret = WEBHOOK_SECRET, at = NOW) {
  const t = Math.floor(at.getTime() / 1000);
  return {
    method: 'POST',
    headers: { 'stripe-signature': `t=${t},v1=${computeStripeSignature(secret, t, rawBody)}`, 'content-type': 'application/json' },
    body: rawBody,
  };
}

const subscriptionEvent = (id = 'evt_1', status = 'active', extra: Record<string, unknown> = {}) => JSON.stringify({
  id,
  type: 'customer.subscription.updated',
  created: 1_790_000_000,
  livemode: false,
  data: {
    object: {
      id: 'sub_A',
      customer: 'cus_A',
      status,
      cancel_at_period_end: false,
      canceled_at: null,
      metadata: { organizationId: ORG },
      items: { data: [{ price: { id: 'price_team' }, current_period_end: 1_792_000_000 }] },
    },
  },
  ...extra,
});

const activeSnapshot = (status: HostedSubscriptionSnapshot['status'] = 'active'): HostedSubscriptionSnapshot => ({
  organizationId: ORG,
  stripeSubscriptionId: 'sub_A',
  status,
  planKey: null,
  priceId: 'price_team',
  currentPeriodEnd: new Date('2026-11-01T00:00:00.000Z'),
  cancelAtPeriodEnd: false,
  canceledAt: null,
  livemode: false,
  latestInvoiceStatus: 'paid',
});

// ── configuration ───────────────────────────────────────────────────────────

describe('hosted billing configuration parsing', () => {
  it('accepts an absent or valid portal configuration id and refuses a malformed one', () => {
    expect(parseStripePortalConfigurationId(undefined)).toBeNull();
    expect(parseStripePortalConfigurationId('   ')).toBeNull();
    expect(parseStripePortalConfigurationId(' bpc_1ULZRf ')).toBe('bpc_1ULZRf');
    expect(() => parseStripePortalConfigurationId('pc_123')).toThrow('PAPERCUSP_STRIPE_PORTAL_CONFIGURATION_ID');
    expect(() => parseStripePortalConfigurationId('bpc_1;drop')).toThrow('PAPERCUSP_STRIPE_PORTAL_CONFIGURATION_ID');
  });

  it('parses the plan list strictly: malformed JSON, bad ids and duplicate keys are configuration errors', () => {
    expect(parseHostedBillingPlans(undefined)).toEqual([]);
    expect(parseHostedBillingPlans('[{"planKey":"team","priceId":"price_1","label":" Team "}]'))
      .toEqual([{ planKey: 'team', priceId: 'price_1', label: 'Team', description: null }]);
    expect(() => parseHostedBillingPlans('{')).toThrow('PAPERCUSP_HOSTED_BILLING_PLANS');
    expect(() => parseHostedBillingPlans('{"planKey":"team"}')).toThrow('PAPERCUSP_HOSTED_BILLING_PLANS');
    expect(() => parseHostedBillingPlans('[{"planKey":"team","priceId":"prod_1","label":"T"}]')).toThrow('[0]');
    expect(() => parseHostedBillingPlans(
      '[{"planKey":"team","priceId":"price_1","label":"T"},{"planKey":"team","priceId":"price_2","label":"U"}]',
    )).toThrow('[1]');
  });

  it('reads the runtime configuration from the environment and requires the public origin', () => {
    expect(() => readHostedBillingRuntimeConfiguration({})).toThrow('PAPERCUSP_HOSTED_PUBLIC_ORIGIN');
    expect(readHostedBillingRuntimeConfiguration({
      PAPERCUSP_HOSTED_PUBLIC_ORIGIN: ORIGIN,
      PAPERCUSP_STRIPE_SECRET_KEY_REF: ' file:/run/stripe-key ',
      PAPERCUSP_HOSTED_BILLING_PLANS: '[{"planKey":"team","priceId":"price_1","label":"Team"}]',
      PAPERCUSP_STRIPE_PORTAL_CONFIGURATION_ID: 'bpc_9',
    })).toEqual({
      publicOrigin: ORIGIN,
      stripeSecretKeyRef: 'file:/run/stripe-key',
      stripeWebhookSecretRef: null,
      plans: [{ planKey: 'team', priceId: 'price_1', label: 'Team', description: null }],
      stripePortalConfigurationId: 'bpc_9',
    });
  });
});

// ── runtime composition ─────────────────────────────────────────────────────

describe('createHostedBillingRuntime', () => {
  it('mounts exactly the declared surface', async () => {
    const built = await runtime();
    expect(built.mounted.map((r) => `${r.method} ${r.path}`)).toEqual(HOSTED_BILLING_RUNTIME_MOUNTED_ROUTE_KEYS);
    expect(built.configured).toBe(true);
    expect(built.unavailableReason).toBeNull();
  });

  it.each([
    ['no secret refs', { stripeSecretKeyRef: null, stripeWebhookSecretRef: null }, 'billing_not_configured'],
    ['no plans', { plans: [] }, 'no_plans_configured'],
    ['a webhook secret that is not whsec_', { stripeWebhookSecretRef: 'env:NOT_A_WHSEC' }, 'invalid_webhook_secret'],
    ['a live key without the owner flag', { stripeSecretKeyRef: 'env:STRIPE_LIVE_KEY' }, 'live_mode_not_allowed'],
  ] as const)('stays mounted but unconfigured with %s', async (_label, config, reason) => {
    const built = await runtime({ config });
    expect(built.configured).toBe(false);
    expect(built.unavailableReason).toBe(reason);
    const plans = await (await built.app.request('/api/hosted/billing/plans')).json();
    expect(plans).toMatchObject({ ok: true, configured: false, unavailableReason: reason });
    const checkout = await built.app.request('/api/hosted/billing/checkout', post({ cookie: 'owner', body: { planKey: 'team' } }));
    expect(checkout.status).toBe(503);
    expect(await checkout.json()).toMatchObject({ error: { code: 'billing_unavailable', safeMessage: reason } });
    const webhook = await built.app.request('/api/hosted/billing/webhook', signedWebhook(subscriptionEvent()));
    expect(webhook.status).toBe(503);
  });

  it('a live key constructs only when the live-mode flag reads true, and a flag read failure refuses', async () => {
    const live = await runtime({ config: { stripeSecretKeyRef: 'env:STRIPE_LIVE_KEY' }, deps: { liveModeAllowed: async () => true } });
    expect(live.configured).toBe(true);
    expect(await (await live.app.request('/api/hosted/billing/plans')).json()).toMatchObject({ livemode: true });
    const broken = await runtime({
      config: { stripeSecretKeyRef: 'env:STRIPE_LIVE_KEY' },
      deps: { liveModeAllowed: async () => { throw new Error('flags down'); } },
    });
    expect(broken.unavailableReason).toBe('live_mode_not_allowed');
  });
});

// ── public plan list ────────────────────────────────────────────────────────

describe('GET /hosted/billing/plans', () => {
  it('is public and never exposes Stripe price ids', async () => {
    const { app } = await runtime();
    const response = await app.request('/api/hosted/billing/plans');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      ok: true,
      configured: true,
      livemode: false,
      unavailableReason: null,
      plans: [{ planKey: 'team', label: 'Team', description: 'For teams' }],
    });
    expect(JSON.stringify(body)).not.toContain('price_team');
  });
});

// ── authority ───────────────────────────────────────────────────────────────

describe('route authority', () => {
  it.each([
    [undefined, 401, 'unauthorized'],
    ['revoked', 403, 'forbidden'],
    ['outage', 503, 'authority_unavailable'],
  ] as const)('subscription with session %s → %i', async (cookie, status, code) => {
    const { app } = await runtime();
    const response = await app.request('/api/hosted/billing/subscription', get(cookie));
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ ok: false, error: { code } });
  });

  it('a member who can view but not manage billing is refused checkout and portal before any Stripe call', async () => {
    const { app, stripe } = await runtime();
    for (const path of ['/api/hosted/billing/checkout', '/api/hosted/billing/portal']) {
      const response = await app.request(path, post({ cookie: 'member', body: { planKey: 'team' } }));
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: { code: 'forbidden', message: 'permission_missing' } });
    }
    expect(stripe.calls).toHaveLength(0);
  });

  it('refuses cross-origin and origin-less mutating requests (CSRF) before any Stripe call', async () => {
    const { app, stripe } = await runtime();
    for (const origin of ['https://evil.example', null]) {
      for (const path of ['/api/hosted/billing/checkout', '/api/hosted/billing/portal']) {
        const response = await app.request(path, post({ cookie: 'owner', origin, body: { planKey: 'team' } }));
        expect(response.status).toBe(403);
        expect(await response.json()).toMatchObject({ error: { code: 'cross_origin_blocked' } });
      }
    }
    expect(stripe.calls).toHaveLength(0);
  });
});

// ── subscription read ───────────────────────────────────────────────────────

describe('GET /hosted/billing/subscription', () => {
  it('a member with no subscription sees not_subscribed and cannot manage', async () => {
    const { app } = await runtime();
    const body = await (await app.request('/api/hosted/billing/subscription', get('member'))).json();
    expect(body).toMatchObject({
      ok: true,
      configured: true,
      canManage: false,
      subscription: null,
      entitlement: { entitled: false, reason: 'not_subscribed', bundleKey: null, providerId: 'stub:plan-key-bundle' },
    });
  });

  it('reports the active subscription with its configured plan label and the stub entitlement', async () => {
    const { app, store } = await runtime();
    store.subscription = activeSnapshot();
    const body = await (await app.request('/api/hosted/billing/subscription', get('owner'))).json();
    expect(body).toMatchObject({
      canManage: true,
      subscription: {
        status: 'active',
        planKey: 'team',
        planLabel: 'Team',
        currentPeriodEnd: '2026-11-01T00:00:00.000Z',
        cancelAtPeriodEnd: false,
        latestInvoiceStatus: 'paid',
      },
      entitlement: { entitled: true, reason: 'active', bundleKey: 'hosted-paid:team', patch: null },
    });
  });

  it('asks the injected entitlement provider, never deciding policy itself', async () => {
    const entitlementFor = vi.fn(() => ({
      entitled: true, reason: 'active' as const, bundleKey: 'metered:team', patch: null, source: 'billing' as const, providerId: 'metering',
    }));
    const { app, store } = await runtime({ deps: { entitlementProvider: { id: 'metering', entitlementFor } } });
    store.subscription = activeSnapshot();
    const body = await (await app.request('/api/hosted/billing/subscription', get('owner'))).json();
    expect(body.entitlement).toMatchObject({ bundleKey: 'metered:team', providerId: 'metering' });
    expect(entitlementFor).toHaveBeenCalledWith(expect.objectContaining({ planKey: 'team' }), NOW);
  });

  it('a store outage is 503, not an empty subscription', async () => {
    const { app, store } = await runtime();
    store.failReads = true;
    const response = await app.request('/api/hosted/billing/subscription', get('owner'));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: 'billing_store_unavailable' } });
  });
});

// ── checkout ────────────────────────────────────────────────────────────────

describe('POST /hosted/billing/checkout', () => {
  it('creates the org customer once, then a subscription Checkout returning to the hosted origin', async () => {
    const { app, store, stripe } = await runtime({
      stripe: [
        { body: { id: 'cus_new' } },
        { body: { id: 'cs_1', url: 'https://checkout.stripe.com/c/cs_1' } },
        { body: { id: 'cs_2', url: 'https://checkout.stripe.com/c/cs_2' } },
      ],
    });
    const first = await app.request('/api/hosted/billing/checkout', post({ cookie: 'owner', body: { planKey: 'team' } }));
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true, url: 'https://checkout.stripe.com/c/cs_1' });
    expect(store.customers.get(ORG)).toEqual({ organizationId: ORG, stripeCustomerId: 'cus_new', livemode: false });

    expect(stripe.calls.map((c) => new URL(c.url).pathname)).toEqual(['/v1/customers', '/v1/checkout/sessions']);
    const session = stripe.calls[1]!;
    expect(session.form.get('customer')).toBe('cus_new');
    expect(session.form.get('line_items[0][price]')).toBe('price_team');
    expect(session.form.get('success_url')).toBe(`${ORIGIN}/billing?checkout=success&session_id={CHECKOUT_SESSION_ID}`);
    expect(session.form.get('cancel_url')).toBe(`${ORIGIN}/billing?checkout=canceled`);
    const window = Math.floor(NOW.getTime() / 600_000);
    expect(session.headers['idempotency-key']).toBe(`papercusp-sub-checkout:${ORG}:team:${window}`);

    // A second attempt reuses the recorded customer — no second /customers call.
    await app.request('/api/hosted/billing/checkout', post({ cookie: 'owner', body: { planKey: 'team' } }));
    expect(stripe.calls.map((c) => new URL(c.url).pathname)).toEqual(['/v1/customers', '/v1/checkout/sessions', '/v1/checkout/sessions']);
  });

  it('refuses an unknown plan key without calling Stripe', async () => {
    const { app, stripe } = await runtime();
    for (const body of [{ planKey: 'enterprise' }, { planKey: 7 }, {}]) {
      const response = await app.request('/api/hosted/billing/checkout', post({ cookie: 'owner', body }));
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: 'unknown_plan' } });
    }
    expect(stripe.calls).toHaveLength(0);
  });

  it.each(['trialing', 'active', 'past_due', 'unpaid', 'paused'] as const)(
    'refuses a second subscription while one is %s',
    async (status) => {
      const { app, store, stripe } = await runtime();
      store.subscription = activeSnapshot(status);
      const response = await app.request('/api/hosted/billing/checkout', post({ cookie: 'owner', body: { planKey: 'team' } }));
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: { code: 'already_subscribed' } });
      expect(stripe.calls).toHaveLength(0);
    },
  );

  it('allows a fresh subscription after the previous one was canceled', async () => {
    const { app, store } = await runtime({ stripe: [{ body: { id: 'cus_1' } }, { body: { id: 'cs_1', url: 'https://checkout.stripe.com/c/cs_1' } }] });
    store.subscription = activeSnapshot('canceled');
    const response = await app.request('/api/hosted/billing/checkout', post({ cookie: 'owner', body: { planKey: 'team' } }));
    expect(response.status).toBe(200);
  });

  it('refuses a customer recorded in the other Stripe mode', async () => {
    const { app, store, stripe } = await runtime();
    store.customers.set(ORG, { organizationId: ORG, stripeCustomerId: 'cus_live', livemode: true });
    const response = await app.request('/api/hosted/billing/checkout', post({ cookie: 'owner', body: { planKey: 'team' } }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'customer_mode_mismatch' } });
    expect(stripe.calls).toHaveLength(0);
  });

  it('a Stripe failure is 502 and never echoes the provider message', async () => {
    const { app, store } = await runtime({ stripe: [{ status: 402, body: { error: { message: 'sk_test_secret leaked?' } } }] });
    const response = await app.request('/api/hosted/billing/checkout', post({ cookie: 'owner', body: { planKey: 'team' } }));
    expect(response.status).toBe(502);
    const text = await response.text();
    expect(text).toContain('provider_error');
    expect(text).not.toContain('sk_test');
    expect(store.customers.size).toBe(0);
  });
});

// ── customer portal ─────────────────────────────────────────────────────────

describe('POST /hosted/billing/portal', () => {
  it('needs an existing billing customer', async () => {
    const { app, stripe } = await runtime();
    const response = await app.request('/api/hosted/billing/portal', post({ cookie: 'owner' }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'no_billing_customer' } });
    expect(stripe.calls).toHaveLength(0);
  });

  it('opens the portal with the explicit configuration and the hosted return URL', async () => {
    const { app, store, stripe } = await runtime({ stripe: [{ body: { url: 'https://billing.stripe.com/p/session_1' } }] });
    store.customers.set(ORG, { organizationId: ORG, stripeCustomerId: 'cus_A', livemode: false });
    const response = await app.request('/api/hosted/billing/portal', post({ cookie: 'owner' }));
    expect(await response.json()).toEqual({ ok: true, url: 'https://billing.stripe.com/p/session_1' });
    expect(new URL(stripe.calls[0]!.url).pathname).toBe('/v1/billing_portal/sessions');
    expect(stripe.calls[0]!.form.get('customer')).toBe('cus_A');
    expect(stripe.calls[0]!.form.get('configuration')).toBe('bpc_123');
    expect(stripe.calls[0]!.form.get('return_url')).toBe(`${ORIGIN}/billing`);
  });

  it("falls back to the account's default configuration when none is configured", async () => {
    const { app, store, stripe } = await runtime({
      config: { stripePortalConfigurationId: null },
      stripe: [{ body: { url: 'https://billing.stripe.com/p/session_2' } }],
    });
    store.customers.set(ORG, { organizationId: ORG, stripeCustomerId: 'cus_A', livemode: false });
    await app.request('/api/hosted/billing/portal', post({ cookie: 'owner' }));
    expect(stripe.calls[0]!.form.has('configuration')).toBe(false);
  });
});

// ── webhook ─────────────────────────────────────────────────────────────────

describe('POST /hosted/billing/webhook', () => {
  it('refuses an unsigned, mis-signed or stale delivery before parsing, recording nothing', async () => {
    const { app, store } = await runtime();
    const body = subscriptionEvent();
    const unsigned = await app.request('/api/hosted/billing/webhook', { method: 'POST', body });
    expect(unsigned.status).toBe(400);
    expect(await unsigned.json()).toMatchObject({ error: { code: 'missing-signature' } });
    const wrongSecret = await app.request('/api/hosted/billing/webhook', signedWebhook(body, 'whsec_someoneelse'));
    expect(await wrongSecret.json()).toMatchObject({ error: { code: 'bad-signature' } });
    const stale = await app.request('/api/hosted/billing/webhook', signedWebhook(body, WEBHOOK_SECRET, new Date(NOW.getTime() - 3_600_000)));
    expect(await stale.json()).toMatchObject({ error: { code: 'stale-timestamp' } });
    expect(store.events.size).toBe(0);
  });

  it('applies a signed subscription event in the configured mode with the configured plan mapping', async () => {
    const { app, store } = await runtime();
    const body = subscriptionEvent();
    const response = await app.request('/api/hosted/billing/webhook', signedWebhook(body));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, outcome: 'applied' });
    expect(store.applied).toHaveLength(1);
    expect(store.applied[0]).toMatchObject({ expectedLivemode: false, planKey: 'team', event: { eventId: 'evt_1' } });
    expect(store.events.get('evt_1')).toBe(webhookBodyDigest(body));
  });

  it('a byte-identical redelivery is a duplicate; the same id with different bytes is a 409 replay', async () => {
    const { app } = await runtime();
    await app.request('/api/hosted/billing/webhook', signedWebhook(subscriptionEvent()));
    const again = await app.request('/api/hosted/billing/webhook', signedWebhook(subscriptionEvent()));
    expect(await again.json()).toEqual({ ok: true, outcome: 'duplicate' });
    const tampered = await app.request('/api/hosted/billing/webhook', signedWebhook(subscriptionEvent('evt_1', 'canceled')));
    expect(tampered.status).toBe(409);
    expect(await tampered.json()).toMatchObject({ error: { code: 'replay-mismatch' } });
  });

  it('acknowledges (2xx) and records a signed event it cannot attribute, so Stripe stops retrying', async () => {
    const { app, store } = await runtime();
    const orphan = JSON.parse(subscriptionEvent('evt_orphan'));
    orphan.data.object.metadata = {};
    const response = await app.request('/api/hosted/billing/webhook', signedWebhook(JSON.stringify(orphan)));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, outcome: 'rejected', code: 'missing-organization' });
    expect(store.rejected).toEqual([{ eventId: 'evt_orphan', code: 'missing-organization' }]);
    expect(store.applied).toHaveLength(0);
  });

  it('a signed body that is not a Stripe event is 400 and is not recorded', async () => {
    const { app, store } = await runtime();
    const response = await app.request('/api/hosted/billing/webhook', signedWebhook('{"hello":"world"}'));
    expect(response.status).toBe(400);
    expect(store.events.size).toBe(0);
  });

  it('a store failure is a non-2xx so Stripe redelivers', async () => {
    const { app, store } = await runtime();
    store.applyEvent = async () => { throw new Error('connection reset'); };
    const response = await app.request('/api/hosted/billing/webhook', signedWebhook(subscriptionEvent()));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: 'billing_store_unavailable' } });
  });
});
