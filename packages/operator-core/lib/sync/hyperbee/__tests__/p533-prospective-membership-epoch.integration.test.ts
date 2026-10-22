/** Independent prospective P533 contracts. WI-6554700010020476.
 * Three migrated disposable PGs; real epoch/member projections and readers.
 * Transport is excluded here; the existing boot churn rigs remain separate.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { encodeHlc } from '@papercusp/locks-core';
import { createOrgTestDb, type OrgTestDb } from '../../../../test/_org-test-db';
import { seedHive, HIVE_SLUG, WORKSPACE_ID } from './_hive-substrate-rig';
import { getHiveEpoch, setHiveEpoch } from '../hive-epoch-state';
import { buildHiveSettingsProjection } from '../projections/hive-settings';
import { buildHiveMembersProjection } from '../projections/hive-members';
import { applyOpVia, type TableProjection } from '../projection';
import { getScopeRoster } from '../../../p2p/scope-roster';
import { advanceGrantorHighWater } from '../../../p2p/grant-store';
import { addRevokedHivePubkeys, listHiveMembers, loadRevokedHivePubkeys, upsertHiveMember } from '../../../hive-membership-store';
import { __resetCommsTierGate, __setCommsTierGateDeps, resolveAuthorCommsTier } from '../comms-tier-gate';
import { resolvePeerAdmission } from '../../pot-git/serve-wiring';
import type { ScopeId } from '../../pot-git/scope-repo';
import type { DeviceAttestationEntry } from '../../../harness/contributor-row-types';

const databases: OrgTestDb[] = [];
afterEach(async () => {
  __resetCommsTierGate();
  await Promise.all(databases.splice(0).map(db => db.cleanup()));
});
const scope: ScopeId = { kind: 'fleet', ownerGithubUserId: 101, slug: 'p533-independent' };
function attestation(device: string): DeviceAttestationEntry {
  return { device_pubkey: device, gist_id: 'fixture', gist_url: 'https://example.invalid/fixture',
    device_label: device, created_at: 1, signature_by_device: 'fixture-signature' };
}
async function peer() {
  const db = await createOrgTestDb();
  databases.push(db);
  await seedHive(db.adminSql);
  await upsertHiveMember({ workspaceId: WORKSPACE_ID, potHomeSlug: HIVE_SLUG,
    githubUserId: 101, githubUsername: 'owner', deviceAttestations: [attestation('owner-device')] }, db.adminSql);
  await upsertHiveMember({ workspaceId: WORKSPACE_ID, potHomeSlug: HIVE_SLUG,
    githubUserId: 102, githubUsername: 'member', deviceAttestations: [attestation('member-old')] }, db.adminSql);
  return db;
}
function roster(db: OrgTestDb) {
  return getScopeRoster({ workspaceId: WORKSPACE_ID, potSlug: HIVE_SLUG, sqlOverride: db.adminSql });
}
async function project(db: OrgTestDb, epoch: number, revoked: string[]) {
  const opts = { workspaceId: WORKSPACE_ID, harnessSlug: HIVE_SLUG, sql: db.adminSql };
  const settings = buildHiveSettingsProjection(opts);
  const members = buildHiveMembersProjection(opts);
  const projections = new Map<string, TableProjection<unknown>>([
    [settings.tableTag, settings as TableProjection<unknown>], [members.tableTag, members as TableProjection<unknown>],
  ]);
  for (const [projection, key, value] of [
    [members, '101', { pot_home_slug: HIVE_SLUG, github_user_id: 101, github_username: 'owner',
      device_attestations: [attestation('owner-device')], revoked_pubkeys: revoked, binding_status: 'verified' }],
    [settings, 'epoch', { harness_slug: HIVE_SLUG, setting_key: 'epoch', value: JSON.stringify(epoch) }],
  ] as const) {
    expect(await applyOpVia(tag => projections.get(tag) ?? null, {
      type: 'put', table: projection.tableTag, hbKey: key, value,
      ts: epoch * 1000, hlc: encodeHlc({ ms: epoch * 1000, count: 0 }),
      writerPubkey: 'owner-device', sourceLogKeyHex: 'a'.repeat(64),
    }, { ownLogKeyHex: 'b'.repeat(64) })).toBe(true);
  }
}

describe('P533 prospective shared membership epoch', () => {
  it('three peers use the same membership epoch after revoke, partition and rejoin; stale replay cannot lower it', async () => {
    const [a, b, c] = await Promise.all([peer(), peer(), peer()]);
    await Promise.all([a, b, c].map(db => project(db, 1, [])));
    await addRevokedHivePubkeys(WORKSPACE_ID, HIVE_SLUG, 101, ['member-old'], a.adminSql);
    await setHiveEpoch(WORKSPACE_ID, HIVE_SLUG, 2, a.adminSql);
    await project(b, 2, ['member-old']);
    // C is partitioned and still has epoch 1. Its later catch-up uses the same
    // production projections, followed by an out-of-order old replay.
    expect(await getHiveEpoch(WORKSPACE_ID, HIVE_SLUG, c.adminSql)).toBe(1);
    await project(c, 2, ['member-old']);
    await project(c, 1, []);
    for (const db of [a, b, c]) {
      expect(await getHiveEpoch(WORKSPACE_ID, HIVE_SLUG, db.adminSql)).toBe(2);
      expect(await loadRevokedHivePubkeys(WORKSPACE_ID, HIVE_SLUG, db.adminSql)).toContain('member-old');
      expect(await roster(db).currentEpoch(scope)).toBe(2);
    }
  });

  it('grant replay high-water remains separate from the membership epoch used for disclosure', async () => {
    const db = await peer();
    await setHiveEpoch(WORKSPACE_ID, HIVE_SLUG, 3, db.adminSql);
    await advanceGrantorHighWater({ workspaceId: WORKSPACE_ID, potSlug: HIVE_SLUG,
      grantorGithubUserId: 101, epoch: 23 }, db.adminSql);
    expect(await getHiveEpoch(WORKSPACE_ID, HIVE_SLUG, db.adminSql)).toBe(3);
    expect(await roster(db).currentEpoch(scope)).toBe(3);
    const rows = await db.adminSql`SELECT high_water_epoch FROM harness_shared.p2p_grantor_epochs
      WHERE workspace_id=${WORKSPACE_ID} AND harness_slug=${HIVE_SLUG} AND grantor_github_user_id=101`;
    expect(Number(rows[0].high_water_epoch)).toBe(23);
  });

  it('a cached comms admission cannot outlive the same revocation that immediately fences Git serving', async () => {
    const db = await peer();
    await setHiveEpoch(WORKSPACE_ID, HIVE_SLUG, 1, db.adminSql);
    __setCommsTierGateDeps({ listHiveMembers: async () => listHiveMembers(WORKSPACE_ID, HIVE_SLUG, db.adminSql),
      effectiveCommsTier: async () => ({ tier: 'steer', source: 'override' }) });
    const input = { workspaceId: WORKSPACE_ID, potHomeSlug: HIVE_SLUG, devicePubkey: 'member-old', nowMs: 1000 };
    expect(await resolveAuthorCommsTier(input)).toMatchObject({ tier: 'steer', githubUserId: 102 });
    await addRevokedHivePubkeys(WORKSPACE_ID, HIVE_SLUG, 101, ['member-old'], db.adminSql);
    await setHiveEpoch(WORKSPACE_ID, HIVE_SLUG, 2, db.adminSql);
    const serve = await resolvePeerAdmission({ workspaceId: WORKSPACE_ID, potHomeSlug: HIVE_SLUG,
      peerDevicePubkey: 'member-old', loadRevoked: async () => loadRevokedHivePubkeys(WORKSPACE_ID, HIVE_SLUG, db.adminSql),
      resolveMember: async () => 102 });
    expect(serve).toMatchObject({ ok: false, refusal: 'revoked-device' });
    const after = await resolveAuthorCommsTier({ ...input, nowMs: 1001 });
    expect(after.githubUserId).toBeNull();
    expect(after.tier).not.toBe('steer');
  });
});
