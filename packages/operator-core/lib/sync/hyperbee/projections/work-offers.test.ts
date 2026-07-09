/**
 * p2p-work-offers projection — unit tests (P-102 store leg, WI-1935; mig 490).
 * Mirrors fleet-directory.test.ts: pure seams, the verify gate with real
 * Ed25519 keys + mocked membership reads, and the TEETH test — neuter the
 * injectable verifier and a FORGED record applies, proving the default gate is
 * load-bearing, not decorative (EN-1 test posture). Plus the store-specific
 * invariant: the upsert NEVER touches local_disposition (a remote refresh
 * cannot clear this host's refusal — P-106 deferred #2).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const listHiveMembersMock = vi.fn(async (..._args: unknown[]): Promise<unknown[]> => []);
const loadRevokedMock = vi.fn(async (..._args: unknown[]): Promise<Set<string>> => new Set<string>());
const honorSpawnMock = vi.fn(async (..._args: unknown[]): Promise<unknown> => ({ outcome: 'skipped', reason: 'test' }));
vi.mock('../../../hive-membership-store', () => ({
  listHiveMembers: (...args: unknown[]) => listHiveMembersMock(...args),
  loadRevokedHivePubkeys: (...args: unknown[]) => loadRevokedMock(...args),
}));
// The P-009 honor hook is dynamically imported by writeToPg — mock the module
// so a projection unit test can never open a real terminal.
vi.mock('../../../p2p/delegated-spawn-honor', () => ({
  honorSpawnRequestFromProjection: (...args: unknown[]) => honorSpawnMock(...args),
}));

import {
  buildWorkOffersProjection,
  _testing,
  type WorkOfferWireRow,
  type WorkOffersProjectionOpts,
} from './work-offers';
import {
  canonicalWorkOfferRecordJson,
  coerceWorkOfferStoreRecord,
  workOfferStoreSignedBytes,
} from '../../../p2p/offer-store-schema';
import {
  generateEd25519KeypairDer,
  signWithPrivateKeyDer,
} from '../../../identity/ed25519';

const { composeKey, decodeValue, isWorkOfferWireRow, realVerifyWorkOffer } = _testing;

const WS = 'ws-test';
const HIVE = 'hive-home';
const PUBLISHER = 279242982;

const deviceKp = generateEd25519KeypairDer();
const devicePubkey = deviceKp.pubkeyBase64;
const otherKp = generateEd25519KeypairDer();

const opts: WorkOffersProjectionOpts = { workspaceId: WS, harnessSlug: HIVE };

/** A row whose record_json + signature are genuinely consistent, signed by `kp`. */
function signedRow(
  recordOver: Partial<Record<string, unknown>> = {},
  rowOver: Partial<WorkOfferWireRow> = {},
  kp = deviceKp,
  signerPubkey = devicePubkey,
): WorkOfferWireRow {
  const c = coerceWorkOfferStoreRecord({
    offerId: 'seat-abc123',
    publisherGithubUserId: PUBLISHER,
    fleetSlug: 'alpha',
    kind: 'seat',
    status: 'open',
    cancelReason: null,
    workOffer: null,
    authorship: null,
    seat: { model: 'haiku', effort: 'low', count: 2, accountScope: 'auto', hostLabel: 'box-b' },
    recordVersion: 1,
    ...recordOver,
  });
  if (!c.ok) throw new Error(c.error);
  const json = canonicalWorkOfferRecordJson(c.record);
  const sig = signWithPrivateKeyDer(kp.privateKeyDer, workOfferStoreSignedBytes({
    workspaceId: WS, potHomeSlug: HIVE,
    recordVersion: c.record.recordVersion, canonicalRecordJson: json,
  })).toString('base64');
  return {
    harness_slug: HIVE,
    publisher_github_user_id: c.record.publisherGithubUserId,
    offer_id: c.record.offerId,
    record_json: json,
    signer_device_pubkey: signerPubkey,
    signature: sig,
    record_version: c.record.recordVersion,
    fleet_slug: c.record.fleetSlug,
    offer_kind: c.record.kind,
    status: c.record.status,
    ...rowOver,
  };
}

function attestPublisherDevice() {
  listHiveMembersMock.mockResolvedValue([
    { githubUserId: PUBLISHER, deviceAttestations: [{ device_pubkey: devicePubkey }] },
  ]);
}

beforeEach(() => {
  listHiveMembersMock.mockReset().mockResolvedValue([]);
  loadRevokedMock.mockReset().mockResolvedValue(new Set());
  honorSpawnMock.mockReset().mockResolvedValue({ outcome: 'skipped', reason: 'test' });
});

