/**
 * Live-PG regression sentinel for ensure-schema-dogfood.ts.
 *
 * Brings up an embedded PG18 on a non-default port, points
 * getOrgPg() at it via HARNESS_ADMIN_DATABASE_URL, runs
 * ensureAllDogfoodTables(), then asserts every expected table
 * exists with the expected columns + constraints. Cleans up.
 *
 * Sibling to verify-trigger-consolidation.mjs; together they cover
 * the dogfood schema's two surfaces — DDL shape (here) and
 * reactivity wiring (over there).
 *
 * Run: cd apps/operator && npx tsx scripts/verify-dogfood-schema.ts
 *
 * Exits 0 on PASS, 1 on FAIL. Useful as a pre-commit gate on any
 * change to ensure-schema-dogfood.ts.
 */

import { startEmbeddedPostgresServer } from '@restart/embedded-postgres-server';
import postgres from 'postgres';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type PgHandle = Awaited<ReturnType<typeof startEmbeddedPostgresServer>>;

const PG_PORT = 16781;
const DB_NAME = 'papercusp';

interface ExpectedTable {
  name: string;
  bucket: 'HYPERBEE' | 'SECURITY' | 'LOCAL';
  /** Columns that MUST exist (drift-detection sentinels). */
  requiredColumns: string[];
}

const EXPECTED_TABLES: ExpectedTable[] = [
  {
    name: 'feature_queue',
    bucket: 'HYPERBEE',
    requiredColumns: ['workspace_id', 'harness_slug', 'github_user_id', 'feature_id', 'queued_at', 'removed_at', 'schema_version'],
  },
  {
    name: 'contributors',
    bucket: 'HYPERBEE',
    requiredColumns: ['workspace_id', 'harness_slug', 'github_user_id', 'github_username', 'device_attestations', 'revoked_pubkeys', 'joined_at', 'schema_version'],
  },
  {
    name: 'feature_claims',
    bucket: 'HYPERBEE',
    requiredColumns: ['workspace_id', 'harness_slug', 'feature_id', 'seq', 'claimer_pubkey', 'claimer_github_user_id', 'claimed_at', 'schema_version'],
  },
  {
    name: 'pr_reviewer_settings',
    bucket: 'SECURITY',
    requiredColumns: ['workspace_id', 'harness_slug', 'github_user_id', 'pr_reviewer_role_enabled', 'auto_review', 'auto_merge', 'merge_method'],
  },
  {
    name: 'trusted_authors',
    bucket: 'SECURITY',
    requiredColumns: ['workspace_id', 'harness_slug', 'trusted_github_user_id', 'trusted_by_github_user_id', 'trusted_at'],
  },
  {
    name: 'pr_check_status_cache',
    bucket: 'LOCAL',
    requiredColumns: ['workspace_id', 'harness_slug', 'head_sha', 'check_name', 'status', 'fetched_at'],
  },
  {
    name: 'known_schema_versions',
    bucket: 'LOCAL',
    requiredColumns: ['workspace_id', 'harness_slug', 'max_known_version', 'updated_at'],
  },
  {
    name: 'auto_review_audit',
    bucket: 'LOCAL',
    requiredColumns: ['workspace_id', 'id', 'harness_slug', 'pr_number', 'reviewer_github_id', 'action', 'ts'],
  },
  {
    name: 'claim_audit',
    bucket: 'LOCAL',
    requiredColumns: ['workspace_id', 'id', 'harness_slug', 'feature_id', 'claimer_pubkey', 'outcome'],
  },
  {
    name: 'webhook_audit',
    bucket: 'LOCAL',
    requiredColumns: ['workspace_id', 'id', 'harness_slug', 'target_url', 'event_kind', 'sent_at'],
  },
  {
    name: 'contributor_usage_events',
    bucket: 'HYPERBEE',
    requiredColumns: ['harness_slug', 'event_id', 'github_user_id', 'device_pubkey', 'kind', 'schema_version'],
  },
  {
    name: 'insights_first_visit',
    bucket: 'LOCAL',
    requiredColumns: ['workspace_id', 'harness_slug', 'user_id'],
  },
  {
    name: 'shared_repo_binding_cache',
    bucket: 'LOCAL',
    requiredColumns: [
      'workspace_id', 'provider', 'github_repository_id', 'github_full_name',
      'harness_topic', 'harness_slug', 'harness_link', 'privacy', 'claim_status',
      'provisional_owner_github_user_id', 'claimed_by_github_user_ids',
      'created_at', 'cached_at',
    ],
  },
];

let failures = 0;
function expect(cond: boolean, msg: string): void {
  if (!cond) {
    console.error('  FAIL: ' + msg);
    failures++;
  } else {
    console.log('  OK:   ' + msg);
  }
}

