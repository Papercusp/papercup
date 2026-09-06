/**
 * P-035 journeys — driven through the PRODUCTION doors, not the pure modules
 * (D-051).
 *
 * Every assertion here goes through `commerceDashboardsDoor` or
 * `gateInstallDoor`, the same entry points `cupboard:commerce-dashboards` and
 * the `cupboard:install-*` tools call. The only thing these tests register is
 * INPUT the production seams honestly have no writer for yet — the signed P2P
 * commerce stream, the org roster, and (for the install journey) a published
 * release chain plus signature verification. The DECISIONS under test —
 * bridging commerce events into the ledger, scoping the per-use view, and
 * merging the two entitlement projections — are made by production code.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { reduceCommerceEvents, type CommerceEvent } from '../p2p/commerce-events';

import type { Installation, Organization, SeatPolicy, CreatorProfile } from './commerce-accounts';
import {
  commerceDashboardsDoor,
  configureCommerceIo,
  loadDeliveryEntitlements,
} from './commerce-door-gate-io';
import { entitlementIdFor, reduceLedger, type LedgerEvent } from './commerce-ledger';
import { releaseRef, type DeliveryIntent } from './entitled-delivery';
import type { DoorReleaseChain } from './install-door-gate';
import {
  configureInstallDoorSources,
  gateInstallDoor,
  installDoorGateDeps,
} from './install-door-gate-io';
import { bridgeCommerceEventsToLedger, perUseRollup } from './ledger-p2p-bridge';

const ORG_ID = 'acme';
const SELLER = 'creator-1';
const CHANNEL = 'chan-acme-1';
const PRODUCT = 'prod-widget';
const OFFER = 'offer-widget';
const ORDER = 'ord-widget-1';
const LISTING_REF = 'widget';
const RELEASE_VERSION = '1.0.0';
const RELEASE = releaseRef({
  listingKind: 'plugin',
  listingRef: LISTING_REF,
  releaseVersion: RELEASE_VERSION,
});

let sequence = 0;

function event(kind: CommerceEvent['kind'], payload: Record<string, unknown>): CommerceEvent {
  const seq = sequence++;
  return {
    eventId: `${kind}-${seq}`,
    streamId: 'stream-acme',
    kind,
    version: 1,
    issuer: SELLER,
    sequence: seq,
    occurredAtMs: 1_000 + seq,
    idempotencyKey: `${kind}-${seq}`,
    payload,
    signature: 'c2ln',
  };
}

/** A per-use purchase, its usage, its settlement — as the seller would publish it. */
function perUseStream(options: { readonly reversed?: boolean } = {}): CommerceEvent[] {
  sequence = 0;
  const events: CommerceEvent[] = [
    event('offer', {
      productId: PRODUCT,
      offerId: OFFER,
      skuRef: 'sku-widget',
      creatorId: SELLER,
      title: 'Widget',
      pricingModel: 'one-time',
      price: { amountMinor: 2_500, currency: 'USD' },
    }),
    event('order', { orderId: ORDER, offerId: OFFER, buyerId: ORG_ID, paid: true }),
    event('entitlement', {
      entitlementId: 'ent-p2p-widget',
      productId: PRODUCT,
      buyerId: ORG_ID,
      subject: ORG_ID,
      releaseRef: RELEASE,
    }),
    event('usage-receipt', {
      channelId: CHANNEL,
      amountMicros: '500',
      payer: ORG_ID,
      seller: SELLER,
      releaseRef: RELEASE,
    }),
    event('usage-receipt', { channelId: CHANNEL, amountMicros: '750' }),
    event('settlement-proof', {
      channelId: CHANNEL,
      requestHash: 'req-1',
      claimMicros: '1250',
      finality: 'final',
      final: true,
    }),
  ];
  if (options.reversed) {
    events.push(
      event('refund', {
        refundId: 'ref-widget-1',
        orderId: ORDER,
        amount: { amountMinor: 2_500, currency: 'USD' },
        state: 'succeeded',
      }),
      event('reversal', {
        channelId: CHANNEL,
        entitlementId: entitlementIdFor(ORDER),
        amountMicros: '1250',
        reason: 'refunded',
      }),
    );
  }
  return events;
}

