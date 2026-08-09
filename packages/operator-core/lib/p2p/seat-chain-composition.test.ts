/**
 * seat-chain-composition.test.ts — proves the P-205 SEAT chain COMPOSES:
 *   offer (kind:'seat') → pull (listOffers kind:'seat') → spawn_request → refusal-without-a-seat.
 *
 * WHY THIS FILE EXISTS (WI-5135 / P-205; ruling
 * `p2p-public-release-remaining-lanes-2026-07-16#D-023` — "wired is not proven").
 *
 * Every leg of this chain already has a rich unit test, and all of them pass:
 *   - offer-store-publish.test.ts        (leg 1: publishSeatOfferForDelegation)
 *   - request-remote-spawn.test.ts       (leg 2: the puller's offer pick)
 *   - spawn-request-publish.test.ts      (leg 3: publishSpawnRequest)
 *
 * But each one is "Pure DI — no PG, no keychain, no gh" (spawn-request-publish.test.ts:13)
 * and each HAND-BUILDS its own `StoredWorkOffer` fixture. So leg 3 has only ever been
 * shown to accept a seat record that THE TEST wrote — never one that leg 1 actually
 * authored. Both sides are green against the same hand-written idea of the shape, which
 * is a shared assumption, not evidence. If the authored record and the validated record
 * ever disagree — a renamed field, a nullability flip, a payload dropped by the canonical
 * serializer — every existing test stays green and the live chain breaks.
 *
 * This file closes exactly that gap. It runs the REAL leg functions against ONE shared
 * store, and that store round-trips every record through the REAL codecs
 * (coerceWorkOfferStoreRecord → canonicalWorkOfferRecordJson → parseWorkOfferRecordJson)
 * and derives its projection columns from the record exactly as putWorkOffer's INSERT
 * does (fleet_slug/pot_slug/offer_kind/status ← record.*). That round-trip matters
 * structurally: leg 2 filters on the COLUMNS while leg 3 validates the RECORD, so a
 * fixture that skips serialization cannot detect a divergence between them.
 *
 * NOT claimed here: cross-machine federation, the reaper, or the honor path on a real
 * host. Those need the 2-machine rig (FED-REAP remains the open structural leg of P-205).
 * This proves the LOCAL authoring/validation chain is mutually consistent end-to-end.
 *
 * Pure DI — no PG, no keychain, no gh.
 * Run: npm run test:file -- packages/operator-core/lib/p2p/seat-chain-composition.test.ts
 */
import { describe, expect, it, vi } from 'vitest';
import { publishSeatOfferForDelegation } from './offer-store-publish';
import { publishSpawnRequest } from './spawn-request-publish';
import type { StoredWorkOffer, ListWorkOffersFilter } from './offer-store';
import {
  coerceWorkOfferStoreRecord,
  canonicalWorkOfferRecordJson,
  parseWorkOfferRecordJson,
} from './offer-store-schema';

const WS = 'ws-1';
const HOME = 'hive-home';
const POT = 'hive-home'; // a pot-scoped seat advertises into the pot's own hive topic
const UID_HOST = 279242982; // the contributing machine that delegates the seat
const UID_OWNER = 1567022; // the fleet owner that spends it
const PK_HOST = 'pk-host';
const PK_OWNER = 'pk-owner';

/**
 * An in-memory offer store faithful to putWorkOffer/getWorkOffer/listOffers.
 *
 * Faithfulness is the whole point, so it mirrors the real writer's observable
 * behaviour rather than being convenient: the publisher gate, the monotonic
 * recordVersion gate, the canonical-JSON round-trip, and — critically — columns
 * derived FROM THE RECORD while `record` is the value PARSED BACK from the stored
 * JSON (offer-store.ts rowToStored). That asymmetry is real and is preserved.
 *
 * `mutateStoredJson` is the falsifiability seam used by the controls at the bottom.
 */
