/**
 * hive-members projection — the Hyperbee→PG read side for per-Hive admission
 * federation (shared-hive-federation P-006 multi-Swarm). Real-PG: applies migs
 * 184 (hives) + 185 (hive_members) + 189 (federation cols) and exercises the
 * projection's writeToPg LWW + cross-Hive demux + delete. The capture/op-key/
 * register-all (write side) is su-02ae39's wiring; this proves the read side +
 * that a federated revoked_pubkeys lands where loadRevokedHivePubkeys reads it.
 */

import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFreshPgDb, type FreshPgDb } from '../../../../test/_pg-helpers';
import { generateEd25519KeypairDer } from '../../../identity/ed25519';
import { hiveKeychainId } from '../../../identity/hive-keypair';
import { insertHiveIfAbsent } from '../../../hive-store';
import { loadRevokedHivePubkeys, getHiveMember } from '../../../hive-membership-store';
import { buildHiveMembersProjection, _testing, type HiveMemberRow } from './hive-members';
import type { DeviceAttestationEntry } from '../../../harness/contributor-row-types';
import { listBootHistory, _resetBootHistoryForTests } from '../boot-history';

// WI-3828: the WI-887 self-heal (writeToPg's onMemberApplied epoch-key reconcile) used to
// swallow its dynamic-import result in a bare `catch {}` — a thrown grant failure, or a
// meaningful non-throw skip, was completely invisible. Mock the dynamically-imported module
// so each test below controls exactly what reconcileEpochKeysForCurrentMembers returns/throws.
const reconcileEpochKeysForCurrentMembers = vi.fn().mockResolvedValue({ applied: true, newEpoch: 1, distributed: 1 });
const isHiveRekeyEnabledMock = vi.fn().mockResolvedValue(true);
vi.mock('../hive-epoch-boundary-wiring', () => ({
  reconcileEpochKeysForCurrentMembers: (...args: unknown[]) => reconcileEpochKeysForCurrentMembers(...args),
  isHiveRekeyEnabled: () => isHiveRekeyEnabledMock(),
}));

const SQL_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../../../../libs/papercusp/libs/db/sql');
const WS = 'ws-proj';
const HIVE = 'alpha';

function dev(pk: string): DeviceAttestationEntry {
  return { device_pubkey: pk, gist_id: 'g', gist_url: 'u', device_label: 'd', created_at: 1, signature_by_device: 's' };
}
function memberRow(over: Partial<HiveMemberRow> = {}): HiveMemberRow {
  return {
    hive_home_slug: HIVE,
    github_user_id: 7,
    github_username: 'octo',
    device_attestations: [dev('pk-a')],
    revoked_pubkeys: [],
    binding_status: 'verified',
    ...over,
  };
}

let db: FreshPgDb;

beforeAll(async () => {
  db = await createFreshPgDb('hive-members-proj');
  for (const m of ['184-hives-table.sql', '185-hive-members-admission.sql', '189-hive-members-federation-cols.sql']) {
    await db.sql.unsafe(readFileSync(join(SQL_DIR, m), 'utf8'));
  }
  // D-001 (mig 314): the fed_hlc ordering column the projection now writes.
  await db.sql.unsafe(`ALTER TABLE harness_shared.hive_members ADD COLUMN IF NOT EXISTS fed_hlc TEXT`);
});
afterAll(async () => {
  await db?.cleanup();
});
afterEach(async () => {
  await db.sql.unsafe('TRUNCATE harness_shared.hive_members, harness_shared.hives CASCADE');
  reconcileEpochKeysForCurrentMembers.mockReset().mockResolvedValue({ applied: true, newEpoch: 1, distributed: 1 });
  isHiveRekeyEnabledMock.mockReset().mockResolvedValue(true);
  _resetBootHistoryForTests();
});
async function seedHive(slug = HIVE) {
  await insertHiveIfAbsent(
    { workspaceId: WS, homeSlug: slug, pubkeyBase64: generateEd25519KeypairDer().pubkeyBase64, keychainId: hiveKeychainId(WS, slug) },
    db.sql,
  );
}

const proj = () => buildHiveMembersProjection({ workspaceId: WS, harnessSlug: HIVE, sql: db.sql });

describe('hive-members projection — pure helpers', () => {
  it('isHiveMemberRow / decodeValue accept a valid row, reject malformed', () => {
    expect(_testing.decodeValue(memberRow())).not.toBeNull();
    expect(_testing.decodeValue({ ...memberRow(), github_user_id: 0 })).toBeNull();
    expect(_testing.decodeValue({ ...memberRow(), hive_home_slug: '' })).toBeNull();
    expect(_testing.decodeValue({ ...memberRow(), device_attestations: 'nope' })).toBeNull();
  });
  it('composeKey is the github_user_id', () => {
    expect(_testing.composeKey(memberRow({ github_user_id: 42 }))).toBe('42');
  });
});

