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
import { createHash } from 'node:crypto';
import { postStripeForm } from '../../../cupboard/payment-adapters/stripe';
import type { StripeBalanceTransaction } from '../../../cupboard/money-journal-producers';

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
  /** Read-only provider evidence. This is NOT a payment/reversal census or
   * transaction-bound funding authority; it must be reconciled with those. */
  readAccountCash(input: {
    readonly accountId: string;
    readonly customerId: string;
    readonly organizationId: string;
  }): Promise<StripeBillingCallResult<{ evidence: StripeAccountCashEvidence }>>;
  /** Exhaustive, unfiltered account history. Receipt/journal/reversal mapping
   * and freshness reconciliation are still required before funding admission. */
  readAccountTransactions(input: {
    readonly accountId: string;
    readonly maxPages?: number;
  }): Promise<StripeBillingCallResult<{ evidence: StripeAccountTransactionEvidence }>>;
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

export interface StripeAccountCashEvidence {
  readonly accountId: string;
  readonly customerId: string;
  readonly organizationId: string;
  /** Verified on BOTH the authenticated balance and customer responses. */
  readonly livemode: boolean;
  /** Signed cents. Negative cash remains negative; pending cash is separate. */
  readonly availableUsdCents: number;
  readonly pendingUsdCents: number;
  readonly observedAtMs: number;
  readonly requestIds: readonly string[];
  readonly evidenceRef: string;
}

export interface StripeAccountTransactionEvidence {
  readonly accountId: string;
  readonly observedAtMs: number;
  readonly requestIds: readonly string[];
  readonly transactions: readonly StripeBalanceTransaction[];
  readonly evidenceRef: string;
}

