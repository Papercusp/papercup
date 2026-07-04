/**
 * composition-rig-schema-drift.integration.test.ts — EI-6794.
 *
 * THE GAP THIS CLOSES
 * --------------------
 * composition-rig.ts's `setupCellSchema` hand-rolls a "minimal-but-faithful"
 * snapshot of `harness_shared.harness_features_consolidated` (a CREATE TABLE
 * block + a follow-on ALTER TABLE ADD COLUMN block — see composition-rig.ts
 * lines ~178-354) instead of applying the real migration chain (deliberately,
 * for rig speed/isolation — see that file's own doc comment). Twice this
 * session that trade-off bit: WI-1472/1473 (a missing `owner_author_pubkey`-
 * style column) and WI-1644 (columns later migrations assumed existed). Each
 * time the failure surfaced OPAQUELY, deep in an unrelated integration test,
 * as a raw Postgres "column does not exist" — costing real investigation time
 * to trace back to "the fixture is stale."
 *
 * This test closes the loop for the highest-risk table (the richest DDL +
 * ALTER history, the one both prior incidents involved): it re-derives the
 * column list composition-rig.ts CURRENTLY declares by reading that file's
 * own source (regex over the CREATE TABLE + ALTER TABLE blocks — so this
 * test can never itself go stale relative to composition-rig.ts), boots a
 * REAL fresh Postgres through the REAL, CURRENT, full migration chain (mirrors
 * work-items-outbox-canonical-slug.integration.test.ts), and asserts every
 * column composition-rig.ts assumes actually exists in that real schema.
 * A later migration that renames/drops/retypes one of these columns now fails
 * LOUD, HERE, with the exact column name — instead of silently waiting to
 * surface as a opaque failure in some unrelated hermetic-loop test.
 *
 * SCOPE (disclosed, not silent): this covers `harness_features_consolidated`
 * only — the table both prior incidents hit, and the one with by far the
 * richest column/migration history in the rig. The other 7 tables
 * setupCellSchema creates (user_trust_list, hive_members,
 * harness_issues_consolidated, projects, rig_side_effects, work_item_deps,
 * datatype_registry) are comparatively small/stable slices with no drift
 * incident on record; extending this same pattern to them is a natural,
 * cheap follow-up (the parse-from-source + real-schema-assert shape below
 * generalizes directly) but is NOT done here.
 *
 * RUN (real testcontainer PG):
 *   cd packages/operator-core && VITEST_UNIT_TIMEOUT_MS=180000 \
 *     npx vitest run lib/shared-hive-loop/composition-rig-schema-drift.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import postgres from 'postgres';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../..');
const SQL_DIR = resolve(REPO_ROOT, 'libs/papercusp/libs/db/sql');
const MIGRATION_RUNNER = resolve(REPO_ROOT, 'libs/papercusp/packages/embedded-postgres-server/src/migration-runner.js');
const RIG_FILE = join(HERE, 'composition-rig.ts');

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

/**
 * Pure, exported for its own unit coverage: extract the column names
 * composition-rig.ts's `setupCellSchema` declares for
 * `harness_shared.harness_features_consolidated` — from BOTH its CREATE TABLE
 * block and the follow-on ALTER TABLE ADD COLUMN IF NOT EXISTS block. Reads
 * the rig's OWN source text so this list can never itself drift out of sync
 * with the fixture it is checking.
 */
export function extractRigFeatureColumns(rigSourceText: string): string[] {
  const columns = new Set<string>();

  // 1. The CREATE TABLE block.
  const createMatch = rigSourceText.match(
    /CREATE TABLE harness_shared\.harness_features_consolidated \(([\s\S]*?)\n\s*\);/,
  );
  if (!createMatch) {
    throw new Error(
      'extractRigFeatureColumns: could not find the harness_features_consolidated CREATE TABLE block in composition-rig.ts — did its shape change?',
    );
  }
  for (const rawLine of createMatch[1].split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('--') || line.startsWith('PRIMARY KEY') || line.startsWith('CONSTRAINT')) continue;
    const m = line.match(/^(\w+)\s+\S/);
    if (m) columns.add(m[1]);
  }

  // 2. The follow-on ALTER TABLE ADD COLUMN block (WI-1644's widened set).
  const alterMatch = rigSourceText.match(
    /ALTER TABLE harness_shared\.harness_features_consolidated\s*\n([\s\S]*?);\s*\n\s*`\);/,
  );
  if (alterMatch) {
    const addColRe = /ADD COLUMN IF NOT EXISTS (\w+)/g;
    let m: RegExpExecArray | null;
    while ((m = addColRe.exec(alterMatch[1])) !== null) columns.add(m[1]);
  }

  return [...columns].sort();
}

describe('extractRigFeatureColumns', () => {
  it('finds the known columns from the current composition-rig.ts source (sanity check on the parser itself)', () => {
    const src = readFileSync(RIG_FILE, 'utf8');
    const cols = extractRigFeatureColumns(src);
    // A handful of columns from each of the two blocks (CREATE + ALTER) this
    // parser must both reach — proves the regexes are hitting real content,
    // not silently matching zero columns.
    for (const expected of [
      'harness_slug',
      'feature_id',
      'item_kind',
      'feature_order',
      'swarm_affinity',
      'requeue_count',
      'last_progress_at',
      'terminal_completion_ref',
    ]) {
      expect(cols).toContain(expected);
    }
    expect(cols.length).toBeGreaterThan(20);
  });
});

describe('composition-rig schema drift — harness_features_consolidated vs the REAL migration chain', () => {
  let db: MigratedTestDb;
  let sql: postgres.Sql;

  beforeAll(async () => {
    db = await createFreshTestDb({
      prefix: 'rigdrift',
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

  it('every column composition-rig.ts assumes exists in the REAL, fully-migrated schema', async () => {
    const rigSrc = readFileSync(RIG_FILE, 'utf8');
    const rigColumns = extractRigFeatureColumns(rigSrc);

    const realColumns = (
      await sql<{ column_name: string }[]>`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'harness_shared' AND table_name = 'harness_features_consolidated'
      `
    ).map((r) => r.column_name);

    const missing = rigColumns.filter((c) => !realColumns.includes(c));

    if (missing.length > 0) {
      throw new Error(
        `composition-rig.ts's setupCellSchema assumes column(s) that do NOT exist in the real, ` +
          `fully-migrated harness_shared.harness_features_consolidated: ${missing.join(', ')}. ` +
          `A migration renamed/dropped/retyped one of these — update composition-rig.ts's hand-rolled ` +
          `schema to match (see EI-6794; this is exactly the drift class WI-1472/1473 and WI-1644 hit). ` +
          `Real columns present: ${realColumns.sort().join(', ')}`,
      );
    }

    expect(missing).toEqual([]);
  });
});
