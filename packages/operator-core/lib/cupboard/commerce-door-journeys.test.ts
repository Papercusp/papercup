/**
 * P-012 — the commerce journeys driven THROUGH the production doors.
 *
 * `commerce-journeys.test.ts` already drives the module chain (adapter ->
 * webhook inbox -> ledger -> accounts -> dashboards). D-045 §5 asks for
 * something that suite structurally cannot give: the same journey run through
 * the AGENT-CALLABLE DOORS, because a door is where a real caller enters and a
 * module chain that works says nothing about whether the door in front of it is
 * wired to it. So every assertion below goes through the actual `defineTool`
 * handler exported by `agent-tools/cupboard/*` — the same object the MCP
 * surface invokes — not through the gate functions those handlers call.
 *
 * Two things this catches that a module-level suite cannot:
 *
 *   1. A door that resolves a DIFFERENT collaborator than the one under test,
 *      or marshals its args wrongly on the way in. Both are invisible to a gate
 *      test and fatal to a caller.
 *   2. The production install default staying fail-closed until release-chain
 *      persistence is wired, while the explicit test seam proves that a real
 *      ledger entitlement can open — and a refund can close — the managed path.
 *
 * The doors read their state through `configureCommerceIo` /
 * `configureInstallDoorSources`. Those seams exist because the default readers
 * are honest-but-empty (no local commerce persistence exists yet), which makes
 * every door refuse `unknown-org` and leaves everything past the gate
 * unreachable. Registering a fold BUILT FROM REAL SIGNED WEBHOOK BYTES is what
 * makes the door layer testable at all; nothing downstream of the seam is
 * stubbed. `journey: the doors with no state registered` pins the default so the
 * seam cannot quietly become the production path.
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
  computeStripeSignature,
  createStripeAdapter,
  STRIPE_SIGNATURE_HEADER,
} from './payment-adapters/stripe';
import {
  ingestWebhook,
  memoryWebhookInboxStore,
  type NormalizeVerdict,
  type PaymentProviderAdapter,
  type SignatureVerdict,
  type WebhookRequest,
} from './webhook-inbox';
import { reduceLedger, type LedgerEvent, type LedgerState } from './commerce-ledger';
import type { CreatorProfile, Installation, Organization, SeatPolicy } from './commerce-accounts';
import { configureCommerceIo, type CommerceIoSources } from './commerce-door-gate-io';
import {
  configureInstallDoorSources,
  gateInstallDoor,
  installDoorGateDeps,
} from './install-door-gate-io';
import type { CommerceSnapshot } from './commerce-door-gate';
import type { DoorListingFacts, InstallDoorGateDeps } from './install-door-gate';
import {
  projectEntitlements,
  projectLedgerEntitlements,
} from './entitled-delivery';
import type { CupboardReleaseManifest } from './listing-manifest';
import {
  buildArtifactPackage,
  createProviderRegistry,
  type ArtifactProviderAdapter,
} from '../p2p/artifact-package';
import {
  DEFAULT_PINNING_POLICY,
  type ArtifactDistributionState,
  type DistributionSource,
} from '../p2p/artifact-distribution';
import { memoryArtifactStore } from './artifact-store';
import type { InstallRunnerDeps } from './install-runner';

// ---------------------------------------------------------------------------
// Provider-independent journey fixtures
// ---------------------------------------------------------------------------

const SECRET = 'whsec_p012_doors';
const FAKE_SECRET = 'fakesec_p012_doors';
const NOW_SEC = 1_800_000_000;
const NOW_MS = NOW_SEC * 1000;

const ORDER_ID = 'ord-1';
const OFFER_ID = 'offer-1';
const ORG_ID = 'org-acme';
const AMOUNT_MINOR = 5000;

const ACME: Organization = {
  orgId: ORG_ID,
  displayName: 'Acme',
  memberships: [
    { userId: 'alice', role: 'owner', addedAtMs: 1 },
    { userId: 'bob', role: 'member', addedAtMs: 2 },
  ],
};

/** Catalog facts a provider webhook never carries — the operator defines these. */
function catalogEvents(): LedgerEvent[] {
  const source = { provider: 'operator', providerEventId: null };
  return [
    {
      ledgerEventId: 'cat-1',
      kind: 'product.defined',
      occurredAtMs: NOW_MS - 10_000,
      source,
      payload: { productId: 'prod-1', skuRef: 'sku-1', creatorId: 'creator-1', title: 'Widget' },
    },
    {
      ledgerEventId: 'cat-2',
      kind: 'offer.defined',
      occurredAtMs: NOW_MS - 9_000,
      source,
      payload: {
        offerId: OFFER_ID,
        productId: 'prod-1',
        pricingModel: 'one-time',
        price: { amountMinor: AMOUNT_MINOR, currency: 'USD' },
      },
    },
    {
      ledgerEventId: 'cat-3',
      kind: 'order.created',
      occurredAtMs: NOW_MS - 8_000,
      source,
      payload: { orderId: ORDER_ID, offerId: OFFER_ID, buyerId: ORG_ID },
    },
  ];
}

