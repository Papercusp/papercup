/**
 * offer-store-schema.test.ts — the signed-offer store record schema (WI-1935,
 * migration 490).
 *
 * What a regression here breaks: a malformed/hostile offer record coerces
 * (the store and projection both trust this gate), the canonical bytes drift
 * between author and verifier (every remote apply starts failing sig verify),
 * a cuckoo record lands under mismatched key columns, or the D-005 privacy
 * contract leaks a gateway account id onto the wire.
 *
 * Pure — no PG, no keychain.
 * Run: cd packages/operator-core && npx vitest run lib/p2p/offer-store-schema.test.ts
 */
import { describe, expect, it } from 'vitest';
import {
  WORK_OFFER_STORE_SIG_DOMAIN,
  canonicalWorkOfferRecordJson,
  coerceWorkOfferStoreRecord,
  parseWorkOfferRecordJson,
  workOfferFedKey,
  workOfferStoreSignedBytes,
  type WorkOfferStoreRecord,
} from './offer-store-schema';

const SEAT_RECORD = {
  offerId: 'seat-abc123',
  publisherGithubUserId: 279242982,
  fleetSlug: 'alpha',
  kind: 'seat',
  status: 'open',
  cancelReason: null,
  workOffer: null,
  authorship: null,
  seat: { model: 'haiku', effort: 'low', count: 2, accountScope: 'auto', hostLabel: 'box-b' },
  recordVersion: 1,
};

describe('coerceWorkOfferStoreRecord — seat kind', () => {
  it('accepts a valid seat record fully populated', () => {
    const c = coerceWorkOfferStoreRecord(SEAT_RECORD);
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    expect(c.record.kind).toBe('seat');
    expect(c.record.seat).toEqual({ ...SEAT_RECORD.seat, audience: null });
    expect(c.record.workOffer).toBeNull();
    expect(c.record.authorship).toBeNull();
  });

  it('defaults absent hostLabel/cancelReason to null', () => {
    const c = coerceWorkOfferStoreRecord({
      ...SEAT_RECORD,
      cancelReason: undefined,
      seat: { model: 'haiku', effort: 'low', count: 1, accountScope: 'pinned' },
    });
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    expect(c.record.cancelReason).toBeNull();
    expect(c.record.seat!.hostLabel).toBeNull();
  });

  it('rejects out-of-range counts (mig-486 cap), bad accountScope, and a raw account field', () => {
    for (const seat of [
      { ...SEAT_RECORD.seat, count: 0 },
      { ...SEAT_RECORD.seat, count: 1001 },
      { ...SEAT_RECORD.seat, count: 1.5 },
      { ...SEAT_RECORD.seat, accountScope: 'AUTO' }, // vocabulary is 'auto'|'pinned', never the raw sentinel
    ]) {
      expect(coerceWorkOfferStoreRecord({ ...SEAT_RECORD, seat }).ok).toBe(false);
    }
  });

  it("rejects retired work-offer fields on a seat record (kind discrimination is closed)", () => {
    expect(coerceWorkOfferStoreRecord({ ...SEAT_RECORD, workOffer: {}, authorship: {} }).ok).toBe(false);
    expect(coerceWorkOfferStoreRecord({ ...SEAT_RECORD, seat: null }).ok).toBe(false);
  });
});