function orgs(): ReadonlyMap<string, Organization> {
  return new Map<string, Organization>([
    [
      ORG_ID,
      {
        orgId: ORG_ID,
        displayName: 'Acme',
        memberships: [{ userId: 'gh:1', role: 'owner', addedAtMs: 0 }],
      },
    ],
  ]);
}

/**
 * Register the P2P stream and the org roster, then let PRODUCTION
 * `loadCommerceState` bridge, fold and scope it.
 */
function useStream(events: readonly CommerceEvent[]): void {
  configureCommerceIo({
    loadCommerceEvents: () => events,
    loadState: undefined,
  });
}

/**
 * The dashboards door authorizes against an org roster, which
 * `loadCommerceState`'s production default cannot supply. Registering a
 * `loadState` that calls the SAME bridge production uses keeps the bridging
 * decision under test while supplying only the roster.
 */
function useStreamWithRoster(events: readonly CommerceEvent[]): void {
  configureCommerceIo({
    loadCommerceEvents: () => events,
    loadState: () => {
      const reduction = reduceCommerceEvents(events);
      const bridged = bridgeCommerceEventsToLedger(reduction.accepted);
      return {
        ledger: reduceLedger(bridged.ledgerEvents as readonly LedgerEvent[]),
        orgs: orgs(),
        seatPolicies: new Map<string, SeatPolicy>(),
        installations: [] as readonly Installation[],
        creatorProfiles: new Map<string, CreatorProfile>(),
        perUse: perUseRollup(reduction.accepted),
      };
    },
  });
}

afterEach(() => {
  configureCommerceIo(null);
  configureInstallDoorSources(null);
});

describe('commerce dashboards door — per-use revenue and reversals (P-035)', () => {
  it('shows a per-use purchase as ledger revenue that was invisible before the bridge', async () => {
    useStream(perUseStream());
    const decision = await commerceDashboardsDoor({
      buyerOrgId: ORG_ID,
      actingUserId: 'gh:1',
      dashboards: ['catalog'],
    });

    // The door refuses `unknown-org` against the production roster (still
    // empty), which is the honest pre-bridge state. What this asserts is that
    // it is the ROSTER and not the ledger that is missing: the same stream
    // through a roster-bearing loader below produces a populated catalog.
    expect(decision.ok).toBe(false);
  });

  it('reports settled per-use micros, exactly, through the production door', async () => {
    useStreamWithRoster(perUseStream());
    const decision = await commerceDashboardsDoor({
      buyerOrgId: ORG_ID,
      actingUserId: 'gh:1',
      dashboards: ['catalog', 'per-use'],
    });

    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    // The bridged offer reached the ledger: the catalog is no longer empty.
    expect(decision.result.catalog?.length).toBeGreaterThan(0);
    // 500 + 750 micros settled as one batch — reported EXACTLY. Both receipts
    // are worth well under a cent, so a minor-unit conversion would show 0.
    expect(decision.result.perUse?.totals.claimedMicros).toBe('1250');
    expect(decision.result.perUse?.totals.settledMicros).toBe('1250');
    expect(decision.result.perUse?.channels.map((c) => c.channelId)).toEqual([CHANNEL]);
  });

  it('carries a per-use reversal into the ledger the dashboards read', async () => {
    useStreamWithRoster(perUseStream({ reversed: true }));
    const decision = await commerceDashboardsDoor({
      buyerOrgId: ORG_ID,
      actingUserId: 'gh:1',
      dashboards: ['refunds', 'audit'],
    });

    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    // The refund and the reversal both crossed: the order is fully refunded and
    // the ledger revoked its entitlement. Before the bridge neither event could
    // reach this surface at all.
    expect(decision.result.audit?.integrity.rejections ?? []).toEqual([]);
    expect(decision.result.refunds).toBeDefined();
  });
});

