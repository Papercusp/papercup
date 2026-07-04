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
import type { OfferAuthorship } from './offer-authorship';
import type { WorkOffer } from './offer-budget';
import {
  WORK_OFFER_STORE_SIG_DOMAIN,
  canonicalWorkOfferRecordJson,
  coerceWorkOfferStoreRecord,
  parseWorkOfferRecordJson,
  workOfferFedKey,
  workOfferStoreSignedBytes,
  type WorkOfferStoreRecord,
} from './offer-store-schema';

const OFFER: WorkOffer = {
  offerId: 'wo-1',
  fleetSlug: 'alpha',
  publisherRef: 'pub-dev-1',
  billedTo: 'host-pays',
  modelClass: 'bulk',
  priority: 5,
  isolationReqs: [],
  budget: { remote: null, local: { cap: 10, unit: 'slots', maxPerCall: null } },
  publishedAt: 1000,
  ttlMs: 60_000,
};
const AUTHORSHIP: OfferAuthorship = { devicePubkey: 'dpk', signatureByDevice: 'c2ln', epoch: 3 };

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

const WORK_RECORD = {
  offerId: 'wo-1',
  publisherGithubUserId: 279242982,
  fleetSlug: 'alpha',
  kind: 'work',
  status: 'open',
  cancelReason: null,
  workOffer: OFFER,
  authorship: AUTHORSHIP,
  seat: null,
  recordVersion: 1,
};

describe('coerceWorkOfferStoreRecord — seat kind', () => {
  it('accepts a valid seat record fully populated', () => {
    const c = coerceWorkOfferStoreRecord(SEAT_RECORD);
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    expect(c.record.kind).toBe('seat');
    expect(c.record.seat).toEqual(SEAT_RECORD.seat);
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

  it("rejects work-kind fields on a seat record (kind discrimination is closed)", () => {
    expect(coerceWorkOfferStoreRecord({ ...SEAT_RECORD, workOffer: OFFER, authorship: AUTHORSHIP }).ok).toBe(false);
    expect(coerceWorkOfferStoreRecord({ ...SEAT_RECORD, seat: null }).ok).toBe(false);
  });
});

describe('coerceWorkOfferStoreRecord — work kind (H17 single-validator reuse)', () => {
  it('accepts a valid work record (offer + inner authorship)', () => {
    const c = coerceWorkOfferStoreRecord(WORK_RECORD);
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    expect(c.record.workOffer).toEqual(OFFER);
    expect(c.record.authorship).toEqual(AUTHORSHIP);
    expect(c.record.seat).toBeNull();
  });

  it('refuses through the H17 intake gate on a malformed inner offer', () => {
    const c = coerceWorkOfferStoreRecord({
      ...WORK_RECORD,
      workOffer: { ...OFFER, budget: undefined },
    });
    expect(c.ok).toBe(false);
    if (c.ok) return;
    expect(c.error).toContain('H17');
  });

  it('rejects cuckoo key fields (store key must BE the offer identity)', () => {
    expect(coerceWorkOfferStoreRecord({ ...WORK_RECORD, offerId: 'wo-other' }).ok).toBe(false);
    expect(coerceWorkOfferStoreRecord({ ...WORK_RECORD, fleetSlug: 'beta' }).ok).toBe(false);
  });

  it('requires the inner pair and refuses a seat payload', () => {
    expect(coerceWorkOfferStoreRecord({ ...WORK_RECORD, authorship: null }).ok).toBe(false);
    expect(coerceWorkOfferStoreRecord({ ...WORK_RECORD, seat: SEAT_RECORD.seat }).ok).toBe(false);
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
    const c = coerceWorkOfferStoreRecord(WORK_RECORD);
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    const json = canonicalWorkOfferRecordJson(c.record);
    expect(json.includes('\n')).toBe(false);
    expect(parseWorkOfferRecordJson(json)).toEqual(c.record);
  });

  it('parse fails closed on junk', () => {
    expect(parseWorkOfferRecordJson(null)).toBeNull();
    expect(parseWorkOfferRecordJson('not json')).toBeNull();
    expect(parseWorkOfferRecordJson('{"kind":"work"}')).toBeNull();
  });

  it('signed bytes are domain-separated and bind workspace/hive/version', () => {
    const json = canonicalWorkOfferRecordJson(SEAT_RECORD as unknown as WorkOfferStoreRecord);
    const base = { workspaceId: 'ws', hiveHomeSlug: 'hive', recordVersion: 1, canonicalRecordJson: json };
    const bytes = workOfferStoreSignedBytes(base).toString('utf8');
    expect(bytes.startsWith(`${WORK_OFFER_STORE_SIG_DOMAIN}\nws\nhive\n1\n`)).toBe(true);
    for (const variant of [
      { ...base, workspaceId: 'ws2' },
      { ...base, hiveHomeSlug: 'hive2' },
      { ...base, recordVersion: 2 },
    ]) {
      expect(workOfferStoreSignedBytes(variant).equals(workOfferStoreSignedBytes(base))).toBe(false);
    }
  });

  it('fed key mirrors the mig-490 generated column', () => {
    expect(workOfferFedKey(279242982, 'seat-abc123')).toBe('279242982/seat-abc123');
  });
});
