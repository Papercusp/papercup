/**
 * seat-chain-composition.integration.test.ts — the P-205 SEAT chain against REAL Postgres.
 *
 * This is the definitive half of the WI-5135 / P-205 proof demanded by
 * `p2p-public-release-remaining-lanes-2026-07-16#D-023` ("wired is not proven").
 *
 * seat-chain-composition.test.ts composes the same legs against an in-memory store. That
 * store is a hand-written MODEL of putWorkOffer, so on its own it can only prove the legs
 * agree with THAT MODEL — which would be the same two-fixtures-agreeing gap it was written
 * to close, moved up one level. This file removes the model entirely:
 *
 *   - putWorkOffer / getWorkOffer / listOffers are the REAL functions, hitting real PG
 *     (mig 490 `harness_shared.p2p_work_offers`, incl. the federation stamp trigger).
 *   - Only the environment seams are stubbed — hive scope, gh identity, device signer,
 *     host label, clock. Those are genuinely unavailable in a test (no keychain, no gh),
 *     and none of them is the thing under test.
 *
 * So what is asserted here is the production authoring/validation chain: the seat record
 * `resource:delegate` really writes, found by the filter the puller really issues, accepted
 * by the validation `publishSpawnRequest` really applies — through real canonical JSON,
 * real column projection, and a real round trip through the database.
 *
 * NOT claimed: cross-machine federation, remote honor, or the reaper. FED-REAP remains the
 * open structural leg of P-205 and needs the 2-machine rig — single-box cannot prove it.
 *
 * Run: npm run test:file -- packages/operator-core/lib/p2p/seat-chain-composition.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { OrgTestDb } from '../../test/_org-test-db';
import { publishSeatOfferForDelegation } from './offer-store-publish';
import { publishSpawnRequest } from './spawn-request-publish';
import { listOffers } from './offer-store';

const { createOrgTestDb } = await import('../../test/_org-test-db');

const HOME = 'hive-home';
const UID_HOST = 279242982; // the contributing machine that delegates the seat
const UID_OWNER = 1567022; // the fleet owner that spends it
const PK_HOST = 'pk-host';
const PK_OWNER = 'pk-owner';

const hostSigner = { pubkey: PK_HOST, sign: vi.fn(async (b: Buffer) => Buffer.from(`host:${b.length}`)) };
const ownerSigner = { pubkey: PK_OWNER, sign: vi.fn(async (b: Buffer) => Buffer.from(`owner:${b.length}`)) };

/** Environment seams only — the STORE stays real. */
const seatDeps = {
  resolveScope: vi.fn(async () => ({ kind: 'one' as const, homeSlug: HOME })),
  resolveActor: vi.fn(async () => ({ githubUserId: UID_HOST, devicePubkey: PK_HOST })),
  buildSigner: vi.fn(async () => hostSigner),
  resolveHostLabel: () => "contributor's box",
} as never;

const spawnDeps = {
  resolveScope: vi.fn(async () => ({ kind: 'one' as const, homeSlug: HOME })),
  resolveActor: vi.fn(async () => ({ githubUserId: UID_OWNER, devicePubkey: PK_OWNER })),
  buildSigner: vi.fn(async () => ownerSigner),
  nowMs: () => 1_751_600_000_000,
} as never;

