/**
 * SDK-free Stripe client for hosted subscription billing: one customer per
 * organization, subscription-mode Checkout, and customer-portal sessions.
 *
 * Every request goes through the cupboard adapter's `postStripeForm` (form
 * encoding, Idempotency-Key, error shaping) — this file adds only the request
 * shapes. The secret key is resolved by the caller from an injected reference;
 * it is never read from the tree.
 *
 * LIVE MODE IS AN OWNER-AUTHORITY ACTION. A live key (`sk_live_…`/`rk_live_…`)
 * charges real cards, so the client refuses to construct with one unless the
 * caller has established that the default-OFF `papercusp-hosted-billing-live-mode`
 * flag is on. Test keys are always accepted.
 *
 * stripe-subscription-signup-2026-10-01 P-004.
 */
// Import the contract SHAPE from the dependency-free leaf, never from
// `identity-refusal-contract`: this module sits in the portal-prebundled hosted cone and
// `hosted-auth-runtime.bundle-cone.test.ts` walks `import type` edges too (WI-10005197).
import type { RefusalContract } from '../../../capability-envelope/refusal-contract-types';
import { postStripeForm } from '../../../cupboard/payment-adapters/stripe';

export const STRIPE_API_BASE = 'https://api.stripe.com/v1';

export type StripeKeyMode = 'test' | 'live';

/** Classify a Stripe secret/restricted key without echoing it. */
export function stripeKeyMode(secretKey: string): StripeKeyMode | null {
  if (/^(sk|rk)_test_[A-Za-z0-9]+$/.test(secretKey)) return 'test';
  if (/^(sk|rk)_live_[A-Za-z0-9]+$/.test(secretKey)) return 'live';
  return null;
}

export type StripeBillingCallResult<T> =
  | ({ readonly ok: true } & T)
  | { readonly ok: false; readonly code: 'provider-error' | 'malformed-response'; readonly status: number | null; readonly detail: string };

export interface StripeBillingClient {
  readonly livemode: boolean;
  createCustomer(input: {
    organizationId: string;
    email?: string | null;
    name?: string | null;
  }): Promise<StripeBillingCallResult<{ customerId: string }>>;
  createSubscriptionCheckout(input: {
    customerId: string;
    organizationId: string;
    priceId: string;
    successUrl: string;
    cancelUrl: string;
    idempotencyKey: string;
  }): Promise<StripeBillingCallResult<{ sessionId: string; url: string }>>;
  createPortalSession(input: {
    customerId: string;
    returnUrl: string;
    /** `bpc_…`; absent = Stripe's dashboard default configuration (which must then exist). */
    configurationId?: string | null;
  }): Promise<StripeBillingCallResult<{ url: string }>>;
}

export type StripeBillingClientConstruction =
  | { readonly ok: true; readonly client: StripeBillingClient }
  | { readonly ok: false; readonly code: 'invalid_secret_key' }
  | { readonly ok: false; readonly code: 'live_mode_not_allowed'; readonly refusal: RefusalContract };

const malformed = (status: number, detail: string) =>
  ({ ok: false as const, code: 'malformed-response' as const, status, detail });

export function createStripeBillingClient(input: {
  secretKey: string;
  fetchImpl: typeof fetch;
  /** The resolved value of the default-OFF owner-authority live-mode flag. */
  liveModeAllowed: boolean;
}): StripeBillingClientConstruction {
  const mode = stripeKeyMode(input.secretKey);
  if (!mode) return { ok: false, code: 'invalid_secret_key' };
  if (mode === 'live' && !input.liveModeAllowed) {
    return {
      ok: false,
      code: 'live_mode_not_allowed',
      refusal: {
        observed: { keyMode: 'live', liveModeAllowed: 'false' },
        liftsWhen:
          'the owner turns the default-OFF `papercusp-hosted-billing-live-mode` flag on, or the deployment is ' +
          'given a test-mode (sk_test_/rk_test_) Stripe key. Retrying with the same live key and flag changes nothing',
        whoCanMakeItTrue: ['owner'],
      } satisfies RefusalContract,
    };
  }
  const post = (path: string, params: Record<string, unknown>, idempotencyKey?: string) =>
    postStripeForm({ url: `${STRIPE_API_BASE}${path}`, secretKey: input.secretKey, params, fetchImpl: input.fetchImpl, idempotencyKey });

  const client: StripeBillingClient = {
    livemode: mode === 'live',

    async createCustomer({ organizationId, email, name }) {
      // Stripe's idempotency window is 24h; the store's unique (organization_id)
      // row is the durable one-customer-per-org guarantee beyond it.
      const posted = await post('/customers', {
        email: email ?? undefined,
        name: name ?? undefined,
        metadata: { organizationId },
      }, `papercusp-org-customer:${organizationId}`);
      if (!posted.ok) return posted;
      const id = posted.body.id;
      if (typeof id !== 'string' || !/^cus_[A-Za-z0-9]+$/.test(id)) return malformed(posted.status, 'stripe response carried no customer id');
      return { ok: true, customerId: id };
    },

    async createSubscriptionCheckout({ customerId, organizationId, priceId, successUrl, cancelUrl, idempotencyKey }) {
      const posted = await post('/checkout/sessions', {
        mode: 'subscription',
        customer: customerId,
        client_reference_id: organizationId,
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: successUrl,
        cancel_url: cancelUrl,
        metadata: { organizationId, purpose: 'hosted-subscription' },
        // The org id must ride on the SUBSCRIPTION itself: every later
        // customer.subscription.* webhook is attributed from it (and verified
        // against the customer mapping), independent of checkout delivery order.
        subscription_data: { metadata: { organizationId } },
        // Same measured account default as the cupboard Checkout builder:
        // Managed Payments makes Stripe merchant of record and 400s line items
        // without a product tax code. We settle directly (P-038, 2026-09-06).
        managed_payments: { enabled: false },
      }, idempotencyKey);
      if (!posted.ok) return posted;
      const { id, url } = posted.body;
      if (typeof id !== 'string' || !id) return malformed(posted.status, 'stripe response carried no session id');
      if (typeof url !== 'string' || !url) return malformed(posted.status, 'stripe response carried no checkout url');
      return { ok: true, sessionId: id, url };
    },

    async createPortalSession({ customerId, returnUrl, configurationId }) {
      // An explicit portal configuration (created through the API) beats the account's dashboard
      // default: portal behaviour then lives in injected config, not in un-versioned dashboard state.
      const posted = await post('/billing_portal/sessions', {
        customer: customerId,
        return_url: returnUrl,
        ...(configurationId ? { configuration: configurationId } : {}),
      });
      if (!posted.ok) return posted;
      const { url } = posted.body;
      if (typeof url !== 'string' || !url) return malformed(posted.status, 'stripe response carried no portal url');
      return { ok: true, url };
    },
  };
  return { ok: true, client };
}
