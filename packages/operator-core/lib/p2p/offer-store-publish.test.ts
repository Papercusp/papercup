/**
 * offer-store-publish.test.ts — the seat-offer publish leg (WI-1935 production
 * caller; agent-allocation D-005).
 *
 * What a regression here breaks: agent_slot delegations silently stop
 * federating seat-offers (the exact built-not-wired gap WI-1935 closed), a
 * re-delegation churns record_version and re-federates a byte-identical offer
 * every time, a revoke leaves the offer advertising seats forever, or the raw
 * gateway ACCOUNT ID leaks onto the wire (D-005/M19 privacy contract).
 *
 * Pure DI — no PG, no keychain, no gh.
 * Run: cd packages/operator-core && npx vitest run lib/p2p/offer-store-publish.test.ts
 */
import { describe, expect, it, vi } from 'vitest';
import {
  describeSeatOfferOutcome,
  publishSeatOfferForDelegation,
  publishSeatOfferForDelegationBestEffort,
  seatOfferId,
  type SeatOfferPublishDeps,
} from './offer-store-publish';
import type { StoredWorkOffer } from './offer-store';
import type { WorkOfferStoreRecord } from './offer-store-schema';

const WS = 'ws-1';
const HOME = 'hive-home';
const UID = 279242982;
const PK = 'pk';

function storedOf(record: WorkOfferStoreRecord): StoredWorkOffer {
  return {
    workspaceId: WS,
    potHomeSlug: HOME,
    publisherGithubUserId: record.publisherGithubUserId,
    offerId: record.offerId,
    record,
    recordJson: JSON.stringify(record),
    signerDevicePubkey: PK,
    signature: 'sig',
    recordVersion: record.recordVersion,
    fleetSlug: record.fleetSlug,
    potSlug: record.potSlug,
    offerKind: record.kind,
    status: record.status,
    localDisposition: null,
    fedHlc: null,
    updatedAt: 2,
  };
}

const signer = { pubkey: PK, sign: vi.fn(async () => Buffer.from('s')) };

function deps(over: Partial<Record<keyof SeatOfferPublishDeps, any>> = {}): {
  d: SeatOfferPublishDeps;
  putRecord: ReturnType<typeof vi.fn>;
} {
  const putRecord = vi.fn(async (input: any) => ({ ok: true as const, stored: storedOf(input.record) }));
  const d: SeatOfferPublishDeps = {
    resolveScope: vi.fn(async () => ({ kind: 'one' as const, homeSlug: HOME })),
    resolveActor: vi.fn(async () => ({ githubUserId: UID, devicePubkey: PK })),
    getRecord: vi.fn(async () => null),
    putRecord,
    buildSigner: vi.fn(async () => signer),
    resolveHostLabel: () => 'box-b',
    ...over,
  };
  return { d, putRecord };
}

const OPTS = {
  workspaceId: WS,
  fleetSlug: 'alpha',
  model: 'haiku',
  effort: 'low',
  account: 'AUTO',
  count: 2,
};

const SEAT_ID = seatOfferId({ fleetSlug: 'alpha', model: 'haiku', effort: 'low', account: 'AUTO', devicePubkey: PK });

/** The record a fresh OPTS publish composes (version 1). */
function freshRecord(): WorkOfferStoreRecord {
  return {
    offerId: SEAT_ID,
    publisherGithubUserId: UID,
    fleetSlug: 'alpha',
    potSlug: null,
    kind: 'seat',
    status: 'open',
    cancelReason: null,
    workOffer: null,
    authorship: null,
    seat: { model: 'haiku', effort: 'low', count: 2, accountScope: 'auto', hostLabel: 'box-b', audience: null },
    spawnRequest: null,
    recordVersion: 1,
  };
}

