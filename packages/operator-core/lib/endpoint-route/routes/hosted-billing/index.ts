/**
 * Hosted organization subscription billing routes (app.papercusp.com).
 *
 *   GET  /hosted/billing/plans         public   — configured plans (no prices: Stripe owns those)
 *   GET  /hosted/billing/subscription  member   — current subscription + what it entitles
 *   POST /hosted/billing/checkout      billing:manage — Stripe Checkout (subscription mode) URL
 *   POST /hosted/billing/portal        billing:manage — Stripe customer-portal URL (manage/cancel)
 *   GET  /hosted/billing/receipts      billing:manage — the org's own payment receipts (P-046)
 *   POST /hosted/billing/webhook       public, Stripe-signed — subscription state intake
 *
 * Mounted only by `hosted-billing-runtime.ts`, never the local route barrel.
 * Entitlement policy is NOT decided here: the subscription route asks the
 * `HostedSubscriptionEntitlementProvider` seam.
 *
 * stripe-subscription-signup-2026-10-01 P-005; receipts:
 * agent-economy-flywheel-2026-08-30 P-046 / D-029 §7 (WI-10004802).
 */
import type { HostedPermission, HostedPrincipal } from '../../../auth/hosted-principal';
import type { HostedBillingStore } from '../../../auth/hosted/billing/billing-store';
import {
  SUBSCRIBED_STATUSES,
  resolveHostedSubscriptionEntitlement,
  type HostedSubscriptionEntitlementProvider,
} from '../../../auth/hosted/billing/entitlement-seam';
import type { StripeBillingClient } from '../../../auth/hosted/billing/stripe-billing-client';
import { parseHostedBillingEvent } from '../../../auth/hosted/billing/stripe-billing-events';
import { createStripeAdapter } from '../../../cupboard/payment-adapters/stripe';
import type { CustomerReceiptEntry } from '../../../cupboard/payment-receipt-store';
import { webhookBodyDigest } from '../../../cupboard/webhook-inbox';

export const HOSTED_BILLING_ROUTES = [
  { method: 'GET', path: '/hosted/billing/plans', access: 'public' },
  { method: 'GET', path: '/hosted/billing/subscription', access: 'authenticated' },
  { method: 'POST', path: '/hosted/billing/checkout', access: 'authenticated' },
  { method: 'POST', path: '/hosted/billing/portal', access: 'authenticated' },
  { method: 'GET', path: '/hosted/billing/receipts', access: 'authenticated' },
  { method: 'POST', path: '/hosted/billing/webhook', access: 'public' },
] as const;

/**
 * Every payment receipt for ONE Stripe customer, newest first. The route only
 * ever passes the signed-in organization's own customer id; which workspace's
 * ledger holds the receipts is the composition's decision.
 */
export type HostedBillingReceiptSource = (stripeCustomerId: string) => Promise<readonly CustomerReceiptEntry[]>;

/** One entry of `GET /hosted/billing/receipts`. */
export interface HostedBillingReceiptView {
  readonly balanceTransactionId: string;
  readonly created: string;
  readonly amount: number;
  readonly currency: string;
  /** `anchored` carries the verifiable receipt; anything else is still waiting for an anchored root. */
  readonly status: 'anchored' | 'not-yet-anchored';
  /** Why a not-yet-anchored entry is waiting (`not-chained` | `not-in-log` | `not-yet-anchored` | …). */
  readonly pendingReason: string | null;
  /** The receipt exactly as `scripts/verify-payment-receipt.mts` checks it; null until anchored. */
  readonly receipt: unknown;
}

export function hostedBillingReceiptView(entry: CustomerReceiptEntry): HostedBillingReceiptView {
  const base = {
    balanceTransactionId: entry.balanceTransactionId,
    created: new Date(entry.created * 1000).toISOString(),
    amount: entry.amount,
    currency: entry.currency,
  };
  return entry.result.ok
    ? { ...base, status: 'anchored', pendingReason: null, receipt: entry.result.receipt }
    : { ...base, status: 'not-yet-anchored', pendingReason: entry.result.error, receipt: null };
}

