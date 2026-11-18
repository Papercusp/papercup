// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { existsSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';
import { readHostAuthorityBindings } from './host-authority-bindings';

let sql: postgres.Sql;
beforeAll(async () => {
  const uri = await getTestPg();
  const name = `hostbindings_${randomBytes(5).toString('hex')}`;
  const admin = postgres(uri, { max: 1, onnotice: () => {} });
  try { await admin.unsafe(`CREATE DATABASE "${name}"`); await markManagedTestDatabase(admin, name); }
  finally { await admin.end({ timeout: 5 }); }
  const target = new URL(uri); target.pathname = `/${name}`;
  sql = postgres(target.toString(), { max: 4, onnotice: () => {} });
  await sql`CREATE SCHEMA harness_shared`;
  await sql`GRANT USAGE ON SCHEMA harness_shared TO harness_app`;
  const migration = new URL('../../../../libs/papercusp/libs/db/sql/1646-governance-host-authority-bindings.sql', import.meta.url);
  const source = existsSync(migration) ? migration : new URL(migration.href + '.DRAFT');
  // Exercise the complete migration, including grants to the framework's real
  // runtime role. Stripping grants hid a nonexistent-role typo before arming.
  await sql.unsafe(readFileSync(source, 'utf8'));
  await sql`CREATE TABLE harness_shared.binding_effects (target text NOT NULL)`;
}, 60_000);
afterAll(async () => { await sql?.end({ timeout: 5 }); });
beforeEach(async () => {
  await sql`TRUNCATE harness_shared.governance_host_authority_bindings, harness_shared.binding_effects`;
});
const txSql = (tx: postgres.TransactionSql) => tx as unknown as postgres.Sql;
// Storage fixtures, deliberately not proof of a production enrollment writer.
async function insert(kind = 'platform', subject = 'required-floor', workspace = 'ws', owner = 'human') {
  await sql`INSERT INTO harness_shared.governance_host_authority_bindings
    (workspace_id, kind, subject_id, human_owner_id, request_principal_revision, reason)
    VALUES (${workspace}, ${kind}, ${subject}, ${owner}, ${'a'.repeat(64)}, 'explicit enrollment fixture')`;
}

