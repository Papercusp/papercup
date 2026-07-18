/**
 * remote-seat-inventory.test.ts — pot-seat-pools-prose-ux-2026-07-18
 * P-007/P-013/P-014: the impure resolver that feeds `RemoteSeatSummary` into
 * the routing-gate kickoff text (launch-prompt.ts stays pure/dependency-free).
 *
 * What a regression here breaks: the routing gate silently reverts to the
 * static "local fleet only" text on a shared pot with real donated seats
 * (P-007), or crashes/blocks a plan launch when the offer-store read errors
 * (the fail-soft contract).
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

function seatOffer(over: {
  publisherGithubUserId: number;
  count: number;
  fleetSlug?: string;
}): StoredWorkOffer {
  const record: WorkOfferStoreRecord = {
    offerId: `seat-${over.publisherGithubUserId}`,
    publisherGithubUserId: over.publisherGithubUserId,
    fleetSlug: over.fleetSlug ?? 'alpha',
    kind: 'seat',
    status: 'open',
    cancelReason: null,
    workOffer: null,
    authorship: null,
    seat: { model: 'haiku', effort: 'low', count: over.count, accountScope: 'auto' },
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

  it('sums seats and dedupes donors across multiple offers (incl. different fleets — pot-wide, fleetSlug-agnostic)', async () => {
    const resolveScope = vi.fn(async () => ({ kind: 'one' as const, homeSlug: HOME }));
    const rows = [
      seatOffer({ publisherGithubUserId: 1, count: 3, fleetSlug: 'alpha' }),
      seatOffer({ publisherGithubUserId: 2, count: 5, fleetSlug: 'beta' }),
      // same donor, a second offer (e.g. a different model/effort trio) — donor counted once
      { ...seatOffer({ publisherGithubUserId: 1, count: 2, fleetSlug: 'alpha' }), offerId: 'seat-1-b' },
    ];
    const listOffers = vi.fn(async () => rows);
    const out = await resolveRemoteSeatInventory(WS, { resolveScope, listOffers });
    expect(out).toEqual({ potShared: true, donorCount: 2, totalSeats: 10 });
  });

  it('ignores a row with no parsed seat payload (junk/non-seat kind) rather than throwing', async () => {
    const resolveScope = vi.fn(async () => ({ kind: 'one' as const, homeSlug: HOME }));
    const junk = { ...seatOffer({ publisherGithubUserId: 9, count: 1 }), record: null };
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