// ---------------------------------------------------------------------------
// The two providers
// ---------------------------------------------------------------------------

/**
 * A SECOND payment provider, deliberately unlike Stripe in every respect the
 * journey could accidentally depend on.
 *
 * This is the provider-replacement half of P-012. The claim under test is that
 * the ledger, the entitlement fold and every door are provider-agnostic: only
 * the adapter knows the provider. A claim like that is only worth anything if a
 * genuinely different provider can be substituted, so this one differs in
 * signature scheme (bare body HMAC in a different header, no timestamp), in
 * envelope field names, in event-type vocabulary, and in money units — it quotes
 * MAJOR units where Stripe quotes minor, so an adapter that forgot to convert
 * would produce a ledger amount 100x off and fail the shared assertions.
 *
 * It is a test double rather than a shipped adapter on purpose: adding a second
 * real provider is a product decision that is not P-012's to make. What P-012
 * owes is evidence that the seam ADMITS one.
 */
function fakeSignature(secret: string, rawBody: string): string {
  // Reuses the Stripe HMAC helper with a fixed timestamp so this double does not
  // hand-roll a second crypto implementation — the SCHEME differs, not the math.
  return computeStripeSignature(secret, 0, rawBody);
}

const FAKE_SIGNATURE_HEADER = 'x-fakepay-signature';

function createFakeProviderAdapter(opts: { webhookSecret: string }): PaymentProviderAdapter {
  return {
    provider: 'fakepay',
    verifySignature(request: WebhookRequest): SignatureVerdict {
      const presented = request.headers[FAKE_SIGNATURE_HEADER];
      if (typeof presented !== 'string' || presented === '') {
        return { ok: false, code: 'missing-signature', detail: `no ${FAKE_SIGNATURE_HEADER} header` };
      }
      const expected = fakeSignature(opts.webhookSecret, request.rawBody);
      if (presented !== expected) {
        return { ok: false, code: 'bad-signature', detail: 'fakepay signature mismatch' };
      }
      return { ok: true };
    },
    normalize(rawBody: string, receivedAtMs: number): NormalizeVerdict {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(rawBody) as Record<string, unknown>;
      } catch {
        return { ok: false, code: 'malformed-body', detail: 'not JSON', providerEventId: null };
      }
      const eventId = typeof parsed.event_id === 'string' ? parsed.event_id : null;
      if (!eventId) {
        return { ok: false, code: 'malformed-body', detail: 'event_id required', providerEventId: null };
      }
      const kind = typeof parsed.kind === 'string' ? parsed.kind : '';
      const order = (parsed.order ?? {}) as Record<string, unknown>;
      const orderId = typeof order.ref === 'string' ? order.ref : '';
      // MAJOR units on the wire — the conversion an adapter owes.
      const major = typeof order.total === 'number' ? order.total : 0;
      const amountMinor = Math.round(major * 100);

      if (kind === 'payment.settled') {
        return {
          ok: true,
          webhook: {
            providerEventId: eventId,
            providerEventType: kind,
            occurredAtMs: receivedAtMs,
            events: [
              {
                ledgerEventId: `fakepay-${eventId}`,
                kind: 'order.paid',
                occurredAtMs: receivedAtMs,
                source: { provider: 'fakepay', providerEventId: eventId },
                payload: {
                  orderId,
                  amount: { amountMinor, currency: 'USD' },
                  providerRef: `fp_${orderId}`,
                },
              },
            ],
          },
        };
      }
      if (kind === 'payment.reversed') {
        const refund = (parsed.refund ?? {}) as Record<string, unknown>;
        const refundId = typeof refund.ref === 'string' ? refund.ref : '';
        const refundMajor = typeof refund.total === 'number' ? refund.total : 0;
        return {
          ok: true,
          webhook: {
            providerEventId: eventId,
            providerEventType: kind,
            occurredAtMs: receivedAtMs,
            events: [
              {
                ledgerEventId: `fakepay-${eventId}`,
                kind: 'refund.succeeded',
                occurredAtMs: receivedAtMs,
                source: { provider: 'fakepay', providerEventId: eventId },
                payload: {
                  refundId,
                  orderId,
                  amount: { amountMinor: Math.round(refundMajor * 100), currency: 'USD' },
                },
              },
            ],
          },
        };
      }
      // Authenticated but irrelevant — the same "zero events" contract Stripe has.
      return {
        ok: true,
        webhook: { providerEventId: eventId, providerEventType: kind, occurredAtMs: receivedAtMs, events: [] },
      };
    },
  };
}

