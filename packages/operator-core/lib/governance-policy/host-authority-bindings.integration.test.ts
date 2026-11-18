// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { existsSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';
import { enrollHostAuthorityBinding, readHostAuthorityBindings } from './host-authority-bindings';

let sql: postgres.Sql;
const inheritedMigration = new URL('../../../../libs/papercusp/libs/db/sql/1647-governance-inherited-human-ownership.sql', import.meta.url);
const inheritedMigrationSource = () => readFileSync(existsSync(inheritedMigration)
  ? inheritedMigration : new URL(inheritedMigration.href + '.DRAFT'), 'utf8');
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
  await sql.unsafe(inheritedMigrationSource());
  await sql`CREATE TABLE harness_shared.binding_effects (target text NOT NULL)`;
  await sql`CREATE TABLE harness_shared.users (id uuid PRIMARY KEY, is_active boolean NOT NULL DEFAULT true)`;
  await sql`CREATE TABLE harness_shared.user_sessions (token text PRIMARY KEY, user_id uuid NOT NULL,
    workspace_id text, capabilities text[], expires_at timestamptz NOT NULL)`;
}, 60_000);
afterAll(async () => { await sql?.end({ timeout: 5 }); });
beforeEach(async () => {
  await sql`TRUNCATE harness_shared.governance_host_authority_bindings, harness_shared.binding_effects,
    harness_shared.users, harness_shared.user_sessions`;
});

async function browser(capabilities = ['*'], workspace = 'ws') {
  const userId = '11111111-1111-4111-8111-111111111111';
  const token = randomBytes(32).toString('hex');
  await sql`INSERT INTO harness_shared.users (id) VALUES (${userId}) ON CONFLICT DO NOTHING`;
  await sql`INSERT INTO harness_shared.user_sessions (token, user_id, workspace_id, capabilities, expires_at)
    VALUES (${token}, ${userId}, ${workspace}, ${capabilities}, clock_timestamp() + interval '1 hour')`;
  return { userId, token, headers: new Headers({ cookie: `papercusp_session=${token}` }) };
}
const enrollment = { kind: 'platform' as const, subjectId: 'explicit-floor', reason: 'I explicitly own this platform floor' };