describe('publishSeatOfferForDelegation — fail-soft gates', () => {
  it('no exactly-one shared hive → skipped, nothing authored', async () => {
    for (const scope of [{ kind: 'none' as const }, { kind: 'many' as const, candidates: ['a', 'b'] }]) {
      const { d, putRecord } = deps({ resolveScope: vi.fn(async () => scope) });
      const r = await publishSeatOfferForDelegation(OPTS, d);
      expect(r).toEqual({ ok: false, skipped: `no_single_shared_hive:${scope.kind}` });
      expect(putRecord).not.toHaveBeenCalled();
    }
  });

  it('WI-5211 multi-hive: hiveOverride naming a shared hive → publishes THERE (no longer skipped)', async () => {
    const { d, putRecord } = deps({
      resolveScope: vi.fn(async () => ({ kind: 'many' as const, candidates: ['papercusp', 'hello-world-3-pot'] })),
    });
    const r = await publishSeatOfferForDelegation({ ...OPTS, hiveOverride: 'papercusp' }, d);
    expect(r).toMatchObject({ ok: true, changed: true });
    expect(putRecord).toHaveBeenCalledTimes(1);
    expect(putRecord.mock.calls[0]![0].potHomeSlug).toBe('papercusp');
  });

  it('WI-5211: hiveOverride that is NOT a shared hive here → skipped hive_not_shared, nothing authored', async () => {
    const { d, putRecord } = deps({
      resolveScope: vi.fn(async () => ({ kind: 'many' as const, candidates: ['papercusp', 'hello-world-3-pot'] })),
    });
    const r = await publishSeatOfferForDelegation({ ...OPTS, hiveOverride: 'not-a-hive' }, d);
    expect(r).toEqual({ ok: false, skipped: 'hive_not_shared:not-a-hive' });
    expect(putRecord).not.toHaveBeenCalled();
  });

  it('WI-5211: hiveOverride is IGNORED on a single-hive workspace (still publishes to the sole hive)', async () => {
    const { d, putRecord } = deps(); // default resolveScope → kind:'one', homeSlug HOME
    const r = await publishSeatOfferForDelegation({ ...OPTS, hiveOverride: HOME }, d);
    expect(r).toMatchObject({ ok: true, changed: true });
    expect(putRecord.mock.calls[0]![0].potHomeSlug).toBe(HOME);
  });

  it('no workspace / no gh identity → skipped (never forge a publisher)', async () => {
    const { d: d1 } = deps();
    expect(await publishSeatOfferForDelegation({ ...OPTS, workspaceId: null }, d1)).toEqual({
      ok: false,
      skipped: 'no_workspace',
    });
    const { d: d2, putRecord } = deps({ resolveActor: vi.fn(async () => null) });
    expect(await publishSeatOfferForDelegation(OPTS, d2)).toEqual({ ok: false, skipped: 'no_github_identity' });
    expect(putRecord).not.toHaveBeenCalled();
  });

  it('signer failure (locked keychain) → error, delegation unaffected by contract', async () => {
    const { d, putRecord } = deps({ buildSigner: vi.fn(async () => { throw new Error('keychain locked'); }) });
    expect(await publishSeatOfferForDelegation(OPTS, d)).toEqual({
      ok: false,
      error: 'device signer unavailable: keychain locked',
    });
    expect(putRecord).not.toHaveBeenCalled();
  });
});

describe('publishSeatOfferForDelegation — authoring', () => {
  it('fresh publish: composes the open seat record, version 1, publisher = actor, deterministic offer id', async () => {
    const { d, putRecord } = deps();
    const r = await publishSeatOfferForDelegation(OPTS, d);
    expect(r).toMatchObject({ ok: true, changed: true });
    expect(putRecord).toHaveBeenCalledTimes(1);
    const input = putRecord.mock.calls[0]![0];
    expect(input).toMatchObject({ workspaceId: WS, potHomeSlug: HOME, selfGithubUserId: UID, signer });
    expect(input.record).toEqual(freshRecord());
  });

  it('paused delegation publishes status paused', async () => {
    const { d, putRecord } = deps();
    await publishSeatOfferForDelegation({ ...OPTS, paused: true }, d);
    expect(putRecord.mock.calls[0]![0].record.status).toBe('paused');
  });

  it("D-005/M19: a pinned account yields accountScope 'pinned' and the raw account NEVER enters the record", async () => {
    const { d, putRecord } = deps();
    await publishSeatOfferForDelegation({ ...OPTS, account: 'gh-secret-account-42' }, d);
    const input = putRecord.mock.calls[0]![0];
    expect(input.record.seat.accountScope).toBe('pinned');
    expect(JSON.stringify(input.record)).not.toContain('gh-secret-account-42');
    // …but it DOES scope the offer id (a different account = a different standing offer row).
    expect(input.record.offerId).not.toBe(SEAT_ID);
  });

  it('no-churn gate: re-delegating the identical trio+count → ok changed:false, NO put', async () => {
    const stored = storedOf({ ...freshRecord(), recordVersion: 5 });
    const { d, putRecord } = deps({ getRecord: vi.fn(async () => stored) });
    const r = await publishSeatOfferForDelegation(OPTS, d);
    expect(r).toEqual({ ok: true, stored, changed: false });
    expect(putRecord).not.toHaveBeenCalled();
  });

  it('count change bumps the version and republishes', async () => {
    const stored = storedOf({ ...freshRecord(), recordVersion: 3 });
    const { d, putRecord } = deps({ getRecord: vi.fn(async () => stored) });
    const r = await publishSeatOfferForDelegation({ ...OPTS, count: 5 }, d);
    expect(r).toMatchObject({ ok: true, changed: true });
    expect(putRecord.mock.calls[0]![0].record).toMatchObject({
      seat: { count: 5 },
      recordVersion: 4,
      status: 'open',
    });
  });
});