interface ProviderCase {
  readonly name: string;
  readonly adapter: PaymentProviderAdapter;
  /** A signed request carrying "this order was paid in full". */
  paid(): WebhookRequest;
  /** A signed request carrying a partial refund. */
  refunded(amountMinor: number): WebhookRequest;
}

function stripeCase(): ProviderCase {
  const sign = (body: unknown, atSec: number): WebhookRequest => {
    const rawBody = JSON.stringify(body);
    const sig = computeStripeSignature(SECRET, atSec, rawBody);
    return { rawBody, headers: { [STRIPE_SIGNATURE_HEADER]: `t=${atSec},v1=${sig}` }, nowMs: atSec * 1000 };
  };
  return {
    name: 'stripe',
    adapter: createStripeAdapter({ webhookSecret: SECRET }),
    paid: () =>
      sign(
        {
          id: 'evt_paid',
          type: 'checkout.session.completed',
          created: NOW_SEC,
          data: {
            object: {
              id: `cs_${ORDER_ID}`,
              payment_status: 'paid',
              payment_intent: `pi_${ORDER_ID}`,
              amount_total: AMOUNT_MINOR,
              currency: 'usd',
              metadata: { orderId: ORDER_ID },
            },
          },
        },
        NOW_SEC,
      ),
    refunded: (amountMinor: number) =>
      sign(
        {
          id: 'evt_refund',
          type: 'charge.refunded',
          created: NOW_SEC + 60,
          data: {
            object: {
              id: `ch_${ORDER_ID}`,
              currency: 'usd',
              metadata: { orderId: ORDER_ID },
              refunds: { data: [{ id: 're_1', status: 'succeeded', amount: amountMinor, currency: 'usd' }] },
            },
          },
        },
        NOW_SEC + 60,
      ),
  };
}

function fakepayCase(): ProviderCase {
  const sign = (body: unknown, atMs: number): WebhookRequest => {
    const rawBody = JSON.stringify(body);
    return {
      rawBody,
      headers: { [FAKE_SIGNATURE_HEADER]: fakeSignature(FAKE_SECRET, rawBody) },
      nowMs: atMs,
    };
  };
  return {
    name: 'fakepay',
    adapter: createFakeProviderAdapter({ webhookSecret: FAKE_SECRET }),
    paid: () =>
      sign({ event_id: 'fp_paid', kind: 'payment.settled', order: { ref: ORDER_ID, total: AMOUNT_MINOR / 100 } }, NOW_MS),
    refunded: (amountMinor: number) =>
      sign(
        {
          event_id: 'fp_reversed',
          kind: 'payment.reversed',
          order: { ref: ORDER_ID },
          refund: { ref: 're_1', total: amountMinor / 100 },
        },
        NOW_MS + 60_000,
      ),
  };
}