/** Browser path (under the `/api` base) the Checkout and portal flows return to. */
export const HOSTED_BILLING_RETURN_PATH = '/billing';

export interface HostedBillingPlan {
  readonly planKey: string;
  /** Stripe price id (`price_…`) — configuration, never code. Dollar amounts live in Stripe. */
  readonly priceId: string;
  readonly label: string;
  readonly description: string | null;
}

/** Everything that exists only once Stripe is configured. */
export interface HostedBillingStripe {
  readonly client: StripeBillingClient;
  readonly webhookSecret: string;
  /** Explicit customer-portal configuration (`bpc_…`); null = the account's dashboard default. */
  readonly portalConfigurationId?: string | null;
}

export interface HostedBillingRouteDependencies {
  readonly publicOrigin: string;
  readonly plans: readonly HostedBillingPlan[];
  readonly store: HostedBillingStore;
  /** Null = billing is not configured on this host; mutating routes answer 503. */
  readonly stripe: HostedBillingStripe | null;
  /** Why `stripe` is null, surfaced to the UI (e.g. `live_mode_not_allowed`). */
  readonly unavailableReason?: string | null;
  readonly entitlementProvider?: HostedSubscriptionEntitlementProvider;
  /** Absent = receipts are not configured on this host; `/receipts` answers 503. */
  readonly receipts?: HostedBillingReceiptSource;
  readonly clock?: () => Date;
}

export interface HostedBillingRouteContext {
  readonly principal: HostedPrincipal | null;
}

export interface HostedBillingRoute {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly auth: 'public' | { readonly capabilities: readonly HostedPermission[] };
  handler(req: Request, ctx: HostedBillingRouteContext): Promise<Response>;
}

function jsonError(code: string, safeMessage: string, status: number): Response {
  return Response.json({ ok: false, error: { code, safeMessage } }, { status });
}

