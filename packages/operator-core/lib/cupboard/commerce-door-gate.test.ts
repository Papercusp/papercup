/**
 * commerce-door-gate — the authorization rules the four P-011 doors share
 * (D-045 §3d scope item 4, WI-2146326).
 *
 * The cases here are the ones a door would otherwise each have to remember:
 * an org that does not exist, an actor who is a stranger to it, a refund
 * against someone else's order, a refund larger than what is safely available,
 * and the purity of the dashboards read.
 */
import { describe, expect, it } from 'vitest';

import type { Installation, Organization, SeatPolicy, CreatorProfile } from './commerce-accounts';
import { reduceLedger, type LedgerEvent } from './commerce-ledger';
import {
  authorizeOrgActor,
  gateCheckout,
  gateCommerceDashboards,
  gateRefundRequest,
  gateSupportRequest,
  type CommerceSnapshot,
} from './commerce-door-gate';

const ORG_ID = 'org-acme';
const MEMBER = 'user-mia';
const STRANGER = 'user-nobody';

function orgs(): Map<string, Organization> {
  return new Map<string, Organization>([
    [
      ORG_ID,
      {
        orgId: ORG_ID,
        displayName: 'Acme',
        memberships: [
          { userId: MEMBER, role: 'admin', addedAtMs: 1_000 },
          { userId: 'user-sam', role: 'member', addedAtMs: 1_000 },
        ],
      },
    ],
  ]);
}

/**
 * A paid, settled order for the org — the state every refund case starts from.
 * Built through the real reducer rather than hand-assembled, so a rule change
 * in `commerce-ledger` cannot leave these fixtures describing a state the
 * ledger would never actually produce.
 */
function ledgerEvents(extra: readonly LedgerEvent[] = []): LedgerEvent[] {
  const src = { provider: 'stripe', providerEventId: null };
  return [
    {
      ledgerEventId: 'e1',
      kind: 'product.defined',
      occurredAtMs: 1_000,
      source: src,
      payload: { productId: 'prod-1', skuRef: 'sku-1', creatorId: 'creator-1', title: 'Widget', active: true },
    },
    {
      ledgerEventId: 'e2',
      kind: 'offer.defined',
      occurredAtMs: 1_100,
      source: src,
      payload: {
        offerId: 'offer-1',
        productId: 'prod-1',
        pricingModel: 'one-time',
        price: { amountMinor: 10_000, currency: 'USD' },
        active: true,
      },
    },
    {
      ledgerEventId: 'e3',
      kind: 'order.created',
      occurredAtMs: 1_200,
      source: src,
      payload: {
        orderId: 'order-1',
        offerId: 'offer-1',
        buyerId: ORG_ID,
        amount: { amountMinor: 10_000, currency: 'USD' },
      },
    },
    {
      ledgerEventId: 'e4',
      kind: 'order.paid',
      occurredAtMs: 1_300,
      source: src,
      payload: { orderId: 'order-1', provider: 'stripe', providerRef: 'pi_1' },
    },
    ...extra,
  ];
}

function snapshot(extra: readonly LedgerEvent[] = []): CommerceSnapshot {
  return {
    ledger: reduceLedger(ledgerEvents(extra)),
    orgs: orgs(),
    seatPolicies: new Map<string, SeatPolicy>(),
    installations: [] as readonly Installation[],
    creatorProfiles: new Map<string, CreatorProfile>(),
    // These fixtures predate the P2P bridge and exercise the ledger-only
    // doors; null is the honest value for "no P2P commerce source is wired".
    perUse: null,
  };
}

const CHECKOUT = {
  buyerOrgId: ORG_ID,
  actingUserId: MEMBER,
  offerId: 'offer-1',
  successUrl: 'https://example.test/ok',
  cancelUrl: 'https://example.test/no',
  idempotencyKey: 'key-1',
};

describe('authorizeOrgActor', () => {
  it('refuses an org that does not exist instead of falling back to an individual buyer', () => {
    // THE RULE THIS PROTECTS: resolveBuyerPrincipal never fails — an unknown id
    // comes back as { kind:'individual', userId:<that id> }. A door trusting
    // that fallback would authorize a caller who named a nonexistent org as if
    // they WERE that buyer. Nothing else in the stack catches it.
    const verdict = authorizeOrgActor('org-does-not-exist', MEMBER, orgs());
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error('unreachable');
    expect(verdict.code).toBe('unknown-org');
  });

  it('refuses an actor who is a stranger to a real org', () => {
    const verdict = authorizeOrgActor(ORG_ID, STRANGER, orgs());
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error('unreachable');
    expect(verdict.code).toBe('actor-not-in-org');
  });

  it('admits a member and reports the role', () => {
    const verdict = authorizeOrgActor(ORG_ID, MEMBER, orgs());
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) throw new Error('unreachable');
    expect(verdict.role).toBe('admin');
  });

  it('would NOT have caught the unknown org if the fallback were trusted', () => {
    // Calibration for the first case: the same id DOES resolve as an
    // individual, which is what makes the explicit kind check load-bearing
    // rather than redundant.
    const verdict = authorizeOrgActor('org-does-not-exist', 'org-does-not-exist', orgs());
    expect(verdict.ok).toBe(false);
  });
});