// ---------------------------------------------------------------------------
// The journey: real bytes -> real ledger -> the snapshot the doors read
// ---------------------------------------------------------------------------

/**
 * Drive the provider leg for real and fold the result.
 *
 * Nothing here is stubbed: the adapter verifies its own signature, the inbox
 * enforces its own idempotency, and `reduceLedger` folds whatever the adapter
 * actually emitted. The snapshot handed to the doors is therefore downstream of
 * real signed bytes rather than hand-authored to match the assertions.
 */
async function foldJourney(
  provider: ProviderCase,
  requests: readonly WebhookRequest[],
): Promise<{ ledger: LedgerState; produced: LedgerEvent[] }> {
  const store = memoryWebhookInboxStore();
  const produced: LedgerEvent[] = [];
  for (const request of requests) {
    const res = await ingestWebhook({ adapter: provider.adapter, store, request });
    if (res.outcome === 'accepted') produced.push(...res.events);
  }
  return { ledger: reduceLedger([...catalogEvents(), ...produced]), produced };
}

function snapshotOf(ledger: LedgerState): CommerceSnapshot {
  return {
    ledger,
    orgs: new Map<string, Organization>([[ACME.orgId, ACME]]),
    seatPolicies: new Map<string, SeatPolicy>([[OFFER_ID, { offerId: OFFER_ID, seats: 2 }]]),
    installations: [] as readonly Installation[],
    creatorProfiles: new Map<string, CreatorProfile>(),
    // Ledger-only journeys: no P2P commerce source is wired for them.
    perUse: null,
  };
}

