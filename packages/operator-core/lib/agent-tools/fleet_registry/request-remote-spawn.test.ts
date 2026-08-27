/**
 * request-remote-spawn.test.ts — P-004 (pot-seat-pools-prose-ux-2026-07-18):
 * `fleet:request_remote_spawn`'s auto-pick must fall back to the requester's
 * POT-scoped seat-offers (fleetSlug=null, potSlug set) when the fleet has no
 * fleet-scoped offer of its own, picking deterministically (mirroring
 * distributeRemotePlacement's max-spread sort: host label then offer id) the
 * first offer whose delegated seat count covers the request.
 *
 * Pure unit coverage of the extracted picker; the full handler also needs
 * getFleet/resolveWorkspaceHiveScope/listOffers/publishSpawnRequest wired
 * through PG-backed integration coverage (out of scope here — the picker is
 * the load-bearing, easy-to-get-wrong logic: a regression here silently picks
 * a different/wrong host, or fails to pick when it should).
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/fleet_registry/request-remote-spawn.test.ts
 */
import { describe, expect, it } from 'vitest';
import tool, { byHostThenOffer, pickPotSeatOffer } from './request-remote-spawn';
import type { StoredWorkOffer } from '../../p2p/offer-store';
import type { WorkOfferStoreRecord } from '../../p2p/offer-store-schema';

function potOffer(offerId: string, host: string | null, count: number): StoredWorkOffer {
  const record: WorkOfferStoreRecord = {
    offerId,
    publisherGithubUserId: 1,
    fleetSlug: null,
    potSlug: 'pot-x',
    kind: 'seat',
    status: 'open',
    cancelReason: null,
    workOffer: null,
    authorship: null,
    seat: { model: 'haiku', effort: 'low', count, accountScope: 'auto', hostLabel: host, audience: 'whole-pot' },
    spawnRequest: null,
    recordVersion: 1,
  };
  return {
    workspaceId: 'ws-1',
    potHomeSlug: 'hive-home',
    publisherGithubUserId: 1,
    offerId,
    record,
    recordJson: JSON.stringify(record),
    signerDevicePubkey: 'pk',
    signature: 'sig',
    recordVersion: 1,
    fleetSlug: null,
    potSlug: 'pot-x',
    offerKind: 'seat',
    status: 'open',
    localDisposition: null,
    fedHlc: null,
    updatedAt: 1,
  };
}

describe('pickPotSeatOffer (P-004 pot-scoped auto-pick)', () => {
  it('accepts a remote request above the retired local 12-member ceiling', () => {
    expect(tool.args.safeParse({ fleet: 'wide-fleet', plan: 'wide-plan', count: 64 }).success).toBe(true);
  });

  it('picks the sole qualifying offer', () => {
    const picked = pickPotSeatOffer([potOffer('seat-a', 'box-a', 3)], 2);
    expect(picked?.offerId).toBe('seat-a');
  });

  it('is deterministic: sorts by host label then offer id, picks the FIRST that qualifies', () => {
    const offers = [potOffer('seat-zzz', 'box-b', 5), potOffer('seat-aaa', 'box-a', 5)];
    const picked = pickPotSeatOffer(offers, 1);
    // box-a sorts before box-b regardless of input order.
    expect(picked?.offerId).toBe('seat-aaa');
  });

  it('skips an offer with too few seats, picks the next qualifying one in sort order', () => {
    const offers = [potOffer('seat-a', 'box-a', 1), potOffer('seat-b', 'box-b', 5)];
    const picked = pickPotSeatOffer(offers, 3);
    expect(picked?.offerId).toBe('seat-b');
  });

  it('returns null when no offer has enough delegated seats', () => {
    const offers = [potOffer('seat-a', 'box-a', 1), potOffer('seat-b', 'box-b', 2)];
    expect(pickPotSeatOffer(offers, 5)).toBeNull();
  });

  it('returns null on an empty offer list', () => {
    expect(pickPotSeatOffer([], 1)).toBeNull();
  });

  it('a null hostLabel sorts before any named host (empty-string collation) and never throws', () => {
    const offers = [potOffer('seat-a', null, 2), potOffer('seat-b', 'box-a', 2)];
    expect(() => pickPotSeatOffer(offers, 1)).not.toThrow();
    const sorted = [...offers].sort(byHostThenOffer);
    expect(sorted[0]!.offerId).toBe('seat-a');
  });
});