describe('P-002 authenticated explicit host enrollment', () => {
  it.each(['organization', 'department', 'workspace'] as const)(
    'records an explicit %s human owner without creating policy or inferring ownership', async kind => {
      const f = await browser();
      // Exercise the runtime boundary before its TypeScript union is extended.
      const input = JSON.parse(JSON.stringify({ kind, subjectId: `required-${kind}`, reason: 'I explicitly own this authority' }));
      const result = await enrollHostAuthorityBinding(f.headers, 'ws', input, sql);
      expect(result).toMatchObject({ status: 'enrolled', binding: { kind,
        subjectId: `required-${kind}`, humanOwnerId: f.userId } });
      expect(await readHostAuthorityBindings(sql, 'ws')).toMatchObject({ status: 'ok', bindings: [result.binding] });
      expect(JSON.stringify(result)).not.toContain(f.token);
      expect(await sql`SELECT to_regclass('harness_shared.governance_policy_layers') AS policy`).toEqual([{ policy: null }]);
      await expect(enrollHostAuthorityBinding(f.headers, 'ws', input, sql)).rejects.toMatchObject({ code: 'conflict' });
    },
  );

  it.each(['organization', 'department', 'workspace'] as const)(
    'does not let a limited request, absent cookie or forged owner enroll %s', async kind => {
      const f = await browser(['tools:read']);
      const input = JSON.parse(JSON.stringify({ kind, subjectId: `required-${kind}`, reason: 'explicit request' }));
      for (const headers of [f.headers, new Headers()])
        await expect(enrollHostAuthorityBinding(headers, 'ws', input, sql)).rejects.toMatchObject({ code: 'forbidden' });
      await expect(enrollHostAuthorityBinding(f.headers, 'ws', { ...input, humanOwnerId: 'forged' }, sql))
        .rejects.toMatchObject({ code: 'invalid' });
      expect(await readHostAuthorityBindings(sql, 'ws')).toMatchObject({ bindings: [] });
    },
  );

  it('enrolls the exact browser human and named floor, without creating a policy or leaking credentials', async () => {
    const f = await browser();
    const self = await enrollHostAuthorityBinding(f.headers, 'ws',
      { kind: 'user', subjectId: f.userId, reason: 'I explicitly enroll myself' }, sql);
    const floor = await enrollHostAuthorityBinding(f.headers, 'ws', enrollment, sql);
    expect(self).toMatchObject({ status: 'enrolled', binding: { humanOwnerId: f.userId, subjectId: f.userId } });
    expect(floor).toMatchObject({ status: 'enrolled', binding: { humanOwnerId: f.userId, subjectId: 'explicit-floor',
      requestPrincipalRevision: expect.stringMatching(/^[a-f0-9]{64}$/) } });
    expect(JSON.stringify({ self, floor })).not.toContain(f.token);
    expect(await readHostAuthorityBindings(sql, 'ws')).toMatchObject({ requiredUserIds: [f.userId], requiredPlatformIds: ['explicit-floor'] });
    expect(await sql`SELECT to_regclass('harness_shared.governance_policy_layers') AS policy`).toEqual([{ policy: null }]);
  });

  it.each(['missing', 'bearer', 'foreign', 'limited', 'inactive', 'expired', 'revoked', 'malformed-cookie', 'invalid-token'])(
    'refuses %s credentials without writing ownership', async mode => {
      const f = await browser(mode === 'limited' ? ['tools:read'] : ['*'], mode === 'foreign' ? 'foreign' : 'ws');
      if (mode === 'inactive') await sql`UPDATE harness_shared.users SET is_active = false`;
      if (mode === 'expired') await sql`UPDATE harness_shared.user_sessions SET expires_at = clock_timestamp() - interval '1 second'`;
      if (mode === 'revoked') await sql`DELETE FROM harness_shared.user_sessions`;
      const headers = mode === 'missing' ? new Headers() : mode === 'bearer'
        ? new Headers({ authorization: `Bearer ${f.token}` }) : mode === 'malformed-cookie'
          ? new Headers({ cookie: 'papercusp_session=%' }) : mode === 'invalid-token'
            ? new Headers({ cookie: 'papercusp_session=not-a-browser-token' }) : f.headers;
      await expect(enrollHostAuthorityBinding(headers, 'ws', enrollment, sql)).rejects.toMatchObject({ code: 'forbidden' });
      expect(await readHostAuthorityBindings(sql, 'ws')).toMatchObject({ bindings: [] });
    },
  );

  it('refuses another user subject, forged human ownership, wildcard subjects and missing reasons', async () => {
    const f = await browser();
    await expect(enrollHostAuthorityBinding(f.headers, 'ws', { ...enrollment, kind: 'user', subjectId: 'another-human' }, sql))
      .rejects.toMatchObject({ code: 'forbidden' });
    for (const input of [{ ...enrollment, humanOwnerId: 'another-human' }, { ...enrollment, subjectId: '*' },
      { ...enrollment, reason: '' }, { ...enrollment, workspaceId: 'foreign' }])
      await expect(enrollHostAuthorityBinding(f.headers, 'ws', input, sql)).rejects.toMatchObject({ code: 'invalid' });
    expect(await readHostAuthorityBindings(sql, 'ws')).toMatchObject({ bindings: [] });
  });

  it('cannot replace, refresh or implicitly replay existing ownership', async () => {
    const f = await browser();
    const first = await enrollHostAuthorityBinding(f.headers, 'ws', enrollment, sql);
    await expect(enrollHostAuthorityBinding(f.headers, 'ws', { ...enrollment, reason: 'replace' }, sql))
      .rejects.toMatchObject({ code: 'conflict' });
    expect(await readHostAuthorityBindings(sql, 'ws')).toMatchObject({ bindings: [first.binding] });
  });

  it.each(['expired', 'revoked', 'capability', 'reassigned', 'extended'] as const)(
    'rechecks %s credentials after a real binding-table wait', async mode => {
      const f = await browser();
      let pending: Promise<unknown> | undefined;
      // A real conflicting lock makes authorization-before-lock bugs observable.
      // pg_locks is the synchronization signal; no guessed sleeps or fake SQL.
      await sql.begin(async blocker => {
        await blocker`LOCK TABLE harness_shared.governance_host_authority_bindings IN SHARE MODE`;
        pending = enrollHostAuthorityBinding(f.headers, 'ws', enrollment, sql);
        const outcome = pending.catch(error => error);
        const deadline = Date.now() + 10_000;
        let waiting = false;
        while (!waiting && Date.now() < deadline) {
          const [row] = await blocker`SELECT EXISTS(SELECT 1 FROM pg_locks
            WHERE relation = 'harness_shared.governance_host_authority_bindings'::regclass
              AND mode = 'ShareRowExclusiveLock' AND NOT granted) AS waiting`;
          waiting = row.waiting;
          if (!waiting) await blocker`SELECT pg_sleep(0.01)`;
        }
        expect(waiting, 'enrollment reached the actual binding-table wait').toBe(true);
        if (mode === 'expired') await blocker`UPDATE harness_shared.user_sessions SET expires_at = clock_timestamp() - interval '1 second'`;
        if (mode === 'revoked') await blocker`DELETE FROM harness_shared.user_sessions`;
        if (mode === 'capability') await blocker`UPDATE harness_shared.user_sessions SET capabilities = ARRAY['tools:read']::text[]`;
        if (mode === 'reassigned') await blocker`UPDATE harness_shared.user_sessions SET workspace_id = 'foreign'`;
        if (mode === 'extended') await blocker`UPDATE harness_shared.user_sessions SET expires_at = expires_at + interval '1 hour'`;
        pending = outcome;
      });
      expect(await pending).toMatchObject({ code: 'forbidden' });
      expect(await readHostAuthorityBindings(sql, 'ws')).toMatchObject({ bindings: [] });
    },
  );

  it('owns its transaction instead of accepting an old caller snapshot', async () => {
    const f = await browser();
    await expect(sql.begin('isolation level repeatable read', tx =>
      enrollHostAuthorityBinding(f.headers, 'ws', enrollment, txSql(tx))))
      .rejects.toMatchObject({ code: 'invalid' });
  });

  it('checks wall-clock expiry on the INSERT after an auth-row lock wait, not only before locking', async () => {
    const f = await browser();
    // A name-filtered run starts with a cold auth graph. Exercise the actual
    // authenticated SQL path BEFORE starting the expiry window, without writing
    // ownership or replacing wall-clock expiry with a larger guessed timeout.
    await expect(enrollHostAuthorityBinding(f.headers, 'ws',
      { ...enrollment, kind: 'user', subjectId: 'another-human' }, sql))
      .rejects.toMatchObject({ code: 'forbidden' });
    await sql`UPDATE harness_shared.user_sessions SET expires_at = clock_timestamp() + interval '2 seconds'`;
    let pending: Promise<unknown> | undefined;
    await sql.begin(async blocker => {
      // An unchanged row preserves the content revision while making FOR SHARE
      // wait. Its pre-wait WHERE may already have evaluated unexpired=true.
      await blocker`UPDATE harness_shared.users SET is_active = true WHERE id = ${f.userId}`;
      // Deliberately cache the pre-wait activity snapshot. Every observation
      // below must refresh it; pg_stat_activity is not pg_locks' live view.
      await blocker`SELECT count(*) FROM pg_stat_activity`;
      pending = enrollHostAuthorityBinding(f.headers, 'ws', enrollment, sql).catch(error => error);
      const deadline = Date.now() + 10_000;
      let waiting = false;
      while (!waiting && Date.now() < deadline) {
        await blocker`SELECT pg_stat_clear_snapshot()`;
        const [row] = await blocker`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'
            AND query LIKE '%FOR SHARE OF s, u%') AS waiting`;
        waiting = row.waiting;
        if (!waiting) await blocker`SELECT pg_sleep(0.01)`;
      }
      expect(waiting, 'enrollment reached the actual credential-row wait').toBe(true);
      await blocker`SELECT pg_sleep(GREATEST(0, EXTRACT(epoch FROM (expires_at - clock_timestamp()))) + 0.01)
        FROM harness_shared.user_sessions WHERE token = ${f.token}`;
    });
    expect(await pending).toMatchObject({ code: 'forbidden' });
    expect(await readHostAuthorityBindings(sql, 'ws')).toMatchObject({ bindings: [] });
  });
});
const txSql = (tx: postgres.TransactionSql) => tx as unknown as postgres.Sql;
// Storage fixtures, deliberately not proof of a production enrollment writer.
async function insert(kind = 'platform', subject = 'required-floor', workspace = 'ws', owner = 'human') {
  await sql`INSERT INTO harness_shared.governance_host_authority_bindings
    (workspace_id, kind, subject_id, human_owner_id, request_principal_revision, reason)
    VALUES (${workspace}, ${kind}, ${subject}, ${owner}, ${'a'.repeat(64)}, 'explicit enrollment fixture')`;
}

