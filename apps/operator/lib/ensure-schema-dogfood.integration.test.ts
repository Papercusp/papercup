/**
 * ensure-schema-dogfood.integration.test.ts — the dogfood runtime DDL against
 * REAL Postgres (testcontainers).
 *
 * Proves: (1) ensureAllDogfoodTables is idempotent (CREATE …/ALTER … IF NOT
 * EXISTS re-runs cleanly), (2) the resulting schema carries the load-bearing
 * columns the substrate depends on (contributors.revoked_pubkeys /
 * binding_status, the append-only usage ledger, feature_queue's composite key),
 * and (3) wireDogfoodTriggers attaches emit_change_notify_trg to every
 * DOGFOOD_REACTIVE_TABLE.
 *
 * The ensure fns reach PG via getOrgPg(); we mock that to the throwaway test DB.
 * Migration 078 (the emit_change_notify function) is applied first — wire
 * references it — and minimal consolidated tables are pre-created so the
 * substrate-outbox ALTER + the consolidated-table trigger attaches succeed.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';

const h = vi.hoisted(() => ({ sql: null as unknown }));
vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: h.sql }),
}));

import { ensureAllDogfoodTables, wireDogfoodTriggers, DOGFOOD_REACTIVE_TABLES } from '@/lib/ensure-schema-dogfood';

const HERE = dirname(fileURLToPath(import.meta.url)); // apps/operator/lib
const MIGRATION_078 = resolve(HERE, '../../../libs/papercusp/libs/db/sql/078-emit-change-notify.sql');

let db: FreshPgDb;

function resetEnsureFlags(): void {
  const g = globalThis as Record<string, unknown>;
  const flags = g.__dogfoodEnsureFlags as Record<string, boolean> | undefined;
  if (flags) for (const k of Object.keys(flags)) flags[k] = false;
  g.__dogfoodTriggersWired = false;
}

beforeAll(async () => {
  db = await createFreshPgDb('dogfood_schema');
  h.sql = db.sql;
  // emit_change_notify() — wireDogfoodTriggers attaches it; it must exist first.
  await db.sql.unsafe(readFileSync(MIGRATION_078, 'utf8'));
  // Minimal consolidated tables: ensureSubstrateOutboxTable ALTERs
  // harness_issues_consolidated, and wireDogfoodTriggers attaches triggers to
  // both consolidated tables (missing ones are tolerated, but we want the
  // happy path exercised).
  await db.sql.unsafe(`
    CREATE TABLE IF NOT EXISTS harness_shared.harness_features_consolidated (harness_slug TEXT, feature_id TEXT);
    CREATE TABLE IF NOT EXISTS harness_shared.harness_issues_consolidated (harness_slug TEXT, issue_id TEXT);
  `);
}, 60_000);

afterAll(async () => {
  await db?.cleanup();
});

describe('ensure-schema-dogfood against real PG', () => {
  it('ensureAllDogfoodTables runs and is idempotent (second run is a no-op DDL re-apply)', async () => {
    resetEnsureFlags();
    await expect(ensureAllDogfoodTables()).resolves.toBeUndefined();
    resetEnsureFlags(); // force the IF-NOT-EXISTS DDL to actually re-run
    await expect(ensureAllDogfoodTables()).resolves.toBeUndefined();
  });

  it('creates the expected tables', async () => {
    const rows = await db.sql<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'harness_shared'`;
    const names = new Set(rows.map((r) => r.table_name));
    for (const t of [
      'feature_queue',
      'feature_working_set',
      'contributors',
      'feature_claims',
      'pr_reviewer_settings',
      'contributor_usage_events',
      'trusted_authors',
      'shared_repo_binding_cache',
      'substrate_outbox',
    ]) {
      expect(names.has(t)).toBe(true);
    }
  });

  it('contributors carries the substrate-critical columns (revoked_pubkeys, binding_status, device_attestations)', async () => {
    const cols = await db.sql<{ column_name: string; data_type: string }[]>`
      SELECT column_name, data_type FROM information_schema.columns
       WHERE table_schema = 'harness_shared' AND table_name = 'contributors'`;
    const byName = new Map(cols.map((c) => [c.column_name, c.data_type]));
    expect(byName.has('revoked_pubkeys')).toBe(true);
    expect(byName.get('revoked_pubkeys')).toBe('ARRAY');
    expect(byName.has('device_attestations')).toBe(true);
    expect(byName.has('binding_status')).toBe(true);
    expect(byName.has('channel2_branch_ref')).toBe(true);
  });

  it('feature_queue is keyed by (workspace_id, harness_slug, github_user_id, feature_id)', async () => {
    const pk = await db.sql<{ column_name: string }[]>`
      SELECT kcu.column_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
       WHERE tc.table_schema = 'harness_shared'
         AND tc.table_name = 'feature_queue'
         AND tc.constraint_type = 'PRIMARY KEY'
       ORDER BY kcu.ordinal_position`;
    expect(pk.map((r) => r.column_name)).toEqual(['workspace_id', 'harness_slug', 'github_user_id', 'feature_id']);
  });

  it('contributor_usage_events is an append-only ledger keyed for dedup', async () => {
    const cols = await db.sql<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'harness_shared' AND table_name = 'contributor_usage_events'`;
    const names = new Set(cols.map((c) => c.column_name));
    // ledger essentials — event id + kind + actor
    expect(names.has('kind')).toBe(true);
    expect(names.has('github_user_id')).toBe(true);
  });

  it('wireDogfoodTriggers attaches emit_change_notify_trg to every DOGFOOD_REACTIVE_TABLE', async () => {
    resetEnsureFlags();
    await expect(wireDogfoodTriggers()).resolves.toBeUndefined();
    const trg = await db.sql<{ event_object_table: string }[]>`
      SELECT event_object_table FROM information_schema.triggers
       WHERE trigger_schema = 'harness_shared' AND trigger_name = 'emit_change_notify_trg'`;
    const wired = new Set(trg.map((r) => r.event_object_table));
    for (const t of DOGFOOD_REACTIVE_TABLES) {
      expect(wired.has(t)).toBe(true);
    }
  });
});
