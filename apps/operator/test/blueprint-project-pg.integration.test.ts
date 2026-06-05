/**
 * P-002 (PG half) — real-Postgres coverage for the blueprint projection cache
 * (`harness_shared.blueprints`). Exercises projectBlueprintToPg / readBlueprintFromPg
 * / getEffectiveBlueprint against a throwaway testcontainer DB.
 *
 * The full migration 133 (RLS + grants, compose-onto-baseline) is covered by
 * fresh-migrate.integration.test.ts, which applies every sql/ migration empty→head;
 * here we create just the table so the projection LOGIC is what's under test.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { getTestPg } from '@papercusp/test-config';
import { loadBuiltinBlueprint } from '@papercusp/orchestrator/blueprint';
import {
  projectBlueprintToPg,
  readBlueprintFromPg,
  readBlueprintHashFromPg,
} from '@papercusp/operator-core/lib/blueprint/project-to-pg';

let adminUri: string;
let dbName: string;
let sql: postgres.Sql;

const WS = 'ws_test';

beforeAll(async () => {
  adminUri = await getTestPg();
  dbName = `bp_${randomBytes(5).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const u = new URL(adminUri);
  u.pathname = `/${dbName}`;
  sql = postgres(u.toString(), { max: 4, onnotice: () => {} });
  await sql.unsafe('CREATE SCHEMA IF NOT EXISTS harness_shared');
  // Table shape mirrors migration 133 (sans RLS/grants — those are exercised by
  // fresh-migrate.integration.test.ts).
  await sql.unsafe(`
    CREATE TABLE harness_shared.blueprints (
      workspace_id  text NOT NULL,
      harness_slug  text NOT NULL,
      blueprint_id  text NOT NULL,
      version       text NOT NULL DEFAULT '0.1.0',
      resolved      jsonb NOT NULL,
      content_hash  text NOT NULL,
      source_path   text,
      source_commit text,
      projected_at  timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (workspace_id, harness_slug)
    )
  `);
}, 60_000);

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

it('projects + reads back the resolved coding blueprint', async () => {
  const loaded = loadBuiltinBlueprint('coding');
  const { contentHash } = await projectBlueprintToPg(sql, {
    workspaceId: WS,
    harnessSlug: 'demo',
    blueprint: loaded.blueprint,
    contentHash: loaded.contentHash,
    sourcePath: '.papercusp/blueprint.yaml',
  });
  expect(contentHash).toBe(loaded.contentHash);

  const read = await readBlueprintFromPg(sql, WS, 'demo');
  expect(read).not.toBeNull();
  expect(read!.id).toBe('coding');
  // The round-tripped (jsonb → schema-parse) blueprint equals the loaded one.
  expect(read).toEqual(loaded.blueprint);
  expect(await readBlueprintHashFromPg(sql, WS, 'demo')).toBe(loaded.contentHash);
});

it('upsert overwrites the same (workspace, harness) row', async () => {
  const coding = loadBuiltinBlueprint('coding').blueprint;
  await projectBlueprintToPg(sql, { workspaceId: WS, harnessSlug: 'up', blueprint: coding });
  // Re-project a mutated version → row is replaced, not duplicated.
  const bumped = { ...coding, version: '9.9.9' };
  await projectBlueprintToPg(sql, { workspaceId: WS, harnessSlug: 'up', blueprint: bumped });

  const rows = await sql`SELECT version FROM harness_shared.blueprints WHERE workspace_id=${WS} AND harness_slug='up'`;
  expect(rows.length).toBe(1);
  expect(rows[0].version).toBe('9.9.9');
});

it('reads are isolated by (workspace, harness)', async () => {
  const coding = loadBuiltinBlueprint('coding').blueprint;
  await projectBlueprintToPg(sql, { workspaceId: 'ws_a', harnessSlug: 'shared-slug', blueprint: coding });
  expect(await readBlueprintFromPg(sql, 'ws_b', 'shared-slug')).toBeNull();
  expect(await readBlueprintFromPg(sql, 'ws_a', 'shared-slug')).not.toBeNull();
});
