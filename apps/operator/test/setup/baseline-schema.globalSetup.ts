/**
 * baseline-schema.globalSetup.ts — integration-tier globalSetup (P-015 / production-readiness P-002).
 *
 * Plan: self-contained-migration-baseline-2026-06-02.
 *
 * Stands up the COMPLETE harness_shared schema ONCE per integration run by applying
 * the real migration set (000-baseline.sql + 107/108…) — the capability the owed
 * baseline rebuild (D-005) unblocked. Before this, integration tool-suites had to
 * hand-build per-test schemas from Drizzle `getTableConfig` (see read-tools.integration.test.ts)
 * because `empty → migrations` didn't yield a working schema. Now they can
 * `inject('baselineSchemaDsn')` and query any real table.
 *
 * Owns its OWN pgvector container (NOT the shared `getTestPg`): per-file tests call
 * `teardownTestPg()` in their afterAll, which would stop/recreate the shared container
 * mid-run and invalidate this DSN (and double-stop races throw at close). A dedicated
 * container keeps this schema-DB valid + isolated for the whole run.
 *
 * Read the DSN in a test with:
 *   import { inject } from 'vitest';
 *   const dsn = inject('baselineSchemaDsn');
 * Tests needing write-isolation should still make their own schema; this shared DB is
 * for read-heavy tool-suite assertions against the true schema.
 */
import type { GlobalSetupContext } from 'vitest/node';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import postgres from 'postgres';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// eslint-disable-next-line import/no-relative-packages -- exercise the real boot-path runner
import { applyPendingMigrations } from '../../../../libs/papercusp/packages/embedded-postgres-server/src/migration-runner.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../../..');
const SQL_DIR = resolve(REPO_ROOT, 'libs/papercusp/libs/db/sql');

// Boot pre-step (roles + extensions) — mirrors embedded-postgres-server/src/index.js.
const BOOT_PREREQS_DDL = `
  DO $pg$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='harness_app')   THEN CREATE ROLE harness_app   LOGIN PASSWORD 'harness_app_pwd'; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='harness_admin') THEN CREATE ROLE harness_admin LOGIN SUPERUSER PASSWORD 'harness_admin_pwd'; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='harness_zero')  THEN CREATE ROLE harness_zero  LOGIN REPLICATION SUPERUSER PASSWORD 'harness_zero_pwd'; END IF;
  END $pg$;
  CREATE EXTENSION IF NOT EXISTS pgcrypto;
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
  CREATE EXTENSION IF NOT EXISTS vector;
`;

export default async function setup({ provide }: GlobalSetupContext) {
  const container = await new PostgreSqlContainer('pgvector/pgvector:pg16')
    .withDatabase('papercusp_it')
    .withUsername('it_admin')
    .withPassword('it_admin')
    .start();
  const dsn = container.getConnectionUri();

  // max:1 — the runner applies each migration in an explicit BEGIN/COMMIT block.
  const sql = postgres(dsn, { max: 1, onnotice: () => {} });
  try {
    await sql.unsafe(BOOT_PREREQS_DDL);
    const { appliedCount, totalKnown } = await applyPendingMigrations({ client: sql, sqlDir: SQL_DIR });
    if (appliedCount !== totalKnown) {
      throw new Error(`baseline globalSetup: applied ${appliedCount}/${totalKnown} (expected zero skips)`);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }

  provide('baselineSchemaDsn', dsn);

  return async () => {
    await container.stop().catch(() => {});
  };
}

// Type the injected value for consumers.
declare module 'vitest' {
  interface ProvidedContext {
    baselineSchemaDsn: string;
  }
}