describe('publishSeatOfferForDelegation — revoke (remove:true)', () => {
  it('revoking a delegation that never federated → skipped no_offer_to_cancel', async () => {
    const { d, putRecord } = deps();
    expect(await publishSeatOfferForDelegation({ ...OPTS, removed: true }, d)).toEqual({
      ok: false,
      skipped: 'no_offer_to_cancel',
    });
    expect(putRecord).not.toHaveBeenCalled();
  });

  it('revoke publishes cancelled with the carried seat payload + bumped version', async () => {
    const stored = storedOf({ ...freshRecord(), recordVersion: 2 });
    const { d, putRecord } = deps({ getRecord: vi.fn(async () => stored) });
    const r = await publishSeatOfferForDelegation({ ...OPTS, removed: true }, d);
    expect(r).toMatchObject({ ok: true, changed: true });
    expect(putRecord.mock.calls[0]![0].record).toMatchObject({
      status: 'cancelled',
      cancelReason: 'delegation-removed',
      seat: freshRecord().seat, // carried, not recomposed
      recordVersion: 3,
    });
  });

  it('re-revoking an already-cancelled offer is a no-churn no-op', async () => {
    const cancelled: WorkOfferStoreRecord = {
      ...freshRecord(),
      status: 'cancelled',
      cancelReason: 'delegation-removed',
      recordVersion: 3,
    };
    const stored = storedOf(cancelled);
    const { d, putRecord } = deps({ getRecord: vi.fn(async () => stored) });
    expect(await publishSeatOfferForDelegation({ ...OPTS, removed: true }, d)).toEqual({
      ok: true,
      stored,
      changed: false,
    });
    expect(putRecord).not.toHaveBeenCalled();
  });

  // WI-5447: resource:delegate { remove:true } revoked the local allotment but
  // left the published seat-offer 'open' — because the homeSlug resolution
  // above required an explicit disambiguator on a multi-hive workspace, and
  // (unlike a SET) the caller has no `hive_required` gate forcing them to name
  // one on a revoke. Cancel must not fail closed on hive ambiguity.
  it('WI-5447: revoke with NO disambiguator on a multi-hive workspace tries every shared-hive candidate and cancels wherever the offer actually lives', async () => {
    const stored = storedOf({ ...freshRecord(), recordVersion: 2 });
    const getRecord = vi.fn(async (_ws: string, homeSlug: string) => (homeSlug === 'hive-b' ? stored : null));
    const { d, putRecord } = deps({
      resolveScope: vi.fn(async () => ({ kind: 'many' as const, candidates: ['hive-a', 'hive-b', 'hive-c'] })),
      getRecord,
    });
    const r = await publishSeatOfferForDelegation({ ...OPTS, removed: true }, d);
    expect(r).toMatchObject({ ok: true, changed: true });
    // tried every candidate — never fails closed just because more than one exists
    expect(getRecord).toHaveBeenCalledTimes(3);
    expect(getRecord.mock.calls.map((c) => c[1])).toEqual(['hive-a', 'hive-b', 'hive-c']);
    expect(putRecord).toHaveBeenCalledTimes(1);
    expect(putRecord.mock.calls[0]![0].potHomeSlug).toBe('hive-b');
    expect(putRecord.mock.calls[0]![0].record).toMatchObject({ status: 'cancelled', cancelReason: 'delegation-removed' });
  });

  it('WI-5447: revoke with NO disambiguator, offer not found in ANY multi-hive candidate → no_offer_to_cancel, no put', async () => {
    const getRecord = vi.fn(async () => null);
    const { d, putRecord } = deps({
      resolveScope: vi.fn(async () => ({ kind: 'many' as const, candidates: ['hive-a', 'hive-b'] })),
      getRecord,
    });
    const r = await publishSeatOfferForDelegation({ ...OPTS, removed: true }, d);
    expect(r).toEqual({ ok: false, skipped: 'no_offer_to_cancel' });
    expect(getRecord).toHaveBeenCalledTimes(2);
    expect(putRecord).not.toHaveBeenCalled();
  });

  it('WI-5447: revoke with NO shared hive at all (scope kind none) → skipped no_shared_hive_to_cancel_in, no lookups', async () => {
    const getRecord = vi.fn(async () => null);
    const { d, putRecord } = deps({
      resolveScope: vi.fn(async () => ({ kind: 'none' as const })),
      getRecord,
    });
    const r = await publishSeatOfferForDelegation({ ...OPTS, removed: true }, d);
    expect(r).toEqual({ ok: false, skipped: 'no_shared_hive_to_cancel_in' });
    expect(getRecord).not.toHaveBeenCalled();
    expect(putRecord).not.toHaveBeenCalled();
  });

  it('WI-5447: revoke with an explicit hiveOverride on a multi-hive workspace still restricts to that ONE hive', async () => {
    const stored = storedOf({ ...freshRecord(), recordVersion: 2 });
    const getRecord = vi.fn(async (_ws: string, _homeSlug: string) => stored);
    const { d, putRecord } = deps({
      resolveScope: vi.fn(async () => ({ kind: 'many' as const, candidates: ['hive-a', 'hive-b'] })),
      getRecord,
    });
    const r = await publishSeatOfferForDelegation({ ...OPTS, removed: true, hiveOverride: 'hive-a' }, d);
    expect(r).toMatchObject({ ok: true, changed: true });
    expect(getRecord).toHaveBeenCalledTimes(1);
    expect(getRecord.mock.calls[0]![1]).toBe('hive-a');
    expect(putRecord.mock.calls[0]![0].potHomeSlug).toBe('hive-a');
  });
});

