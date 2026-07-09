/**
 * p2p-fleet-directory projection — unit tests (P-101 / D-006). Mirrors
 * hive-policy.test.ts for the pure seams, PLUS the verify gate itself with real
 * Ed25519 keys and mocked membership/hive reads, and the TEETH test: neuter the
 * injectable verifier and a FORGED record applies — proving the default gate is
 * load-bearing, not decorative (EN-1 test posture).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const listHiveMembersMock = vi.fn(async (..._args: unknown[]): Promise<unknown[]> => []);
const loadRevokedMock = vi.fn(async (..._args: unknown[]): Promise<Set<string>> => new Set<string>());
vi.mock('../../../hive-membership-store', () => ({
  listHiveMembers: (...args: unknown[]) => listHiveMembersMock(...args),
  loadRevokedHivePubkeys: (...args: unknown[]) => loadRevokedMock(...args),
}));
const getHiveBySlugMock = vi.fn(async (..._args: unknown[]): Promise<unknown> => null);
vi.mock('../../../hive-store', () => ({
  getHiveBySlug: (...args: unknown[]) => getHiveBySlugMock(...args),
}));

import {
  buildFleetDirectoryProjection,
  _testing,
  type FleetDirectoryRow,
  type FleetDirectoryProjectionOpts,
} from './fleet-directory';
import {
  canonicalFleetRecordJson,
  coerceFleetDirectoryRecord,
  fleetDirectorySignedBytes,
} from '../../../p2p/fleet-directory-schema';
import {
  generateEd25519KeypairDer,
  signWithPrivateKeyDer,
} from '../../../identity/ed25519';

const { composeKey, decodeValue, isFleetDirectoryRow, realVerifyFleetDirectory } = _testing;

const WS = 'ws-test';
const HIVE = 'hive-home';
const OWNER = 279242982;

const deviceKp = generateEd25519KeypairDer();
const devicePubkey = deviceKp.pubkeyBase64;
const hiveKp = generateEd25519KeypairDer();
const hivePubkey = hiveKp.pubkeyBase64;

const opts: FleetDirectoryProjectionOpts = { workspaceId: WS, harnessSlug: HIVE };

/** A row whose record_json + signature are genuinely consistent, signed by `kp`. */
function signedRow(
  recordOver: Partial<Record<string, unknown>> = {},
  rowOver: Partial<FleetDirectoryRow> = {},
  kp = deviceKp,
  signerPubkey = devicePubkey,
): FleetDirectoryRow {
  const c = coerceFleetDirectoryRecord({
    fleetSlug: 'alpha',
    ownerGithubUserId: OWNER,
    title: 'Alpha',
    description: '',
    recordVersion: 1,
    archived: false,
    ...recordOver,
  });
  if (!c.ok) throw new Error(c.error);
  const json = canonicalFleetRecordJson(c.record);
  const sig = signWithPrivateKeyDer(kp.privateKeyDer, fleetDirectorySignedBytes({
    workspaceId: WS, potHomeSlug: HIVE,
    recordVersion: c.record.recordVersion, canonicalRecordJson: json,
  })).toString('base64');
  return {
    harness_slug: HIVE,
    owner_github_user_id: c.record.ownerGithubUserId,
    fleet_slug: c.record.fleetSlug,
    record_json: json,
    signer_device_pubkey: signerPubkey,
    signature: sig,
    record_version: c.record.recordVersion,
    archived: c.record.archived,
    ...rowOver,
  };
}

function attestOwnerDevice() {
  listHiveMembersMock.mockResolvedValue([
    { githubUserId: OWNER, deviceAttestations: [{ device_pubkey: devicePubkey }] },
  ]);
}

beforeEach(() => {
  listHiveMembersMock.mockReset().mockResolvedValue([]);
  loadRevokedMock.mockReset().mockResolvedValue(new Set());
  getHiveBySlugMock.mockReset().mockResolvedValue(null);
});

describe('p2p-fleet-directory projection (pure seams)', () => {
  it('isFleetDirectoryRow gates malformed wire rows; composeKey = fed key; decodeValue', () => {
    const row = signedRow();
    expect(isFleetDirectoryRow(row)).toBe(true);
    expect(isFleetDirectoryRow({ ...row, harness_slug: '' })).toBe(false);
    expect(isFleetDirectoryRow({ ...row, owner_github_user_id: -1 })).toBe(false);
    expect(isFleetDirectoryRow({ ...row, record_json: '' })).toBe(false);
    expect(isFleetDirectoryRow({ ...row, signature: 42 })).toBe(false);
    expect(isFleetDirectoryRow({ ...row, archived: 'no' })).toBe(false);
    expect(isFleetDirectoryRow(null)).toBe(false);
    expect(composeKey(row)).toBe(`${OWNER}/alpha`);
    expect(decodeValue(row)).toEqual(row);
    expect(decodeValue({ bad: 1 })).toBeNull();
  });
});

