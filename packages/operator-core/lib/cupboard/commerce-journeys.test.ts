/**
 * P-012 — end-to-end commerce journey verification.
 *
 * Every other suite in this cluster tests ONE module against hand-built inputs.
 * This one drives the real path a real purchase takes, module to module, with
 * nothing stubbed between them:
 *
 *   signed Stripe webhook bytes
 *     -> createStripeAdapter (signature + normalize)
 *     -> ingestWebhook       (idempotency + inbox record)
 *     -> reduceLedger        (orders, entitlements, refunds)
 *     -> commerce-accounts   (seats, installations, D-042 intent rule)
 *     -> commerce-dashboards (checkout / refund / support / audit)
 *
 * The point of an integration suite here is to catch what per-module tests
 * structurally cannot: a seam where two modules each behave correctly against
 * their own fixtures but disagree about the value crossing between them. The
 * webhook's `metadata.orderId` -> ledger `orderId` -> entitlement -> seat chain
 * is exactly such a seam, and it is only exercised when the modules are run
 * together against bytes rather than against each other's mocks.
 *
 * Bodies are signed with the REAL HMAC (`computeStripeSignature`) rather than a
 * stubbed verifier, so the signature path is covered too: a suite that bypasses
 * verification would keep passing if verification broke open.
 */

import { describe, expect, it } from 'vitest';

import {
  computeStripeSignature,
  createStripeAdapter,
  STRIPE_SIGNATURE_HEADER,
} from './payment-adapters/stripe';
import { ingestWebhook, memoryWebhookInboxStore, type PaymentProviderAdapter } from './webhook-inbox';
import { reduceLedger, type LedgerEvent, type LedgerState } from './commerce-ledger';
import {
  allocateSeat,
  authorizeSeatIntent,
  resolveBuyerPrincipal,
  seatsForOffer,
  type Installation,
  type Organization,
  type SeatPolicy,
} from './commerce-accounts';
import { auditExport, checkoutDashboard, refundDashboard, supportDashboard } from './commerce-dashboards';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const SECRET = 'whsec_test_p012';
const NOW_SEC = 1_800_000_000;
const NOW_MS = NOW_SEC * 1000;

function signedRequest(body: unknown, opts: { nowMs?: number; secret?: string } = {}) {
  const rawBody = JSON.stringify(body);
  const nowMs = opts.nowMs ?? NOW_MS;
  const t = Math.floor(nowMs / 1000);
  const sig = computeStripeSignature(opts.secret ?? SECRET, t, rawBody);
  return { rawBody, headers: { [STRIPE_SIGNATURE_HEADER]: `t=${t},v1=${sig}` }, nowMs };
}

function checkoutCompleted(id: string, orderId: string, amountTotal: number, currency = 'usd') {
  return {
    id,
    type: 'checkout.session.completed',
    created: NOW_SEC,
    data: {
      object: {
        id: `cs_${orderId}`,
        payment_status: 'paid',
        payment_intent: `pi_${orderId}`,
        amount_total: amountTotal,
        currency,
        metadata: { orderId },
      },
    },
  };
}

function chargeRefunded(id: string, orderId: string, refundId: string, amount: number, currency = 'usd') {
  return {
    id,
    type: 'charge.refunded',
    created: NOW_SEC + 60,
    data: {
      object: {
        id: `ch_${orderId}`,
        currency,
        metadata: { orderId },
        refunds: { data: [{ id: refundId, status: 'succeeded', amount, currency }] },
      },
    },
  };
}

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
        offerId: 'offer-1',
        productId: 'prod-1',
        pricingModel: 'one-time',
        price: { amountMinor: 5000, currency: 'USD' },
      },
    },
    {
      ledgerEventId: 'cat-3',
      kind: 'order.created',
      occurredAtMs: NOW_MS - 8_000,
      source,
      payload: { orderId: 'ord-1', offerId: 'offer-1', buyerId: 'org-acme' },
    },
  ];
}

const ACME: Organization = {
  orgId: 'org-acme',
  displayName: 'Acme',
  memberships: [
    { userId: 'alice', role: 'owner', addedAtMs: 1 },
    { userId: 'bob', role: 'member', addedAtMs: 2 },
  ],
};
const ORGS = new Map<string, Organization>([[ACME.orgId, ACME]]);
const SEATS = new Map<string, SeatPolicy>([['offer-1', { offerId: 'offer-1', seats: 2 }]]);

async function ingest(adapter: PaymentProviderAdapter, body: unknown, opts?: { nowMs?: number }) {
  const store = memoryWebhookInboxStore();
  return { store, result: await ingestWebhook({ adapter, store, request: signedRequest(body, opts) }) };
}