describe('coerceWorkOfferStoreRecord — seat kind P-001 pot-scoped grantee (pot-seat-pools-prose-ux-2026-07-18)', () => {
  it('accepts a pot-scoped seat record (potSlug set, fleetSlug null, audience required+set)', () => {
    const c = coerceWorkOfferStoreRecord({
      ...SEAT_RECORD,
      fleetSlug: undefined,
      potSlug: 'my-pot',
      seat: { ...SEAT_RECORD.seat, audience: 'whole-pot' },
    });
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    expect(c.record.fleetSlug).toBeNull();
    expect(c.record.potSlug).toBe('my-pot');
    expect(c.record.seat!.audience).toBe('whole-pot');
  });

  it('rejects a seat record with BOTH fleetSlug and potSlug set (grantee must be exactly one)', () => {
    expect(
      coerceWorkOfferStoreRecord({
        ...SEAT_RECORD,
        fleetSlug: 'alpha',
        potSlug: 'my-pot',
        seat: { ...SEAT_RECORD.seat, audience: 'whole-pot' },
      }).ok,
    ).toBe(false);
  });

  it('rejects a seat record with NEITHER fleetSlug nor potSlug set', () => {
    expect(
      coerceWorkOfferStoreRecord({ ...SEAT_RECORD, fleetSlug: undefined, potSlug: undefined }).ok,
    ).toBe(false);
  });

  it('rejects a pot-scoped seat with missing/invalid audience (D-002: no silent default)', () => {
    for (const audience of [undefined, null, 'everyone']) {
      expect(
        coerceWorkOfferStoreRecord({
          ...SEAT_RECORD,
          fleetSlug: undefined,
          potSlug: 'my-pot',
          seat: { ...SEAT_RECORD.seat, audience },
        }).ok,
      ).toBe(false);
    }
  });

  it('rejects a fleet-scoped seat that sets a non-null audience (audience is pot-scoped only)', () => {
    expect(
      coerceWorkOfferStoreRecord({
        ...SEAT_RECORD,
        seat: { ...SEAT_RECORD.seat, audience: 'trusted-members' },
      }).ok,
    ).toBe(false);
  });

  it("rejects potSlug set on 'spawn_request' (only 'seat' may be pot-scoped)", () => {
    expect(coerceWorkOfferStoreRecord({ ...SPAWN_REQUEST_RECORD, potSlug: 'my-pot' }).ok).toBe(false);
  });

  it('canonical json round-trips a pot-scoped seat record', () => {
    const c = coerceWorkOfferStoreRecord({
      ...SEAT_RECORD,
      fleetSlug: undefined,
      potSlug: 'my-pot',
      seat: { ...SEAT_RECORD.seat, audience: 'trusted-members' },
    });
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    const json = canonicalWorkOfferRecordJson(c.record);
    expect(parseWorkOfferRecordJson(json)).toEqual(c.record);
  });
});

const SPAWN_REQUEST_RECORD = {
  offerId: 'spawnreq-0123456789abcdef',
  publisherGithubUserId: 1567022,
  fleetSlug: 'alpha',
  kind: 'spawn_request',
  status: 'open',
  cancelReason: null,
  workOffer: null,
  authorship: null,
  seat: null,
  spawnRequest: {
    targetPublisherGithubUserId: 279242982,
    targetOfferId: 'seat-abc123',
    count: 2,
    planSlug: 'my-plan-2026-07-04',
    requesterOwnerId: 'su-owner-1',
    requestedAtMs: 1_751_600_000_000,
    launchContext: 'work the plan',
  },
  recordVersion: 1,
};

describe('coerceWorkOfferStoreRecord — spawn_request kind (P-009)', () => {
  it('accepts a valid spawn-request record and defaults absent launchContext to null', () => {
    const res = coerceWorkOfferStoreRecord(SPAWN_REQUEST_RECORD);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.record.spawnRequest?.count).toBe(2);
    const { launchContext: _omit, ...bare } = SPAWN_REQUEST_RECORD.spawnRequest;
    const res2 = coerceWorkOfferStoreRecord({ ...SPAWN_REQUEST_RECORD, spawnRequest: bare });
    expect(res2.ok).toBe(true);
    if (res2.ok) expect(res2.record.spawnRequest?.launchContext).toBeNull();
  });

  it('rejects a count past the per-request cap and a non-positive requestedAtMs', () => {
    expect(
      coerceWorkOfferStoreRecord({
        ...SPAWN_REQUEST_RECORD,
        spawnRequest: { ...SPAWN_REQUEST_RECORD.spawnRequest, count: 13 },
      }).ok,
    ).toBe(false);
    expect(
      coerceWorkOfferStoreRecord({
        ...SPAWN_REQUEST_RECORD,
        spawnRequest: { ...SPAWN_REQUEST_RECORD.spawnRequest, requestedAtMs: 0 },
      }).ok,
    ).toBe(false);
  });

  it('rejects target/requester fields that would break the fed key or signed bytes', () => {
    expect(
      coerceWorkOfferStoreRecord({
        ...SPAWN_REQUEST_RECORD,
        spawnRequest: { ...SPAWN_REQUEST_RECORD.spawnRequest, targetOfferId: 'has/slash' },
      }).ok,
    ).toBe(false);
    expect(
      coerceWorkOfferStoreRecord({
        ...SPAWN_REQUEST_RECORD,
        spawnRequest: { ...SPAWN_REQUEST_RECORD.spawnRequest, requesterOwnerId: 'white space' },
      }).ok,
    ).toBe(false);
    expect(
      coerceWorkOfferStoreRecord({
        ...SPAWN_REQUEST_RECORD,
        spawnRequest: { ...SPAWN_REQUEST_RECORD.spawnRequest, targetPublisherGithubUserId: -1 },
      }).ok,
    ).toBe(false);
  });

  it('kind discrimination is closed: no seat/retired-work payloads on a spawn_request, no spawnRequest elsewhere', () => {
    expect(coerceWorkOfferStoreRecord({ ...SPAWN_REQUEST_RECORD, seat: SEAT_RECORD.seat }).ok).toBe(false);
    expect(coerceWorkOfferStoreRecord({ ...SPAWN_REQUEST_RECORD, workOffer: {}, authorship: {} }).ok).toBe(false);
    expect(coerceWorkOfferStoreRecord({ ...SPAWN_REQUEST_RECORD, spawnRequest: null }).ok).toBe(false);
    expect(
      coerceWorkOfferStoreRecord({ ...SEAT_RECORD, spawnRequest: SPAWN_REQUEST_RECORD.spawnRequest }).ok,
    ).toBe(false);
  });

  it('canonical json round-trips a spawn_request record', () => {
    const res = coerceWorkOfferStoreRecord(SPAWN_REQUEST_RECORD);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const json = canonicalWorkOfferRecordJson(res.record);
    expect(parseWorkOfferRecordJson(json)).toEqual(res.record);
  });
});

