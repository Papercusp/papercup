/**
 * P-006 DB backstop trigger (pot-membership-enforcement-2026-07-20): the
 * BEFORE INSERT / UPDATE-OF-harness_slug guard on harness_shared.work_items
 * installed by migration 651 must REJECT a non-pot harness_slug in a workspace
 * that has a platform Pot, while failing OPEN for federation replicas
 * (origin<>'local') and for workspaces with no platform Pot (test fixtures).
 *
 * Self-contained: builds the minimal schema the trigger reads (canonical_harness_slug
 * + pots + work_items) then applies the REAL migration file, so the trigger under
 * test is exactly what ships.
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
      workspace_id text NOT NULL, harness_slug text NOT NULL, feature_id text NOT NULL,
      item_kind text NOT NULL DEFAULT 'bug', origin text NOT NULL DEFAULT 'local',
      status text NOT NULL DEFAULT 'open',
      PRIMARY KEY (harness_slug, feature_id));`);
  // papercusp-workspace HAS the platform Pot ⇒ enforced; generic-test has pots but
  // NO platform Pot ⇒ fail-open.
  await sql`INSERT INTO harness_shared.pots (workspace_id, pot_home_slug) VALUES
    (${WS}, 'papercusp'), (${WS}, 'oddsmith-hive'), (${FIXTURE_WS}, 'lane7hive')`;
  // Apply the REAL migration under test.
  await applyMigrationForTest(sql, join(SQL_DIR, '651-pot-membership-enforce-trigger.sql'));
});

afterAll(async () => {
  await db?.cleanup();
});

describe('pot-membership backstop trigger (migration 651)', () => {
  it('ALLOWS an insert under a real Pot in the enforced workspace', async () => {
    await expect(insertItem({ workspace_id: WS, harness_slug: 'papercusp', feature_id: 'WI-OK-1' })).resolves.toBeDefined();
    await expect(insertItem({ workspace_id: WS, harness_slug: 'oddsmith-hive', feature_id: 'WI-OK-2' })).resolves.toBeDefined();
  });

  it('ALLOWS a legacy dogfood slug (canonicalized to the platform Pot)', async () => {
    await expect(insertItem({ workspace_id: WS, harness_slug: 'papercup', feature_id: 'WI-OK-3' })).resolves.toBeDefined();
  });

  it('REJECTS an operator/global scope label in the enforced workspace', async () => {
    await expect(
      insertItem({ workspace_id: WS, harness_slug: 'operator:papercusp-workspace', feature_id: 'WI-BAD-1' }),
    ).rejects.toThrow(/not a real Pot/i);
    await expect(insertItem({ workspace_id: WS, harness_slug: '@singleton', feature_id: 'WI-BAD-2' })).rejects.toThrow(
      /not a real Pot/i,
    );
    await expect(
      insertItem({ workspace_id: WS, harness_slug: 'papercusp-workspace', feature_id: 'WI-BAD-3' }),
    ).rejects.toThrow(/not a real Pot/i);
  });

  it('REJECTS a made-up Pot slug in the enforced workspace', async () => {
    await expect(insertItem({ workspace_id: WS, harness_slug: 'totally-made-up', feature_id: 'WI-BAD-4' })).rejects.toThrow(
      /not a real Pot/i,
    );
  });

  it('ALLOWS a federation replica (origin<>local) even under a non-pot slug', async () => {
    await expect(
      insertItem({ workspace_id: WS, harness_slug: 'operator:papercusp-workspace', feature_id: 'WI-REMOTE-1', origin: 'remote' }),
    ).resolves.toBeDefined();
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