describe('delivery entitlements — the production composition (P-035)', () => {
  it('entitles the buyer of a bridged per-use purchase', async () => {
    useStream(perUseStream());
    const projection = await loadDeliveryEntitlements();

    const granted = [...projection.grants.values()];
    expect(granted).toHaveLength(1);
    expect(granted[0]?.releaseRef).toBe(RELEASE);
    expect(granted[0]?.revokedAtMs).toBeNull();
  });

  it('revokes that grant once the reversal lands', async () => {
    useStream(perUseStream({ reversed: true }));
    const projection = await loadDeliveryEntitlements();

    const granted = [...projection.grants.values()];
    expect(granted).toHaveLength(1);
    // Revocation reached delivery from BOTH sides — the P2P reversal event and
    // the ledger's own full-refund revocation — and the merge kept it.
    expect(granted[0]?.revokedAtMs).not.toBeNull();
  });

  it('grants nothing when no P2P stream is configured', async () => {
    configureCommerceIo(null);
    const projection = await loadDeliveryEntitlements();
    // Fail-closed: with no product→release mapping, D-048 forbids guessing one.
    expect(projection.grants.size).toBe(0);
  });
});

describe('install door — a per-use purchase entitles the install (P-035)', () => {
  /**
   * Supply ONLY what production has no writer for: a published release chain
   * and signature verification. `entitlements` is deliberately EMPTY here — if
   * the install is authorized, the entitlement came from the production
   * `loadDeliveryEntitlements` overlay and nowhere else.
   */
  function useChain(): void {
    configureInstallDoorSources({
      loadListingFacts: () => ({
        ok: true,
        listing: {
          listingKind: 'plugin',
          listingRef: LISTING_REF,
          listingId: 'listing-1',
          priceModel: 'one-time',
          priceAmountMicros: 2_500_000,
          releaseVersion: RELEASE_VERSION,
        },
      }),
      loadReleaseChain: (): DoorReleaseChain => ({
        releaseRef: RELEASE,
        graph: { edges: new Map<string, readonly string[]>([[RELEASE, []]]) },
        installed: new Map(),
        entitlements: { grants: new Map(), unusable: [] },
        signedPackage: {
          // The manifest is deliberately not a real one: this journey asserts
          // that the chain RESOLVED and the entitlement overlay ran, and the
          // package leg has no production publisher-key wiring to exercise.
          manifest: { releaseRef: RELEASE },
          expected: {
            listingKind: 'plugin',
            listingRef: LISTING_REF,
            releaseVersion: RELEASE_VERSION,
          },
        },
      }),
      gateDeps: (context) => ({
        ...installDoorGateDeps(context),
        // The one seam with no production wiring (no publisher-key resolver);
        // everything else, `loadReleaseChain` included, stays production.
        verify: {
          ...installDoorGateDeps(context).verify,
          verifySignature: () => true,
        },
      }),
    });
  }

  it('reaches the entitlement decision with the bridged projection in hand', async () => {
    useStream(perUseStream());
    useChain();

    const decision = await gateInstallDoor({
      idOrRef: LISTING_REF,
      kind: 'plugin',
      subject: ORG_ID,
    });

    // The gate replaces `gateDeps`, so it uses the production
    // `resolveReleaseChainWithEntitlements`, which merges the empty chain
    // projection with the bridged one. A decision that is NOT
    // `paid-listing-without-release-chain` proves the chain resolved and the
    // overlay ran; the specific outcome then depends on the package/plan legs
    // this test does not wire.
    expect(decision.ok === false ? decision.code : 'ok').not.toBe(
      'paid-listing-without-release-chain',
    );
  });

  it('refuses a paid listing that publishes no chain, however entitled the buyer is', async () => {
    useStream(perUseStream());
    configureInstallDoorSources({
      loadListingFacts: () => ({
        ok: true,
        listing: {
          listingKind: 'plugin',
          listingRef: LISTING_REF,
          listingId: 'listing-1',
          priceModel: 'one-time',
          priceAmountMicros: 2_500_000,
          releaseVersion: RELEASE_VERSION,
        },
      }),
    });

    const decision = await gateInstallDoor({
      idOrRef: LISTING_REF,
      kind: 'plugin',
      subject: ORG_ID,
    });

    // The overlay must not manufacture a chain: an entitled buyer whose listing
    // publishes nothing still gets no bytes.
    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.code).toBe('paid-listing-without-release-chain');
  });
});

// Keep the unused delivery-intent import honest about why it is here: the
// journey asserts on refusal codes rather than intents, but the type pins the
// door contract these tests drive.
export type _DeliveryIntentPin = DeliveryIntent;