/** Drive the whole path and hand back the ledger plus the events that built it. */
async function purchaseJourney(extra: unknown[] = []): Promise<{ ledger: LedgerState; webhookEvents: LedgerEvent[] }> {
  const adapter = createStripeAdapter({ webhookSecret: SECRET });
  const store = memoryWebhookInboxStore();
  const webhookEvents: LedgerEvent[] = [];
  for (const body of [checkoutCompleted('evt_paid', 'ord-1', 5000), ...extra]) {
    const res = await ingestWebhook({ adapter, store, request: signedRequest(body) });
    if (res.outcome === 'accepted') webhookEvents.push(...res.events);
  }
  return { ledger: reduceLedger([...catalogEvents(), ...webhookEvents]), webhookEvents };
}

// ---------------------------------------------------------------------------
// Journey 1 — purchase -> webhook -> entitlement
// ---------------------------------------------------------------------------

describe('journey: purchase -> webhook -> entitlement', () => {
  it('a signed checkout.session.completed grants an active entitlement end to end', async () => {
    const { ledger, webhookEvents } = await purchaseJourney();

    // The webhook produced ledger facts, not just an inbox row.
    expect(webhookEvents.map((e) => e.kind)).toEqual(['order.paid']);
    expect(ledger.rejected).toEqual([]);

    const order = ledger.orders.get('ord-1');
    expect(order?.state).toBe('paid');
    // The seam that only an integration test covers: metadata.orderId on the
    // provider's bytes has to land on the ledger's own order key.
    expect(order?.buyerId).toBe('org-acme');
    expect(order?.providerRef).toBe('pi_ord-1');

    const ent = ledger.entitlements.get('ent:ord-1');
    expect(ent?.state).toBe('active');
    expect(ent?.productId).toBe('prod-1');
  });

  it('surfaces on the buyer checkout dashboard with correct money', async () => {
    const { ledger } = await purchaseJourney();
    const view = checkoutDashboard({
      buyerId: 'org-acme',
      ledger,
      orgs: ORGS,
      seatPolicies: SEATS,
      installations: [],
      currency: 'USD',
    });
    expect(view.principal.kind).toBe('organization');
    expect(view.lines).toHaveLength(1);
    expect(view.lines[0].entitlementState).toBe('active');
    expect(view.grossMinor).toBe(5000);
    expect(view.netMinor).toBe(5000);
  });

  it('an UNSIGNED body never reaches the ledger at all', async () => {
    const adapter = createStripeAdapter({ webhookSecret: SECRET });
    const store = memoryWebhookInboxStore();
    const res = await ingestWebhook({
      adapter,
      store,
      request: { ...signedRequest(checkoutCompleted('evt_x', 'ord-1', 5000), { secret: 'whsec_wrong' }) },
    });
    expect(res.outcome).toBe('rejected');
    if (res.outcome !== 'rejected') throw new Error('unreachable');
    expect(res.code).toBe('bad-signature');
    // Fail-closed: nothing recorded, so nothing can be replayed into the fold.
    expect(store.records()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Journey 2 — entitlement -> seat -> install / update
// ---------------------------------------------------------------------------

describe('journey: entitlement -> seat -> install/update', () => {
  it('a paid entitlement lets an org member take a seat and install', async () => {
    const { ledger } = await purchaseJourney();
    const ent = ledger.entitlements.get('ent:ord-1')!;
    const order = ledger.orders.get('ord-1')!;

    const alloc = allocateSeat({
      entitlement: ent,
      principal: resolveBuyerPrincipal(order.buyerId, ORGS),
      granted: seatsForOffer(order.offerId, SEATS),
      installations: [],
      holderId: 'alice',
      deviceRef: 'laptop-1',
      installationId: 'inst-1',
      nowMs: NOW_MS,
    });
    expect(alloc.ok).toBe(true);
    if (!alloc.ok) throw new Error('unreachable');

    for (const intent of ['install', 'update', 'repair'] as const) {
      expect(authorizeSeatIntent(alloc.installation, ent, intent).ok).toBe(true);
    }
  });

  it('a NON-member of the buying org is refused before seats are considered', async () => {
    const { ledger } = await purchaseJourney();
    const view = supportDashboard({
      userId: 'mallory',
      buyerId: 'org-acme',
      intent: 'install',
      ledger,
      orgs: ORGS,
      seatPolicies: SEATS,
      installations: [],
    });
    expect(view.entitled).toBe(false);
    expect(view.findings[0].blocked?.code).toBe('not-entitled');
  });

  it('the seat policy bounds concurrent installations', async () => {
    const { ledger } = await purchaseJourney();
    const ent = ledger.entitlements.get('ent:ord-1')!;
    const principal = resolveBuyerPrincipal('org-acme', ORGS);
    const taken: Installation[] = [];

    for (const [holder, device, id] of [
      ['alice', 'laptop-1', 'inst-1'],
      ['bob', 'laptop-2', 'inst-2'],
    ] as const) {
      const r = allocateSeat({
        entitlement: ent,
        principal,
        granted: 2,
        installations: taken,
        holderId: holder,
        deviceRef: device,
        installationId: id,
        nowMs: NOW_MS,
      });
      expect(r.ok).toBe(true);
      if (r.ok) taken.push(r.installation);
    }

    const third = allocateSeat({
      entitlement: ent,
      principal,
      granted: 2,
      installations: taken,
      holderId: 'alice',
      deviceRef: 'laptop-3',
      installationId: 'inst-3',
      nowMs: NOW_MS,
    });
    expect(third.ok).toBe(false);
    if (third.ok) throw new Error('unreachable');
    expect(third.code).toBe('no-seats-available');
  });
});

// ---------------------------------------------------------------------------
// Journey 3 — refund -> revoke, and what survives it (D-042)
// ---------------------------------------------------------------------------

describe('journey: refund -> revoke', () => {
  it('a refund webhook revokes the entitlement without bricking the install', async () => {
    const { ledger } = await purchaseJourney([
      chargeRefunded('evt_refund', 'ord-1', 're_1', 5000),
    ]);
    expect(ledger.rejected).toEqual([]);

    const order = ledger.orders.get('ord-1')!;
    expect(order.state).toBe('refunded');
    expect(order.refundedMinor).toBe(5000);

    const ent = ledger.entitlements.get('ent:ord-1')!;
    expect(ent.state).toBe('revoked');
    expect(ent.revokeReason).toBe('refunded');

    const installed: Installation = {
      installationId: 'inst-1',
      entitlementId: 'ent:ord-1',
      holderId: 'alice',
      deviceRef: 'laptop-1',
      state: 'active',
      allocatedAtMs: NOW_MS,
      releasedAtMs: null,
    };

    // The whole point of D-042, reached through the COMMERCIAL door: the
    // customer cannot move forward, but what is already running keeps running
    // and stays repairable.
    expect(authorizeSeatIntent(installed, ent, 'install').ok).toBe(false);
    expect(authorizeSeatIntent(installed, ent, 'update').ok).toBe(false);
    expect(authorizeSeatIntent(installed, ent, 'repair').ok).toBe(true);
  });

  it('the support dashboard explains the refusal in the customer-facing terms', async () => {
    const { ledger } = await purchaseJourney([
      chargeRefunded('evt_refund', 'ord-1', 're_1', 5000),
    ]);
    const installations: Installation[] = [
      {
        installationId: 'inst-1',
        entitlementId: 'ent:ord-1',
        holderId: 'alice',
        deviceRef: 'laptop-1',
        state: 'active',
        allocatedAtMs: NOW_MS,
        releasedAtMs: null,
      },
    ];
    const blockedView = supportDashboard({
      userId: 'alice',
      buyerId: 'org-acme',
      intent: 'update',
      ledger,
      orgs: ORGS,
      seatPolicies: SEATS,
      installations,
    });
    expect(blockedView.findings[0].blocked?.code).toBe('entitlement-revoked');

    const repairView = supportDashboard({
      userId: 'alice',
      buyerId: 'org-acme',
      intent: 'repair',
      ledger,
      orgs: ORGS,
      seatPolicies: SEATS,
      installations,
    });
    expect(repairView.anyPermitted).toBe(true);
  });

  it('a PARTIAL refund leaves the entitlement active and the remainder refundable', async () => {
    const { ledger } = await purchaseJourney([
      chargeRefunded('evt_refund', 'ord-1', 're_1', 2000),
    ]);
    const order = ledger.orders.get('ord-1')!;
    expect(order.state).toBe('partially-refunded');
    expect(ledger.entitlements.get('ent:ord-1')!.state).toBe('active');

    const [pos] = refundDashboard({ ledger, installations: [] });
    expect(pos.settledMinor).toBe(2000);
    expect(pos.refundableMinor).toBe(3000);
  });
});

// ---------------------------------------------------------------------------
// Journey 4 — provider replacement contract
// ---------------------------------------------------------------------------

describe('contract: a provider is replaceable', () => {
  /**
   * A second provider is only a different way of PRODUCING LedgerEvents. The
   * reducer's own docs say it never branches on `source.provider`; this asserts
   * it, because a provider-conditional branch added later would still pass every
   * stripe-only test in the tree.
   */
  it('an equivalent event stream from another provider yields an identical ledger', async () => {
    const { webhookEvents } = await purchaseJourney();
    const viaStripe = reduceLedger([...catalogEvents(), ...webhookEvents]);

    const viaOther = reduceLedger([
      ...catalogEvents(),
      ...webhookEvents.map((e) => ({
        ...e,
        ledgerEventId: e.ledgerEventId.replace('stripe:', 'acme-pay:'),
        source: { provider: 'acme-pay', providerEventId: 'ap_1' },
      })),
    ]);

    const shape = (s: LedgerState) => ({
      orders: [...s.orders.values()].map((o) => ({ ...o, provider: null, providerRef: null })),
      entitlements: [...s.entitlements.values()],
      refunds: [...s.refunds.values()].map((r) => ({ ...r, provider: null, providerRef: null })),
      rejected: s.rejected,
    });

    // Provider identity is RECORDED (it is on the order) but never DECIDES.
    expect(shape(viaOther)).toEqual(shape(viaStripe));
    expect(viaStripe.orders.get('ord-1')!.provider).toBe('stripe');
    expect(viaOther.orders.get('ord-1')!.provider).toBe('acme-pay');
  });

  it('the inbox scopes idempotency per provider, so two providers cannot collide', async () => {
    const adapter = createStripeAdapter({ webhookSecret: SECRET });
    const store = memoryWebhookInboxStore();
    const body = checkoutCompleted('evt_paid', 'ord-1', 5000);

    const first = await ingestWebhook({ adapter, store, request: signedRequest(body) });
    expect(first.outcome).toBe('accepted');

    // Same provider + same id + same bytes = a replay, not a second payment.
    const replay = await ingestWebhook({ adapter, store, request: signedRequest(body) });
    expect(replay.outcome).toBe('duplicate');

    // A different provider reusing the same event id is a DIFFERENT fact.
    const other: PaymentProviderAdapter = { ...adapter, provider: 'acme-pay' };
    const cross = await ingestWebhook({ adapter: other, store, request: signedRequest(body) });
    expect(cross.outcome).toBe('accepted');
  });

  it('the same event id with DIFFERENT bytes is refused as a replay mismatch', async () => {
    const adapter = createStripeAdapter({ webhookSecret: SECRET });
    const store = memoryWebhookInboxStore();

    await ingestWebhook({ adapter, store, request: signedRequest(checkoutCompleted('evt_1', 'ord-1', 5000)) });
    const tampered = await ingestWebhook({
      adapter,
      store,
      request: signedRequest(checkoutCompleted('evt_1', 'ord-1', 9999)),
    });

    expect(tampered.outcome).toBe('rejected');
    if (tampered.outcome !== 'rejected') throw new Error('unreachable');
    expect(tampered.code).toBe('replay-mismatch');
  });

  it('a duplicate delivery cannot double-grant or double-charge', async () => {
    const adapter = createStripeAdapter({ webhookSecret: SECRET });
    const store = memoryWebhookInboxStore();
    const body = checkoutCompleted('evt_paid', 'ord-1', 5000);

    const events: LedgerEvent[] = [];
    for (let i = 0; i < 3; i += 1) {
      const res = await ingestWebhook({ adapter, store, request: signedRequest(body) });
      if (res.outcome === 'accepted') events.push(...res.events);
    }

    expect(events).toHaveLength(1); // two of three were absorbed as duplicates
    const ledger = reduceLedger([...catalogEvents(), ...events]);
    expect(ledger.entitlements.size).toBe(1);
    expect(ledger.orders.get('ord-1')!.state).toBe('paid');
  });
});

// ---------------------------------------------------------------------------
// Journey 5 — the audit export describes the journey that actually happened
// ---------------------------------------------------------------------------

describe('journey: audit export', () => {
  it('reproduces the full purchase-and-refund history', async () => {
    const { ledger } = await purchaseJourney([
      chargeRefunded('evt_refund', 'ord-1', 're_1', 5000),
    ]);
    const out = auditExport({
      ledger,
      installations: [],
      orgs: ORGS,
      creatorProfiles: new Map(),
    });

    expect(out.orders.map((o) => o.state)).toEqual(['refunded']);
    expect(out.refunds.map((r) => r.state)).toEqual(['succeeded']);
    expect(out.entitlements.map((e) => e.state)).toEqual(['revoked']);
    expect(out.integrity.rejectedCount).toBe(0);
    // A creator with no profile on file is reported as unpayable, not omitted.
    expect(out.payouts).toEqual([]);
  });
});
