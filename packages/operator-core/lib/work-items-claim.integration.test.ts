/**
 * work-items-claim.integration.test.ts — the blackboard as a tuple-space (P3, D-004/D-007).
 *
 * Plan: fleet-as-supervised-blackboard-2026-06-04. Proves the claim primitives against
 * real Postgres:
 *   • claim (`in`) is an ATOMIC compare-and-claim — two competing claims on one item ⇒
 *     exactly one wins (the old code was last-write-wins, where both "won").
 *   • claim_next is the ASSOCIATIVE `in` via SELECT … FOR UPDATE SKIP LOCKED + oldest-first
 *     (work-stealing, D-007): competing consumers each grab a different, most-starved item.
 *   • observe (`rd`) reads claimability WITHOUT taking.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';
import { HARNESS_FEATURES_CONSOLIDATED_DDL, USER_TRUST_LIST_DDL, WORK_ITEM_DEPS_DDL } from '../test/_work-items-schema';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = resolve(__dirname, '../../../libs/papercusp/libs/db/sql');
const readMigration = (f: string) =>
  readFileSync(resolve(SQL_DIR, f), 'utf8')
    .split('\n')
    .filter((line) => !/^\s*\\/.test(line) && !/\bGRANT\b/.test(line) && !/^\s*(BEGIN|COMMIT);\s*$/.test(line))
    .join('\n');

// Canonical complete consolidated-features schema (single source of truth) — see
// test/_work-items-schema.ts (D-014 fixture-completeness debt).
const HFC_DDL = HARNESS_FEATURES_CONSOLIDATED_DDL;

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async () => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
vi.mock('./workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('./workspace-registry')>('./workspace-registry');
  return { ...actual, activeWorkspaceId: () => 'default' };
});

const wi = await import('./work-items');
const H = 'papercup';
let db: FreshPgDb;

async function seedFeature(id: string, opts: { createdTs?: number; kind?: string; status?: string; takenBy?: string | null } = {}) {
  await db.sql`
    INSERT INTO harness_shared.harness_features_consolidated
      (harness_slug, feature_id, item_kind, status, taken_by, workspace_id, created_ts, updated_ts)
    VALUES (${H}, ${id}, ${opts.kind ?? 'feature'}, ${opts.status ?? 'todo'}, ${opts.takenBy ?? null}, 'default', ${opts.createdTs ?? 0}, 0)`;
}

beforeAll(async () => {
  db = await createFreshPgDb('wi-claim');
  h.sql = db.sql;
  await db.sql.unsafe(HFC_DDL);
  await db.sql.unsafe(USER_TRUST_LIST_DDL); // claim path LEFT-JOINs the trust list (autoPickableWhereSql, migration 276)
  await db.sql.unsafe(WORK_ITEM_DEPS_DDL).simple(); // claim path's P-005 readiness clause reads work_item_deps
  // Per-assignee rank columns (local-hive P-020, migration 178 §1) — FEATURE_COLS/ISSUE_COLS select them.
  await db.sql.unsafe(`
    ALTER TABLE harness_shared.work_items
      ADD COLUMN IF NOT EXISTS assignee_rank integer, ADD COLUMN IF NOT EXISTS rank_writer text,
      ADD COLUMN IF NOT EXISTS rank_updated_at timestamptz;
    ALTER TABLE harness_shared.work_items
      ADD COLUMN IF NOT EXISTS assignee_rank integer, ADD COLUMN IF NOT EXISTS rank_writer text,
      ADD COLUMN IF NOT EXISTS rank_updated_at timestamptz,
      ADD COLUMN IF NOT EXISTS signal_origin text NOT NULL DEFAULT 'organic';`).simple();
}, 90_000);
afterAll(async () => { await db.cleanup(); });
beforeEach(async () => { await db.sql`TRUNCATE harness_shared.work_items`; });

describe('work_items claim — atomic `in` (D-004, real PG)', () => {
  it('two competing claims on one item ⇒ exactly one wins', async () => {
    await seedFeature('F-1');
    const [a, b] = await Promise.all([
      wi.claimWorkItem('F-1', 'agA', { harness: H }),
      wi.claimWorkItem('F-1', 'agB', { harness: H }),
    ]);
    const winners = [a, b].filter(Boolean);
    expect(winners).toHaveLength(1); // NOT both — atomic, not last-write-wins
    const row = await db.sql<{ taken_by: string }[]>`SELECT taken_by FROM harness_shared.harness_features_consolidated WHERE feature_id='F-1'`;
    expect(['agA', 'agB']).toContain(row[0].taken_by);
    expect(winners[0]!.assignee).toBe(row[0].taken_by);
  });

  it('claiming an item already held by someone else returns null (claim lost)', async () => {
    await seedFeature('F-2', { takenBy: 'agA' });
    expect(await wi.claimWorkItem('F-2', 'agB', { harness: H })).toBeNull();
    const row = await db.sql<{ taken_by: string }[]>`SELECT taken_by FROM harness_shared.harness_features_consolidated WHERE feature_id='F-2'`;
    expect(row[0].taken_by).toBe('agA'); // unchanged
  });

  it('re-claiming by the same assignee is idempotent', async () => {
    await seedFeature('F-3');
    expect((await wi.claimWorkItem('F-3', 'agA', { harness: H }))?.assignee).toBe('agA');
    expect((await wi.claimWorkItem('F-3', 'agA', { harness: H }))?.assignee).toBe('agA');
  });
});

describe('work_items claim_next — associative `in` + work-stealing (D-004/D-007, real PG)', () => {
  it('steals the OLDEST unclaimed item first', async () => {
    await seedFeature('F-old', { createdTs: 100 });
    await seedFeature('F-mid', { createdTs: 200 });
    await seedFeature('F-new', { createdTs: 300 });
    expect((await wi.claimNextWorkItem({ harness: H, assignee: 'w1' }))?.id).toBe('F-old');
    expect((await wi.claimNextWorkItem({ harness: H, assignee: 'w1' }))?.id).toBe('F-mid');
  });

  it('competing consumers (SKIP LOCKED) never double-claim', async () => {
    await seedFeature('F-a', { createdTs: 100 });
    await seedFeature('F-b', { createdTs: 200 });
    const [a, b] = await Promise.all([
      wi.claimNextWorkItem({ harness: H, assignee: 'w1' }),
      wi.claimNextWorkItem({ harness: H, assignee: 'w2' }),
    ]);
    const ids = [a?.id, b?.id].filter(Boolean).sort();
    expect(ids).toEqual(['F-a', 'F-b']); // two DISTINCT items, no overlap
  });

  it('returns null when nothing matches the template', async () => {
    await seedFeature('F-done', { status: 'done' });
    await seedFeature('F-taken', { takenBy: 'someone' });
    expect(await wi.claimNextWorkItem({ harness: H, assignee: 'w1' })).toBeNull();
  });

  it('respects the kind filter', async () => {
    await seedFeature('F-chunk', { kind: 'chunk', createdTs: 100 });
    await seedFeature('F-feat', { kind: 'feature', createdTs: 200 });
    expect((await wi.claimNextWorkItem({ harness: H, assignee: 'w1', kind: 'feature' }))?.id).toBe('F-feat');
  });
});

describe('work_items observe — `rd` (D-004, real PG)', () => {
  it('reads claimability without taking', async () => {
    await seedFeature('F-x');
    const obs1 = await wi.observeWorkItem('F-x', { harness: H });
    expect(obs1).toMatchObject({ available: true, claimedBy: null });
    // observe did NOT claim it.
    expect((await db.sql<{ taken_by: string | null }[]>`SELECT taken_by FROM harness_shared.harness_features_consolidated WHERE feature_id='F-x'`)[0].taken_by).toBeNull();

    await wi.claimWorkItem('F-x', 'agA', { harness: H });
    const obs2 = await wi.observeWorkItem('F-x', { harness: H });
    expect(obs2).toMatchObject({ available: false, claimedBy: 'agA' });
    expect(await wi.observeWorkItem('F-missing', { harness: H })).toBeNull();
  });
});
