/**
 * work-items-outbox-canonical-slug.integration.test.ts — migration 452 (WI-900 M1).
 *
 * THE GAP THIS CLOSES
 * --------------------
 * `capture_work_items_outbox()` (the CDC capture the unified `work_items` table
 * rides — mig 375, refined 382/423/446) derives its routing `v_slug` straight from
 * the row's raw `harness_slug` and never calls `harness_shared.canonical_harness_slug()`
 * — unlike its sibling `capture_substrate_outbox()` (mig 359), which DOES wrap its
 * `v_slug` for exactly this reason: a write tagged with a RETIRED slug should
 * self-heal into its current hive instead of enqueuing an outbox row no booted
 * drain owns (which then just sits until the 48h backstop GC drops it, silently
 * never federating). `federation-slug-canonicalization.integration.test.ts` proves
 * this invariant for the GENERIC capture path (coord_event_log,
 * harness_features_consolidated pre-unification) — it does NOT cover the
 * work-items-specific capture fn, which is exactly where mig 375/382 silently
 * dropped the canonicalization. This file is that missing coverage, against the
 * REAL, CURRENT, full migration chain (000-baseline → HEAD, including mig 452).
 *
 * WHY THE FULL-CHAIN BOOT (not a hand-assembled schema slice)
 * -------------------------------------------------------------
 * Mirrors stamp-trigger-coverage.integration.test.ts: `createFreshTestDb` +
 * `applyPendingMigrations` runs the REAL boot-path migration runner over the REAL
 * sql/ directory, so this test exercises the actual live `capture_work_items_outbox`
 * function post-452 (not a reconstructed approximation) and would have caught the
 * bug had it existed at HEAD before this fix.
 *
 * RUN (real testcontainer PG):
 *   cd packages/operator-core && VITEST_UNIT_TIMEOUT_MS=180000 \
 *     npx vitest run lib/sync/hyperbee/__tests__/work-items-outbox-canonical-slug.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import postgres from 'postgres';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../../../..');
const SQL_DIR = resolve(REPO_ROOT, 'libs/papercusp/libs/db/sql');
const MIGRATION_RUNNER = resolve(
  REPO_ROOT,
  'libs/papercusp/packages/embedded-postgres-server/src/migration-runner.js',
);

// Boot pre-step (roles + extensions) — mirrors embedded-postgres-server boot /
// stamp-trigger-coverage.integration.test.ts. Roles are cluster-global on the
// reused testcontainer, hence IF NOT EXISTS.
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

const WS = 'ws_work_items_canon';

let db: MigratedTestDb;
let sql: postgres.Sql;

beforeAll(async () => {
  db = await createFreshTestDb({
    prefix: 'wicanon',
    provision: async (url) => {
      const { applyPendingMigrations } = (await import(pathToFileURL(MIGRATION_RUNNER).href)) as {
        applyPendingMigrations: (opts: { client: postgres.Sql; sqlDir: string }) => Promise<unknown>;
      };
      const s = postgres(url, { max: 1, onnotice: () => {} });
      try {
        await s.unsafe(BOOT_PREREQS_DDL);
        await applyPendingMigrations({ client: s, sqlDir: SQL_DIR });
      } finally {
        await s.end({ timeout: 5 });
      }
    },
  });
  sql = postgres(db.url, { max: 4, onnotice: () => {}, prepare: false });
}, 240_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 });
  await db?.drop();
});

interface OutboxRow {
  table_name: string;
  harness_slug: string;
}

async function latestOutbox(key: string): Promise<OutboxRow | undefined> {
  const [r] = await sql<OutboxRow[]>`
    SELECT table_name, harness_slug FROM harness_shared.substrate_outbox
     WHERE key = ${key} ORDER BY id DESC LIMIT 1`;
  return r;
}

let seq = 0;
function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}-canon-${seq}`;
}

describe('capture_work_items_outbox canonicalizes harness_slug (migration 452, WI-900 M1, real PG)', () => {
  it('an ISSUE (bug) written under the retired papercup slug federates under the canonical papercusp slug', async () => {
    const id = nextId('WI');
    await sql`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, title, summary, status, item_kind, origin)
      VALUES (${WS}, 'papercup', ${id}, 'canon test issue', 'body', 'open', 'bug', 'local')`;
    const row = await latestOutbox(id);
    expect(row?.table_name).toBe('engineer_issues');
    expect(row?.harness_slug).toBe('papercusp');
  });

  it('the papercup-hive alias also canonicalizes to papercusp (issue family)', async () => {
    const id = nextId('WI');
    await sql`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, title, summary, status, item_kind, origin)
      VALUES (${WS}, 'papercup-hive', ${id}, 'canon test issue 2', 'body', 'open', 'change', 'local')`;
    expect((await latestOutbox(id))?.harness_slug).toBe('papercusp');
  });

  it('a FEATURE written under the retired papercup slug federates under the canonical papercusp slug', async () => {
    const id = nextId('F');
    await sql`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, title, summary, status, item_kind, origin)
      VALUES (${WS}, 'papercup', ${id}, 'canon test feature', 'body', 'todo', 'feature', 'local')`;
    const row = await latestOutbox(id);
    expect(row?.table_name).toBe('harness_features_consolidated');
    expect(row?.harness_slug).toBe('papercusp');
  });

  it('a non-retired slug passes through UNCHANGED (behavior-preserving), both families', async () => {
    const issueId = nextId('WI');
    const featureId = nextId('F');
    await sql`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, title, summary, status, item_kind, origin)
      VALUES (${WS}, 'real-hive', ${issueId}, 'passthrough issue', 'body', 'open', 'bug', 'local')`;
    await sql`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, title, summary, status, item_kind, origin)
      VALUES (${WS}, 'real-hive', ${featureId}, 'passthrough feature', 'body', 'todo', 'feature', 'local')`;
    expect((await latestOutbox(issueId))?.harness_slug).toBe('real-hive');
    expect((await latestOutbox(featureId))?.harness_slug).toBe('real-hive');
  });
});