describe('publishSeatOfferForDelegation — failure passthrough', () => {
  it('putWorkOffer refusal → error passthrough', async () => {
    const { d } = deps({ putRecord: vi.fn(async () => ({ ok: false as const, error: 'stale version' })) });
    expect(await publishSeatOfferForDelegation(OPTS, d)).toEqual({ ok: false, error: 'stale version' });
  });
});

/**
 * EI-19304844689981989 — the SILENCE regression guard.
 *
 * The bug this pins: `publishSeatOfferForDelegationBestEffort` computed a rich
 * outcome ({ok} | {skipped} | {error}) and then DISCARDED it — `void ...
 * .catch(() => {})`. Combined with a second empty catch at the resource:delegate
 * call site, a seat that never federated produced NO signal anywhere: the tool
 * returned ok:true, the local allotment wrote fine, and the seat simply never
 * appeared on the fleet owner's board. Diagnosing that cost multiple wakes across
 * three machines precisely because nothing recorded the outcome.
 *
 * These tests do not assert the publish WORKS (covered above) — they assert it
 * is never again SILENT about not working.
 */
describe('EI-19304844689981989: a non-publishing seat offer is never silent', () => {
  it('a benign skip is REPORTED (the silent-drop case that cost the investigation)', async () => {
    const log = vi.fn();
    const { d } = deps({ resolveActor: vi.fn(async () => null) });
    publishSeatOfferForDelegationBestEffort(OPTS, { ...d, log });
    await vi.waitFor(() => expect(log).toHaveBeenCalledTimes(1));
    const line = log.mock.calls[0]![0] as string;
    expect(line).toContain('NOT PUBLISHED');
    expect(line).toContain('no_github_identity'); // the actionable reason, not just "failed"
    expect(line).toContain('fleet:alpha');
  });

  it('a real publish error is REPORTED with its cause', async () => {
    const log = vi.fn();
    const { d } = deps({ putRecord: vi.fn(async () => ({ ok: false as const, error: 'stale version' })) });
    publishSeatOfferForDelegationBestEffort(OPTS, { ...d, log });
    await vi.waitFor(() => expect(log).toHaveBeenCalledTimes(1));
    expect(log.mock.calls[0]![0]).toContain('stale version');
  });

  it('a THROWN publish is reported rather than swallowed', async () => {
    const log = vi.fn();
    const { d } = deps({
      resolveScope: vi.fn(async () => {
        throw new Error('keychain locked');
      }),
    });
    publishSeatOfferForDelegationBestEffort(OPTS, { ...d, log });
    await vi.waitFor(() => expect(log).toHaveBeenCalledTimes(1));
    expect(log.mock.calls[0]![0]).toContain('keychain locked');
  });

  it('still never throws at the call site — the delegation write must not depend on this leg', () => {
    const { d } = deps({
      resolveScope: vi.fn(async () => {
        throw new Error('boom');
      }),
    });
    expect(() => publishSeatOfferForDelegationBestEffort(OPTS, { ...d, log: vi.fn() })).not.toThrow();
  });

  it('distinguishes a real publish from an idempotent no-churn re-publish', () => {
    expect(describeSeatOfferOutcome(OPTS, { ok: true, stored: {} as never, changed: true }).msg).toContain(
      'published',
    );
    const noChurn = describeSeatOfferOutcome(OPTS, { ok: true, stored: {} as never, changed: false });
    expect(noChurn.msg).toContain('already current');
    expect(noChurn.level).toBe('info'); // benign — must not read as a failure
  });

  it('a skip is level:warn, so it cannot be mistaken for a successful delegation', () => {
    expect(describeSeatOfferOutcome(OPTS, { ok: false, skipped: 'no_single_shared_hive:many' }).level).toBe(
      'warn',
    );
  });
});
