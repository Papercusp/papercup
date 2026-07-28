/**
 * migration-649-pot-backfill.integration.test.ts — a migration must not make a
 * BOOT depend on which optional Pots a given database happens to contain.
 *
 * WHY THIS EXISTS (EI-18892214197928842). `649-pot-membership-backfill.sql` maps
 * mis-scoped `work_items.harness_slug` values onto real Pots. Its CASE names
 * optional Pots — `oddsmith-hive`, `sb-devboard-hive`, `quartermaster-hive`,
 * `hiveloop-hive`, `shared-hive-test-hive`, `papercusp-public-site-pot` — that
 * exist in the dev database it was written against. They do not exist in every
 * deployment. When one is absent the file's own `bad_target` guard RAISEs, the
 * runner rolls the whole migration back, and `serve.mjs` exits 1 before becoming
 * ready.
 *
 * The consequence was not a failed migration. It was that THE SHIPPED DESKTOP APP
 * COULD NOT BOOT AT ALL: reproduced on the packaged 0.0.13 deb on 2026-07-28 with
 * `649 guard: 8 mapped target slug(s) are not real pots`, after which the app
 * respawn-looped its sidecar indefinitely and the webview showed a plaintext 502
 * forever. Nothing in that symptom points at a migration, which is why it cost a
 * full diagnosis to find.
 *
 * The fix collapses any target Pot that does not exist here onto the `papercusp`
 * catch-all — which is what the file's own header already declares the fallback to
 * be. So the two things worth asserting are opposite in direction:
 *
 *   1. an absent OPTIONAL Pot must no longer fail the migration (the regression), and
 *   2. an absent CATCH-ALL Pot must STILL fail it (the guard keeps its teeth).
 *
 * Asserting only (1) would pass just as well against a migration whose guard had
 * been deleted outright, which is the failure mode this file is really guarding:
 * a "fix" that works by removing the check is indistinguishable from one that
 * works, unless you also prove the check can still fire.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTestPg } from '@papercusp/test-config/pg';
// eslint-disable-next-line import/no-relative-packages -- exercise the real boot-path runner
import { applyPendingMigrations } from '../../../libs/papercusp/packages/embedded-postgres-server/src/migration-runner.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../..');
const SQL_DIR = resolve(REPO_ROOT, 'libs/papercusp/libs/db/sql');

const MIGRATION = '649-pot-membership-backfill.sql';
const WORKSPACE = 'papercusp-workspace';
/** Maps to `oddsmith-hive` in the CASE — an optional Pot we deliberately never create. */
const MIS_SCOPED_SLUG = 'oddsmith';
const CATCH_ALL_POT = 'papercusp';

const BOOT_PREREQS_DDL = `
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
  CREATE EXTENSION IF NOT EXISTS pgcrypto;
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
  CREATE EXTENSION IF NOT EXISTS vector;
`;

let adminUri: string;
let dbName: string;
let sql: postgres.Sql;
const featureId = `EI-TEST-649-${randomBytes(4).toString('hex')}`;

/** Re-arm 649 as pending by forgetting it was applied (the runner skips by filename). */
async function rearm649(): Promise<void> {
  await sql.unsafe(`DELETE FROM harness_shared.schema_migrations WHERE filename = $1`, [MIGRATION]);
}

async function slugOfSeededRow(): Promise<string | null> {
  const rows = await sql.unsafe(
    `SELECT harness_slug FROM harness_shared.work_items
      WHERE workspace_id = $1 AND feature_id = $2`,
    [WORKSPACE, featureId],
  );
  return rows.length ? (rows[0] as unknown as { harness_slug: string }).harness_slug : null;
}

beforeAll(async () => {
  adminUri = await getTestPg();
  dbName = `m649_${randomBytes(5).toString('hex')}`;

  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
  } finally {
    await admin.end({ timeout: 5 });
  }

  const u = new URL(adminUri);
  u.pathname = `/${dbName}`;
  sql = postgres(u.toString(), { max: 1, onnotice: () => {} });

  await sql.unsafe(BOOT_PREREQS_DDL);
  await applyPendingMigrations({ client: sql, sqlDir: SQL_DIR });

  // A fresh database has no work_items, so 649 was a no-op above. Seed the exact
  // shape that broke the packaged app: a row scoped to a slug the CASE maps onto
  // an optional Pot, in a database where that Pot does not exist.
  await sql.unsafe(
    `INSERT INTO harness_shared.work_items (workspace_id, harness_slug, feature_id)
     VALUES ($1, $2, $3)`,
    [WORKSPACE, MIS_SCOPED_SLUG, featureId],
  );
}, 180_000);

afterAll(async () => {
  if (sql) await sql.end({ timeout: 5 });
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  } catch {
    /* best-effort */
  } finally {
    await admin.end({ timeout: 5 });
  }
});

describe('migration 649 — pot-membership backfill must not depend on optional Pots', () => {
  it('STILL FAILS when even the catch-all Pot is missing (the guard keeps its teeth)', async () => {
    // No Pots exist at all yet, so there is no valid home for the seeded row.
    // Refusing here is correct: it means the database has no platform Pot, which
    // is a genuine catastrophe rather than a deployment difference.
    await rearm649();
    await expect(applyPendingMigrations({ client: sql, sqlDir: SQL_DIR })).rejects.toThrow(
      /649 guard/,
    );

    // The runner wraps the file in one transaction, so a RAISE must leave the row
    // exactly as it was — no partial re-homing.
    expect(await slugOfSeededRow()).toBe(MIS_SCOPED_SLUG);
  });

  it('SUCCEEDS once the catch-all Pot exists, homing the row onto it', async () => {
    await sql.unsafe(
      `INSERT INTO harness_shared.pots
         (workspace_id, pot_home_slug, canonical_pot_home_slug, public_key, keychain_id, created_at)
       VALUES ($1, $2, $2, '\\x00'::bytea, $3, $4)
       ON CONFLICT DO NOTHING`,
      [WORKSPACE, CATCH_ALL_POT, `kc-${randomBytes(4).toString('hex')}`, Date.now()],
    );

    // `oddsmith-hive` — the Pot the CASE actually maps this slug to — is still
    // absent. Before the fix that alone raised `649 guard: N mapped target slug(s)
    // are not real pots` and took the whole boot down with it.
    const [{ n }] = (await sql.unsafe(
      `SELECT count(*)::int AS n FROM harness_shared.pots WHERE pot_home_slug = 'oddsmith-hive'`,
    )) as Array<{ n: number }>;
    expect(n).toBe(0);

    await rearm649();
    await expect(
      applyPendingMigrations({ client: sql, sqlDir: SQL_DIR }),
    ).resolves.toBeDefined();

    expect(await slugOfSeededRow()).toBe(CATCH_ALL_POT);
  });
});