describe('realVerifyFleetDirectory', () => {
  it('accepts a record signed by an owner-attested, non-revoked device', async () => {
    attestOwnerDevice();
    expect(await realVerifyFleetDirectory(opts, signedRow())).toBe(true);
  });

  it('drops a forged signature (attested signer, bytes do not verify)', async () => {
    attestOwnerDevice();
    const row = signedRow();
    row.signature = Buffer.from('forged-signature-bytes-not-valid!').toString('base64');
    expect(await realVerifyFleetDirectory(opts, row)).toBe(false);
  });

  it('drops an unattested signer (valid signature by a non-owner device)', async () => {
    // Signed by hiveKp, which is NOT attested to the owner (and not the hive key path).
    const row = signedRow({}, {}, hiveKp, hivePubkey);
    attestOwnerDevice();
    expect(await realVerifyFleetDirectory(opts, row)).toBe(false);
  });

  it('drops a revoked signer even when attested + signature-valid', async () => {
    attestOwnerDevice();
    loadRevokedMock.mockResolvedValue(new Set([devicePubkey]));
    expect(await realVerifyFleetDirectory(opts, signedRow())).toBe(false);
  });

  it('drops cuckoo rows — signed record must match the row key columns', async () => {
    attestOwnerDevice();
    // Row claims a different owner than the signed record.
    expect(await realVerifyFleetDirectory(opts, signedRow({}, { owner_github_user_id: 555 }))).toBe(false);
    expect(await realVerifyFleetDirectory(opts, signedRow({}, { fleet_slug: 'other' }))).toBe(false);
    expect(await realVerifyFleetDirectory(opts, signedRow({}, { record_version: 9 }))).toBe(false);
    expect(await realVerifyFleetDirectory(opts, signedRow({}, { archived: true }))).toBe(false);
  });

  it('H10: the hive identity key may sign ONLY an archived record', async () => {
    getHiveBySlugMock.mockResolvedValue({ pubkeyBase64: hivePubkey });
    const archive = signedRow({ archived: true }, {}, hiveKp, hivePubkey);
    expect(await realVerifyFleetDirectory(opts, archive)).toBe(true);
    // The same authority over a LIVE record is refused — the hive owner cannot
    // publish or mutate a live fleet record.
    const live = signedRow({}, {}, hiveKp, hivePubkey);
    expect(await realVerifyFleetDirectory(opts, live)).toBe(false);
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

describe('writeToPg gate (TEETH) + demux + delete', () => {
  it('TEETH: a forged row is DROPPED by the default verifier but APPLIES when the verifier is neutered', async () => {
    const forged = signedRow();
    forged.signature = Buffer.from('forged!').toString('base64');

    // Default gate (no attestation resolvable) ⇒ no write.
    const closed = fakeTemplateSql();
    const gated = buildFleetDirectoryProjection({ ...opts, sql: closed.sql });
    await gated.writeToPg(forged, undefined);
    expect(closed.calls.length).toBe(0);

    // Neutered gate ⇒ the SAME forged row applies — the verifier is load-bearing.
    const open = fakeTemplateSql();
    const neutered = buildFleetDirectoryProjection({
      ...opts, sql: open.sql, verifyRecord: async () => true,
    });
    await neutered.writeToPg(forged, undefined);
    expect(open.calls.length).toBe(1);
    expect(open.calls[0]!.text).toMatch(/INSERT INTO harness_shared\.p2p_fleet_directory/);
    expect(open.calls[0]!.text).toMatch(/fed_order_key/); // the LWW guard is in the statement
  });

  it('demuxes on the hive-home slug even with a neutered verifier', async () => {
    const { sql, calls } = fakeTemplateSql();
    const p = buildFleetDirectoryProjection({ ...opts, sql, verifyRecord: async () => true });
    await p.writeToPg(signedRow({}, { harness_slug: 'some-other-hive' }), undefined);
    expect(calls.length).toBe(0);
  });

  it('deleteFromPg parses the fed key defensively and LWW-guards the delete', async () => {
    const { sql, calls } = fakeTemplateSql();
    const p = buildFleetDirectoryProjection({ ...opts, sql });
    await p.deleteFromPg('junk-no-slash', 1, 'hlc');
    await p.deleteFromPg('/missing-owner', 1, 'hlc');
    await p.deleteFromPg('0/bad-owner', 1, 'hlc');
    expect(calls.length).toBe(0);
    await p.deleteFromPg(`${OWNER}/alpha`, 1, 'hlc');
    expect(calls.length).toBe(1);
    expect(calls[0]!.text).toMatch(/DELETE FROM harness_shared\.p2p_fleet_directory/);
    expect(calls[0]!.text).toMatch(/fed_order_key/);
    expect(calls[0]!.vals).toContain(OWNER);
    expect(calls[0]!.vals).toContain('alpha');
  });
});