function makeOfferStore(mutateStoredJson?: (json: string) => string) {
  const rows = new Map<string, StoredWorkOffer>();
  let clock = 0;
  const key = (ws: string, home: string, pub: number, offerId: string) =>
    `${ws}\x00${home}\x00${pub}\x00${offerId}`;

  const getRecord = async (
    ws: string,
    home: string,
    pub: number,
    offerId: string,
  ): Promise<StoredWorkOffer | null> => rows.get(key(ws, home, pub, offerId)) ?? null;

  const putRecord = async (input: {
    workspaceId: string;
    potHomeSlug: string;
    selfGithubUserId: number;
    record: unknown;
    signer: { pubkey: string; sign: (b: Buffer) => Promise<Buffer> };
  }): Promise<{ ok: true; stored: StoredWorkOffer } | { ok: false; error: string }> => {
    const coerced = coerceWorkOfferStoreRecord(input.record);
    if (!coerced.ok) return { ok: false, error: coerced.error };
    const record = coerced.record;

    if (input.selfGithubUserId !== record.publisherGithubUserId) {
      return { ok: false, error: 'only the publisher may author their offer record' };
    }
    const existing = await getRecord(
      input.workspaceId,
      input.potHomeSlug,
      record.publisherGithubUserId,
      record.offerId,
    );
    if (existing && record.recordVersion <= existing.recordVersion) {
      return {
        ok: false,
        error: `record_version ${record.recordVersion} does not advance past stored ${existing.recordVersion}`,
      };
    }

    let recordJson = canonicalWorkOfferRecordJson(record);
    if (mutateStoredJson) recordJson = mutateStoredJson(recordJson);
    const signature = (await input.signer.sign(Buffer.from(recordJson))).toString('base64');

    const stored: StoredWorkOffer = {
      workspaceId: input.workspaceId,
      potHomeSlug: input.potHomeSlug,
      publisherGithubUserId: record.publisherGithubUserId,
      offerId: record.offerId,
      // Read-back is the PARSED json, exactly like rowToStored.
      record: parseWorkOfferRecordJson(recordJson),
      recordJson,
      signerDevicePubkey: input.signer.pubkey,
      signature,
      recordVersion: record.recordVersion,
      // Columns derive from the record, exactly like the INSERT's $9..$12.
      fleetSlug: record.fleetSlug,
      potSlug: record.potSlug,
      offerKind: record.kind,
      status: record.status,
      localDisposition: existing?.localDisposition ?? null,
      fedHlc: null,
      updatedAt: ++clock,
    };
    rows.set(key(input.workspaceId, input.potHomeSlug, record.publisherGithubUserId, record.offerId), stored);
    return { ok: true, stored };
  };

  /** Mirrors listOffers' server-side filtering — on the COLUMNS, not the record. */
  const list = async (
    ws: string,
    home: string,
    filter: ListWorkOffersFilter = {},
  ): Promise<StoredWorkOffer[]> =>
    [...rows.values()].filter((r) => {
      if (r.workspaceId !== ws || r.potHomeSlug !== home) return false;
      if (filter.kind !== undefined && r.offerKind !== filter.kind) return false;
      if (filter.status !== undefined && r.status !== filter.status) return false;
      if (filter.fleetSlug !== undefined && r.fleetSlug !== filter.fleetSlug) return false;
      if (filter.potSlug !== undefined && r.potSlug !== filter.potSlug) return false;
      if (
        filter.publisherGithubUserId !== undefined &&
        r.publisherGithubUserId !== filter.publisherGithubUserId
      ) {
        return false;
      }
      if (!filter.includeLocallyDisposed && r.localDisposition) return false;
      return true;
    });

  return { rows, getRecord, putRecord, list };
}

const hostSigner = { pubkey: PK_HOST, sign: vi.fn(async (b: Buffer) => Buffer.from(`host:${b.length}`)) };
const ownerSigner = { pubkey: PK_OWNER, sign: vi.fn(async (b: Buffer) => Buffer.from(`owner:${b.length}`)) };

/** Leg 1 deps: the CONTRIBUTING host authors the seat offer. */
function seatDeps(store: ReturnType<typeof makeOfferStore>) {
  return {
    resolveScope: vi.fn(async () => ({ kind: 'one' as const, homeSlug: HOME })),
    resolveActor: vi.fn(async () => ({ githubUserId: UID_HOST, devicePubkey: PK_HOST })),
    getRecord: store.getRecord as never,
    putRecord: store.putRecord as never,
    buildSigner: vi.fn(async () => hostSigner),
    resolveHostLabel: () => "contributor's box",
  };
}

/** Leg 3 deps: the FLEET OWNER authors the spawn request against that same store. */
function spawnDeps(store: ReturnType<typeof makeOfferStore>) {
  return {
    resolveScope: vi.fn(async () => ({ kind: 'one' as const, homeSlug: HOME })),
    resolveActor: vi.fn(async () => ({ githubUserId: UID_OWNER, devicePubkey: PK_OWNER })),
    getRecord: store.getRecord as never,
    putRecord: store.putRecord as never,
    buildSigner: vi.fn(async () => ownerSigner),
    nowMs: () => 1_751_600_000_000,
  };
}

/** Leg 1 → the real authored offer, asserted published. */
async function publishFleetSeat(store: ReturnType<typeof makeOfferStore>, count = 3) {
  const out = await publishSeatOfferForDelegation(
    { workspaceId: WS, fleetSlug: 'alpha', model: 'haiku', effort: 'low', account: 'AUTO', count },
    seatDeps(store) as never,
  );
  return out;
}

