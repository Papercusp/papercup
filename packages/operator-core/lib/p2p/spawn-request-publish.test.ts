/**
 * spawn-request-publish.test.ts — the P-009 spawn-request author (fleet-owner
 * side of cross-machine launch).
 *
 * What a regression here breaks: a spawn-request publishes against a paused/
 * cancelled/foreign-fleet/locally-refused seat-offer (a request the host can
 * only refuse — or worse, honor against a withdrawn delegation), the count cap
 * stops being enforced at author time, a self-targeted request sits forever
 * un-honored (the projection hook only fires on REMOTE apply), or the record
 * stops carrying the freshness stamp the honor window fences on.
 *
 * Pure DI — no PG, no keychain, no gh.
 * Run: cd packages/operator-core && npx vitest run lib/p2p/spawn-request-publish.test.ts
 */
import { describe, expect, it, vi } from 'vitest';
import {
  publishSpawnRequest,
  spawnRequestOfferId,
  type PublishSpawnRequestOpts,
  type SpawnRequestPublishDeps,
} from './spawn-request-publish';
import type { StoredWorkOffer } from './offer-store';
import type { WorkOfferStoreRecord } from './offer-store-schema';

const WS = 'ws-1';
const HOME = 'hive-home';
const UID_A = 1567022; // the requesting fleet owner (this machine)
const UID_B = 279242982; // the contributing host that published the seat-offer
const PK_A = 'pk-a';
const PK_B = 'pk-b';
const NOW = 1_751_600_000_000;

function seatOfferStored(over: Partial<StoredWorkOffer> = {}): StoredWorkOffer {
  const record: WorkOfferStoreRecord = {
    offerId: 'seat-abc123',
    publisherGithubUserId: UID_B,
    fleetSlug: 'alpha',
    kind: 'seat',
    status: 'open',
    cancelReason: null,
    workOffer: null,
    authorship: null,
    seat: { model: 'haiku', effort: 'low', count: 3, accountScope: 'auto', hostLabel: 'box-b' },
    spawnRequest: null,
    recordVersion: 1,
  };
  return {
    workspaceId: WS,
    hiveHomeSlug: HOME,
    publisherGithubUserId: UID_B,
    offerId: 'seat-abc123',
    record,
    recordJson: JSON.stringify(record),
    signerDevicePubkey: PK_B,
    signature: 'sig-b',
    recordVersion: 1,
    fleetSlug: 'alpha',
    offerKind: 'seat',
    status: 'open',
    localDisposition: null,
    fedHlc: null,
    updatedAt: 2,
    ...over,
  };
}

const signerA = { pubkey: PK_A, sign: vi.fn(async () => Buffer.from('s')) };

function deps(over: Partial<Record<keyof SpawnRequestPublishDeps, any>> = {}): {
  d: SpawnRequestPublishDeps;
  putRecord: ReturnType<typeof vi.fn>;
  getRecord: ReturnType<typeof vi.fn>;
} {
  const putRecord = vi.fn(async (input: any) => ({
    ok: true as const,
    stored: { ...seatOfferStored(), offerId: input.record.offerId, record: input.record } as StoredWorkOffer,
  }));
  // First get = the TARGET seat-offer; second get = the (absent) prior request.
  const getRecord = vi.fn(async (_ws: string, _home: string, publisher: number) =>
    publisher === UID_B ? seatOfferStored() : null,
  );
  const d: SpawnRequestPublishDeps = {
    resolveScope: vi.fn(async () => ({ kind: 'one' as const, homeSlug: HOME })),
    resolveActor: vi.fn(async () => ({ githubUserId: UID_A, devicePubkey: PK_A })),
    getRecord,
    putRecord,
    buildSigner: vi.fn(async () => signerA),
    nowMs: () => NOW,
    ...over,
  };
  return { d, putRecord, getRecord };
}

function opts(over: Partial<PublishSpawnRequestOpts> = {}): PublishSpawnRequestOpts {
  return {
    workspaceId: WS,
    fleetSlug: 'alpha',
    targetPublisherGithubUserId: UID_B,
    targetOfferId: 'seat-abc123',
    count: 2,
    planSlug: 'plan-x-2026-07-04',
    requesterOwnerId: 'su-a',
    launchContext: '  work the plan  ',
    ...over,
  };
}