describe('P-002 independent host authority binding source', () => {
  it('applies the complete migration and gives the application role SELECT only', async () => {
    await sql.begin(async tx => {
      await tx`SET LOCAL ROLE harness_app`;
      expect(await tx`SELECT * FROM harness_shared.governance_host_authority_bindings`).toEqual([]);
    });
    for (const statement of [
      "INSERT INTO harness_shared.governance_host_authority_bindings (workspace_id) VALUES ('forbidden')",
      "UPDATE harness_shared.governance_host_authority_bindings SET reason = 'forbidden'",
      'DELETE FROM harness_shared.governance_host_authority_bindings',
    ]) {
      await expect(sql.begin(async tx => {
        await tx`SET LOCAL ROLE harness_app`;
        await tx.unsafe(statement);
      })).rejects.toMatchObject({ code: '42501' });
    }
  });

  it('keeps absence explicit, workspace-scoped and distinct from a required policy', async () => {
    const empty = await readHostAuthorityBindings(sql, 'ws');
    expect(empty).toMatchObject({ status: 'ok', bindings: [], requiredUserIds: [], requiredPlatformIds: [] });
    await insert();
    await insert('user', 'human', 'ws');
    await insert('platform', 'foreign-floor', 'foreign');
    const read = await readHostAuthorityBindings(sql, 'ws');
    expect(read).toMatchObject({ status: 'ok', bindings: [
      { kind: 'platform', subjectId: 'required-floor', humanOwnerId: 'human' },
      { kind: 'user', subjectId: 'human', humanOwnerId: 'human' },
    ], requiredUserIds: ['human'], requiredPlatformIds: ['required-floor'] });
    expect(read.revision).not.toBe(empty.revision);
    expect(await sql`SELECT to_regclass('harness_shared.governance_policy_layers') AS policy`).toEqual([{ policy: null }]);
    expect((await readHostAuthorityBindings(sql, 'unregistered')).revision).not.toBe(empty.revision);
  });

  it.each(['', '*', ' ws', 'ws\n'])('rejects ambiguous workspace %j', async workspace => {
    await expect(readHostAuthorityBindings(sql, workspace)).rejects.toThrow('exact workspace');
  });

  it('requires a real effect transaction and refuses old snapshots or unpinned read-committed reads', async () => {
    await expect(readHostAuthorityBindings(sql, 'ws', { pinForEffect: true })).rejects.toThrow('existing transaction');
    await expect(readHostAuthorityBindings(sql, 'ws', { expectedRevision: 'bad' })).rejects.toThrow('exact workspace');
    await expect(sql.begin('isolation level repeatable read', tx =>
      readHostAuthorityBindings(txSql(tx), 'ws', { pinForEffect: true }))).rejects.toThrow('read committed');
    await expect(sql.begin(tx => readHostAuthorityBindings(txSql(tx), 'ws'))).rejects.toThrow('repeatable read');
  });

  it.each(['human_owner_id', 'request_principal_revision', 'reason', 'recorded_at'] as const)(
    'detects a changed %s before a protected effect', async field => {
      await insert();
      const before = await readHostAuthorityBindings(sql, 'ws');
      const values = { human_owner_id: 'other-human', request_principal_revision: 'b'.repeat(64),
        reason: 'different enrollment', recorded_at: '2030-01-01T00:00:00Z' };
      await sql.unsafe(`UPDATE harness_shared.governance_host_authority_bindings SET ${field} = $1`, [values[field]]);
      const checked = await sql.begin(async tx => {
        const current = await readHostAuthorityBindings(txSql(tx), 'ws', { expectedRevision: before.revision });
        if (current.status === 'ok') await tx`INSERT INTO harness_shared.binding_effects VALUES ('guarded')`;
        return current;
      });
      expect(checked.status).toBe('stale');
      expect(await sql`SELECT * FROM harness_shared.binding_effects`).toEqual([]);
    },
  );

  it.each(['insert', 'update', 'delete'] as const)('holds %s and insertion gaps until effect commit', async operation => {
    await insert();
    const before = await readHostAuthorityBindings(sql, 'ws');
    await sql.begin(async tx => {
      const read = await readHostAuthorityBindings(txSql(tx), 'ws', { expectedRevision: before.revision });
      expect(read.status).toBe('ok');
      await expect(sql.begin(async other => {
        await other`SET LOCAL lock_timeout = '50ms'`;
        if (operation === 'insert') await other`INSERT INTO harness_shared.governance_host_authority_bindings
          (workspace_id, kind, subject_id, human_owner_id, request_principal_revision, reason)
          VALUES ('ws', 'platform', 'new-floor', 'human', ${'b'.repeat(64)}, 'new fixture')`;
        else if (operation === 'update') await other`UPDATE harness_shared.governance_host_authority_bindings SET reason = 'changed'`;
        else await other`DELETE FROM harness_shared.governance_host_authority_bindings`;
      })).rejects.toMatchObject({ code: '55P03' });
      await tx`INSERT INTO harness_shared.binding_effects VALUES ('guarded')`;
    });
    expect(await sql`SELECT * FROM harness_shared.binding_effects`).toEqual([{ target: 'guarded' }]);
    expect(await readHostAuthorityBindings(sql, 'ws')).toEqual(before);
  });

  it('pins an empty source against the first required floor', async () => {
    await sql.begin(async tx => {
      expect(await readHostAuthorityBindings(txSql(tx), 'ws', { pinForEffect: true }))
        .toMatchObject({ status: 'ok', bindings: [] });
      await expect(sql.begin(async other => {
        await other`SET LOCAL lock_timeout = '50ms'`;
        await other`INSERT INTO harness_shared.governance_host_authority_bindings
          (workspace_id, kind, subject_id, human_owner_id, request_principal_revision, reason)
          VALUES ('ws', 'platform', 'first', 'human', ${'a'.repeat(64)}, 'first fixture')`;
      })).rejects.toMatchObject({ code: '55P03' });
    });
    await insert();
    expect(await readHostAuthorityBindings(sql, 'ws')).toMatchObject({ bindings: [{ subjectId: 'required-floor' }] });
  });

  it('uses canonical UTC timestamps across connection settings', async () => {
    await insert();
    const before = await readHostAuthorityBindings(sql, 'ws');
    const after = await sql.begin('isolation level repeatable read', async tx => {
      await tx`SET LOCAL timezone = 'Pacific/Honolulu'`;
      return readHostAuthorityBindings(txSql(tx), 'ws');
    });
    expect(after).toEqual(before);
  });

  it('refuses restricted row visibility instead of treating it as an empty source', async () => {
    await sql`ALTER TABLE harness_shared.governance_host_authority_bindings ENABLE ROW LEVEL SECURITY`;
    await sql`ALTER TABLE harness_shared.governance_host_authority_bindings FORCE ROW LEVEL SECURITY`;
    try {
      await sql.begin('isolation level repeatable read', async tx => {
        // The private DB owner is superuser; changing role makes RLS effective.
        await tx.unsafe('CREATE ROLE host_binding_rls_fixture');
        await tx.unsafe('GRANT USAGE ON SCHEMA harness_shared TO host_binding_rls_fixture');
        await tx.unsafe('GRANT SELECT ON harness_shared.governance_host_authority_bindings TO host_binding_rls_fixture');
        await tx.unsafe('SET LOCAL ROLE host_binding_rls_fixture');
        await expect(readHostAuthorityBindings(txSql(tx), 'ws')).rejects.toThrow('not fully visible');
        throw new Error('rollback fixture role');
      }).catch(error => { if (error.message !== 'rollback fixture role') throw error; });
    } finally {
      await sql`ALTER TABLE harness_shared.governance_host_authority_bindings DISABLE ROW LEVEL SECURITY`;
    }
  });

  it('does not accept another human as a user subject or an untyped principal revision', async () => {
    await expect(insert('user', 'somebody-else')).rejects.toMatchObject({ code: '23514' });
    await expect(sql`INSERT INTO harness_shared.governance_host_authority_bindings
      (workspace_id, kind, subject_id, human_owner_id, request_principal_revision, reason)
      VALUES ('ws', 'platform', 'floor', 'human', 'agent-says-human', 'fixture')`).rejects.toMatchObject({ code: '23514' });
  });
});