describe('gateCheckout', () => {
  it('shapes the hosted request for an authorized member', () => {
    const decision = gateCheckout(CHECKOUT, snapshot());
    expect(decision.ok).toBe(true);
    if (!decision.ok) throw new Error('unreachable');
    // actingUserId is deliberately ABSENT from the hosted request: the actor is
    // an authorization input, not something the payment provider is told.
    expect(decision.request).toEqual({
      buyerOrgId: ORG_ID,
      offerId: 'offer-1',
      successUrl: 'https://example.test/ok',
      cancelUrl: 'https://example.test/no',
      idempotencyKey: 'key-1',
      quantity: 1,
    });
  });

  it('passes a positive per-use channel cap to the hosted preflight', () => {
    const decision = gateCheckout({ ...CHECKOUT, maxSpendMicros: 25_000 }, snapshot());
    expect(decision.ok).toBe(true);
    if (!decision.ok) throw new Error('unreachable');
    expect(decision.request.maxSpendMicros).toBe(25_000);
  });

  it('refuses an invalid per-use channel cap before transport', () => {
    const decision = gateCheckout({ ...CHECKOUT, maxSpendMicros: 0 }, snapshot());
    expect(decision.ok).toBe(false);
    if (decision.ok) throw new Error('unreachable');
    expect(decision.code).toBe('invalid-max-spend');
  });

  it('refuses a quantity other than 1 before any provider call', () => {
    const decision = gateCheckout({ ...CHECKOUT, quantity: 3 }, snapshot());
    expect(decision.ok).toBe(false);
    if (decision.ok) throw new Error('unreachable');
    expect(decision.code).toBe('unsupported-quantity');
  });

  it('refuses an unknown org', () => {
    const decision = gateCheckout({ ...CHECKOUT, buyerOrgId: 'nope' }, snapshot());
    expect(decision.ok).toBe(false);
    if (decision.ok) throw new Error('unreachable');
    expect(decision.code).toBe('unknown-org');
  });
});

describe('gateRefundRequest', () => {
  const base = { buyerOrgId: ORG_ID, actingUserId: MEMBER, orderId: 'order-1' };

  it('authorizes the full refundable remainder when no amount is given', () => {
    const decision = gateRefundRequest(base, snapshot());
    expect(decision.ok).toBe(true);
    if (!decision.ok) throw new Error('unreachable');
    expect(decision.request.amount).toEqual({ amountMinor: 10_000, currency: 'USD' });
  });

  it('refuses an unentitled actor — a stranger to the buying org', () => {
    const decision = gateRefundRequest({ ...base, actingUserId: STRANGER }, snapshot());
    expect(decision.ok).toBe(false);
    if (decision.ok) throw new Error('unreachable');
    expect(decision.code).toBe('actor-not-in-org');
  });

  it("refuses refunding another org's order even for a legitimate admin", () => {
    const other = snapshot();
    const orgsWithBoth = new Map(other.orgs);
    orgsWithBoth.set('org-other', {
      orgId: 'org-other',
      displayName: 'Other',
      memberships: [{ userId: MEMBER, role: 'owner', addedAtMs: 1_000 }],
    });
    const decision = gateRefundRequest(
      { ...base, buyerOrgId: 'org-other' },
      { ...other, orgs: orgsWithBoth },
    );
    expect(decision.ok).toBe(false);
    if (decision.ok) throw new Error('unreachable');
    expect(decision.code).toBe('order-not-owned');
  });

  it('refuses an unknown order', () => {
    const decision = gateRefundRequest({ ...base, orderId: 'order-404' }, snapshot());
    expect(decision.ok).toBe(false);
    if (decision.ok) throw new Error('unreachable');
    expect(decision.code).toBe('unknown-order');
  });

  it('refuses an amount larger than the order', () => {
    const decision = gateRefundRequest({ ...base, amountMinor: 10_001 }, snapshot());
    expect(decision.ok).toBe(false);
    if (decision.ok) throw new Error('unreachable');
    expect(decision.code).toBe('refund-exceeds-refundable');
  });

  it('subtracts an IN-FLIGHT refund from what may be requested', () => {
    // The rule EI-22438759043480870 exists for: `Order.refundedMinor` is still
    // 0 while a refund is merely requested, so a ceiling read from it would let
    // this second request take the full 10_000 on top of the pending 6_000 and
    // together exceed the order. Only `refundableMinor` subtracts the pending
    // leg — which is why this case, not the one above, is the load-bearing one.
    const pending = snapshot([
      {
        ledgerEventId: 'e5',
        kind: 'refund.requested',
        occurredAtMs: 1_400,
        source: { provider: 'stripe', providerEventId: null },
        payload: {
          refundId: 'refund-1',
          orderId: 'order-1',
          amount: { amountMinor: 6_000, currency: 'USD' },
        },
      },
    ]);
    expect(pending.ledger.orders.get('order-1')?.refundedMinor).toBe(0);

    const decision = gateRefundRequest({ ...base, amountMinor: 5_000 }, pending);
    expect(decision.ok).toBe(false);
    if (decision.ok) throw new Error('unreachable');
    expect(decision.code).toBe('refund-exceeds-refundable');
    expect(decision.detail).toContain('4000');

    const withinRemainder = gateRefundRequest({ ...base, amountMinor: 4_000 }, pending);
    expect(withinRemainder.ok).toBe(true);
  });
});