describe('hive-members projection — writeToPg / deleteFromPg (real PG)', () => {
  it('applies a member op; the federated revoked_pubkeys is visible to loadRevokedHivePubkeys', async () => {
    await seedHive();
    await proj().writeToPg(memberRow({ github_user_id: 7, revoked_pubkeys: ['bad-pk'] }), { ts: 100, origin: 'remote', authorPubkey: 'peer' });
    const member = await getHiveMember(WS, HIVE, 7, db.sql);
    expect(member?.githubUsername).toBe('octo');
    expect(member?.deviceAttestations[0]?.device_pubkey).toBe('pk-a');
    // the whole point: a federated revocation lands where the admission union reads it
    expect([...(await loadRevokedHivePubkeys(WS, HIVE, db.sql))]).toEqual(['bad-pk']);
  });

  it('drops a cross-Hive op (hive_home_slug != the projection scope)', async () => {
    await seedHive();
    await seedHive('beta');
    await proj().writeToPg(memberRow({ hive_home_slug: 'beta', github_user_id: 9 }), { ts: 1, origin: 'remote', authorPubkey: 'peer' });
    expect(await getHiveMember(WS, HIVE, 9, db.sql)).toBeNull(); // demuxed out
    expect(await getHiveMember(WS, 'beta', 9, db.sql)).toBeNull(); // this projection is bound to HIVE
  });

  it('LWW: a newer fed_ts wins, an older one is dropped', async () => {
    await seedHive();
    const p = proj();
    await p.writeToPg(memberRow({ github_user_id: 7, revoked_pubkeys: ['old'] }), { ts: 200, origin: 'remote', authorPubkey: 'peer' });
    await p.writeToPg(memberRow({ github_user_id: 7, revoked_pubkeys: ['stale'] }), { ts: 100, origin: 'remote', authorPubkey: 'peer' }); // older
    expect((await getHiveMember(WS, HIVE, 7, db.sql))?.revokedPubkeys).toEqual(['old']); // newer held
    await p.writeToPg(memberRow({ github_user_id: 7, revoked_pubkeys: ['new'] }), { ts: 300, origin: 'remote', authorPubkey: 'peer' }); // newer
    expect((await getHiveMember(WS, HIVE, 7, db.sql))?.revokedPubkeys).toEqual(['new']);
  });

  it('deleteFromPg removes by github_user_id (ts-guarded)', async () => {
    await seedHive();
    const p = proj();
    await p.writeToPg(memberRow({ github_user_id: 7 }), { ts: 100, origin: 'remote', authorPubkey: 'peer' });
    await p.deleteFromPg('7', 50); // stale del — guarded out
    expect(await getHiveMember(WS, HIVE, 7, db.sql)).not.toBeNull();
    await p.deleteFromPg('7', 200); // newer del — applies
    expect(await getHiveMember(WS, HIVE, 7, db.sql)).toBeNull();
  });
});

describe('hive-members projection — WI-3828 self-heal grant is no longer a bare swallow', () => {
  it('records a rekey_grant_failed boot-history event when the reconcile throws (was: silently swallowed)', async () => {
    await seedHive();
    reconcileEpochKeysForCurrentMembers.mockRejectedValueOnce(new Error('boom-grant'));
    // writeToPg must still resolve — a grant failure must never abort the member apply.
    await expect(
      proj().writeToPg(memberRow({ github_user_id: 7 }), { ts: 100, origin: 'remote', authorPubkey: 'peer' }),
    ).resolves.toBeUndefined();
    expect(await getHiveMember(WS, HIVE, 7, db.sql)).not.toBeNull(); // the row still landed
    const events = listBootHistory({ workspaceId: WS, harnessSlug: HIVE, kinds: ['rekey_grant_failed'] });
    expect(events).toHaveLength(1);
    expect(events[0]?.message).toContain('boom-grant');
    expect(events[0]?.message).toContain('onMemberApplied self-heal');
  });

  it('records a rekey_grant_skipped boot-history event on a meaningful (non-throw) skip reason', async () => {
    await seedHive();
    reconcileEpochKeysForCurrentMembers.mockResolvedValueOnce({ applied: false, reason: 'no-fresh-members' });
    await proj().writeToPg(memberRow({ github_user_id: 7 }), { ts: 100, origin: 'remote', authorPubkey: 'peer' });
    const events = listBootHistory({ workspaceId: WS, harnessSlug: HIVE, kinds: ['rekey_grant_skipped'] });
    expect(events).toHaveLength(1);
    expect(events[0]?.message).toContain('no-fresh-members');
  });

  it('does NOT record an event for the benign no-gap / no-author skip reasons (steady-state noise)', async () => {
    await seedHive();
    reconcileEpochKeysForCurrentMembers.mockResolvedValueOnce({ applied: false, reason: 'no-gap' });
    await proj().writeToPg(memberRow({ github_user_id: 7 }), { ts: 100, origin: 'remote', authorPubkey: 'peer' });
    reconcileEpochKeysForCurrentMembers.mockResolvedValueOnce({ applied: false, reason: 'no-author' });
    await proj().writeToPg(memberRow({ github_user_id: 8, github_username: 'octo2' }), { ts: 101, origin: 'remote', authorPubkey: 'peer' });
    expect(listBootHistory({ workspaceId: WS, harnessSlug: HIVE })).toHaveLength(0);
  });

  it('records nothing on a healthy applied:true grant (the common case)', async () => {
    await seedHive();
    await proj().writeToPg(memberRow({ github_user_id: 7 }), { ts: 100, origin: 'remote', authorPubkey: 'peer' });
    expect(listBootHistory({ workspaceId: WS, harnessSlug: HIVE })).toHaveLength(0);
  });
});