describe('P-002 independent host authority binding source', () => {
  it('upgrades the existing kind constraint without changing old receipts or permitting arbitrary kinds', async () => {
    await sql.begin(async tx => {
      await tx`ALTER TABLE harness_shared.governance_host_authority_bindings
        DROP CONSTRAINT governance_host_authority_bindings_kind_check`;
      await tx`ALTER TABLE harness_shared.governance_host_authority_bindings
        ADD CONSTRAINT governance_host_authority_bindings_kind_check CHECK (kind IN ('user', 'platform'))`;
      await tx`INSERT INTO harness_shared.governance_host_authority_bindings
        (workspace_id, kind, subject_id, human_owner_id, request_principal_revision, reason)
        VALUES ('ws', 'platform', 'original-floor', 'original-human', ${'a'.repeat(64)}, 'preserved receipt')`;
      const original = await tx`SELECT * FROM harness_shared.governance_host_authority_bindings`;
      await tx.unsafe(inheritedMigrationSource());
      await tx.unsafe(inheritedMigrationSource());
      expect(await tx`SELECT * FROM harness_shared.governance_host_authority_bindings`).toEqual(original);
    });
    await expect(insert('unsupported', 'invalid')).rejects.toMatchObject({ code: '23514' });
    expect(await readHostAuthorityBindings(sql, 'ws')).toMatchObject({ bindings: [
      { kind: 'platform', subjectId: 'original-floor', humanOwnerId: 'original-human' },
    ] });
  });

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