describe('publishSpawnRequest — happy path', () => {
  it('authors a signed spawn_request with the freshness stamp and the deterministic id', async () => {
    const { d, putRecord } = deps();
    const res = await publishSpawnRequest(opts(), d);
    expect(res.ok).toBe(true);
    expect(putRecord).toHaveBeenCalledTimes(1);
    const record: WorkOfferStoreRecord = putRecord.mock.calls[0]![0].record;
    expect(record.kind).toBe('spawn_request');
    expect(record.publisherGithubUserId).toBe(UID_A);
    expect(record.fleetSlug).toBe('alpha');
    expect(record.status).toBe('open');
    expect(record.spawnRequest).toEqual({
      targetPublisherGithubUserId: UID_B,
      targetOfferId: 'seat-abc123',
      count: 2,
      planSlug: 'plan-x-2026-07-04',
      requesterOwnerId: 'su-a',
      requestedAtMs: NOW,
      launchContext: 'work the plan',
    });
    expect(record.offerId).toBe(
      spawnRequestOfferId({
        targetPublisherGithubUserId: UID_B,
        targetOfferId: 'seat-abc123',
        planSlug: 'plan-x-2026-07-04',
        requesterOwnerId: 'su-a',
        requestedAtMs: NOW,
        devicePubkey: PK_A,
      }),
    );
  });
});

describe('publishSpawnRequest — target validation (refuse at author time, not on the host)', () => {
  it('refuses a missing / non-seat / non-open / locally-refused target', async () => {
    const missing = deps({ getRecord: vi.fn(async () => null) });
    expect(await publishSpawnRequest(opts(), missing.d)).toMatchObject({ ok: false, error: expect.stringContaining('no seat-offer') });

    const paused = deps({ getRecord: vi.fn(async () => seatOfferStored({ status: 'paused' })) });
    expect(await publishSpawnRequest(opts(), paused.d)).toMatchObject({ ok: false, error: expect.stringContaining("'paused'") });

    const disposed = deps({ getRecord: vi.fn(async () => seatOfferStored({ localDisposition: 'revoked:grant' })) });
    expect(await publishSpawnRequest(opts(), disposed.d)).toMatchObject({ ok: false, error: expect.stringContaining('locally refused') });

    const junk = deps({ getRecord: vi.fn(async () => seatOfferStored({ record: null })) });
    expect(await publishSpawnRequest(opts(), junk.d)).toMatchObject({ ok: false, error: expect.stringContaining('not a well-formed seat-offer') });
  });

  it('refuses a fleet mismatch and a count past the delegated seats', async () => {
    const { d } = deps();
    expect(await publishSpawnRequest(opts({ fleetSlug: 'other' }), d)).toMatchObject({
      ok: false,
      error: expect.stringContaining("delegates to fleet 'alpha'"),
    });
    expect(await publishSpawnRequest(opts({ count: 4 }), d)).toMatchObject({
      ok: false,
      error: expect.stringContaining('count must be 1..3'),
    });
  });

  it('refuses a SELF-target (the honor hook only fires on remote apply)', async () => {
    const { d } = deps({
      resolveActor: vi.fn(async () => ({ githubUserId: UID_B, devicePubkey: PK_B })),
      buildSigner: vi.fn(async () => ({ pubkey: PK_B, sign: vi.fn(async () => Buffer.from('s')) })),
    });
    const res = await publishSpawnRequest(opts(), d);
    expect(res).toMatchObject({ ok: false, error: expect.stringContaining('OWN delegation') });
  });
});

describe('publishSpawnRequest — fail-soft gates (offer-store-publish discipline)', () => {
  it('skips on no workspace / no single hive / no identity', async () => {
    const { d } = deps();
    expect(await publishSpawnRequest(opts({ workspaceId: null }), d)).toEqual({ ok: false, skipped: 'no_workspace' });

    const many = deps({ resolveScope: vi.fn(async () => ({ kind: 'many' as const })) });
    expect(await publishSpawnRequest(opts(), many.d)).toEqual({ ok: false, skipped: 'no_single_shared_hive:many' });

    const anon = deps({ resolveActor: vi.fn(async () => null) });
    expect(await publishSpawnRequest(opts(), anon.d)).toEqual({ ok: false, skipped: 'no_github_identity' });
  });
});