describe('gateSupportRequest', () => {
  it('lets an org admin diagnose a colleague', () => {
    const decision = gateSupportRequest(
      { buyerOrgId: ORG_ID, actingUserId: MEMBER, subjectUserId: 'user-sam', intent: 'install' },
      snapshot(),
    );
    expect(decision.ok).toBe(true);
    if (!decision.ok) throw new Error('unreachable');
    expect(decision.dashboard.userId).toBe('user-sam');
  });

  it('refuses a stranger diagnosing anyone in the org', () => {
    const decision = gateSupportRequest(
      { buyerOrgId: ORG_ID, actingUserId: STRANGER, subjectUserId: MEMBER, intent: 'install' },
      snapshot(),
    );
    expect(decision.ok).toBe(false);
    if (decision.ok) throw new Error('unreachable');
    expect(decision.code).toBe('actor-not-in-org');
  });
});

describe('gateCommerceDashboards', () => {
  it('returns only the requested projections', () => {
    const decision = gateCommerceDashboards(
      { buyerOrgId: ORG_ID, actingUserId: MEMBER, dashboards: ['refunds'] },
      snapshot(),
    );
    expect(decision.ok).toBe(true);
    if (!decision.ok) throw new Error('unreachable');
    expect(decision.result.refunds).toBeDefined();
    expect(decision.result.checkout).toBeUndefined();
    expect(decision.result.audit).toBeUndefined();
  });

  it('is PURE — reading leaves the ledger byte-identical', () => {
    // Purity is the whole basis for exposing this to an agent as a read: a
    // report surface that could mutate the ledger would be a write door under
    // a report's name. Serializing before and after is what makes the claim
    // falsifiable rather than asserted in a comment.
    const snap = snapshot();
    const before = JSON.stringify({
      orders: [...snap.ledger.orders.entries()],
      entitlements: [...snap.ledger.entitlements.entries()],
      refunds: [...snap.ledger.refunds.entries()],
      applied: snap.ledger.applied,
      rejected: snap.ledger.rejected,
    });

    const decision = gateCommerceDashboards({ buyerOrgId: ORG_ID, actingUserId: MEMBER }, snap);
    expect(decision.ok).toBe(true);

    const after = JSON.stringify({
      orders: [...snap.ledger.orders.entries()],
      entitlements: [...snap.ledger.entitlements.entries()],
      refunds: [...snap.ledger.refunds.entries()],
      applied: snap.ledger.applied,
      rejected: snap.ledger.rejected,
    });
    expect(after).toEqual(before);
    // Positive control: the fixture must actually CONTAIN state, or an empty
    // ledger would compare equal to itself and prove nothing.
    expect(snap.ledger.orders.size).toBeGreaterThan(0);
  });

  it('refuses a stranger before computing any projection', () => {
    const decision = gateCommerceDashboards({ buyerOrgId: ORG_ID, actingUserId: STRANGER }, snapshot());
    expect(decision.ok).toBe(false);
    if (decision.ok) throw new Error('unreachable');
    expect(decision.code).toBe('actor-not-in-org');
  });
});