async function main(): Promise<void> {
  const dataDir = await mkdtemp(join(tmpdir(), 'pg-dogfood-schema-test-'));
  console.log('[test] booting embedded PG18 at port ' + PG_PORT + ', dataDir=' + dataDir);
  const t0 = Date.now();

  let pgHandle: PgHandle | null = null;
  try {
    pgHandle = await startEmbeddedPostgresServer({ dataDir, port: PG_PORT, dbName: DB_NAME });
    console.log('[test] PG ready in ' + (Date.now() - t0) + 'ms');

    // Point getOrgPg() at the test PG. Must happen BEFORE any import
    // of ensure-schema-dogfood (which calls getOrgPg lazily).
    const url = 'postgres://postgres:postgres@localhost:' + PG_PORT + '/' + DB_NAME;
    process.env.HARNESS_ADMIN_DATABASE_URL = url;

    // Bootstrap the harness_shared schema (the table-creates use
    // fully-qualified names but require the schema to exist).
    const sysSql = postgres(url, { max: 1 });
    try {
      await sysSql.unsafe('CREATE SCHEMA IF NOT EXISTS harness_shared;');
      // Roles the GRANT statements reference. The ensure-schema
      // functions don't issue GRANTs (they're CREATE TABLE only),
      // but trigger function from migration 078 might.
      await sysSql.unsafe(`
        DO $body$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='harness_app') THEN
            CREATE ROLE harness_app;
          END IF;
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='harness_admin') THEN
            CREATE ROLE harness_admin;
          END IF;
        END $body$;
      `);
    } finally {
      await sysSql.end({ timeout: 1 });
    }

    // Dynamic import AFTER env is set, so getOrgPg() resolves to test PG.
    const { ensureAllDogfoodTables } = await import('../lib/ensure-schema-dogfood.js');
    console.log('[test] calling ensureAllDogfoodTables() ...');
    await ensureAllDogfoodTables();
    console.log('[test] all dogfood ensures completed');

    // Verify with a fresh connection (avoid relying on the operator's
    // pool cache for the assertion path).
    const checkSql = postgres(url, { max: 1 });
    try {
      console.log('\n[test] assertions:');

      // 1) Every expected table exists in harness_shared.
      const tables = await checkSql<{ table_name: string }[]>`
        SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'harness_shared'
         ORDER BY table_name
      `;
      const tableSet = new Set(tables.map((t) => t.table_name));
      for (const expected of EXPECTED_TABLES) {
        expect(tableSet.has(expected.name),
          'table ' + expected.name + ' (' + expected.bucket + ' bucket) exists');
      }

      // 2) Every expected column exists on each table.
      for (const expected of EXPECTED_TABLES) {
        if (!tableSet.has(expected.name)) continue; // skip column-check; table-check already failed
        const cols = await checkSql<{ column_name: string }[]>`
          SELECT column_name FROM information_schema.columns
           WHERE table_schema = 'harness_shared' AND table_name = ${expected.name}
        `;
        const colSet = new Set(cols.map((c) => c.column_name));
        for (const expectedCol of expected.requiredColumns) {
          expect(colSet.has(expectedCol),
            expected.name + '.' + expectedCol + ' column exists');
        }
      }

      // 3) Specific schema-correctness sanity checks (catch typos in
      // CHECK constraints and PK definitions).
      const checkConstraintCount = await checkSql<{ n: number }[]>`
        SELECT COUNT(*)::int AS n FROM information_schema.check_constraints cc
         JOIN information_schema.constraint_column_usage ccu
           ON cc.constraint_name = ccu.constraint_name
        WHERE ccu.table_schema = 'harness_shared'
          AND ccu.table_name = 'shared_repo_binding_cache'
      `;
      expect((checkConstraintCount[0]?.n ?? 0) >= 3,
        'shared_repo_binding_cache has ≥3 CHECK constraints (provider + privacy + claim_status), got ' + checkConstraintCount[0]?.n);

      // 4) Idempotent re-run: ensureAllDogfoodTables() second call is fast + no-op.
      const t2 = Date.now();
      await ensureAllDogfoodTables();
      const dt = Date.now() - t2;
      expect(dt < 200,
        'idempotent re-run completes in <200ms (got ' + dt + 'ms; flag short-circuit working)');

      // 5) Total table count matches EXPECTED_TABLES length.
      expect(tables.length === EXPECTED_TABLES.length,
        'harness_shared has exactly ' + EXPECTED_TABLES.length + ' tables (got ' + tables.length + ')');
    } finally {
      await checkSql.end({ timeout: 1 });
    }

    if (failures > 0) {
      console.error('\n[test] FAILED: ' + failures + ' assertion(s) failed');
      process.exit(1);
    } else {
      console.log('\n[test] PASS — all 13 dogfood tables present with expected columns');
    }
  } finally {
    try {
      if (pgHandle && typeof (pgHandle as { stop?: () => Promise<void> }).stop === 'function') {
        await (pgHandle as { stop: () => Promise<void> }).stop();
      }
    } catch (e: unknown) {
      console.error('[test] stop failed (best-effort): ' + (e instanceof Error ? e.message : String(e)));
    }
    try { await rm(dataDir, { recursive: true, force: true }); } catch {}
    console.log('[test] cleaned up');
  }
}

main().catch((e) => {
  console.error('[test] fatal: ' + (e instanceof Error ? (e.stack || e.message) : String(e)));
  process.exit(1);
});
