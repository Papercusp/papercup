/**
 * remote-seat-inventory.test.ts — pot-seat-pools-prose-ux-2026-07-18
 * P-007/P-013/P-014: the impure resolver that feeds `RemoteSeatSummary` into
 * the routing-gate kickoff text (launch-prompt.ts stays pure/dependency-free).
 *
 * What a regression here breaks: the routing gate silently reverts to the
 * static "local fleet only" text on a shared pot with real donated seats
 * (P-007), or crashes/blocks a plan launch when the offer-store read errors
 * (the fail-soft contract), or double-counts a fleet-scoped offer that isn't
 * actually spendable by the not-yet-created fleet this gate is about.
 *
 * Pure DI — no PG.
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/plans/remote-seat-inventory.test.ts
 */
import { describe, expect, it, vi } from 'vitest';
import { resolveRemoteSeatInventory } from './remote-seat-inventory';
import type { StoredWorkOffer } from '../../p2p/offer-store';
import type { WorkOfferStoreRecord } from '../../p2p/offer-store-schema';

const WS = 'ws-1';
const HOME = 'hive-home';

/** A pot-scoped (potSlug set, fleetSlug null) standing seat-offer — P-001. */
function potSeatOffer(over: {
  publisherGithubUserId: number;
  count: number;
  potSlug?: string;
  hostLabel?: string | null;
}): StoredWorkOffer {
  const record: WorkOfferStoreRecord = {
    offerId: `seat-${over.publisherGithubUserId}`,
    publisherGithubUserId: over.publisherGithubUserId,
    fleetSlug: null,
    potSlug: over.potSlug ?? HOME,
    kind: 'seat',
    status: 'open',
    cancelReason: null,
    workOffer: null,
    authorship: null,
    seat: {
      model: 'haiku',
      effort: 'low',
      count: over.count,
      accountScope: 'auto',
      hostLabel: over.hostLabel ?? null,
      audience: 'trusted-members',
    },
    spawnRequest: null,
    recordVersion: 1,
  };
  return {
    workspaceId: WS,
    potHomeSlug: HOME,
    publisherGithubUserId: record.publisherGithubUserId,
    offerId: record.offerId,
    record,
    recordJson: JSON.stringify(record),
    signerDevicePubkey: 'pk',
    signature: 'sig',
    recordVersion: 1,
    fleetSlug: null,
    potSlug: record.potSlug,
    offerKind: record.kind,
    status: record.status,
    localDisposition: null,
    fedHlc: null,
    updatedAt: 1,
  };
}

/** A fleet-SCOPED (fleetSlug set, potSlug null) offer — pre-P-001 shape, still
 *  the norm for an offer donated to an already-existing fleet. Not spendable
 *  by the not-yet-created fleet the routing gate is deciding about. */
function fleetSeatOffer(over: { publisherGithubUserId: number; count: number; fleetSlug?: string }): StoredWorkOffer {
  const record: WorkOfferStoreRecord = {
    offerId: `seat-${over.publisherGithubUserId}-fleet`,
    publisherGithubUserId: over.publisherGithubUserId,
    fleetSlug: over.fleetSlug ?? 'alpha',
    potSlug: null,
    kind: 'seat',
    status: 'open',
    cancelReason: null,
    workOffer: null,
    authorship: null,
    seat: { model: 'haiku', effort: 'low', count: over.count, accountScope: 'auto', hostLabel: null, audience: null },
    spawnRequest: null,
    recordVersion: 1,
  };
  return {
    workspaceId: WS,
    potHomeSlug: HOME,
    publisherGithubUserId: record.publisherGithubUserId,
    offerId: record.offerId,
    record,
    recordJson: JSON.stringify(record),
    signerDevicePubkey: 'pk',
    signature: 'sig',
    recordVersion: 1,
    fleetSlug: record.fleetSlug,
    potSlug: null,
    offerKind: record.kind,
    status: record.status,
    localDisposition: null,
    fedHlc: null,
    updatedAt: 1,
  };
}