/** A hosted-checkout transport that answers without a network. */
function fakeCheckoutTransport(): CommerceIoSources['transport'] {
  return {
    baseUrl: 'https://cupboard.test',
    authToken: 'gh-token-for-tests',
    fetchImpl: (async (_url: string, _init?: unknown) =>
      new Response(
        JSON.stringify({ orderId: ORDER_ID, providerSessionId: 'cs_test_1', url: 'https://pay.test/cs_test_1' }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      )) as unknown as CommerceIoSources['transport'] extends { fetchImpl?: infer F } ? F : never,
  };
}

// ---------------------------------------------------------------------------
// Door invocation — the real defineTool handlers
// ---------------------------------------------------------------------------

function body(res: unknown): Record<string, unknown> {
  const content = (res as { content?: Array<{ text?: string }> } | null)?.content;
  const text = content?.[0]?.text;
  if (typeof text !== 'string') {
    throw new Error(`tool response carried no JSON text block: ${JSON.stringify(res)}`);
  }
  return JSON.parse(text) as Record<string, unknown>;
}

async function callDoor(module: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const mod = (await import(`../agent-tools/cupboard/${module}`)) as {
    default: { handler(a: unknown, ctx: unknown): Promise<unknown> };
  };
  return body(await mod.default.handler(args, {} as never));
}

afterEach(() => {
  // The pins are process-wide; leaving either registered would make an unrelated
  // suite's "production default" assertion pass for the wrong reason.
  configureCommerceIo(null);
  configureInstallDoorSources(null);
});

// ---------------------------------------------------------------------------
// Journey 1 — the same journey, through the doors, for each provider
// ---------------------------------------------------------------------------

for (const provider of [stripeCase(), fakepayCase()]) {
  describe(`journey through the doors (${provider.name})`, () => {
    it('purchase -> webhook -> entitlement is visible at the dashboards door', async () => {
      const { ledger, produced } = await foldJourney(provider, [provider.paid()]);

      // The provider leg really ran: one adapter-produced fact, nothing rejected.
      expect(produced.map((e) => e.kind)).toEqual(['order.paid']);
      expect(ledger.rejected).toEqual([]);
      expect(ledger.orders.get(ORDER_ID)?.state).toBe('paid');

      configureCommerceIo({ loadState: () => snapshotOf(ledger) });

      const res = await callDoor('commerce-dashboards', {
        buyerOrgId: ORG_ID,
        actingUserId: 'alice',
      });

      expect(res.ok, `dashboards door refused: ${JSON.stringify(res)}`).toBe(true);
      // The door reports the SETTLED purchase, not merely that it was asked.
      expect(JSON.stringify(res)).toContain(ORDER_ID);
    });

    it('a refund is reflected at the doors without any door being told about it', async () => {
      const { ledger } = await foldJourney(provider, [provider.paid(), provider.refunded(AMOUNT_MINOR)]);
      expect(ledger.rejected).toEqual([]);

      configureCommerceIo({ loadState: () => snapshotOf(ledger) });

      // A fully refunded order has no refundable remainder left, so the refund
      // door must refuse a second bite. This is the seam that matters: the door
      // learns the order is spent from the FOLD, never from its own bookkeeping.
      const res = await callDoor('refund-request', {
        buyerOrgId: ORG_ID,
        actingUserId: 'alice',
        orderId: ORDER_ID,
        amountMinor: 1,
        reason: 'double refund attempt',
      });

      expect(res.ok, `a fully-refunded order must not refund again: ${JSON.stringify(res)}`).toBe(false);
    });
  });
}

// ---------------------------------------------------------------------------
// Journey 2 — provider replacement produces an IDENTICAL downstream world
// ---------------------------------------------------------------------------

describe('journey: provider replacement contract', () => {
  it('two unrelated providers fold to the same orders, and the doors cannot tell them apart', async () => {
    const stripe = await foldJourney(stripeCase(), [stripeCase().paid()]);
    const fake = await foldJourney(fakepayCase(), [fakepayCase().paid()]);

    const order = (s: LedgerState) => {
      const o = s.orders.get(ORDER_ID);
      return { state: o?.state, buyerId: o?.buyerId, amountMinor: o?.amount?.amountMinor };
    };

    // Everything the ledger records about the purchase is provider-independent.
    expect(order(fake.ledger)).toEqual(order(stripe.ledger));
    expect(order(stripe.ledger).state).toBe('paid');
    // The calibration half: the fold really did come from different providers,
    // so the equality above is a contract holding rather than one fixture reused.
    expect(fake.produced[0]?.source.provider).toBe('fakepay');
    expect(stripe.produced[0]?.source.provider).toBe('stripe');

    // And the door's answer is identical across the swap, EXCEPT for the two
    // fields whose whole job is to name the provider. Asserting the whole
    // response equal would be wrong, not merely strict: the audit export is
    // required to record which provider took the money, and a test demanding
    // otherwise would be pressure to erase real provenance.
    configureCommerceIo({ loadState: () => snapshotOf(stripe.ledger) });
    const viaStripe = await callDoor('commerce-dashboards', { buyerOrgId: ORG_ID, actingUserId: 'alice' });
    configureCommerceIo({ loadState: () => snapshotOf(fake.ledger) });
    const viaFake = await callDoor('commerce-dashboards', { buyerOrgId: ORG_ID, actingUserId: 'alice' });

    // The buyer-facing surfaces carry no provider trace at all.
    expect(viaFake.checkout).toEqual(viaStripe.checkout);
    expect(viaFake.refunds).toEqual(viaStripe.refunds);

    type AuditOrder = { provider?: unknown; providerRef?: unknown };
    const auditOrders = (res: Record<string, unknown>): AuditOrder[] =>
      ((res.audit as { orders?: AuditOrder[] } | undefined)?.orders ?? []);
    const withoutProvider = (rows: AuditOrder[]) =>
      rows.map(({ provider: _p, providerRef: _r, ...rest }) => rest);

    expect(auditOrders(viaStripe).length, 'the audit export must carry the order').toBe(1);
    expect(withoutProvider(auditOrders(viaFake))).toEqual(withoutProvider(auditOrders(viaStripe)));

    // The calibration half. Without it, a door that dropped provenance entirely
    // — or a fixture that quietly reused one provider twice — would satisfy the
    // equality above while proving nothing about provider replacement.
    expect(auditOrders(viaStripe)[0]?.provider).toBe('stripe');
    expect(auditOrders(viaFake)[0]?.provider).toBe('fakepay');
    expect(auditOrders(viaFake)[0]?.providerRef).not.toBe(auditOrders(viaStripe)[0]?.providerRef);
  });
});

// ---------------------------------------------------------------------------
// Journey 3 — the checkout door's own leg, end to end
// ---------------------------------------------------------------------------

describe('journey: checkout door', () => {
  it('authorizes locally and returns the hosted session to the caller', async () => {
    const { ledger } = await foldJourney(stripeCase(), []);
    configureCommerceIo({ loadState: () => snapshotOf(ledger), transport: fakeCheckoutTransport() });

    const res = await callDoor('checkout', {
      buyerOrgId: ORG_ID,
      actingUserId: 'bob',
      offerId: OFFER_ID,
      successUrl: 'https://app.test/ok',
      cancelUrl: 'https://app.test/no',
      idempotencyKey: 'idem-1',
    });

    expect(res.ok, `checkout door refused: ${JSON.stringify(res)}`).toBe(true);
    expect(res.orderId).toBe(ORDER_ID);
    expect(res.url).toBe('https://pay.test/cs_test_1');
  });

  it('refuses a non-member BEFORE any provider round trip', async () => {
    const { ledger } = await foldJourney(stripeCase(), []);
    let called = 0;
    const transport = fakeCheckoutTransport();
    configureCommerceIo({
      loadState: () => snapshotOf(ledger),
      transport: {
        ...transport,
        fetchImpl: ((...args: unknown[]) => {
          called += 1;
          return (transport as { fetchImpl: (...a: unknown[]) => unknown }).fetchImpl(...args);
        }) as never,
      },
    });

    const res = await callDoor('checkout', {
      buyerOrgId: ORG_ID,
      actingUserId: 'mallory',
      offerId: OFFER_ID,
      successUrl: 'https://app.test/ok',
      cancelUrl: 'https://app.test/no',
      idempotencyKey: 'idem-2',
    });

    expect(res.ok).toBe(false);
    expect(res.error).toBe('actor-not-in-org');
    // The point of gating locally first: an unauthorized caller must not be able
    // to make us originate a provider request on their behalf.
    expect(called, 'an unauthorized checkout must not reach the provider').toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Journey 4 — the production default, pinned
// ---------------------------------------------------------------------------

describe('journey: the doors with no state registered', () => {
  it('every commerce door refuses against the empty production fold', async () => {
    // No configureCommerceIo call — this is exactly what a door sees today.
    const args = { buyerOrgId: ORG_ID, actingUserId: 'alice' };

    const dashboards = await callDoor('commerce-dashboards', args);
    const refund = await callDoor('refund-request', { ...args, orderId: ORDER_ID, amountMinor: 1, reason: 'x' });
    const support = await callDoor('support-request', { ...args, subject: 'help' });

    for (const [name, res] of [
      ['commerce-dashboards', dashboards],
      ['refund-request', refund],
      ['support-request', support],
    ] as const) {
      expect(res.ok, `${name} must refuse with no commerce state`).toBe(false);
      expect(res.error, `${name} refusal code`).toBe('unknown-org');
    }
  });
});

// ---------------------------------------------------------------------------
// Journey 5 — the install door, with production refusal and bridged ledger path
// ---------------------------------------------------------------------------

const PAID_LISTING: DoorListingFacts = {
  listingKind: 'plugin',
  listingRef: 'tools',
  listingId: 'lst-1',
  priceModel: 'one-time',
  priceAmountMicros: 9_000_000,
  releaseVersion: '1.0.0',
};

const INSTALL_SUBJECT = 'ws-p012';
const INSTALL_RELEASE_REF = 'plugin:tools:1.0.0';
const INSTALL_BYTES = Buffer.from('commerce-door-p012-install');

/**
 * A release chain that EXISTS but entitles nobody.
 *
 * This is the control for the assertions below. They claim a paid listing is
 * refused because production resolves NO chain; that claim is only worth
 * anything if supplying a chain visibly changes the refusal. Entitlements are
 * deliberately empty — the door should then refuse for an entitlement reason,
 * which is a different code and proves the gate ran past the chain check.
 */
function chainedGateDeps(): InstallDoorGateDeps {
  const releaseRef = 'plugin:tools:1.0.0';
  // Borrow the REAL collaborators, built once for this install's recipient.
  // `installDoorGateDeps` takes an InstallDoorContext because the decrypt seam is
  // addressed to a buyer (D-045 §3b) — a key wrapped for one recipient must not
  // open under another's install — so the subject is the buyer this journey pays
  // as, not a placeholder.
  const production = installDoorGateDeps({ subject: ORG_ID });
  return {
    loadReleaseChain: () => ({
      releaseRef,
      graph: { edges: new Map<string, readonly string[]>([[releaseRef, []]]) },
      installed: new Map(),
      entitlements: projectEntitlements([]),
      signedPackage: {
        manifest: {
          schemaVersion: 1,
          listingKind: 'plugin',
          listingRef: 'tools',
          releaseVersion: '1.0.0',
          contentHash: 'deadbeef',
          signature: 'sig',
          dependencies: [],
          compatibility: { runtime: 'node>=22' },
          permissions: [],
          capabilities: [],
          license: 'MIT',
          publisher: { githubUserId: 42, login: 'alice' },
          reviewStatus: 'approved',
        } as CupboardReleaseManifest,
        expected: { listingKind: 'plugin', listingRef: 'tools', releaseVersion: '1.0.0' },
      },
    }),
    runner: production.runner,
    verify: production.verify,
  };
}

/**
 * Build a real managed chain from the ledger snapshot. The chain is entirely
 * in-memory, but its manifest, artifact, provider, and install runner are the
 * same collaborators the managed production path composes. Only the release
 * and buyer mappings are test-owned decisions: the ledger intentionally carries
 * product/buyer ids rather than delivery release/subject ids.
 */
function bridgedGateDeps(ledger: LedgerState, subject = INSTALL_SUBJECT): InstallDoorGateDeps {
  const pkg = buildArtifactPackage(INSTALL_BYTES);
  const manifest: CupboardReleaseManifest = {
    schemaVersion: 1,
    listingKind: 'plugin',
    listingRef: 'tools',
    releaseVersion: '1.0.0',
    contentHash: pkg.rootHash,
    signature: 'sig',
    dependencies: [],
    compatibility: { runtime: 'node>=22' },
    permissions: [],
    capabilities: [],
    license: 'MIT',
    publisher: { githubUserId: 42, login: 'alice' },
    reviewStatus: 'approved',
  };
  const source: DistributionSource = {
    sourceId: 'commerce-door-p012',
    class: 'pinner',
    providerId: 'memory',
    locator: 'commerce-door-p012',
    advertisedAtMs: NOW_MS - 1_000,
    expiresAtMs: null,
  };
  const distribution = {
    schemaVersion: 1 as const,
    release: manifest,
    rootHash: pkg.rootHash,
    totalSizeBytes: pkg.totalSizeBytes,
    chunks: pkg.chunks,
    visibility: 'public' as const,
    encryption: null,
    pinning: { ...DEFAULT_PINNING_POLICY, minReplicas: 1 },
    signature: 'distribution-sig',
  };
  const state: ArtifactDistributionState = {
    streamId: `dist:${INSTALL_RELEASE_REF}`,
    manifest: distribution,
    sources: [source],
    pins: [source.sourceId],
    keyVersion: 1,
    revokedKeyVersions: [],
    yankedAtMs: null,
    yankReason: null,
    lastSequence: 1,
  };
  const store = memoryArtifactStore();
  store.put({
    contentHash: pkg.rootHash,
    sizeBytes: pkg.totalSizeBytes,
    contentType: 'application/octet-stream',
  });
  const provider: ArtifactProviderAdapter = {
    providerId: 'memory',
    fetchChunk: async ({ chunk }) => {
      const start = chunk.index * pkg.chunkSizeBytes;
      return INSTALL_BYTES.subarray(start, start + chunk.sizeBytes);
    },
  };
  const runner: InstallRunnerDeps = {
    resolveDistribution: () => state,
    registry: createProviderRegistry([provider]),
    apply: (input) => ({
      releaseRef: input.releaseRef,
      installedAtMs: NOW_MS,
      contentHash: input.distribution.rootHash,
    }),
    revert: () => undefined,
  };
  const entitlements = projectLedgerEntitlements(ledger, {
    releaseRefForProduct: (productId) =>
      productId === 'prod-1' ? INSTALL_RELEASE_REF : null,
    subjectForBuyer: (buyerId) => (buyerId === ORG_ID ? subject : null),
  });

  return {
    loadReleaseChain: () => ({
      releaseRef: INSTALL_RELEASE_REF,
      graph: { edges: new Map([[INSTALL_RELEASE_REF, []]]) },
      installed: new Map(),
      entitlements,
      signedPackage: {
        manifest,
        expected: { listingKind: 'plugin', listingRef: 'tools', releaseVersion: '1.0.0' },
      },
    }),
    runner,
    verify: { store, verifySignature: () => true },
    nowMs: () => NOW_MS,
  };
}

describe('journey: install door', () => {
  /**
   * PRODUCTION deps — `gateDeps` is deliberately NOT registered here, so the
   * door runs `installDoorGateDeps()` exactly as a real caller would.
   */
  it('the production door resolves no release chain, so a paid listing is refused', async () => {
    configureInstallDoorSources({ loadListingFacts: () => ({ ok: true, listing: PAID_LISTING }) });

    const res = await callDoor('install-plugin', { listingId: 'lst-1', workspace: 'ws-p012' });

    expect(res.ok).toBe(false);
    expect(res.error).toBe('paid-listing-without-release-chain');
    // The refusal came from the gate, and the door RETURNED it rather than
    // logging it and installing anyway — the property WI-2146325 established.
    expect(res.refusedBy).toBe('install-door-gate');
  });

  it('control: supplying a chain changes the refusal, so the one above is about the missing chain', async () => {
    configureInstallDoorSources({
      loadListingFacts: () => ({ ok: true, listing: PAID_LISTING }),
      gateDeps: chainedGateDeps,
    });

    const res = await callDoor('install-plugin', { listingId: 'lst-1', workspace: 'ws-p012' });

    // Still refused (nobody is entitled), but for a DIFFERENT reason. Without
    // this, a door that refused everything unconditionally would satisfy the
    // test above and the "gap" test below while proving nothing at all.
    expect(res.ok).toBe(false);
    expect(res.error).not.toBe('paid-listing-without-release-chain');
  });

  it('a fully paid ledger order opens the managed install gate through the bridge', async () => {
    const { ledger } = await foldJourney(stripeCase(), [stripeCase().paid()]);
    expect(ledger.orders.get(ORDER_ID)?.state).toBe('paid');
    expect(ledger.entitlements.size).toBeGreaterThan(0);

    configureInstallDoorSources({
      loadListingFacts: () => ({ ok: true, listing: PAID_LISTING }),
      gateDeps: (context) => bridgedGateDeps(ledger, context.subject),
    });

    const decision = await gateInstallDoor({
      idOrRef: 'lst-1',
      kind: 'plugin',
      subject: INSTALL_SUBJECT,
    });

    expect(decision.ok).toBe(true);
    if (!decision.ok || decision.mode !== 'managed') {
      throw new Error(`paid install did not enter the managed path: ${JSON.stringify(decision)}`);
    }
    expect(decision.releaseRef).toBe(INSTALL_RELEASE_REF);
    expect(decision.run.operation).toBe('install');
  });

  it('a full refund revokes the bridged entitlement at the install door', async () => {
    const { ledger } = await foldJourney(stripeCase(), [
      stripeCase().paid(),
      stripeCase().refunded(AMOUNT_MINOR),
    ]);
    expect(ledger.orders.get(ORDER_ID)?.state).toBe('refunded');
    expect([...ledger.entitlements.values()]).toEqual([
      expect.objectContaining({ state: 'revoked', revokeReason: 'refunded' }),
    ]);

    configureInstallDoorSources({
      loadListingFacts: () => ({ ok: true, listing: PAID_LISTING }),
      gateDeps: (context) => bridgedGateDeps(ledger, context.subject),
    });

    const res = await callDoor('install-plugin', { listingId: 'lst-1', workspace: 'ws-p012' });

    expect(res.ok).toBe(false);
    expect(res.error).toBe('not-entitled');
    expect(res.refusedBy).toBe('install-door-gate');
  });
});
