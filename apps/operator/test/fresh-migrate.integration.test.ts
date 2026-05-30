/**
 * fresh-migrate.integration.test.ts — the "empty Postgres → head" tripwire.
 *
 * Plan: production-readiness-test-coverage-2026-05-30, P-007 (Phase 1).
 *
 * BACKGROUND — two boot paths:
 *   The shipping desktop boots embedded Postgres and, on a fresh initdb,
 *   `pg_restore`s a bundled seed dump (PAPERCUSP_PG_SEED_DUMP_PATH) that already
 *   contains the full final schema, then PRE-MARKS every migration as applied —
 *   so the migration runner is a no-op. That is the path real installs take and
 *   it works. `empty → apply all migrations → head` is only the dev/fallback
 *   path, and the migration set is currently NOT self-contained for it
 *   ("push-bootstrapped" — a baseline rebuild is owed). Concretely:
 *     - no migration runs `CREATE ROLE`; the boot pre-creates harness_app /
 *       harness_admin / harness_zero (replicated below), and
 *     - migration 056 `ALTER`s `harness_shared.adaptive_telemetry`, a table NO
 *       migration `CREATE`s (app code creates it lazily at runtime).
 *
 * So this is NOT a ship-blocker — it is tracked tech-debt. This file is a
 * TRIPWIRE, not a hard gate: it runs the REAL production runner from a genuinely
 * empty database and asserts the CURRENT reality (the run gets through the
 * self-contained prefix, then fails). When someone makes the migration set
 * self-contained (the owed baseline rebuild), the first test flips to RED —
 * that is the signal to delete the tripwire and enable the STRICT SUCCESS GATE
 * sketched at the bottom of this file.
 *
 * Uses the production runner directly (relative import — plain ESM, node
 * built-ins only) so it exercises the exact code path the desktop boot takes.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTestPg, teardownTestPg } from '@papercusp/test-config';
// eslint-disable-next-line import/no-relative-packages -- exercise the real boot-path runner
import { applyPendingMigrations } from '../../../libs/papercusp/packages/embedded-postgres-server/src/migration-runner.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// apps/operator/test → repo root is three levels up.
const REPO_ROOT = resolve(__dirname, '../../..');
const SQL_DIR = resolve(REPO_ROOT, 'libs/papercusp/libs/db/sql');

/**
 * Framework roles the migration set assumes already exist (no migration runs
 * `CREATE ROLE`). The production embedded-pg boot creates these BEFORE applying
 * migrations — see embedded-postgres-server/src/index.js. Mirrored verbatim here
 * so the gate exercises the real boot order; keep in sync with index.js (a future
 * refactor should extract a shared `ensureFrameworkRoles()` both call).
 */
const FRAMEWORK_ROLES_DDL = `
  DO $pg$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harness_app') THEN
      CREATE ROLE harness_app LOGIN PASSWORD 'harness_app_pwd';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harness_admin') THEN
      CREATE ROLE harness_admin LOGIN SUPERUSER PASSWORD 'harness_admin_pwd';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harness_zero') THEN
      CREATE ROLE harness_zero LOGIN REPLICATION SUPERUSER PASSWORD 'harness_zero_pwd';
    END IF;
  END $pg$;
`;

let adminUri: string;
let dbName: string;
let sql: postgres.Sql;

beforeAll(async () => {
  adminUri = await getTestPg();
  dbName = `fm_${randomBytes(5).toString('hex')}`;

  // CREATE DATABASE needs a maintenance connection and cannot run inside a txn.
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
  } finally {
    await admin.end({ timeout: 5 });
  }

  // Connect to the freshly-created, genuinely-empty database. max:1 is required —
  // the production runner applies each migration in an explicit BEGIN/COMMIT block
  // via client.unsafe(), which postgres-js only permits on a single connection.
  const u = new URL(adminUri);
  u.pathname = `/${dbName}`;
  sql = postgres(u.toString(), { max: 1, onnotice: () => {} });

  // Replicate the production boot's pre-migration role bootstrap (roles are
  // cluster-global, so IF NOT EXISTS keeps this safe across reused containers).
  await sql.unsafe(FRAMEWORK_ROLES_DDL);
}, 60_000);

afterAll(async () => {
  if (sql) await sql.end({ timeout: 5 });
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  } catch {
    /* best-effort cleanup */
  } finally {
    await admin.end({ timeout: 5 });
  }
  if (!process.env.KEEP_TEST_PG) await teardownTestPg();
});

describe('fresh migrate — empty Postgres → head (tripwire for the owed baseline rebuild)', () => {
  it('currently FAILS to migrate from empty — migration set is not self-contained', async () => {
    // When this assertion flips (the apply stops throwing), the migration set has
    // become self-contained from empty: delete this tripwire and enable the STRICT
    // SUCCESS GATE below. Until then, empty→head is expected to fail (the desktop
    // ships via seed-dump restore instead — see the file header).
    await expect(
      applyPendingMigrations({ client: sql, sqlDir: SQL_DIR }),
    ).rejects.toThrow();
  });

  it('applies the self-contained PREFIX before failing (a late dep, not a total failure)', async () => {
    // The early migrations commit per-file before the runner throws, so real
    // progress is visible. This guards against the failure regressing to "nothing
    // applies" (e.g. the role bootstrap or 001-shared breaking). The failing
    // migration left the shared max:1 connection in an aborted transaction, so
    // read the committed progress from a fresh connection.
    const u = new URL(adminUri);
    u.pathname = `/${dbName}`;
    const probe = postgres(u.toString(), { max: 1, onnotice: () => {} });
    try {
      const rows = await probe.unsafe(
        `SELECT count(*)::int AS n FROM harness_shared.schema_migrations`,
      );
      expect(rows[0].n).toBeGreaterThan(40);

      const schemas = await probe.unsafe(
        `SELECT 1 FROM information_schema.schemata WHERE schema_name = 'harness_shared'`,
      );
      expect(schemas.length).toBe(1);
    } finally {
      await probe.end({ timeout: 5 });
    }
  });
});

/*
 * STRICT SUCCESS GATE — enable once the migration set is self-contained from
 * empty (the owed baseline rebuild). Replace the tripwire `describe` above with:
 *
 *   it('applies every tracked migration from empty', async () => {
 *     const first = await applyPendingMigrations({ client: sql, sqlDir: SQL_DIR });
 *     expect(first.totalKnown).toBeGreaterThanOrEqual(90);
 *     expect(first.appliedCount).toBe(first.totalKnown);
 *   });
 *   it('records one tracker row per migration', async () => {
 *     const [{ n }] = await sql.unsafe(
 *       `SELECT count(*)::int AS n FROM harness_shared.schema_migrations`);
 *     expect(n).toBe(<totalKnown from above>);
 *   });
 *   it('is idempotent — a second run applies nothing', async () => {
 *     const second = await applyPendingMigrations({ client: sql, sqlDir: SQL_DIR });
 *     expect(second.appliedCount).toBe(0);
 *   });
 */
