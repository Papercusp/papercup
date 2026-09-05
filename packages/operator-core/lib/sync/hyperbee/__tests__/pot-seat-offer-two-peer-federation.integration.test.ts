/**
 * pot-seat-offer-two-peer-federation.integration.test.ts — WI-5409/P-010
 * (pot-seat-pools-prose-ux-2026-07-18): the pot-scoped seat-offer chain
 * end-to-end over the $0 LOCAL-PARITY federation path (pattern of
 * `hive-cross-machine.integration.test.ts`'s $0 case / this suite's
 * `feature-claims-two-peer-federation.integration.test.ts`).
 *
 * Two REAL peers ("B" the contributing host, "A" the requesting fleet owner)
 * on a local testnet DHT, mutually admitted, each projecting
 * `p2p_work_offers` into its OWN throwaway PG via the REAL
 * `buildWorkOffersProjection`:
 *
 *  1. B publishes a POT-scoped seat-offer (kind:'seat', potSlug set,
 *     fleetSlug null, D-005/P-001) — proves it federates to A (any fleet in
 *     A's pot can discover it, not just a named fleet).
 *  2. A publishes a spawn-request naming that offer (kind:'spawn_request') —
 *     proves the request crosses BACK to B (the honoring host).
 *  3. Once B's PG genuinely holds the (real, federated) spawn-request row, we
 *     call the REAL `honorSpawnRequestFromProjection` (delegated-spawn-honor.ts)
 *     on it — proving the P-003 audience gate operates correctly on a row
 *     that actually crossed the wire, not a hand-built fixture:
 *       - 'trusted-members' + a trusted requester ⇒ honored (spawnMembers
 *         called, B's local_disposition really flips to 'honored' in PG).
 *       - 'trusted-members' + an untrusted requester ⇒ refused
 *         'audience_refused' — a receipt is emitted and B's local_disposition
 *         really flips to 'refused:audience_refused' in PG.
 *
 * Scope notes (deliberate, mirrors the module's own authenticity/authority
 * split):
 *   - `verifyRecord` is stubbed to always-true on both peers' projections.
 *     The signature+device-attestation gate (realVerifyWorkOffer) is a
 *     SEPARATE authenticity concern with its own coverage; standing up real
 *     hive-member device attestation here would test that gate a second time
 *     instead of the pot-offer/honor crossing this WI is about.
 *   - `spawnMembers` / `emitReceipt` are DI-stubbed (delegated-spawn-honor.ts
 *     already takes them as seams — see its own exhaustive DI unit suite,
 *     delegated-spawn-honor.test.ts) so this test never opens a real desktop
 *     terminal or exercises the receipt's own wire/signing path; what's REAL
 *     here is the offer/request ROWS crossing via actual two-peer federation
 *     and the gate logic running on the row that really landed.
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  federateTwoPeerPresence,
  pollUntil,
  rigAfterEach,
  WORKSPACE_ID,
  HARNESS_SLUG,
} from './_cross-peer-rig';
import { buildWorkOffersProjection, type WorkOfferWireRow } from '../projections/work-offers';
import { canonicalWorkOfferRecordJson, workOfferFedKey, type WorkOfferStoreRecord } from '../../../p2p/offer-store-schema';
import { seatOfferId } from '../../../p2p/offer-store-publish';
import { spawnRequestOfferId } from '../../../p2p/spawn-request-publish';
import { honorSpawnRequestFromProjection, type DelegatedSpawnHonorDeps } from '../../../p2p/delegated-spawn-honor';
import { CURRENT_SCHEMA_VERSION } from '../schema-version';

afterEach(rigAfterEach);

/** The REAL p2p_work_offers DDL (migration 490 base + 626's P-001 pot-scoping
 *  ALTERs folded in) — NOT a hand-rolled subset. Outbox-capture triggers are
 *  deliberately omitted: this test appends federation ops directly (mirrors
 *  feature-claims-two-peer-federation's `claimOp` convention) rather than
 *  driving the local CDC-capture path, so no trigger is needed to make an op
 *  land. */
