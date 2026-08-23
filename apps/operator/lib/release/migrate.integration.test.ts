/**
 * Deploy-time migration apply — integration test against a throwaway PG
 * (testcontainer). Proves D-007: staged migrations apply atomically, the apply
 * is idempotent (re-run = no-op), and a BROKEN migration FAILS LOUD (so the
 * deploy aborts → rollback) rather than the boot-time log-and-continue.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { getTestPg } from '@papercusp/test-config/pg';
import {
  applyStagedMigrations,
  assertMigrationCreatePrivileges,
  migrationCreateSchemas,
} from './migrate';

let dbUrl: string;
let sqlDir: string;

beforeAll(async () => {
  dbUrl = await getTestPg();
}, 120_000);

beforeEach(async () => {
  sqlDir = mkdtempSync(join(tmpdir(), 'relmig-'));
  // The testcontainer DB is reused across runs — reset this test's artifacts so
  // each run starts fresh (the runner is idempotent: an already-applied file
  // reports appliedCount 0).
  const sql = postgres(dbUrl, { max: 1 });
  try {
    await sql`DELETE FROM harness_shared.schema_migrations WHERE filename IN ('900-reltest-apply.sql', '901-reltest-bad.sql')`.catch(() => {});
    await sql`DROP TABLE IF EXISTS harness_shared.reltest_apply, harness_shared.reltest_bad`.catch(() => {});
  } finally {
    await sql.end();
  }
});
afterEach(() => rmSync(sqlDir, { recursive: true, force: true }));

describe('applyStagedMigrations', () => {
  it('detects schema-qualified creates without treating comments or indexes as schema-create needs', () => {
    expect(
      migrationCreateSchemas(`
        -- CREATE TABLE ignored_schema.comment_only (id int);
        CREATE TABLE IF NOT EXISTS papercusp_auth.hosted_sessions (id text);
        CREATE OR REPLACE FUNCTION "papercusp_auth".rotate_session() RETURNS void LANGUAGE sql AS $$ SELECT $$;
        CREATE INDEX hosted_sessions_idx ON papercusp_auth.hosted_sessions (id);
        CREATE VIEW harness_shared.hosted_session_ids AS SELECT id FROM papercusp_auth.hosted_sessions;
      `),
    ).toEqual(['harness_shared', 'papercusp_auth']);
  });

  it('fails with the role, schema owner, and required grant before executing DDL', async () => {
    const client = {
      unsafe: async () => [
        {
          query_role: 'harness_admin',
          schema_owner: 'postgres_app',
          has_create: false,
        },
      ],
    } as unknown as Parameters<typeof assertMigrationCreatePrivileges>[0];

    await expect(
      assertMigrationCreatePrivileges(
        client,
        '902-hosted-session-webhook-receipts.sql',
        'CREATE TABLE papercusp_auth.hosted_sessions (id text);',
      ),
    ).rejects.toThrow(
      /902-hosted-session-webhook-receipts\.sql: migration role harness_admin lacks CREATE on existing schema papercusp_auth \(owner postgres_app\)/,
    );
  });

  it('applies a pending migration and is idempotent', async () => {
    writeFileSync(
      join(sqlDir, '900-reltest-apply.sql'),
      'CREATE TABLE IF NOT EXISTS harness_shared.reltest_apply (id int);',
    );
    const r1 = await applyStagedMigrations({ dbUrl, sqlDir, log: () => {} });
    expect(r1.appliedCount).toBe(1);
    expect(r1.applied).toContain('900-reltest-apply.sql');

    const sql = postgres(dbUrl, { max: 1 });
    try {
      const rows = await sql<Array<{ t: string | null }>>`SELECT to_regclass('harness_shared.reltest_apply')::text AS t`;
      expect(rows[0]!.t).toBe('harness_shared.reltest_apply');
    } finally {
      await sql.end();
    }

    // Re-run = no-op (tracked in schema_migrations).
    const r2 = await applyStagedMigrations({ dbUrl, sqlDir, log: () => {} });
    expect(r2.appliedCount).toBe(0);
  });

  it('FAILS LOUD on a broken migration (deploy aborts → rollback)', async () => {
    writeFileSync(join(sqlDir, '901-reltest-bad.sql'), 'CREATE TABLE harness_shared.reltest_bad (;');
    await expect(applyStagedMigrations({ dbUrl, sqlDir, log: () => {} })).rejects.toThrow();
    // The bad table must NOT exist (transactional apply rolled it back).
    const sql = postgres(dbUrl, { max: 1 });
    try {
      const rows = await sql<Array<{ t: string | null }>>`SELECT to_regclass('harness_shared.reltest_bad')::text AS t`;
      expect(rows[0]!.t).toBeNull();
    } finally {
      await sql.end();
    }
  });

  it('throws when the sql dir is missing', async () => {
    await expect(applyStagedMigrations({ dbUrl, sqlDir: '/no/such/dir' })).rejects.toThrow(/sql dir not found/);
  });
});
