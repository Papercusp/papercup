/**
 * P-006 DB backstop trigger (pot-membership-enforcement-2026-07-20): the
 * BEFORE INSERT / UPDATE-OF-harness_slug guard on harness_shared.work_items.
 * A non-pot harness_slug that names a known workspace-global scope label
 * (operator:<ws> / @singleton / the bare ws id / ...) SELF-HEALS to the platform
 * Pot; a genuinely made-up slug is REJECTED; it fails OPEN for federation
 * replicas (origin<>'local') and for workspaces with no platform Pot (fixtures).
 *
 * Ships as migration 651 + the 652 reconcile. 651 was edited to the self-heal
 * form AFTER an interim REJECT-ONLY version had already applied to the live DB,
 * so the runner (apply-once by filename) never re-applied it and the live trigger
 * stayed reject-only — actively erroring improvements:capture's operator-scope
 * writes. Migration 652 CREATE-OR-REPLACEs the function to self-heal. This test
 * applies BOTH real migration files, so the trigger under test is the full
 * shipping chain (a fresh DB's path); the live DB reached the same end-state via
 * 652's function-only reconcile.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFreshPgDb, applyMigrationForTest, type FreshPgDb } from '../test/_pg-helpers';

const SQL_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../libs/papercusp/libs/db/sql');
const WS = 'papercusp-workspace';
const FIXTURE_WS = 'generic-test';

let db: FreshPgDb;

/** Insert a work_items row with only the columns the trigger reads; returns the promise. */
function insertItem(row: {
  workspace_id: string;
  harness_slug: string;
  feature_id: string;
  item_kind?: string;
  origin?: string;
}) {
  const { sql } = db;
  return sql`
    INSERT INTO harness_shared.work_items (workspace_id, harness_slug, feature_id, item_kind, origin, status)
    VALUES (${row.workspace_id}, ${row.harness_slug}, ${row.feature_id}, ${row.item_kind ?? 'bug'}, ${row.origin ?? 'local'}, 'open')`;
}

/** The harness_slug actually stored for a feature_id (post-trigger). */
async function storedSlug(featureId: string): Promise<string | undefined> {
  const rows = await db.sql<{ harness_slug: string }[]>`
    SELECT harness_slug FROM harness_shared.work_items WHERE feature_id = ${featureId} LIMIT 1`;
  return rows[0]?.harness_slug;
}