describe('P-205 seat chain — offer → pull → spawn composes for real (WI-5135)', () => {
  it('FLEET-scoped: the seat leg 1 really authors is the one the puller finds and the spawn accepts', async () => {
    const store = makeOfferStore();

    // ── leg 1: offer ────────────────────────────────────────────────────────
    const published = await publishFleetSeat(store, 3);
    expect(published, `leg 1 did not publish: ${JSON.stringify(published)}`).toMatchObject({ ok: true });
    if (!('stored' in published)) throw new Error('unreachable — narrowed by the assert above');

    // ── leg 2: pull — the exact filter request-remote-spawn.ts uses ─────────
    const found = await store.list(WS, HOME, { fleetSlug: 'alpha', kind: 'seat', status: 'open' });
    expect(
      found.map((o) => o.offerId),
      'the puller did not find the seat offer leg 1 just authored — offer/pull disagree',
    ).toEqual([published.stored.offerId]);

    // The pull leg reads the seat payload off the record to rank candidates.
    expect(found[0]!.record?.kind).toBe('seat');
    expect(found[0]!.record?.seat).toMatchObject({ count: 3, model: 'haiku', effort: 'low' });

    // ── leg 3: spawn_request against THAT offer ────────────────────────────
    const spawned = await publishSpawnRequest(
      {
        workspaceId: WS,
        fleetSlug: 'alpha',
        targetPublisherGithubUserId: found[0]!.publisherGithubUserId,
        targetOfferId: found[0]!.offerId,
        count: 2,
        planSlug: 'plan-x-2026-07-04',
        requesterOwnerId: 'su-owner',
        launchContext: 'work the plan',
      },
      spawnDeps(store) as never,
    );
    expect(
      spawned,
      `leg 3 REFUSED the seat leg 1 authored — the chain does not compose: ${JSON.stringify(spawned)}`,
    ).toMatchObject({ ok: true });

    // The request must land as its own spawn_request row targeting that seat.
    const requests = await store.list(WS, HOME, { kind: 'spawn_request', status: 'open' });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.record?.spawnRequest).toMatchObject({
      targetOfferId: found[0]!.offerId,
      targetPublisherGithubUserId: UID_HOST,
      count: 2,
    });
  });

  it('POT-scoped: the pot fallback path (request-remote-spawn listOffers potSlug/seat/open) composes too', async () => {
    const store = makeOfferStore();

    const published = await publishSeatOfferForDelegation(
      {
        workspaceId: WS,
        potSlug: POT,
        audience: 'whole-pot',
        model: 'haiku',
        effort: 'low',
        account: 'AUTO',
        count: 4,
      },
      seatDeps(store) as never,
    );
    expect(published, `pot-scoped leg 1 failed: ${JSON.stringify(published)}`).toMatchObject({ ok: true });

    // A pot-scoped seat carries fleetSlug=null — so a FLEET-filtered pull must miss it,
    // and the pot-filtered pull must find it. That split is the P-001 contract.
    expect(await store.list(WS, HOME, { fleetSlug: 'alpha', kind: 'seat', status: 'open' })).toEqual([]);
    const potFound = await store.list(WS, HOME, { potSlug: POT, kind: 'seat', status: 'open' });
    expect(potFound, 'the pot fallback pull found no seat').toHaveLength(1);
    expect(potFound[0]!.record?.seat?.audience).toBe('whole-pot');

    const spawned = await publishSpawnRequest(
      {
        workspaceId: WS,
        fleetSlug: 'alpha',
        targetPublisherGithubUserId: potFound[0]!.publisherGithubUserId,
        targetOfferId: potFound[0]!.offerId,
        requesterPotSlug: POT,
        count: 2,
        planSlug: 'plan-x-2026-07-04',
        requesterOwnerId: 'su-owner',
        launchContext: 'work the plan',
      },
      spawnDeps(store) as never,
    );
    expect(
      spawned,
      `leg 3 refused a pot-scoped seat its own pot requested: ${JSON.stringify(spawned)}`,
    ).toMatchObject({ ok: true });
  });

  it('a REVOKED seat stops being pullable and stops being spawnable (the revocation leg)', async () => {
    const store = makeOfferStore();
    const published = await publishFleetSeat(store, 3);
    if (!('stored' in published)) throw new Error('leg 1 failed');
    const offerId = published.stored.offerId;

    // Revoke through the REAL revoke path (resource:delegate remove:true).
    const revoked = await publishSeatOfferForDelegation(
      {
        workspaceId: WS,
        fleetSlug: 'alpha',
        model: 'haiku',
        effort: 'low',
        account: 'AUTO',
        count: 3,
        removed: true,
      },
      seatDeps(store) as never,
    );
    expect(revoked).toMatchObject({ ok: true });

    // Pull: an open-filtered scan must no longer surface it.
    expect(await store.list(WS, HOME, { fleetSlug: 'alpha', kind: 'seat', status: 'open' })).toEqual([]);

    // Spawn: and authoring against it must refuse rather than target a dead seat.
    const spawned = await publishSpawnRequest(
      {
        workspaceId: WS,
        fleetSlug: 'alpha',
        targetPublisherGithubUserId: UID_HOST,
        targetOfferId: offerId,
        count: 2,
        planSlug: 'plan-x-2026-07-04',
        requesterOwnerId: 'su-owner',
        launchContext: 'work the plan',
      },
      spawnDeps(store) as never,
    );
    expect(spawned).toMatchObject({ ok: false });
    expect(JSON.stringify(spawned)).toMatch(/cancelled|not open|revoked|paused/i);
  });

  it('NO seat in the store → the spawn refuses (D-023: the refusal is itself a leg worth asserting)', async () => {
    const store = makeOfferStore();
    const spawned = await publishSpawnRequest(
      {
        workspaceId: WS,
        fleetSlug: 'alpha',
        targetPublisherGithubUserId: UID_HOST,
        targetOfferId: 'seat-that-was-never-published',
        count: 2,
        planSlug: 'plan-x-2026-07-04',
        requesterOwnerId: 'su-owner',
        launchContext: 'work the plan',
      },
      spawnDeps(store) as never,
    );
    expect(spawned).toMatchObject({ ok: false });
    expect(JSON.stringify(spawned)).toMatch(/no seat-offer/i);
    // Nothing may be authored on a refusal.
    expect(await store.list(WS, HOME, { kind: 'spawn_request' })).toEqual([]);
  });
});

