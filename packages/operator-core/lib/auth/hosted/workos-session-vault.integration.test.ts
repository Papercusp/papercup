import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';
import { PostgresWorkOSSealedSessionVault } from './workos-session-vault';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function migrationPath(): string {
  const armed = path.resolve(HERE, '../../../../../libs/papercusp/libs/db/sql/1002-workos-sealed-session-vault.sql');
  if (existsSync(armed)) return armed;
  const draft = `${armed}.DRAFT`;
  if (existsSync(draft)) return draft;
  throw new Error(`migration 1002 not found at ${armed}[.DRAFT]`);
}

const migrationSql = readFileSync(migrationPath(), 'utf8');
let db: MigratedTestDb;
let sql: Sql;
let vault: PostgresWorkOSSealedSessionVault;

async function provisionMigrationRoles(): Promise<void> {
  await sql.unsafe(`
    DO $$
    DECLARE
      target_role text;
    BEGIN
      FOREACH target_role IN ARRAY ARRAY[
        'hosted_owner', 'hosted_app', 'hosted_service', 'harness_app', 'harness_zero'
      ]
      LOOP
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = target_role) THEN
          EXECUTE format(
            'CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',
            target_role
          );
        END IF;
      END LOOP;
      EXECUTE format('GRANT hosted_owner, hosted_app, hosted_service TO %I', current_user);
    END
    $$;
  `);
}

beforeAll(async () => {
  db = await createFreshTestDb({ prefix: 'workosvault1002adapter' });
  sql = postgres(db.url, { max: 1, onnotice: () => {} });
  await provisionMigrationRoles();
  await sql.unsafe(migrationSql);
  vault = new PostgresWorkOSSealedSessionVault(sql as ReturnType<typeof import('@papercusp/db-org').getOrgPg>['sql']);
}, 120_000);

beforeEach(async () => {
  await sql`TRUNCATE papercusp_auth.workos_sealed_sessions`;
});

afterAll(async () => {
  await sql?.end({ timeout: 5 }).catch(() => {});
  await db?.drop().catch(() => {});
});

describe('PostgresWorkOSSealedSessionVault', () => {
  it('round-trips provider ciphertext and its exact expiry without projecting extra state', async () => {
    const expiresAtMs = Date.now() + 60 * 60 * 1_000;
    await vault.put({
      externalSessionId: 'session_workos_001',
      sealedSession: 'sealed-session-ciphertext-v1',
      expiresAtMs,
    });

    await expect(vault.get('session_workos_001')).resolves.toEqual({
      externalSessionId: 'session_workos_001',
      sealedSession: 'sealed-session-ciphertext-v1',
      expiresAtMs,
    });
  });

  it('atomically replaces a retried exchange for the same upstream session', async () => {
    const firstExpiry = Date.now() + 60 * 60 * 1_000;
    const secondExpiry = firstExpiry + 60_000;
    await vault.put({
      externalSessionId: 'session_workos_retry',
      sealedSession: 'sealed-session-first',
      expiresAtMs: firstExpiry,
    });
    await vault.put({
      externalSessionId: 'session_workos_retry',
      sealedSession: 'sealed-session-second',
      expiresAtMs: secondExpiry,
    });

    await expect(vault.get('session_workos_retry')).resolves.toEqual({
      externalSessionId: 'session_workos_retry',
      sealedSession: 'sealed-session-second',
      expiresAtMs: secondExpiry,
    });
    const [{ count }] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count
        FROM papercusp_auth.workos_sealed_sessions
       WHERE external_session_id = 'session_workos_retry'
    `;
    expect(count).toBe(1);
  });

  it('deletes exactly one session and remains idempotent when the row is absent', async () => {
    await vault.put({
      externalSessionId: 'session_workos_delete',
      sealedSession: 'sealed-session-delete',
      expiresAtMs: Date.now() + 60 * 60 * 1_000,
    });

    await vault.delete('session_workos_delete');
    await vault.delete('session_workos_delete');

    await expect(vault.get('session_workos_delete')).resolves.toBeNull();
  });

  it('fails closed before querying on malformed identifiers, ciphertext, or expiry', async () => {
    await expect(vault.get('   ')).resolves.toBeNull();
    await expect(vault.delete('   ')).resolves.toBeUndefined();
    await expect(
      vault.put({
        externalSessionId: '   ',
        sealedSession: 'sealed-session',
        expiresAtMs: Date.now() + 60_000,
      }),
    ).rejects.toThrow(/externalSessionId/);
    await expect(
      vault.put({
        externalSessionId: 'session_workos_invalid_payload',
        sealedSession: '   ',
        expiresAtMs: Date.now() + 60_000,
      }),
    ).rejects.toThrow(/sealedSession/);
    await expect(
      vault.put({
        externalSessionId: 'session_workos_invalid_expiry',
        sealedSession: 'sealed-session',
        expiresAtMs: Number.NaN,
      }),
    ).rejects.toThrow(/expiresAtMs/);
  });
});