describe('p2p-work-offers projection (pure seams)', () => {
  it('isWorkOfferWireRow gates malformed wire rows; composeKey = fed key; decodeValue', () => {
    const row = signedRow();
    expect(isWorkOfferWireRow(row)).toBe(true);
    expect(composeKey(row)).toBe(`${PUBLISHER}/seat-abc123`);
    expect(decodeValue(row)).toEqual(row);
    expect(decodeValue(null)).toBeNull();
    expect(decodeValue({ ...row, publisher_github_user_id: -1 })).toBeNull();
    expect(decodeValue({ ...row, record_json: '' })).toBeNull();
    expect(decodeValue({ ...row, status: 42 as unknown as string })).toBeNull();
  });
});

describe('realVerifyWorkOffer', () => {
  it('accepts a record signed by a publisher-attested, non-revoked device', async () => {
    attestPublisherDevice();
    expect(await realVerifyWorkOffer(opts, signedRow())).toBe(true);
  });

  it('drops a forged signature (attested signer, bytes do not verify)', async () => {
    attestPublisherDevice();
    const row = signedRow();
    row.signature = Buffer.from('forged!').toString('base64');
    expect(await realVerifyWorkOffer(opts, row)).toBe(false);
  });

  it('drops an unattested signer (valid signature by a non-publisher device)', async () => {
    attestPublisherDevice();
    const row = signedRow({}, {}, otherKp, otherKp.pubkeyBase64);
    expect(await realVerifyWorkOffer(opts, row)).toBe(false);
  });

  it('drops a revoked signer even when attested + signature-valid', async () => {
    attestPublisherDevice();
    loadRevokedMock.mockResolvedValue(new Set([devicePubkey]));
    expect(await realVerifyWorkOffer(opts, signedRow())).toBe(false);
  });

  it('drops cuckoo rows — signed record must match the row columns exactly', async () => {
    attestPublisherDevice();
    for (const rowOver of [
      { publisher_github_user_id: PUBLISHER + 1 },
      { offer_id: 'seat-other' },
      { fleet_slug: 'beta' },
      { offer_kind: 'work' },
      { status: 'cancelled' },
      { record_version: 9 },
    ] satisfies Partial<WorkOfferWireRow>[]) {
      expect(await realVerifyWorkOffer(opts, signedRow({}, rowOver))).toBe(false);
    }
  });

  it('drops a record whose json fails the closed schema (junk never materializes)', async () => {
    attestPublisherDevice();
    const row = signedRow();
    row.record_json = '{"kind":"seat"}';
    expect(await realVerifyWorkOffer(opts, row)).toBe(false);
  });
});

/** Template-tag call recorder standing in for postgres-js (writeToPg/deleteFromPg
 *  use sql`...` template calls). */
function fakeTemplateSql() {
  const calls: { text: string; vals: unknown[] }[] = [];
  const sql = ((strings: TemplateStringsArray, ...vals: unknown[]) => {
    calls.push({ text: strings.join('?'), vals });
    return Promise.resolve([]);
  }) as never;
  return { sql, calls };
}

describe('writeToPg gate (TEETH) + demux + disposition invariant + delete', () => {
  it('TEETH: a forged row is DROPPED by the default verifier but APPLIES when the verifier is neutered', async () => {
    const forged = signedRow();
    forged.signature = Buffer.from('forged!').toString('base64');

    // Default gate (no attestation resolvable) ⇒ no write.
    const closed = fakeTemplateSql();
    const gated = buildWorkOffersProjection({ ...opts, sql: closed.sql });
    await gated.writeToPg(forged, undefined);
    expect(closed.calls.length).toBe(0);

    // Neutered gate ⇒ the SAME forged row applies — the verifier is load-bearing.
    const open = fakeTemplateSql();
    const neutered = buildWorkOffersProjection({
      ...opts, sql: open.sql, verifyRecord: async () => true,
    });
    await neutered.writeToPg(forged, undefined);
    expect(open.calls.length).toBe(1);
    expect(open.calls[0]!.text).toMatch(/INSERT INTO harness_shared\.p2p_work_offers/);
    expect(open.calls[0]!.text).toMatch(/fed_order_key/); // the LWW guard is in the statement
  });

  it('the upsert NEVER touches local_disposition (a remote refresh cannot clear a host refusal)', async () => {
    const { sql, calls } = fakeTemplateSql();
    const p = buildWorkOffersProjection({ ...opts, sql, verifyRecord: async () => true });
    await p.writeToPg(signedRow(), undefined);
    expect(calls.length).toBe(1);
    // The column may appear in comments; assert it is never ASSIGNED.
    expect(calls[0]!.text).not.toMatch(/local_disposition\s*=/);
  });

  it('demuxes on the hive-home slug even with a neutered verifier', async () => {
    const { sql, calls } = fakeTemplateSql();
    const p = buildWorkOffersProjection({ ...opts, sql, verifyRecord: async () => true });
    await p.writeToPg(signedRow({}, { harness_slug: 'some-other-hive' }), undefined);
    expect(calls.length).toBe(0);
  });

  it('deleteFromPg parses the fed key defensively and LWW-guards the delete', async () => {
    const { sql, calls } = fakeTemplateSql();
    const p = buildWorkOffersProjection({ ...opts, sql });
    await p.deleteFromPg('junk-no-slash', 1, 'hlc');
    await p.deleteFromPg('/missing-publisher', 1, 'hlc');
    await p.deleteFromPg('0/bad-publisher', 1, 'hlc');
    expect(calls.length).toBe(0);
    await p.deleteFromPg(`${PUBLISHER}/seat-abc123`, 1, 'hlc');
    expect(calls.length).toBe(1);
    expect(calls[0]!.text).toMatch(/DELETE FROM harness_shared\.p2p_work_offers/);
    expect(calls[0]!.text).toMatch(/fed_order_key/);
    expect(calls[0]!.vals).toContain(PUBLISHER);
    expect(calls[0]!.vals).toContain('seat-abc123');
  });
});