describe('resolveRemoteSeatInventory', () => {
  it('returns the empty/unshared summary for a null workspaceId', async () => {
    const listOffers = vi.fn();
    const out = await resolveRemoteSeatInventory(null, { listOffers });
    expect(out).toEqual({ potShared: false, donorCount: 0, totalSeats: 0 });
    expect(listOffers).not.toHaveBeenCalled();
  });

  it('returns unshared when the workspace resolves to none/many shared hives', async () => {
    const resolveScope = vi.fn(async () => ({ kind: 'none' as const }));
    const listOffers = vi.fn();
    const out = await resolveRemoteSeatInventory(WS, { resolveScope, listOffers });
    expect(out.potShared).toBe(false);
    expect(listOffers).not.toHaveBeenCalled();

    const resolveScopeMany = vi.fn(async () => ({ kind: 'many' as const, candidates: ['a', 'b'] }));
    const out2 = await resolveRemoteSeatInventory(WS, { resolveScope: resolveScopeMany, listOffers });
    expect(out2.potShared).toBe(false);
  });

  it('shared pot, no open seat offers ⇒ potShared true, zero donors/seats', async () => {
    const resolveScope = vi.fn(async () => ({ kind: 'one' as const, homeSlug: HOME }));
    const listOffers = vi.fn(async () => []);
    const out = await resolveRemoteSeatInventory(WS, { resolveScope, listOffers });
    expect(out).toEqual({ potShared: true, donorCount: 0, totalSeats: 0 });
    expect(listOffers).toHaveBeenCalledWith(WS, HOME, { kind: 'seat', status: 'open' });
  });

  it('sums seats and dedupes donors across multiple pot-scoped offers', async () => {
    const resolveScope = vi.fn(async () => ({ kind: 'one' as const, homeSlug: HOME }));
    const rows = [
      potSeatOffer({ publisherGithubUserId: 1, count: 3 }),
      potSeatOffer({ publisherGithubUserId: 2, count: 5 }),
      // same donor, a second offer (e.g. a different model/effort trio) — donor counted once
      { ...potSeatOffer({ publisherGithubUserId: 1, count: 2 }), offerId: 'seat-1-b' },
    ];
    const listOffers = vi.fn(async () => rows);
    const out = await resolveRemoteSeatInventory(WS, { resolveScope, listOffers });
    expect(out).toEqual({ potShared: true, donorCount: 2, totalSeats: 10 });
  });

  it('P-013: collects deduped, sorted hostLabels when donors set one', async () => {
    const resolveScope = vi.fn(async () => ({ kind: 'one' as const, homeSlug: HOME }));
    const rows = [
      potSeatOffer({ publisherGithubUserId: 1, count: 3, hostLabel: 'box-b' }),
      potSeatOffer({ publisherGithubUserId: 2, count: 5, hostLabel: 'box-a' }),
      // a second offer from the SAME donor+label — dedupes to one label
      { ...potSeatOffer({ publisherGithubUserId: 1, count: 2, hostLabel: 'box-b' }), offerId: 'seat-1-b' },
    ];
    const listOffers = vi.fn(async () => rows);
    const out = await resolveRemoteSeatInventory(WS, { resolveScope, listOffers });
    expect(out).toEqual({ potShared: true, donorCount: 2, totalSeats: 10, donorLabels: ['box-a', 'box-b'] });
  });

  it('P-013: donorLabels stays undefined when no donor set a hostLabel (falls back to anonymous count)', async () => {
    const resolveScope = vi.fn(async () => ({ kind: 'one' as const, homeSlug: HOME }));
    const rows = [potSeatOffer({ publisherGithubUserId: 1, count: 3 })];
    const listOffers = vi.fn(async () => rows);
    const out = await resolveRemoteSeatInventory(WS, { resolveScope, listOffers });
    expect(out.donorLabels).toBeUndefined();
  });

  it('P-001: excludes fleet-scoped offers (potSlug null) — not spendable by the not-yet-created fleet', async () => {
    const resolveScope = vi.fn(async () => ({ kind: 'one' as const, homeSlug: HOME }));
    const rows = [
      fleetSeatOffer({ publisherGithubUserId: 3, count: 9, fleetSlug: 'existing-fleet' }),
      potSeatOffer({ publisherGithubUserId: 4, count: 2 }),
    ];
    const listOffers = vi.fn(async () => rows);
    const out = await resolveRemoteSeatInventory(WS, { resolveScope, listOffers });
    // only the pot-scoped donor (4) and their 2 seats count; the fleet-scoped
    // donor (3)'s 9 seats are excluded.
    expect(out).toEqual({ potShared: true, donorCount: 1, totalSeats: 2 });
  });

  it('a pot with ONLY fleet-scoped offers reads as an empty pot-scoped inventory (still potShared)', async () => {
    const resolveScope = vi.fn(async () => ({ kind: 'one' as const, homeSlug: HOME }));
    const listOffers = vi.fn(async () => [fleetSeatOffer({ publisherGithubUserId: 5, count: 4 })]);
    const out = await resolveRemoteSeatInventory(WS, { resolveScope, listOffers });
    expect(out).toEqual({ potShared: true, donorCount: 0, totalSeats: 0 });
  });

  it('ignores a row with no parsed seat payload (junk/non-seat kind) rather than throwing', async () => {
    const resolveScope = vi.fn(async () => ({ kind: 'one' as const, homeSlug: HOME }));
    const junk = { ...potSeatOffer({ publisherGithubUserId: 9, count: 1 }), record: null };
    const listOffers = vi.fn(async () => [junk]);
    const out = await resolveRemoteSeatInventory(WS, { resolveScope, listOffers });
    expect(out).toEqual({ potShared: true, donorCount: 0, totalSeats: 0 });
  });

  it('fails soft to the unshared summary when the scope resolution throws', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const resolveScope = vi.fn(async () => {
      throw new Error('boom');
    });
    const listOffers = vi.fn();
    const out = await resolveRemoteSeatInventory(WS, { resolveScope, listOffers });
    expect(out).toEqual({ potShared: false, donorCount: 0, totalSeats: 0 });
  });

  it('fails soft to the unshared summary when the offer-store read throws', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const resolveScope = vi.fn(async () => ({ kind: 'one' as const, homeSlug: HOME }));
    const listOffers = vi.fn(async () => {
      throw new Error('pg down');
    });
    const out = await resolveRemoteSeatInventory(WS, { resolveScope, listOffers });
    expect(out).toEqual({ potShared: false, donorCount: 0, totalSeats: 0 });
  });
});