type StripeObject = Record<string, unknown>;
const object = (value: unknown): value is StripeObject => !!value && typeof value === 'object' && !Array.isArray(value);
function usdBalance(value: unknown): number | null {
  if (!Array.isArray(value)) return null;
  const currencies = new Set<string>();
  let usd = 0;
  for (const row of value) {
    if (!object(row) || typeof row.currency !== 'string' || !/^[a-z]{3}$/.test(row.currency)
        || !Number.isSafeInteger(row.amount) || currencies.has(row.currency)) return null;
    currencies.add(row.currency);
    if (row.currency === 'usd') usd = row.amount as number;
  }
  return usd;
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
  // Pin injected credentials/transport once; mutation of the composition's
  // options must not switch the account between authenticated reads.
  const { secretKey, fetchImpl } = input;
  const mode = stripeKeyMode(secretKey);
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
    postStripeForm({ url: `${STRIPE_API_BASE}${path}`, secretKey, params, fetchImpl, idempotencyKey });
  const get = async (path: string): Promise<StripeBillingCallResult<{ body: StripeObject; requestId: string; status: number }>> => {
    try {
      const response = await fetchImpl(`${STRIPE_API_BASE}${path}`, {
        method: 'GET', redirect: 'error', headers: { authorization: `Bearer ${secretKey}` },
      });
      // Never copy an error body, URL or transport exception containing a key
      // or customer PII into the evidence/result.
      if (!response.ok) return { ok: false, code: 'provider-error', status: response.status, detail: 'stripe authenticated read failed' };
      const body: unknown = await response.json();
      const requestId = response.headers.get('request-id');
      if (!object(body) || !requestId || !/^req_[A-Za-z0-9]+$/.test(requestId)) {
        return malformed(response.status, 'stripe read lacks an object or request provenance');
      }
      return { ok: true, body, requestId, status: response.status };
    } catch {
      return { ok: false, code: 'provider-error', status: null, detail: 'stripe authenticated read failed' };
    }
  };

  const client: StripeBillingClient = {
    livemode: mode === 'live',

    async readAccountCash(input) {
      const { accountId, customerId, organizationId } = input;
      if (!/^acct_[A-Za-z0-9]+$/.test(accountId) || !/^cus_[A-Za-z0-9]+$/.test(customerId)
          || typeof organizationId !== 'string' || !organizationId.trim()) {
        return malformed(0, 'invalid pinned stripe scope');
      }
      // /account identifies the credential's own account. Looking up an
      // arbitrary /accounts/:id could prove access rather than cash ownership.
      const account = await get('/account');
      if (!account.ok) return account;
      if (account.body.object !== 'account' || account.body.id !== accountId) return malformed(account.status, 'stripe account pin mismatch');
      const customer = await get(`/customers/${customerId}`);
      if (!customer.ok) return customer;
      if (customer.body.object !== 'customer' || customer.body.id !== customerId || customer.body.deleted === true
          || customer.body.livemode !== (mode === 'live') || !object(customer.body.metadata)
          || customer.body.metadata.organizationId !== organizationId) return malformed(customer.status, 'stripe customer pin mismatch');
      const balance = await get('/balance');
      if (!balance.ok) return balance;
      const available = usdBalance(balance.body.available); const pending = usdBalance(balance.body.pending);
      if (balance.body.object !== 'balance' || balance.body.livemode !== (mode === 'live')
          || available === null || pending === null) return malformed(balance.status, 'unverified stripe cash balance');
      const requestIds = Object.freeze([account.requestId, customer.requestId, balance.requestId]);
      const observedAtMs = Date.now();
      const selected = { accountId, customerId, organizationId, livemode: mode === 'live',
        availableUsdCents: available, pendingUsdCents: pending, observedAtMs, requestIds };
      const evidenceRef = `stripe-cash:${createHash('sha256').update(JSON.stringify(selected)).digest('hex')}`;
      return { ok: true, evidence: Object.freeze({ ...selected, evidenceRef }) };
    },

    async readAccountTransactions(input) {
      const { accountId, maxPages = 100 } = input;
      if (!/^acct_[A-Za-z0-9]+$/.test(accountId) || !Number.isSafeInteger(maxPages) || maxPages < 1) {
        return malformed(0, 'invalid pinned stripe census scope');
      }
      const account = await get('/account');
      if (!account.ok) return account;
      if (account.body.object !== 'account' || account.body.id !== accountId) return malformed(account.status, 'stripe account pin mismatch');
      const requestIds = [account.requestId];
      const transactions: StripeBalanceTransaction[] = [];
      const seen = new Set<string>();
      let startingAfter: string | undefined;
      for (let page = 0; page < maxPages; page += 1) {
        const query = new URLSearchParams({ limit: '100' });
        if (startingAfter) query.set('starting_after', startingAfter);
        // Same expansions as the journal importer; no customer/date/type/
        // currency filters can omit a refund or another pool obligation.
        query.append('expand[]', 'data.source');
        query.append('expand[]', 'data.source.invoice');
        const result = await get(`/balance_transactions?${query}`);
        if (!result.ok) return result;
        const { data, has_more: more } = result.body;
        if (result.body.object !== 'list' || !Array.isArray(data) || data.length > 100 || typeof more !== 'boolean'
            || (more && data.length === 0)) return malformed(result.status, 'incomplete stripe transaction page');
        requestIds.push(result.requestId);
        for (const row of data) {
          if (!object(row) || row.object !== 'balance_transaction' || typeof row.id !== 'string' || !/^txn_[A-Za-z0-9]+$/.test(row.id)
              || seen.has(row.id) || typeof row.type !== 'string' || !row.type
              || !Number.isSafeInteger(row.amount) || !Number.isSafeInteger(row.fee) || (row.fee as number) < 0
              || !Number.isSafeInteger(row.net) || BigInt(row.net as number) !== BigInt(row.amount as number) - BigInt(row.fee as number)
              || typeof row.currency !== 'string' || !/^[a-z]{3}$/.test(row.currency)
              || !Number.isSafeInteger(row.created) || (row.created as number) < 0
              || !Number.isSafeInteger(row.available_on) || (row.available_on as number) < 0
              || !['available', 'pending'].includes(row.status as string)) return malformed(result.status, 'invalid or duplicate stripe transaction');
          // Preserve unknown provider types and complete expanded sources for
          // the journal/reversal verifier to refuse or reconcile explicitly.
          seen.add(row.id);
          transactions.push(row as unknown as StripeBalanceTransaction);
        }
        if (!more) {
          const observedAtMs = Date.now();
          const evidenceRef = `stripe-census:${createHash('sha256').update(JSON.stringify({ accountId, observedAtMs, requestIds, transactions })).digest('hex')}`;
          return { ok: true, evidence: { accountId, observedAtMs, requestIds, transactions, evidenceRef } };
        }
        startingAfter = transactions.at(-1)!.id;
      }
      // A page budget is an operational bound, never proof of completeness.
      // Discard partial history rather than returning a successful census.
      return malformed(0, 'stripe transaction census exceeds page budget');
    },

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