/** fakeTemplateSql whose result carries postgres-js's `count` (an APPLIED
 *  upsert) — the honor hook keys on it. */
function fakeAppliedSql(count: number) {
  const calls: { text: string; vals: unknown[] }[] = [];
  const sql = ((strings: TemplateStringsArray, ...vals: unknown[]) => {
    calls.push({ text: strings.join('?'), vals });
    return Promise.resolve(Object.assign([], { count }));
  }) as never;
  return { sql, calls };
}

describe('P-009 spawn-request honor hook (WI-1940 pattern)', () => {
  const spawnReqOver = {
    offerId: 'spawnreq-0123456789abcdef',
    kind: 'spawn_request',
    seat: null,
    spawnRequest: {
      targetPublisherGithubUserId: 1567022,
      targetOfferId: 'seat-abc123',
      count: 2,
      planSlug: 'plan-x-2026-07-04',
      requesterOwnerId: 'su-a',
      requestedAtMs: 1_751_600_000_000,
      launchContext: null,
    },
  };

  it('fires for a landed REMOTE open spawn_request (and hands it row + scope + sql)', async () => {
    const { sql } = fakeAppliedSql(1);
    const p = buildWorkOffersProjection({ ...opts, sql, verifyRecord: async () => true });
    const row = signedRow(spawnReqOver);
    await p.writeToPg(row, { origin: 'remote', authorPubkey: 'apk', ts: 1, fedHlc: 'hlc' } as never);
    expect(honorSpawnMock).toHaveBeenCalledTimes(1);
    expect(honorSpawnMock).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: WS, potHomeSlug: HIVE, row, sql }),
    );
  });

  it('does NOT fire for local origin / a seat row / an LWW-skipped upsert', async () => {
    const applied = fakeAppliedSql(1);
    const p1 = buildWorkOffersProjection({ ...opts, sql: applied.sql, verifyRecord: async () => true });
    await p1.writeToPg(signedRow(spawnReqOver), undefined); // origin defaults 'local'
    await p1.writeToPg(signedRow(), { origin: 'remote', authorPubkey: 'apk', ts: 1, fedHlc: 'h' } as never); // kind seat
    const skipped = fakeAppliedSql(0); // LWW guard filtered the upsert
    const p2 = buildWorkOffersProjection({ ...opts, sql: skipped.sql, verifyRecord: async () => true });
    await p2.writeToPg(signedRow(spawnReqOver), { origin: 'remote', authorPubkey: 'apk', ts: 1, fedHlc: 'h' } as never);
    expect(honorSpawnMock).not.toHaveBeenCalled();
  });

  it('a throwing honor hook never unwinds the landed write (best-effort, warns loudly)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      honorSpawnMock.mockRejectedValueOnce(new Error('boom'));
      const { sql, calls } = fakeAppliedSql(1);
      const p = buildWorkOffersProjection({ ...opts, sql, verifyRecord: async () => true });
      await expect(
        p.writeToPg(signedRow(spawnReqOver), { origin: 'remote', authorPubkey: 'apk', ts: 1, fedHlc: 'h' } as never),
      ).resolves.toBeUndefined();
      expect(calls.length).toBe(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('spawn-request honor hook failed'));
    } finally {
      warn.mockRestore();
    }
  });
});