describe('P-205 seat chain end-to-end against real PG (WI-5135)', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  it('FLEET-scoped: offer → pull → spawn composes through the real store', async () => {
    const workspaceId = 'ws-seatchain-fleet';
    const sql = db.adminSql;

    // ── leg 1: the contributing host delegates a seat (resource:delegate) ────
    const published = await publishSeatOfferForDelegation(
      { workspaceId, fleetSlug: 'alpha', model: 'haiku', effort: 'low', account: 'AUTO', count: 3, sql },
      seatDeps,
    );
    expect(published, `leg 1 did not publish: ${JSON.stringify(published)}`).toMatchObject({ ok: true });
    if (!('stored' in published)) return;

    // It is really in the table, with the projection columns the puller filters on.
    const rows = await sql`
      SELECT offer_kind, status, fleet_slug, pot_slug, record_version
        FROM harness_shared.p2p_work_offers
       WHERE workspace_id = ${workspaceId}`;
    expect(rows).toHaveLength(1);
    expect(rows[0].offer_kind).toBe('seat');
    expect(rows[0].status).toBe('open');
    expect(rows[0].fleet_slug).toBe('alpha');
    expect(rows[0].pot_slug).toBeNull();

    // ── leg 2: the pull — the exact filter request-remote-spawn.ts issues ────
    const found = await listOffers(workspaceId, HOME, { fleetSlug: 'alpha', kind: 'seat', status: 'open' }, sql);
    expect(
      found.map((o) => o.offerId),
      'the real puller did not find the seat the real author just wrote',
    ).toEqual([published.stored.offerId]);
    // The seat payload survived canonical JSON → PG → parse.
    expect(found[0]!.record?.seat).toMatchObject({ count: 3, model: 'haiku', effort: 'low', accountScope: 'auto' });

    // ── leg 3: the fleet owner spawns into that seat ─────────────────────────
    const spawned = await publishSpawnRequest(
      {
        workspaceId,
        fleetSlug: 'alpha',
        targetPublisherGithubUserId: found[0]!.publisherGithubUserId,
        targetOfferId: found[0]!.offerId,
        count: 2,
        planSlug: 'plan-x-2026-07-04',
        requesterOwnerId: 'su-owner',
        launchContext: 'work the plan',
        sql,
      },
      spawnDeps,
    );
    expect(
      spawned,
      `leg 3 REFUSED the seat leg 1 authored — the production chain does not compose: ${JSON.stringify(spawned)}`,
    ).toMatchObject({ ok: true });

    // The spawn_request landed as its own row targeting that seat.
    const requests = await listOffers(workspaceId, HOME, { kind: 'spawn_request', status: 'open' }, sql);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.record?.spawnRequest).toMatchObject({
      targetOfferId: found[0]!.offerId,
      targetPublisherGithubUserId: UID_HOST,
      count: 2,
    });
    // …authored by the OWNER, against the HOST's offer — the two-party shape.
    expect(requests[0]!.publisherGithubUserId).toBe(UID_OWNER);
  });

  it('POT-scoped: the pot fallback pull (P-001) composes, and a fleet-filtered pull correctly misses it', async () => {
    const workspaceId = 'ws-seatchain-pot';
    const sql = db.adminSql;

    const published = await publishSeatOfferForDelegation(
      {
        workspaceId,
        potSlug: HOME,
        audience: 'whole-pot',
        model: 'haiku',
        effort: 'low',
        account: 'AUTO',
        count: 4,
        sql,
      },
      seatDeps,
    );
    expect(published, `pot-scoped leg 1 failed: ${JSON.stringify(published)}`).toMatchObject({ ok: true });

    // P-001: a pot-scoped seat carries fleet_slug NULL, so the fleet pull must miss…
    expect(await listOffers(workspaceId, HOME, { fleetSlug: 'alpha', kind: 'seat', status: 'open' }, sql)).toEqual([]);
    // …and the pot fallback must find it.
    const potFound = await listOffers(workspaceId, HOME, { potSlug: HOME, kind: 'seat', status: 'open' }, sql);
    expect(potFound, 'the pot fallback pull found no seat').toHaveLength(1);
    expect(potFound[0]!.record?.seat?.audience).toBe('whole-pot');

    const spawned = await publishSpawnRequest(
      {
        workspaceId,
        fleetSlug: 'alpha',
        targetPublisherGithubUserId: potFound[0]!.publisherGithubUserId,
        targetOfferId: potFound[0]!.offerId,
        requesterPotSlug: HOME,
        count: 2,
        planSlug: 'plan-x-2026-07-04',
        requesterOwnerId: 'su-owner',
        launchContext: 'work the plan',
        sql,
      },
      spawnDeps,
    );
    expect(
      spawned,
      `leg 3 refused a pot-scoped seat its own pot requested: ${JSON.stringify(spawned)}`,
    ).toMatchObject({ ok: true });
  });

  it('REVOKE: a revoked seat stops being pullable and stops being spawnable', async () => {
    const workspaceId = 'ws-seatchain-revoke';
    const sql = db.adminSql;

    const published = await publishSeatOfferForDelegation(
      { workspaceId, fleetSlug: 'alpha', model: 'haiku', effort: 'low', account: 'AUTO', count: 3, sql },
      seatDeps,
    );
    expect(published).toMatchObject({ ok: true });
    if (!('stored' in published)) return;
    const offerId = published.stored.offerId;

    const revoked = await publishSeatOfferForDelegation(
      { workspaceId, fleetSlug: 'alpha', model: 'haiku', effort: 'low', account: 'AUTO', count: 3, removed: true, sql },
      seatDeps,
    );
    expect(revoked, `revoke failed: ${JSON.stringify(revoked)}`).toMatchObject({ ok: true });

    // The row is cancelled in place (same PK), not deleted — and no longer pullable.
    const all = await listOffers(workspaceId, HOME, { kind: 'seat' }, sql);
    expect(all).toHaveLength(1);
    expect(all[0]!.status).toBe('cancelled');
    expect(await listOffers(workspaceId, HOME, { fleetSlug: 'alpha', kind: 'seat', status: 'open' }, sql)).toEqual([]);

    // And authoring against the dead seat must refuse.
    const spawned = await publishSpawnRequest(
      {
        workspaceId,
        fleetSlug: 'alpha',
        targetPublisherGithubUserId: UID_HOST,
        targetOfferId: offerId,
        count: 2,
        planSlug: 'plan-x-2026-07-04',
        requesterOwnerId: 'su-owner',
        launchContext: 'work the plan',
        sql,
      },
      spawnDeps,
    );
    expect(spawned, 'a spawn was authored against a REVOKED seat').toMatchObject({ ok: false });
    expect(JSON.stringify(spawned)).toMatch(/cancelled|not open|paused|revoked/i);
    // Nothing authored on the refusal.
    expect(await listOffers(workspaceId, HOME, { kind: 'spawn_request' }, sql)).toEqual([]);
  });

  it('NO seat → the spawn refuses and writes nothing (D-023: the refusal is itself a leg)', async () => {
    const workspaceId = 'ws-seatchain-noseat';
    const sql = db.adminSql;

    const spawned = await publishSpawnRequest(
      {
        workspaceId,
        fleetSlug: 'alpha',
        targetPublisherGithubUserId: UID_HOST,
        targetOfferId: 'seat-that-was-never-published',
        count: 2,
        planSlug: 'plan-x-2026-07-04',
        requesterOwnerId: 'su-owner',
        launchContext: 'work the plan',
        sql,
      },
      spawnDeps,
    );
    expect(spawned).toMatchObject({ ok: false });
    expect(JSON.stringify(spawned)).toMatch(/no seat-offer/i);
    const rows = await sql`SELECT 1 FROM harness_shared.p2p_work_offers WHERE workspace_id = ${workspaceId}`;
    expect(rows, 'a refused spawn wrote a row').toHaveLength(0);
  });

  it('COUNT CAP: a request for more seats than were delegated is refused at author time', async () => {
    const workspaceId = 'ws-seatchain-cap';
    const sql = db.adminSql;

    const published = await publishSeatOfferForDelegation(
      { workspaceId, fleetSlug: 'alpha', model: 'haiku', effort: 'low', account: 'AUTO', count: 2, sql },
      seatDeps,
    );
    expect(published).toMatchObject({ ok: true });
    if (!('stored' in published)) return;

    const spawned = await publishSpawnRequest(
      {
        workspaceId,
        fleetSlug: 'alpha',
        targetPublisherGithubUserId: UID_HOST,
        targetOfferId: published.stored.offerId,
        count: 5, // > the 2 delegated
        planSlug: 'plan-x-2026-07-04',
        requesterOwnerId: 'su-owner',
        launchContext: 'work the plan',
        sql,
      },
      spawnDeps,
    );
    expect(spawned, 'the seat count cap was not enforced against the PERSISTED seat').toMatchObject({ ok: false });
    expect(await listOffers(workspaceId, HOME, { kind: 'spawn_request' }, sql)).toEqual([]);
  });
});