/**
 * FALSIFIABILITY CONTROLS — kept permanently, per the repo's
 * "proving a guard is falsifiable" rule (never by mutating the shared tree).
 *
 * These inject a deliberately-broken STORE, not broken production code, and assert the
 * composition above would have caught the break. Without them, a green suite above is
 * only evidence that nothing threw. The calibration case (the passing chain) lives in
 * the describe block above and must stay green alongside these.
 */
describe('P-205 seat chain — controls (the composition must FAIL when the seam diverges)', () => {
  it('CONTROL: a serializer that drops the seat payload breaks the chain at leg 3', async () => {
    // Per-leg tests CANNOT catch this: each builds its own fixture and never
    // round-trips through the canonical JSON, so both stay green.
    const store = makeOfferStore((json) => {
      const o = JSON.parse(json);
      delete o.seat;
      return JSON.stringify(o);
    });

    const published = await publishFleetSeat(store, 3);
    expect(published).toMatchObject({ ok: true }); // leg 1 still "succeeds"

    const found = await store.list(WS, HOME, { fleetSlug: 'alpha', kind: 'seat', status: 'open' });
    expect(found, 'the corrupted offer still occupies the column projection').toHaveLength(1);

    const spawned = await publishSpawnRequest(
      {
        workspaceId: WS,
        fleetSlug: 'alpha',
        targetPublisherGithubUserId: found[0]!.publisherGithubUserId,
        targetOfferId: found[0]!.offerId,
        count: 2,
        planSlug: 'plan-x-2026-07-04',
        requesterOwnerId: 'su-owner',
        launchContext: 'work the plan',
      },
      spawnDeps(store) as never,
    );
    // The chain MUST refuse — this is the regression the composition exists to detect.
    expect(spawned, 'a seat-less record was accepted — the composition test is not falsifiable').toMatchObject(
      { ok: false },
    );
    expect(JSON.stringify(spawned)).toMatch(/well-formed seat-offer|unparseable/i);
  });

  it('CONTROL: a column projection that disagrees with the record hides the seat from the pull', async () => {
    // Simulates offer_kind drifting from record.kind (leg 2 filters columns,
    // leg 3 validates the record — the exact split a fixture cannot model).
    const store = makeOfferStore();
    const published = await publishFleetSeat(store, 3);
    if (!('stored' in published)) throw new Error('leg 1 failed');

    const k = [...store.rows.keys()][0]!;
    store.rows.set(k, { ...store.rows.get(k)!, offerKind: 'work' });

    const found = await store.list(WS, HOME, { fleetSlug: 'alpha', kind: 'seat', status: 'open' });
    expect(found, 'a drifted offer_kind column must make the seat unpullable').toEqual([]);
  });
});