export function createHostedBillingRoutes(deps: HostedBillingRouteDependencies): readonly HostedBillingRoute[] {
  const origin = new URL(deps.publicOrigin).origin;
  const clock = deps.clock ?? (() => new Date());
  const planByKey = new Map(deps.plans.map((plan) => [plan.planKey, plan]));
  const planKeyForPrice = (priceId: string | null): string | null =>
    (priceId ? deps.plans.find((plan) => plan.priceId === priceId)?.planKey : null) ?? null;
  const unavailable = () =>
    jsonError('billing_unavailable', deps.unavailableReason ?? 'billing_not_configured', 503);
  const sameOrigin = (req: Request) => req.headers.get('origin') === origin;
  const organizationOf = (ctx: HostedBillingRouteContext): string | null => ctx.principal?.activeOrganizationId ?? null;

  const plans: HostedBillingRoute = {
    method: 'GET',
    path: '/hosted/billing/plans',
    auth: 'public',
    async handler() {
      return Response.json({
        ok: true,
        configured: deps.stripe !== null,
        livemode: deps.stripe?.client.livemode ?? false,
        unavailableReason: deps.stripe ? null : deps.unavailableReason ?? 'billing_not_configured',
        plans: deps.plans.map(({ planKey, label, description }) => ({ planKey, label, description })),
      });
    },
  };

  const subscription: HostedBillingRoute = {
    method: 'GET',
    path: '/hosted/billing/subscription',
    auth: { capabilities: ['workspace:view'] },
    async handler(_req, ctx) {
      const organizationId = organizationOf(ctx);
      if (!organizationId) return jsonError('organization_required', 'An active organization is required.', 403);
      let snapshot;
      try {
        snapshot = await deps.store.currentSubscription(organizationId, planKeyForPrice);
      } catch {
        return jsonError('billing_store_unavailable', 'Billing state could not be read.', 503);
      }
      const entitlement = await resolveHostedSubscriptionEntitlement(snapshot, {
        provider: deps.entitlementProvider,
        now: clock(),
      });
      return Response.json({
        ok: true,
        configured: deps.stripe !== null,
        canManage: ctx.principal?.capabilities.has('billing:manage') === true,
        subscription: snapshot && {
          status: snapshot.status,
          planKey: snapshot.planKey,
          planLabel: snapshot.planKey ? planByKey.get(snapshot.planKey)?.label ?? null : null,
          currentPeriodEnd: snapshot.currentPeriodEnd?.toISOString() ?? null,
          cancelAtPeriodEnd: snapshot.cancelAtPeriodEnd,
          canceledAt: snapshot.canceledAt?.toISOString() ?? null,
          livemode: snapshot.livemode,
          latestInvoiceStatus: snapshot.latestInvoiceStatus,
        },
        entitlement,
      });
    },
  };

  const checkout: HostedBillingRoute = {
    method: 'POST',
    path: '/hosted/billing/checkout',
    auth: { capabilities: ['billing:manage'] },
    async handler(req, ctx) {
      if (!sameOrigin(req)) return jsonError('cross_origin_blocked', 'The request origin is not allowed.', 403);
      if (!deps.stripe) return unavailable();
      const organizationId = organizationOf(ctx);
      if (!organizationId) return jsonError('organization_required', 'An active organization is required.', 403);
      const body = await req.json().catch(() => null) as { planKey?: unknown } | null;
      const plan = typeof body?.planKey === 'string' ? planByKey.get(body.planKey) : undefined;
      if (!plan) return jsonError('unknown_plan', 'The selected plan is not available.', 400);

      const { client } = deps.stripe;
      try {
        const current = await deps.store.currentSubscription(organizationId, planKeyForPrice);
        if (current && SUBSCRIBED_STATUSES.has(current.status)) {
          return jsonError('already_subscribed', 'This organization already has a subscription; manage it instead.', 409);
        }
        let customer = await deps.store.customerFor(organizationId);
        if (!customer) {
          const created = await client.createCustomer({ organizationId });
          if (!created.ok) return jsonError('provider_error', 'Stripe could not create the billing customer.', 502);
          customer = await deps.store.recordCustomer({
            organizationId,
            stripeCustomerId: created.customerId,
            livemode: client.livemode,
          });
        }
        if (customer.livemode !== client.livemode) {
          return jsonError('customer_mode_mismatch', 'The billing customer belongs to the other Stripe mode.', 409);
        }
        // A double-click inside the same 10-minute window returns the SAME
        // Checkout Session (Stripe idempotency), never a second one.
        const window = Math.floor(clock().getTime() / 600_000);
        const session = await client.createSubscriptionCheckout({
          customerId: customer.stripeCustomerId,
          organizationId,
          priceId: plan.priceId,
          successUrl: `${origin}${HOSTED_BILLING_RETURN_PATH}?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
          cancelUrl: `${origin}${HOSTED_BILLING_RETURN_PATH}?checkout=canceled`,
          idempotencyKey: `papercusp-sub-checkout:${organizationId}:${plan.planKey}:${window}`,
        });
        if (!session.ok) return jsonError('provider_error', 'Stripe could not start checkout.', 502);
        return Response.json({ ok: true, url: session.url });
      } catch {
        return jsonError('billing_store_unavailable', 'Billing state could not be read.', 503);
      }
    },
  };

  const portal: HostedBillingRoute = {
    method: 'POST',
    path: '/hosted/billing/portal',
    auth: { capabilities: ['billing:manage'] },
    async handler(req, ctx) {
      if (!sameOrigin(req)) return jsonError('cross_origin_blocked', 'The request origin is not allowed.', 403);
      if (!deps.stripe) return unavailable();
      const organizationId = organizationOf(ctx);
      if (!organizationId) return jsonError('organization_required', 'An active organization is required.', 403);
      let customer;
      try {
        customer = await deps.store.customerFor(organizationId);
      } catch {
        return jsonError('billing_store_unavailable', 'Billing state could not be read.', 503);
      }
      if (!customer) return jsonError('no_billing_customer', 'This organization has no billing account yet.', 409);
      const session = await deps.stripe.client.createPortalSession({
        customerId: customer.stripeCustomerId,
        returnUrl: `${origin}${HOSTED_BILLING_RETURN_PATH}`,
        configurationId: deps.stripe.portalConfigurationId ?? null,
      });
      if (!session.ok) return jsonError('provider_error', 'Stripe could not open the billing portal.', 502);
      return Response.json({ ok: true, url: session.url });
    },
  };

  const receipts: HostedBillingRoute = {
    method: 'GET',
    path: '/hosted/billing/receipts',
    auth: { capabilities: ['billing:manage'] },
    async handler(_req, ctx) {
      const organizationId = organizationOf(ctx);
      if (!organizationId) return jsonError('organization_required', 'An active organization is required.', 403);
      if (!deps.receipts) return jsonError('receipts_unavailable', 'Payment receipts are not configured on this host.', 503);
      let customer;
      try {
        customer = await deps.store.customerFor(organizationId);
      } catch {
        return jsonError('billing_store_unavailable', 'Billing state could not be read.', 503);
      }
      // No billing customer yet means nothing was ever paid: an empty list, not an error.
      if (!customer) return Response.json({ ok: true, receipts: [] });
      let entries;
      try {
        entries = await deps.receipts(customer.stripeCustomerId);
      } catch {
        return jsonError('receipts_unavailable', 'Payment receipts could not be read.', 503);
      }
      return Response.json({ ok: true, receipts: entries.map(hostedBillingReceiptView) });
    },
  };

  const webhook: HostedBillingRoute = {
    method: 'POST',
    path: '/hosted/billing/webhook',
    auth: 'public',
    async handler(req) {
      if (!deps.stripe) return unavailable();
      const rawBody = await req.text();
      const verdict = createStripeAdapter({ webhookSecret: deps.stripe.webhookSecret }).verifySignature({
        rawBody,
        headers: Object.fromEntries(req.headers),
        nowMs: clock().getTime(),
      });
      // Unauthenticated deliveries are refused before parsing and never recorded.
      if (!verdict.ok) return jsonError(verdict.code, 'The webhook signature is not valid.', 400);
      const bodyDigest = webhookBodyDigest(rawBody);
      const parsed = parseHostedBillingEvent(rawBody);
      try {
        if (!parsed.ok) {
          if (!parsed.eventId || !parsed.eventType || parsed.livemode === null) {
            return jsonError(parsed.code, 'The webhook body is not a Stripe event.', 400);
          }
          const recorded = await deps.store.recordRejectedEvent({
            eventId: parsed.eventId,
            eventType: parsed.eventType,
            bodyDigest,
            livemode: parsed.livemode,
            code: parsed.code,
          });
          if (recorded === 'replay-mismatch') return jsonError('replay-mismatch', 'The event id was already received with different bytes.', 409);
          // A permanent content refusal is acknowledged (2xx) so Stripe does not retry it for days.
          return Response.json({ ok: true, outcome: recorded === 'duplicate' ? 'duplicate' : 'rejected', code: parsed.code });
        }
        const result = await deps.store.applyEvent({
          event: parsed.event,
          bodyDigest,
          expectedLivemode: deps.stripe.client.livemode,
          planKeyForPrice,
        });
        if (result.outcome === 'replay-mismatch') {
          return jsonError('replay-mismatch', 'The event id was already received with different bytes.', 409);
        }
        return Response.json({ ok: true, outcome: result.outcome, ...(result.outcome === 'rejected' ? { code: result.code } : {}) });
      } catch {
        // Transient: a non-2xx makes Stripe redeliver, and the transaction left no partial state.
        return jsonError('billing_store_unavailable', 'The event could not be recorded.', 503);
      }
    },
  };

  return [plans, subscription, checkout, portal, receipts, webhook];
}
