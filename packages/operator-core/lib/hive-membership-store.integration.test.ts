/**
 * hive-membership-store — per-Hive admission data layer (shared-hive-federation
 * P-006, D-004; migration 185). Real-PG integration: applies migrations 184
 * (hives) + 185 (hive_members) to a fresh schema and exercises the store, the FK
 * to hives, workspace scoping, and the revoked-pubkey union that feeds the REUSED
 * read-admission decider. The boot.ts wire-in of loadRevokedHivePubkeys is the
 * P-004 substrate re-key (partner); this proves the data layer + admission
 * semantics that wiring will consume.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';
import { generateEd25519KeypairDer } from './identity/ed25519';
import { hiveKeychainId } from './identity/hive-keypair';
import { insertHiveIfAbsent, deleteHive } from './hive-store';
import {
  upsertHiveMember,
  getHiveMember,
  listHiveMembers,
  loadRevokedHivePubkeys,
  loadHiveMemberDevicePubkeys,
  addRevokedHivePubkeys,
} from './hive-membership-store';
import { makeAdmissionDecider } from './sync/hyperbee/read-admission';
import type { DeviceAttestationEntry } from './harness/contributor-row-types';

const SQL_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../libs/papercusp/libs/db/sql');
const WS = 'ws-p006';
const HIVE = 'alpha';

function dev(pubkey: string): DeviceAttestationEntry {
  return { device_pubkey: pubkey, gist_id: 'g', gist_url: 'u', device_label: 'd', created_at: 1, signature_by_device: 's' };
}

let db: FreshPgDb;

beforeAll(async () => {
  db = await createFreshPgDb('hive-members');
  await db.sql.unsafe(readFileSync(join(SQL_DIR, '184-hives-table.sql'), 'utf8'));
  await db.sql.unsafe(readFileSync(join(SQL_DIR, '185-hive-members-admission.sql'), 'utf8'));
  // WI-892 / EI-3409: forbid the '*' wildcard workspace_id (heal + CHECK constraint).
  await db.sql.unsafe(readFileSync(join(SQL_DIR, '406-hive-members-forbid-wildcard-workspace.sql'), 'utf8'));
});

afterAll(async () => {
  await db?.cleanup();
});

afterEach(async () => {
  await db.sql.unsafe('TRUNCATE harness_shared.hive_members, harness_shared.hives CASCADE');
});

async function seedHive(slug = HIVE, ws = WS): Promise<void> {
  await insertHiveIfAbsent(
    {
      workspaceId: ws,
      homeSlug: slug,
      pubkeyBase64: generateEd25519KeypairDer().pubkeyBase64,
      keychainId: hiveKeychainId(ws, slug),
    },
    db.sql,
  );
}

describe('hive-membership-store (P-006 per-Hive admission)', () => {
  it('requires a parent Hive (FK) — a member with no hives row is rejected', async () => {
    await expect(
      upsertHiveMember({ workspaceId: WS, hiveHomeSlug: 'ghost', githubUserId: 1, githubUsername: 'a' }, db.sql),
    ).rejects.toThrow();
  });

  it('upsert → get round-trips a member with bound devices', async () => {
    await seedHive();
    const rec = await upsertHiveMember(
      { workspaceId: WS, hiveHomeSlug: HIVE, githubUserId: 7, githubUsername: 'octo', deviceAttestations: [dev('pk-a')], bindingStatus: 'verified' },
      db.sql,
    );
    expect(rec.githubUserId).toBe(7);
    const read = await getHiveMember(WS, HIVE, 7, db.sql);
    expect(read?.githubUsername).toBe('octo');
    expect(read?.deviceAttestations[0]?.device_pubkey).toBe('pk-a');
    expect(read?.bindingStatus).toBe('verified');
  });

  it('upsert is idempotent on (ws, hive, user) — updates in place, never duplicates', async () => {
    await seedHive();
    await upsertHiveMember({ workspaceId: WS, hiveHomeSlug: HIVE, githubUserId: 7, githubUsername: 'octo' }, db.sql);
    await upsertHiveMember({ workspaceId: WS, hiveHomeSlug: HIVE, githubUserId: 7, githubUsername: 'octo-renamed' }, db.sql);
    const members = await listHiveMembers(WS, HIVE, db.sql);
    expect(members).toHaveLength(1);
    expect(members[0].githubUsername).toBe('octo-renamed');
  });

  it('loadRevokedHivePubkeys UNIONS + dedupes revoked_pubkeys across all members (the blocklist)', async () => {
    await seedHive();
    await upsertHiveMember({ workspaceId: WS, hiveHomeSlug: HIVE, githubUserId: 1, githubUsername: 'a', revokedPubkeys: ['x', 'y'] }, db.sql);
    await upsertHiveMember({ workspaceId: WS, hiveHomeSlug: HIVE, githubUserId: 2, githubUsername: 'b', revokedPubkeys: ['y', 'z'] }, db.sql);
    const revoked = await loadRevokedHivePubkeys(WS, HIVE, db.sql);
    expect([...revoked].sort()).toEqual(['x', 'y', 'z']);
  });

  it('addRevokedHivePubkeys unions into the owner row (idempotent); null when the owner has no row', async () => {
    await seedHive();
    expect(await addRevokedHivePubkeys(WS, HIVE, 99, ['pk'], db.sql)).toBeNull();
    await upsertHiveMember({ workspaceId: WS, hiveHomeSlug: HIVE, githubUserId: 99, githubUsername: 'owner' }, db.sql);
    const r1 = await addRevokedHivePubkeys(WS, HIVE, 99, ['pk-1', 'pk-2'], db.sql);
    expect(r1?.revokedPubkeys.slice().sort()).toEqual(['pk-1', 'pk-2']);
    const r2 = await addRevokedHivePubkeys(WS, HIVE, 99, ['pk-2', 'pk-3'], db.sql); // pk-2 deduped
    expect(r2?.revokedPubkeys.slice().sort()).toEqual(['pk-1', 'pk-2', 'pk-3']);
  });

  it('loadHiveMemberDevicePubkeys returns a member device pubkeys (revoke targeting)', async () => {
    await seedHive();
    await upsertHiveMember({ workspaceId: WS, hiveHomeSlug: HIVE, githubUserId: 5, githubUsername: 'c', deviceAttestations: [dev('d1'), dev('d2')] }, db.sql);
    expect((await loadHiveMemberDevicePubkeys(WS, HIVE, 5, db.sql)).slice().sort()).toEqual(['d1', 'd2']);
    expect(await loadHiveMemberDevicePubkeys(WS, HIVE, 404, db.sql)).toEqual([]);
  });

  it('is workspace-scoped: a member in one workspace is invisible to another', async () => {
    await seedHive();
    await upsertHiveMember({ workspaceId: WS, hiveHomeSlug: HIVE, githubUserId: 1, githubUsername: 'a', revokedPubkeys: ['x'] }, db.sql);
    expect([...(await loadRevokedHivePubkeys('ws-other', HIVE, db.sql))]).toEqual([]);
    expect(await listHiveMembers('ws-other', HIVE, db.sql)).toHaveLength(0);
  });

  it('FK cascade: deleting the Hive removes its members', async () => {
    await seedHive();
    await upsertHiveMember({ workspaceId: WS, hiveHomeSlug: HIVE, githubUserId: 1, githubUsername: 'a' }, db.sql);
    await deleteHive(WS, HIVE, db.sql);
    expect(await listHiveMembers(WS, HIVE, db.sql)).toHaveLength(0);
  });

  describe('WI-892 / EI-3409 — the "*" read sentinel must never become a stored workspace_id', () => {
    it('the operator member view == the raw rows (no silent divergence) for a concrete workspace', async () => {
      await seedHive();
      // Two admitted members under the SAME concrete workspace — the hello-world-hive shape.
      await upsertHiveMember(
        { workspaceId: WS, hiveHomeSlug: HIVE, githubUserId: 1, githubUsername: 'owner', deviceAttestations: [dev('pk-o')], bindingStatus: 'verified' },
        db.sql,
      );
      await upsertHiveMember(
        { workspaceId: WS, hiveHomeSlug: HIVE, githubUserId: 2, githubUsername: 'joiner', deviceAttestations: [dev('pk-j')], bindingStatus: 'verified' },
        db.sql,
      );
      // The operator's authoritative read…
      const view = await listHiveMembers(WS, HIVE, db.sql);
      // …vs the raw table rows for the same (workspace, hive).
      const raw = (await db.sql.unsafe(
        `SELECT github_user_id FROM harness_shared.hive_members
          WHERE workspace_id = $1 AND hive_home_slug = $2`,
        [WS, HIVE],
      )) as unknown as Array<{ github_user_id: string | number }>;
      expect(view.map((m) => m.githubUserId).sort()).toEqual([1, 2]);
      expect(view).toHaveLength(raw.length); // the divergence WI-892 reported is gone
    });

    it('upsertHiveMember REFUSES the "*" sentinel and empty/blank — loudly, with the EI-3409 reason', async () => {
      await seedHive();
      await expect(
        upsertHiveMember({ workspaceId: '*', hiveHomeSlug: HIVE, githubUserId: 9, githubUsername: 'x' }, db.sql),
      ).rejects.toThrow(/EI-3409|read sentinel/);
      await expect(
        upsertHiveMember({ workspaceId: '', hiveHomeSlug: HIVE, githubUserId: 9, githubUsername: 'x' }, db.sql),
      ).rejects.toThrow(/read sentinel/);
      // and nothing leaked into the table
      const leaked = (await db.sql.unsafe(
        `SELECT count(*)::int AS n FROM harness_shared.hive_members WHERE workspace_id = '*'`,
      )) as unknown as Array<{ n: number }>;
      expect(leaked[0].n).toBe(0);
    });

    it('the migration-406 CHECK constraint blocks a raw INSERT of a "*" workspace_id (the data-layer backstop)', async () => {
      await seedHive();
      await expect(
        db.sql.unsafe(
          `INSERT INTO harness_shared.hive_members
             (workspace_id, hive_home_slug, github_user_id, github_username, binding_status)
           VALUES ('*', $1, 3, 'sneaky', 'verified')`,
          [HIVE],
        ),
      ).rejects.toThrow(/hive_members_workspace_id_concrete|check constraint/i);
    });
  });

  it('the REUSED read-admission decider denies a Hive-revoked pubkey (P-006 admission semantics)', async () => {
    await seedHive();
    await upsertHiveMember({ workspaceId: WS, hiveHomeSlug: HIVE, githubUserId: 1, githubUsername: 'a', revokedPubkeys: ['bad-pk'] }, db.sql);

    // The Hive-scoped revoked union feeds the SAME decider used for per-harness admission.
    const revoked = await loadRevokedHivePubkeys(WS, HIVE, db.sql);
    const decide = makeAdmissionDecider({ revoked, verifyBinding: async () => 'verified' });

    // a revoked pubkey is denied even with a valid sig + binding...
    expect(
      await decide({ device_pubkey: 'bad-pk', github_login: 'a', github_user_id: 1, attestation_gist_id: 'g', sigValid: true }),
    ).toEqual({ admit: false, reason: 'revoked' });
    // ...while a non-revoked, valid-binding pubkey is admitted.
    expect(
      await decide({ device_pubkey: 'good-pk', github_login: 'a', github_user_id: 1, attestation_gist_id: 'g', sigValid: true }),
    ).toEqual({ admit: true });
  });
});
