import { describe, it, expect } from 'vitest';

import type { Entitlement } from './commerce-ledger';
import {
  DELIVERY_INTENTS,
  DEFAULT_SEATS,
  allocateSeat,
  authorizeSeatIntent,
  membershipOf,
  payoutReadiness,
  principalEntitles,
  releaseSeat,
  resolveBuyerPrincipal,
  seatUsage,
  seatsForOffer,
  type CreatorProfile,
  type Installation,
  type Organization,
  type SeatPolicy,
} from './commerce-accounts';

const ORG: Organization = {
  orgId: 'org-acme',
  displayName: 'Acme',
  memberships: [
    { userId: 'u-owner', role: 'owner', addedAtMs: 1 },
    { userId: 'u-member', role: 'member', addedAtMs: 2 },
  ],
};

const orgs = new Map<string, Organization>([[ORG.orgId, ORG]]);

function entitlement(over: Partial<Entitlement> = {}): Entitlement {
  return {
    entitlementId: 'ent:o-1',
    orderId: 'o-1',
    productId: 'p-1',
    buyerId: ORG.orgId,
    state: 'active',
    grantedAtMs: 100,
    revokedAtMs: null,
    revokeReason: null,
    ...over,
  };
}

function installation(over: Partial<Installation> = {}): Installation {
  return {
    installationId: 'i-1',
    entitlementId: 'ent:o-1',
    holderId: 'u-member',
    deviceRef: 'dev-1',
    state: 'active',
    allocatedAtMs: 200,
    releasedAtMs: null,
    ...over,
  };
}

describe('buyer principals (P-011)', () => {
  it('resolves an org buyerId to the organization and anything else to an individual', () => {
    const asOrg = resolveBuyerPrincipal(ORG.orgId, orgs);
    expect(asOrg.kind).toBe('organization');

    const asPerson = resolveBuyerPrincipal('u-solo', orgs);
    expect(asPerson.kind).toBe('individual');
    expect(asPerson.kind === 'individual' && asPerson.userId).toBe('u-solo');
  });

  it('entitles exactly the org members, at ANY role — role governs admin, not entitlement', () => {
    const principal = resolveBuyerPrincipal(ORG.orgId, orgs);
    expect(principalEntitles(principal, 'u-owner')).toBe(true);
    expect(principalEntitles(principal, 'u-member')).toBe(true);
    expect(principalEntitles(principal, 'u-stranger')).toBe(false);
    expect(membershipOf(ORG, 'u-member')?.role).toBe('member');
  });

  it('entitles an individual buyer only to themselves', () => {
    const principal = resolveBuyerPrincipal('u-solo', orgs);
    expect(principalEntitles(principal, 'u-solo')).toBe(true);
    expect(principalEntitles(principal, 'u-other')).toBe(false);
  });
});

describe('creator payout readiness (P-011)', () => {
  const verified: CreatorProfile = {
    creatorId: 'c-1',
    displayName: 'Creator One',
    payout: { provider: 'stripe', externalRef: 'acct_123', verifiedAtMs: 500 },
  };

  it('accepts a verified payout reference', () => {
    const r = payoutReadiness('c-1', new Map([['c-1', verified]]));
    expect(r.ok).toBe(true);
    expect(r.ok && r.reference.externalRef).toBe('acct_123');
  });

  it('distinguishes the three ways a payout cannot settle', () => {
    expect(payoutReadiness('nobody', new Map()).ok === false && payoutReadiness('nobody', new Map()).ok).toBe(false);

    const noProfile = payoutReadiness('nobody', new Map());
    expect(noProfile.ok === false && noProfile.code).toBe('no-profile');

    const noRef = payoutReadiness('c-2', new Map([['c-2', { creatorId: 'c-2', displayName: 'Two', payout: null }]]));
    expect(noRef.ok === false && noRef.code).toBe('no-payout-reference');

    const unverified = payoutReadiness(
      'c-3',
      new Map([['c-3', { ...verified, creatorId: 'c-3', payout: { provider: 'stripe', externalRef: 'acct_9', verifiedAtMs: null } }]]),
    );
    expect(unverified.ok === false && unverified.code).toBe('payout-unverified');
    // The refusal must name the provider, or an admin cannot tell WHERE to go verify.
    expect(unverified.ok === false && unverified.detail).toContain('stripe');
  });
});

describe('seat policy (P-011)', () => {
  it('defaults to a single seat, and treats a nonsense policy as the default rather than trusting it', () => {
    const policies = new Map<string, SeatPolicy>([
      ['off-5', { offerId: 'off-5', seats: 5 }],
      ['off-zero', { offerId: 'off-zero', seats: 0 }],
      ['off-frac', { offerId: 'off-frac', seats: 2.5 }],
    ]);
    expect(seatsForOffer('off-unknown', policies)).toBe(DEFAULT_SEATS);
    expect(seatsForOffer('off-5', policies)).toBe(5);
    // 0 or a fraction would otherwise mean "nobody can install" / a partial seat.
    expect(seatsForOffer('off-zero', policies)).toBe(DEFAULT_SEATS);
    expect(seatsForOffer('off-frac', policies)).toBe(DEFAULT_SEATS);
  });

  it('counts only ACTIVE installations against capacity', () => {
    const usage = seatUsage('ent:o-1', 3, [
      installation({ installationId: 'i-1' }),
      installation({ installationId: 'i-2', state: 'released', releasedAtMs: 300 }),
      installation({ installationId: 'i-3', entitlementId: 'ent:other' }),
    ]);
    expect(usage).toEqual({ granted: 3, used: 1, available: 2 });
  });
});