beforeAll(async () => {
  db = await createFreshPgDb('potmemb');
  const { sql } = db;
  // canonical_harness_slug (migration 359) — the trigger canonicalizes through it.
  await sql.unsafe(`
    CREATE OR REPLACE FUNCTION harness_shared.canonical_harness_slug(p_slug text)
      RETURNS text LANGUAGE sql IMMUTABLE AS $$
      SELECT CASE WHEN p_slug IN ('papercup','papercup-hive') THEN 'papercusp' ELSE p_slug END;
    $$;`);
  // Minimal pots + work_items (only the columns the trigger reads).
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS harness_shared.pots (
      workspace_id text NOT NULL, pot_home_slug text NOT NULL,
      PRIMARY KEY (workspace_id, pot_home_slug));
    CREATE TABLE IF NOT EXISTS harness_shared.work_items (
      -- WI-38326: FEATURE_COLS projects these five claim-spec filter columns; a fixture
      -- missing them fails that projection with "column does not exist" (D-014 debt).
      tags jsonb,
      source_plan_slug text,
      source_plan_item_ids text[],
      redundancy integer,
      expected_cost_cents bigint,
      workspace_id text NOT NULL, harness_slug text NOT NULL, feature_id text NOT NULL,
      item_kind text NOT NULL DEFAULT 'bug', origin text NOT NULL DEFAULT 'local',
      status text NOT NULL DEFAULT 'open',
      PRIMARY KEY (harness_slug, feature_id));`);
  // papercusp-workspace HAS the platform Pot ⇒ enforced; generic-test has pots but
  // NO platform Pot ⇒ fail-open.
  await sql`INSERT INTO harness_shared.pots (workspace_id, pot_home_slug) VALUES
    (${WS}, 'papercusp'), (${WS}, 'oddsmith-hive'), (${FIXTURE_WS}, 'lane7hive')`;
  // Apply the REAL migration chain under test: 651 (installs the trigger) then
  // the 652 self-heal reconcile (CREATE OR REPLACE of the trigger function).
  await applyMigrationForTest(sql, join(SQL_DIR, '651-pot-membership-enforce-trigger.sql'));
  await applyMigrationForTest(sql, join(SQL_DIR, '652-pot-membership-selfheal-reconcile.sql'));
});

afterAll(async () => {
  await db?.cleanup();
});

describe('pot-membership backstop trigger (migration 651 + 652 self-heal reconcile)', () => {
  it('ALLOWS an insert under a real Pot in the enforced workspace', async () => {
    await expect(insertItem({ workspace_id: WS, harness_slug: 'papercusp', feature_id: 'WI-OK-1' })).resolves.toBeDefined();
    await expect(insertItem({ workspace_id: WS, harness_slug: 'oddsmith-hive', feature_id: 'WI-OK-2' })).resolves.toBeDefined();
  });

  it('ALLOWS a legacy dogfood slug (canonicalized to the platform Pot)', async () => {
    await expect(insertItem({ workspace_id: WS, harness_slug: 'papercup', feature_id: 'WI-OK-3' })).resolves.toBeDefined();
  });

  it('SELF-HEALS a known workspace-global scope label to the platform Pot (deploy-order safe)', async () => {
    // operator:<ws> / @singleton / the bare workspace id are not Pots — the backstop
    // rewrites them to the platform Pot instead of failing a pre-P-005 writer.
    for (const [slug, fid] of [
      ['operator:papercusp-workspace', 'WI-HEAL-1'],
      ['@singleton', 'WI-HEAL-2'],
      ['papercusp-workspace', 'WI-HEAL-3'],
      ['operator', 'WI-HEAL-4'],
    ] as const) {
      await expect(insertItem({ workspace_id: WS, harness_slug: slug, feature_id: fid })).resolves.toBeDefined();
      expect(await storedSlug(fid)).toBe('papercusp');
    }
  });

  it('REJECTS a genuinely made-up Pot slug in the enforced workspace', async () => {
    await expect(insertItem({ workspace_id: WS, harness_slug: 'totally-made-up', feature_id: 'WI-BAD-4' })).rejects.toThrow(
      /not a real Pot/i,
    );
  });

  it('ALLOWS a federation replica (origin<>local) and leaves its slug untouched', async () => {
    await expect(
      insertItem({ workspace_id: WS, harness_slug: 'operator:papercusp-workspace', feature_id: 'WI-REMOTE-1', origin: 'remote' }),
    ).resolves.toBeDefined();
    // Remote-origin rows are owned by the authoring peer — never rewritten.
    expect(await storedSlug('WI-REMOTE-1')).toBe('operator:papercusp-workspace');
  });

  it('FAILS OPEN for a workspace with no platform Pot (test fixture tenant)', async () => {
    await expect(
      insertItem({ workspace_id: FIXTURE_WS, harness_slug: 'anything-goes-here', feature_id: 'WI-FIX-1' }),
    ).resolves.toBeDefined();
  });

  it('REJECTS an UPDATE that re-scopes harness_slug to a non-pot slug', async () => {
    await insertItem({ workspace_id: WS, harness_slug: 'oddsmith-hive', feature_id: 'WI-UPD-1' });
    await expect(
      db.sql`UPDATE harness_shared.work_items SET harness_slug = 'made-up-target'
             WHERE harness_slug = 'oddsmith-hive' AND feature_id = 'WI-UPD-1'`,
    ).rejects.toThrow(/not a real Pot/i);
  });

  it('ALLOWS an UPDATE that re-homes harness_slug to another real Pot', async () => {
    await insertItem({ workspace_id: WS, harness_slug: 'papercusp', feature_id: 'WI-UPD-2' });
    await expect(
      db.sql`UPDATE harness_shared.work_items SET harness_slug = 'oddsmith-hive'
             WHERE harness_slug = 'papercusp' AND feature_id = 'WI-UPD-2'`,
    ).resolves.toBeDefined();
  });
});
