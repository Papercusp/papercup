// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';
import { readWorkspaceUserBindings } from './auth';

let sql: postgres.Sql;
const txSql = (tx: postgres.TransactionSql) => tx as unknown as postgres.Sql;
beforeAll(async () => {
  const uri = await getTestPg();
  const name = `workspaceusers_${randomBytes(5).toString('hex')}`;
  const admin = postgres(uri, { max: 1, onnotice: () => {} });
  try { await admin.unsafe(`CREATE DATABASE "${name}"`); await markManagedTestDatabase(admin, name); }
  finally { await admin.end({ timeout: 5 }); }
  const target = new URL(uri); target.pathname = `/${name}`;
  sql = postgres(target.toString(), { max: 4, onnotice: () => {} });
  // The reader must retain corrupt/orphan claims instead of turning them into
  // an empty census. Deliberately permit those states in this real-PG fixture.
  await sql.unsafe(`CREATE SCHEMA harness_shared;
    CREATE TABLE harness_shared.users (id text PRIMARY KEY, is_active boolean,
      username text, password_hash text);
    CREATE TABLE harness_shared.user_sessions (token text PRIMARY KEY, user_id text,
      workspace_id text, capabilities text[], expires_at timestamptz, last_seen_at timestamptz);
    CREATE TABLE harness_shared.user_population_effects (target text)`);
}, 60_000);
afterAll(async () => { await sql?.end({ timeout: 5 }); });
beforeEach(async () => { await sql.unsafe(`TRUNCATE harness_shared.users,
  harness_shared.user_sessions, harness_shared.user_population_effects`); });

async function seed() {
  await sql`INSERT INTO harness_shared.users VALUES
    ('alice', true, 'Alice', 'secret-password-hash'), ('bob', false, 'Bob', NULL),
    ('foreign-user', true, 'Foreign', NULL), ('no-claim', true, 'No claim', NULL)`;
  await sql`INSERT INTO harness_shared.user_sessions (token, user_id, workspace_id, capabilities, expires_at) VALUES
    ('secret-token-alice', 'alice', 'ws', ARRAY['identity:edit'], '2099-01-01'),
    ('secret-expired-token', 'alice', 'ws', ARRAY['*'], '2000-01-01'),
    ('secret-inactive-token', 'bob', 'ws', ARRAY['*'], '2099-01-01'),
    ('secret-orphan-token', 'missing-user', 'ws', NULL, NULL),
    ('secret-unowned-token', NULL, 'ws', ARRAY['*'], '2099-01-01'),
    ('secret-foreign-token', 'foreign-user', 'foreign', ARRAY['*'], '2099-01-01'),
    ('secret-legacy-token', 'no-claim', NULL, ARRAY['*'], '2099-01-01')`;
}