describe('seat allocation (P-011)', () => {
  const principal = resolveBuyerPrincipal(ORG.orgId, orgs);
  const base = { principal, granted: 2, holderId: 'u-member', deviceRef: 'dev-1', installationId: 'i-new', nowMs: 900 };

  it('allocates a seat to an entitled member', () => {
    const r = allocateSeat({ ...base, entitlement: entitlement(), installations: [] });
    expect(r.ok).toBe(true);
    expect(r.ok && r.installation.state).toBe('active');
    expect(r.ok && r.installation.allocatedAtMs).toBe(900);
  });

  it('refuses a non-member without ever mentioning capacity', () => {
    const r = allocateSeat({ ...base, holderId: 'u-stranger', entitlement: entitlement(), installations: [] });
    expect(r.ok === false && r.code).toBe('not-entitled');
  });

  it('refuses when every seat is taken, and says how to fix it', () => {
    const r = allocateSeat({
      ...base,
      deviceRef: 'dev-3',
      entitlement: entitlement(),
      installations: [installation({ installationId: 'i-1', deviceRef: 'dev-1' }), installation({ installationId: 'i-2', deviceRef: 'dev-2' })],
    });
    expect(r.ok === false && r.code).toBe('no-seats-available');
    expect(r.ok === false && r.detail).toContain('2 seat(s)');
  });

  it('is idempotent for the same holder+device — a retried install must not eat a second seat', () => {
    const existing = installation({ installationId: 'i-1', holderId: 'u-member', deviceRef: 'dev-1' });
    const r = allocateSeat({ ...base, entitlement: entitlement(), installations: [existing] });
    expect(r.ok).toBe(true);
    // Same installation back, NOT a new id — otherwise a retry loop drains capacity.
    expect(r.ok && r.installation.installationId).toBe('i-1');
    expect(seatUsage('ent:o-1', 2, [existing]).used).toBe(1);
  });

  it('CHECKS ENTITLEMENT VALIDITY BEFORE MEMBERSHIP AND CAPACITY — the refusal order is load-bearing', () => {
    // A revoked entitlement, a stranger, and zero free seats all at once.
    // Reporting "no seats available" here would send an admin to buy seats
    // that would not have helped; the entitlement is the real blocker.
    const r = allocateSeat({
      ...base,
      holderId: 'u-stranger',
      granted: 0,
      entitlement: entitlement({ state: 'revoked', revokedAtMs: 800, revokeReason: 'refund' }),
      installations: [],
    });
    expect(r.ok === false && r.code).toBe('entitlement-revoked');
    expect(r.ok === false && r.detail).toContain('refund');
    // And it must point at the D-042 carve-out rather than reading as a dead end.
    expect(r.ok === false && r.detail).toContain('repair');
  });
});

describe('seat release (P-011)', () => {
  it('frees the seat and is idempotent', () => {
    const active = installation();
    const first = releaseSeat('i-1', [active], 1000);
    expect(first.ok && first.alreadyReleased).toBe(false);
    expect(first.ok && first.installation.state).toBe('released');
    expect(first.ok && first.installation.releasedAtMs).toBe(1000);

    const again = releaseSeat('i-1', [first.ok ? first.installation : active], 1100);
    expect(again.ok && again.alreadyReleased).toBe(true);
    // A repeated release must not move the timestamp — it is not a new event.
    expect(again.ok && again.installation.releasedAtMs).toBe(1000);
  });

  it('refuses an unknown installation', () => {
    const r = releaseSeat('i-nope', [installation()], 1000);
    expect(r.ok === false && r.code).toBe('unknown-installation');
  });
});

describe('revocation follows D-042 rather than a second rule (P-011)', () => {
  it('lets an already-active installation keep repairing after revocation, but not install or update', () => {
    const revoked = entitlement({ state: 'revoked', revokedAtMs: 800, revokeReason: 'refund' });
    const live = installation();

    expect(authorizeSeatIntent(live, revoked, 'repair').ok).toBe(true);

    for (const intent of ['install', 'update'] as const) {
      const v = authorizeSeatIntent(live, revoked, intent);
      expect(v.ok === false && v.code).toBe('entitlement-revoked');
      expect(v.ok === false && v.detail).toContain('D-042');
    }
  });

  it('authorizes every intent while the entitlement is active', () => {
    for (const intent of DELIVERY_INTENTS) {
      expect(authorizeSeatIntent(installation(), entitlement(), intent).ok).toBe(true);
    }
  });

  it('refuses EVERY intent for a released installation — holding no seat is stronger than revocation', () => {
    const released = installation({ state: 'released', releasedAtMs: 900 });
    for (const intent of DELIVERY_INTENTS) {
      const v = authorizeSeatIntent(released, entitlement(), intent);
      expect(v.ok === false && v.code).toBe('installation-released');
    }
  });

  it('DRIFT GUARD: the intents surviving revocation are exactly those surviving a yank', () => {
    // artifact-distribution refuses a yanked release for every intent except
    // 'repair' (D-042). If either side gains an intent without the other, a
    // refund would brick a running deployment while a yank would not — the
    // exact divergence D-042 was recorded to prevent. Derive both sides from
    // DELIVERY_INTENTS so a NEW intent added upstream fails here loudly
    // instead of silently defaulting to permitted on one side only.
    const revoked = entitlement({ state: 'revoked', revokedAtMs: 800, revokeReason: 'refund' });
    const survivesRevocation = DELIVERY_INTENTS.filter((i) => authorizeSeatIntent(installation(), revoked, i).ok);
    const survivesYank = DELIVERY_INTENTS.filter((i) => i === 'repair');
    expect(survivesRevocation).toEqual(survivesYank);
    expect(survivesRevocation).toEqual(['repair']);
  });
});