describe('coerceWorkOfferStoreRecord — retired work kind', () => {
  it('fails closed on a legacy work record', () => {
    const c = coerceWorkOfferStoreRecord({
      ...SEAT_RECORD,
      offerId: 'wo-legacy',
      kind: 'work',
      seat: null,
      workOffer: { offerId: 'wo-legacy' },
      authorship: { devicePubkey: 'legacy' },
    });
    expect(c.ok).toBe(false);
    if (c.ok) return;
    expect(c.error).toMatch(/legacy 'work' intake is retired/);
  });
});

describe('coerceWorkOfferStoreRecord — shared gates', () => {
  it("rejects offer ids with '/', whitespace, or over-length (fed-key + signed-bytes safety)", () => {
    for (const offerId of ['a/b', 'a b', 'a\nb', '', 'x'.repeat(201)]) {
      expect(coerceWorkOfferStoreRecord({ ...SEAT_RECORD, offerId }).ok).toBe(false);
    }
  });

  it('rejects a non-positive publisher id and an unknown status', () => {
    expect(coerceWorkOfferStoreRecord({ ...SEAT_RECORD, publisherGithubUserId: 0 }).ok).toBe(false);
    expect(coerceWorkOfferStoreRecord({ ...SEAT_RECORD, status: 'expired' }).ok).toBe(false);
  });
});

describe('canonical bytes + parse round-trip', () => {
  it('canonical json parses back to the identical record (author↔verifier stability)', () => {
    const c = coerceWorkOfferStoreRecord(SPAWN_REQUEST_RECORD);
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    const json = canonicalWorkOfferRecordJson(c.record);
    expect(json.includes('\n')).toBe(false);
    expect(JSON.parse(json)).toMatchObject({ workOffer: null, authorship: null });
    expect(parseWorkOfferRecordJson(json)).toEqual(c.record);
  });

  it('parse fails closed on junk', () => {
    expect(parseWorkOfferRecordJson(null)).toBeNull();
    expect(parseWorkOfferRecordJson('not json')).toBeNull();
    expect(parseWorkOfferRecordJson('{"kind":"work"}')).toBeNull();
  });

  it('signed bytes are domain-separated and bind workspace/hive/version', () => {
    const json = canonicalWorkOfferRecordJson(SEAT_RECORD as unknown as WorkOfferStoreRecord);
    const base = { workspaceId: 'ws', potHomeSlug: 'hive', recordVersion: 1, canonicalRecordJson: json };
    const bytes = workOfferStoreSignedBytes(base).toString('utf8');
    expect(bytes.startsWith(`${WORK_OFFER_STORE_SIG_DOMAIN}\nws\nhive\n1\n`)).toBe(true);
    for (const variant of [
      { ...base, workspaceId: 'ws2' },
      { ...base, potHomeSlug: 'hive2' },
      { ...base, recordVersion: 2 },
    ]) {
      expect(workOfferStoreSignedBytes(variant).equals(workOfferStoreSignedBytes(base))).toBe(false);
    }
  });

  it('fed key mirrors the mig-490 generated column', () => {
    expect(workOfferFedKey(279242982, 'seat-abc123')).toBe('279242982/seat-abc123');
  });
});