describe('P-002 local host workspace user binding sources', () => {
  it('retains expired, inactive, orphan and unowned claims without inventing human ownership', async () => {
    await seed();
    const result = await readWorkspaceUserBindings(sql, 'ws');
    expect(result).toMatchObject({ status: 'ok', users: [
      { userId: 'alice', userPresent: true, active: true, claimRevisions: [expect.any(String), expect.any(String)] },
      { userId: 'bob', userPresent: true, active: false, claimRevisions: [expect.any(String)] },
      { userId: 'missing-user', userPresent: false, active: null, claimRevisions: [expect.any(String)] },
      { userId: null, userPresent: false, active: null, claimRevisions: [expect.any(String)] },
    ] });
    expect(JSON.stringify(result)).not.toMatch(/secret|password|owner|foreign-user|no-claim/);
    expect(await readWorkspaceUserBindings(sql, 'ws')).toEqual(result);
  });

  it('keeps an empty stored claim population explicit without default-account fallback', async () => {
    await seed();
    expect(await readWorkspaceUserBindings(sql, 'empty')).toMatchObject({ status: 'ok', users: [] });
    expect(await readWorkspaceUserBindings(sql, 'foreign')).toMatchObject({ users: [{ userId: 'foreign-user' }] });
  });

  it('streams past one cursor batch and hashes every claim', async () => {
    await seed();
    await sql`INSERT INTO harness_shared.user_sessions (token, user_id, workspace_id)
      SELECT 'extra-' || n, 'alice', 'ws' FROM generate_series(1, 40) n`;
    const before = await readWorkspaceUserBindings(sql, 'ws');
    if (before.status !== 'ok') throw new Error('missing population');
    expect(before.users[0].claimRevisions).toHaveLength(42);
    await sql`UPDATE harness_shared.user_sessions SET capabilities = ARRAY['later'] WHERE token = 'extra-9'`;
    expect(await sql.begin(tx => readWorkspaceUserBindings(txSql(tx), 'ws', { expectedRevision: before.revision })))
      .toMatchObject({ status: 'stale' });
  });

  it('ignores observation metadata but pins the actual cookie authorization inputs', async () => {
    await seed();
    const before = await readWorkspaceUserBindings(sql, 'ws');
    await sql`UPDATE harness_shared.user_sessions SET last_seen_at = now()`;
    await sql`UPDATE harness_shared.users SET username = 'renamed', password_hash = 'another-secret'`;
    expect(await readWorkspaceUserBindings(sql, 'ws')).toEqual(before);
    await sql.begin('isolation level repeatable read read only', async tx => {
      await tx`SET LOCAL TIME ZONE 'Pacific/Honolulu'`;
      expect(await readWorkspaceUserBindings(txSql(tx), 'ws')).toEqual(before);
    });
  });

  it.each(['capability', 'expiry', 'token', 'workspace', 'binding', 'active', 'user-remove', 'user-restore', 'claim-add', 'claim-remove'])(
    'refuses a changed %s source before a protected effect', async change => {
      await seed();
      const before = await readWorkspaceUserBindings(sql, 'ws');
      if (change === 'capability') await sql`UPDATE harness_shared.user_sessions SET capabilities = ARRAY['*'] WHERE token = 'secret-token-alice'`;
      if (change === 'expiry') await sql`UPDATE harness_shared.user_sessions SET expires_at = '2001-01-01' WHERE token = 'secret-token-alice'`;
      if (change === 'token') await sql`UPDATE harness_shared.user_sessions SET token = 'replacement' WHERE token = 'secret-token-alice'`;
      if (change === 'workspace') await sql`UPDATE harness_shared.user_sessions SET workspace_id = 'foreign' WHERE token = 'secret-token-alice'`;
      if (change === 'binding') await sql`UPDATE harness_shared.user_sessions SET user_id = 'bob' WHERE token = 'secret-token-alice'`;
      if (change === 'active') await sql`UPDATE harness_shared.users SET is_active = false WHERE id = 'alice'`;
      if (change === 'user-remove') await sql`DELETE FROM harness_shared.users WHERE id = 'alice'`;
      if (change === 'user-restore') await sql`INSERT INTO harness_shared.users (id, is_active) VALUES ('missing-user', true)`;
      if (change === 'claim-add') await sql`INSERT INTO harness_shared.user_sessions (token, user_id, workspace_id) VALUES ('new', 'alice', 'ws')`;
      if (change === 'claim-remove') await sql`DELETE FROM harness_shared.user_sessions WHERE token = 'secret-expired-token'`;
      const current = await sql.begin(async tx => {
        const result = await readWorkspaceUserBindings(txSql(tx), 'ws', { expectedRevision: before.revision });
        if (result.status === 'ok') await tx`INSERT INTO harness_shared.user_population_effects VALUES ('bad')`;
        return result;
      });
      expect(current.status).toBe('stale');
      expect(await sql`SELECT * FROM harness_shared.user_population_effects`).toEqual([]);
    });

  it.each(['users', 'user_sessions'] as const)('holds %s updates and insertion gaps through the protected effect', async table => {
    await seed();
    const before = await readWorkspaceUserBindings(sql, 'ws');
    await sql.begin(async tx => {
      expect(await readWorkspaceUserBindings(txSql(tx), 'ws', { expectedRevision: before.revision })).toEqual(before);
      for (const operation of ['update', 'insert']) {
        await expect(sql.begin(async writer => {
          await writer`SET LOCAL lock_timeout = '80ms'`;
          if (table === 'users') {
            if (operation === 'update') await writer`UPDATE harness_shared.users SET is_active = false WHERE id = 'alice'`;
            else await writer`INSERT INTO harness_shared.users (id, is_active) VALUES ('new', true)`;
          } else if (operation === 'update') await writer`UPDATE harness_shared.user_sessions SET capabilities = ARRAY['denied'] WHERE user_id = 'alice'`;
          else await writer`INSERT INTO harness_shared.user_sessions (token, user_id, workspace_id) VALUES ('new', 'alice', 'ws')`;
        })).rejects.toMatchObject({ code: '55P03' });
      }
      await tx`INSERT INTO harness_shared.user_population_effects VALUES ('current')`;
    });
    await sql`UPDATE harness_shared.users SET is_active = false WHERE id = 'alice'`;
    expect(await sql`SELECT * FROM harness_shared.user_population_effects`).toEqual([{ target: 'current' }]);
  });

  it('requires a current effect transaction and refuses an independently stale historical snapshot', async () => {
    await seed();
    const before = await readWorkspaceUserBindings(sql, 'ws');
    await expect(readWorkspaceUserBindings(sql, 'ws', { expectedRevision: before.revision })).rejects.toThrow('existing transaction');
    await sql.begin('isolation level repeatable read', async tx => {
      expect(await readWorkspaceUserBindings(txSql(tx), 'ws')).toEqual(before);
      await sql`UPDATE harness_shared.users SET is_active = false WHERE id = 'alice'`;
      expect(await readWorkspaceUserBindings(txSql(tx), 'ws')).toEqual(before);
      await expect(readWorkspaceUserBindings(txSql(tx), 'ws', { expectedRevision: before.revision })).rejects.toThrow('read committed');
    });
    await sql.begin(async tx => {
      await expect(readWorkspaceUserBindings(txSql(tx), 'ws')).rejects.toThrow('repeatable read');
      expect(await readWorkspaceUserBindings(txSql(tx), 'ws', { pinForEffect: true })).toMatchObject({ status: 'ok' });
    });
  });

  it.each(['', '*', ' ws', 'ws\n'])('refuses an inexact workspace %j', async workspace => {
    await expect(readWorkspaceUserBindings(sql, workspace)).rejects.toThrow('exact workspace');
  });

  it('does not turn unreadable auth storage into an empty population', async () => {
    await sql.begin(async tx => {
      await tx`ALTER TABLE harness_shared.user_sessions RENAME TO missing_sessions`;
      await expect(readWorkspaceUserBindings(txSql(tx), 'ws', { pinForEffect: true })).rejects.toMatchObject({ code: '42P01' });
      // Roll back the deliberate corruption, including the failed transaction.
      throw new Error('restore fixture');
    }).catch(error => { expect(error.message).toBe('restore fixture'); });
  });
});