const WORK_OFFERS_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.p2p_work_offers (
    workspace_id             text    NOT NULL,
    harness_slug             text    NOT NULL,
    publisher_github_user_id bigint  NOT NULL,
    offer_id                 text    NOT NULL,
    record_json              text    NOT NULL,
    signer_device_pubkey     text    NOT NULL,
    signature                text    NOT NULL,
    record_version           bigint  NOT NULL DEFAULT 1,
    fleet_slug               text,
    pot_slug                 text,
    offer_kind               text    NOT NULL,
    status                   text    NOT NULL DEFAULT 'open',
    local_disposition        text,
    author_pubkey            text,
    origin                   text    NOT NULL DEFAULT 'local',
    fed_ts                   bigint,
    fed_hlc                  text,
    created_at               bigint  NOT NULL,
    updated_at               bigint  NOT NULL DEFAULT 0,
    PRIMARY KEY (workspace_id, harness_slug, publisher_github_user_id, offer_id),
    CONSTRAINT p2p_work_offers_pot_nonempty CHECK (pot_slug IS NULL OR pot_slug <> ''),
    CONSTRAINT p2p_work_offers_grantee CHECK (
      (offer_kind <> 'seat' AND fleet_slug IS NOT NULL AND pot_slug IS NULL)
      OR (offer_kind = 'seat' AND (fleet_slug IS NOT NULL) <> (pot_slug IS NOT NULL))
    )
  )`;

const MODEL = 'sonnet';
const EFFORT = 'high';
const ACCOUNT = 'AUTO';
const SEAT_COUNT = 5;
const POT_SLUG = 'xpeer-shared-pot';
const REQUESTER_FLEET_SLUG = 'xpeer-fleet-a';
const PLAN_SLUG = 'xpeer-plan';

/** Build B's pot-scoped standing seat-offer (D-005/P-001) as the exact wire
 *  shape `writeToPg` expects — mirrors offer-store-publish.ts's real
 *  construction, hand-built here since the signature is never checked
 *  (verifyRecord is stubbed true below). */
function buildSeatOfferWireRow(devicePubkey: string, publisherUserId: number, audience: 'trusted-members' | 'whole-pot') {
  const offerId = seatOfferId({ potSlug: POT_SLUG, model: MODEL, effort: EFFORT, account: ACCOUNT, devicePubkey });
  const record: WorkOfferStoreRecord = {
    offerId,
    publisherGithubUserId: publisherUserId,
    fleetSlug: null,
    potSlug: POT_SLUG,
    kind: 'seat',
    status: 'open',
    cancelReason: null,
    workOffer: null,
    authorship: null,
    seat: { model: MODEL, effort: EFFORT, count: SEAT_COUNT, accountScope: 'auto', hostLabel: 'peer-B', audience },
    spawnRequest: null,
    recordVersion: 1,
  };
  const wireRow: WorkOfferWireRow = {
    harness_slug: HARNESS_SLUG,
    publisher_github_user_id: publisherUserId,
    offer_id: offerId,
    record_json: canonicalWorkOfferRecordJson(record),
    signer_device_pubkey: devicePubkey,
    signature: 'xpeer-test-stub-signature',
    record_version: 1,
    fleet_slug: '',
    pot_slug: POT_SLUG,
    offer_kind: 'seat',
    status: 'open',
  };
  return { offerId, wireRow };
}

/** Build A's signed spawn-request naming B's seat-offer — mirrors
 *  spawn-request-publish.ts's real construction (hand-built; unsigned, same
 *  rationale as the seat-offer above). */
function buildSpawnRequestWireRow(
  devicePubkey: string,
  requesterUserId: number,
  targetPublisherGithubUserId: number,
  targetOfferId: string,
) {
  const requestedAtMs = Date.now();
  const offerId = spawnRequestOfferId({
    targetPublisherGithubUserId,
    targetOfferId,
    planSlug: PLAN_SLUG,
    requesterOwnerId: 'su-xpeer-a',
    requestedAtMs,
    devicePubkey,
  });
  const record: WorkOfferStoreRecord = {
    offerId,
    publisherGithubUserId: requesterUserId,
    fleetSlug: REQUESTER_FLEET_SLUG,
    potSlug: null,
    kind: 'spawn_request',
    status: 'open',
    cancelReason: null,
    workOffer: null,
    authorship: null,
    seat: null,
    spawnRequest: {
      targetPublisherGithubUserId,
      targetOfferId,
      count: 1,
      planSlug: PLAN_SLUG,
      requesterOwnerId: 'su-xpeer-a',
      requestedAtMs,
      launchContext: null,
    },
    recordVersion: 1,
  };
  const wireRow: WorkOfferWireRow = {
    harness_slug: HARNESS_SLUG,
    publisher_github_user_id: requesterUserId,
    offer_id: offerId,
    record_json: canonicalWorkOfferRecordJson(record),
    signer_device_pubkey: devicePubkey,
    signature: 'xpeer-test-stub-signature',
    record_version: 1,
    fleet_slug: REQUESTER_FLEET_SLUG,
    pot_slug: '',
    offer_kind: 'spawn_request',
    status: 'open',
  };
  return { offerId, wireRow };
}

describe('pot-scoped seat-offer — two-peer federation (WI-5409/P-010)', () => {
  it(
    "delegate on B, request from A: the offer AND the spawn-request both cross the wire, and a trusted requester is honored",
    async () => {
      const { dbA, dbB, idA, idB, peerA, peerB, federated } = await federateTwoPeerPresence((sql) => [
        buildWorkOffersProjection({ sql, workspaceId: WORKSPACE_ID, harnessSlug: HARNESS_SLUG, verifyRecord: async () => true }),
      ]);
      expect(federated, 'the two peers never connected/federated presence (rig precondition)').toBeTruthy();
      await dbA.sql.unsafe(WORK_OFFERS_DDL);
      await dbB.sql.unsafe(WORK_OFFERS_DDL);

      // 1. B delegates: publish a pot-scoped seat-offer on B's own-log.
      const { offerId: seatOfferIdB, wireRow: seatWireRow } = buildSeatOfferWireRow(idB.devicePubkey, idB.userId, 'trusted-members');
      await peerB.handle.append({
        type: 'put',
        table: 'p2p-work-offers',
        hbKey: workOfferFedKey(idB.userId, seatOfferIdB),
        value: seatWireRow,
        ts: Date.now(),
        schema_version: CURRENT_SCHEMA_VERSION,
        writerPubkey: idB.devicePubkey,
      });

      // 2. A requests: publish a signed spawn-request naming B's seat-offer,
      // on A's own-log (A discovered the pot-scoped offer via its own pot
      // membership — proven by the crossing below, not by naming a fleet).
      const { offerId: requestOfferId, wireRow: requestWireRow } = buildSpawnRequestWireRow(
        idA.devicePubkey,
        idA.userId,
        idB.userId,
        seatOfferIdB,
      );
      await peerA.handle.append({
        type: 'put',
        table: 'p2p-work-offers',
        hbKey: workOfferFedKey(idA.userId, requestOfferId),
        value: requestWireRow,
        ts: Date.now(),
        schema_version: CURRENT_SCHEMA_VERSION,
        writerPubkey: idA.devicePubkey,
      });

      // ── THE CROSSING PROOF: A's PG holds B's pot-scoped offer, AND B's PG
      // holds A's spawn-request — both directions of the P-010 chain. ──
      const crossed = await pollUntil(
        async () => {
          await peerA.handle.mergeNow();
          await peerB.handle.mergeNow();
          const aSeesOffer = await dbA.sql<Array<Record<string, unknown>>>`
            SELECT * FROM harness_shared.p2p_work_offers
             WHERE workspace_id = ${WORKSPACE_ID} AND harness_slug = ${HARNESS_SLUG}
               AND publisher_github_user_id = ${idB.userId} AND offer_id = ${seatOfferIdB}`;
          const bSeesRequest = await dbB.sql<Array<Record<string, unknown>>>`
            SELECT * FROM harness_shared.p2p_work_offers
             WHERE workspace_id = ${WORKSPACE_ID} AND harness_slug = ${HARNESS_SLUG}
               AND publisher_github_user_id = ${idA.userId} AND offer_id = ${requestOfferId}`;
          return aSeesOffer[0] && bSeesRequest[0] ? { aSeesOffer: aSeesOffer[0], bSeesRequest: bSeesRequest[0] } : undefined;
        },
        { timeoutMs: 25_000, intervalMs: 250 },
      );
      expect(crossed, 'the pot-seat-offer / spawn-request pair never crossed peer→peer').toBeTruthy();
      expect(crossed!.aSeesOffer.pot_slug).toBe(POT_SLUG);
      expect(crossed!.aSeesOffer.fleet_slug).toBeNull();
      expect(crossed!.bSeesRequest.fleet_slug).toBe(REQUESTER_FLEET_SLUG);

      // 3. Honor it on B — the REAL gate logic (delegated-spawn-honor.ts),
      // run on the row that ACTUALLY crossed the wire. Only spawn/receipt are
      // stubbed (see file header); hostAccepts/audience/seat-matching are the
      // real production code paths.
      const spawnMembers = vi.fn(async () => ({ opened: 1, failed: 0, firstError: null }));
      const emitReceipt = vi.fn(async () => ({ ok: true }) as any);
      const isTrustedUser = vi.fn(async () => true); // A IS on B's trust list
      const deps: DelegatedSpawnHonorDeps = {
        hostAccepts: async () => true,
        resolveActor: async () => ({ githubUserId: idB.userId }) as any,
        resolveDevicePubkey: async () => idB.devicePubkey,
        listAllotments: (async (f: { fleetSlug?: string; potSlug?: string }) =>
          f.fleetSlug
            ? []
            : [
                {
                  resourceKind: 'agent_slot',
                  quantity: SEAT_COUNT,
                  axis: { model: MODEL, effort: EFFORT, account: ACCOUNT },
                  resourceRef: `${MODEL}:${EFFORT}:${ACCOUNT}`,
                  fleetSlug: null,
                  potSlug: POT_SLUG,
                  audience: 'trusted-members',
                },
              ]) as any,
        availabilityForFleet: (async () => [
          { ref: `${MODEL}:${EFFORT}:${ACCOUNT}`, model: MODEL, effort: EFFORT, account: ACCOUNT, quantity: SEAT_COUNT, consumed: 0, available: SEAT_COUNT },
        ]) as any,
        spawnMembers,
        emitReceipt,
        getBuildInfo: () => ({ sha: 'integration-build', version: '0.0.13' }),
        probeAgentRuntime: async () => ({ resolved: true, detail: 'stubbed — no real desktop spawn in this test' }),
        verifyLocalMemberBoot: async () => ({
          observed: true,
          detail: 'stubbed — tool-backed first turn proven in this integration test',
        }),
        resolveHonorAccount: async (acc: string) => ({ ok: true as const, account: acc }),
        // P-017: ACCOUNT is 'AUTO' and seatLaunchOpts maps AUTO→'auto', so this
        // honor bills as 'pool-with-attribution' and consults the M17 single-owner
        // reading. Stubbed like every other environment seam in this test — the
        // real reader dynamic-imports the inference-gateway account resolver,
        // which this two-peer federation fixture has no pool for.
        resolveBillingPool: async () => ({ singleOwner: true }),
        isTrustedUser,
        isPotMember: vi.fn(async () => true),
      };

      const row = {
        publisher_github_user_id: Number(crossed!.bSeesRequest.publisher_github_user_id),
        offer_id: String(crossed!.bSeesRequest.offer_id),
        record_json: String(crossed!.bSeesRequest.record_json),
        fleet_slug: String(crossed!.bSeesRequest.fleet_slug),
      };
      const outcome = await honorSpawnRequestFromProjection(
        { workspaceId: WORKSPACE_ID, potHomeSlug: HARNESS_SLUG, row, sql: dbB.sql },
        deps,
      );
      expect(outcome).toEqual({ outcome: 'honored', opened: 1, failed: 0, committedSeats: 1 });
      expect(isTrustedUser).toHaveBeenCalledWith(WORKSPACE_ID, idA.userId);
      expect(spawnMembers).toHaveBeenCalledOnce();
      expect(emitReceipt).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'honored',
          action: 'delegated-seat:spawn',
          offerId: requestOfferId,
          detail: expect.stringContaining('[responder-build sha=integration-build version=0.0.13]'),
        }),
      );

      // setDisposition was NOT stubbed — the REAL implementation ran against
      // B's real PG, so the honored disposition genuinely landed there.
      const dispRows = await dbB.sql<Array<{ local_disposition: string | null }>>`
        SELECT local_disposition FROM harness_shared.p2p_work_offers
         WHERE workspace_id = ${WORKSPACE_ID} AND harness_slug = ${HARNESS_SLUG}
           AND publisher_github_user_id = ${idA.userId} AND offer_id = ${requestOfferId}`;
      expect(dispRows[0]?.local_disposition).toBe('honored');
    },
    90_000,
  );

  it(
    "an audience-refused requester ⇒ refused 'audience_refused', a receipt is emitted, and B's disposition really flips (D-002/D-003 fail-closed)",
    async () => {
      const { dbA, dbB, idA, idB, peerA, peerB, federated } = await federateTwoPeerPresence((sql) => [
        buildWorkOffersProjection({ sql, workspaceId: WORKSPACE_ID, harnessSlug: HARNESS_SLUG, verifyRecord: async () => true }),
      ]);
      expect(federated, 'the two peers never connected/federated presence (rig precondition)').toBeTruthy();
      await dbA.sql.unsafe(WORK_OFFERS_DDL);
      await dbB.sql.unsafe(WORK_OFFERS_DDL);

      const { offerId: seatOfferIdB, wireRow: seatWireRow } = buildSeatOfferWireRow(idB.devicePubkey, idB.userId, 'trusted-members');
      await peerB.handle.append({
        type: 'put',
        table: 'p2p-work-offers',
        hbKey: workOfferFedKey(idB.userId, seatOfferIdB),
        value: seatWireRow,
        ts: Date.now(),
        schema_version: CURRENT_SCHEMA_VERSION,
        writerPubkey: idB.devicePubkey,
      });
      const { offerId: requestOfferId, wireRow: requestWireRow } = buildSpawnRequestWireRow(
        idA.devicePubkey,
        idA.userId,
        idB.userId,
        seatOfferIdB,
      );
      await peerA.handle.append({
        type: 'put',
        table: 'p2p-work-offers',
        hbKey: workOfferFedKey(idA.userId, requestOfferId),
        value: requestWireRow,
        ts: Date.now(),
        schema_version: CURRENT_SCHEMA_VERSION,
        writerPubkey: idA.devicePubkey,
      });

      const crossed = await pollUntil(
        async () => {
          await peerA.handle.mergeNow();
          await peerB.handle.mergeNow();
          const bSeesRequest = await dbB.sql<Array<Record<string, unknown>>>`
            SELECT * FROM harness_shared.p2p_work_offers
             WHERE workspace_id = ${WORKSPACE_ID} AND harness_slug = ${HARNESS_SLUG}
               AND publisher_github_user_id = ${idA.userId} AND offer_id = ${requestOfferId}`;
          return bSeesRequest[0] ? { bSeesRequest: bSeesRequest[0] } : undefined;
        },
        { timeoutMs: 25_000, intervalMs: 250 },
      );
      expect(crossed, "A's spawn-request never crossed to B").toBeTruthy();

      const spawnMembers = vi.fn(async () => ({ opened: 1, failed: 0, firstError: null }));
      const emitReceipt = vi.fn(async () => ({ ok: true }) as any);
      const isTrustedUser = vi.fn(async () => false); // A is NOT on B's trust list this time
      const deps: DelegatedSpawnHonorDeps = {
        hostAccepts: async () => true,
        resolveActor: async () => ({ githubUserId: idB.userId }) as any,
        resolveDevicePubkey: async () => idB.devicePubkey,
        listAllotments: (async (f: { fleetSlug?: string; potSlug?: string }) =>
          f.fleetSlug
            ? []
            : [
                {
                  resourceKind: 'agent_slot',
                  quantity: SEAT_COUNT,
                  axis: { model: MODEL, effort: EFFORT, account: ACCOUNT },
                  resourceRef: `${MODEL}:${EFFORT}:${ACCOUNT}`,
                  fleetSlug: null,
                  potSlug: POT_SLUG,
                  audience: 'trusted-members',
                },
              ]) as any,
        availabilityForFleet: (async () => [
          { ref: `${MODEL}:${EFFORT}:${ACCOUNT}`, model: MODEL, effort: EFFORT, account: ACCOUNT, quantity: SEAT_COUNT, consumed: 0, available: SEAT_COUNT },
        ]) as any,
        spawnMembers,
        emitReceipt,
        probeAgentRuntime: async () => ({ resolved: true, detail: 'stubbed — no real desktop spawn in this test' }),
        resolveHonorAccount: async (acc: string) => ({ ok: true as const, account: acc }),
        // P-017: ACCOUNT is 'AUTO' and seatLaunchOpts maps AUTO→'auto', so this
        // honor bills as 'pool-with-attribution' and consults the M17 single-owner
        // reading. Stubbed like every other environment seam in this test — the
        // real reader dynamic-imports the inference-gateway account resolver,
        // which this two-peer federation fixture has no pool for.
        resolveBillingPool: async () => ({ singleOwner: true }),
        isTrustedUser,
        isPotMember: vi.fn(async () => true),
      };

      const row = {
        publisher_github_user_id: Number(crossed!.bSeesRequest.publisher_github_user_id),
        offer_id: String(crossed!.bSeesRequest.offer_id),
        record_json: String(crossed!.bSeesRequest.record_json),
        fleet_slug: String(crossed!.bSeesRequest.fleet_slug),
      };
      const outcome = await honorSpawnRequestFromProjection(
        { workspaceId: WORKSPACE_ID, potHomeSlug: HARNESS_SLUG, row, sql: dbB.sql },
        deps,
      );
      expect(outcome).toEqual({ outcome: 'refused', code: 'audience_refused' });
      expect(spawnMembers).not.toHaveBeenCalled();
      // D-004: refusals past gate 2 are LOUD — a receipt names the code so the
      // requester learns why (never a silent drop).
      expect(emitReceipt).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'refusal',
          action: 'delegated-seat:spawn',
          offerId: requestOfferId,
          refusal: expect.objectContaining({ code: 'audience_refused' }),
        }),
      );

      const dispRows = await dbB.sql<Array<{ local_disposition: string | null }>>`
        SELECT local_disposition FROM harness_shared.p2p_work_offers
         WHERE workspace_id = ${WORKSPACE_ID} AND harness_slug = ${HARNESS_SLUG}
           AND publisher_github_user_id = ${idA.userId} AND offer_id = ${requestOfferId}`;
      expect(dispRows[0]?.local_disposition).toBe('refused:audience_refused');
    },
    90_000,
  );
});
