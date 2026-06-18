/**
 * work-items-stale-claims.integration.test.ts — the dead-holder claim sweep
 * (owner-reported gap 2026-06-11) against real Postgres. Liveness must match
 * the mig-225 alias-aware rule exactly: coord_presence heartbeat OR a
 * RUNNING/RESTARTING spawned_agents row matched on ANY alias.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';
import { HARNESS_FEATURES_CONSOLIDATED_DDL } from '../test/_work-items-schema';
import { reclaimStaleWorkItemClaims } from './work-items-stale-claims';

const PRESENCE_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.coord_presence (
    owner_id text PRIMARY KEY,
    heartbeat_at timestamptz
  )`;
const SPAWNED_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.spawned_agents (
    spawn_id text PRIMARY KEY,
    session_owner text,
    run_id text,
    status text NOT NULL,
    heartbeat_at timestamptz
  )`;

let db: FreshPgDb;
let sql: postgres.Sql;
const WS = 'default';
const H = 'papercup';

beforeAll(async () => {
  db = await createFreshPgDb();
  sql = db.sql;
  await sql.unsafe('CREATE SCHEMA IF NOT EXISTS harness_shared');
  await sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
  await sql.unsafe(PRESENCE_DDL);
  await sql.unsafe(SPAWNED_DDL);
}, 120_000);

afterAll(async () => {
  await db?.cleanup();
});

beforeEach(async () => {
  await sql`TRUNCATE harness_shared.harness_features_consolidated, harness_shared.coord_presence, harness_shared.spawned_agents`;
});

async function seedItem(
  featureId: string,
  takenBy: string | null,
  takenAgoMin: number,
  status = 'todo',
  requeueCount = 0,
): Promise<void> {
  await sql`
    INSERT INTO harness_shared.harness_features_consolidated
      (workspace_id, harness_slug, feature_id, item_kind, title, status, requeue_count, taken_by, taken_at, created_ts, updated_ts)
    VALUES
      (${WS}, ${H}, ${featureId}, 'feature', ${featureId}, ${status}, ${requeueCount}, ${takenBy},
       ${takenBy ? sql`now() - make_interval(mins => ${takenAgoMin})` : null},
       ${Date.now()}, ${Date.now()})`;
}

async function statusOf(featureId: string): Promise<{ status: string; requeue_count: number; taken_by: string | null }> {
  const [row] = await sql<{ status: string; requeue_count: number; taken_by: string | null }[]>`
    SELECT status, requeue_count, taken_by
      FROM harness_shared.harness_features_consolidated WHERE feature_id = ${featureId}`;
  return row;
}

describe('reclaimStaleWorkItemClaims', () => {
  it('releases a claim whose holder has no presence and no nursery row (the dead-bee case)', async () => {
    await seedItem('F-001', 'opspawn-dead-123', 30);
    const r = await reclaimStaleWorkItemClaims(sql);
    expect(r.released).toHaveLength(1);
    expect(r.released[0]).toMatchObject({
      feature_id: 'F-001',
      former_taken_by: 'opspawn-dead-123',
      former_status: 'todo',
      new_status: 'todo',
      action: 'freed-todo',
    });
    const [row] = await sql<{ taken_by: string | null }[]>`
      SELECT taken_by FROM harness_shared.harness_features_consolidated WHERE feature_id = 'F-001'`;
    expect(row.taken_by).toBeNull();
  });

  it('a holder with a FRESH presence heartbeat is alive — claim kept', async () => {
    await seedItem('F-002', 'su-alive-1', 30);
    await sql`INSERT INTO harness_shared.coord_presence VALUES ('su-alive-1', now())`;
    const r = await reclaimStaleWorkItemClaims(sql);
    expect(r.released).toHaveLength(0);
  });

  it('a holder matching a RUNNING nursery row on ANY alias is alive (mig-225 rule)', async () => {
    // taken_by = the RUN ID alias (the EI-311 degraded-bee case), not the spawn_id.
    await seedItem('F-003', 'opspawn-1786-abc', 30);
    await sql`
      INSERT INTO harness_shared.spawned_agents VALUES
        ('s-xyz', 's-xyz', 'opspawn-1786-abc', 'running', now())`;
    const r = await reclaimStaleWorkItemClaims(sql);
    expect(r.released).toHaveLength(0);
  });

  it('a nursery row that is NOT running does not confer liveness — claim released', async () => {
    await seedItem('F-004', 's-finished', 30);
    await sql`
      INSERT INTO harness_shared.spawned_agents VALUES
        ('s-finished', 's-finished', 'opspawn-x', 'failed', now())`;
    const r = await reclaimStaleWorkItemClaims(sql);
    expect(r.released.map((c) => c.feature_id)).toEqual(['F-004']);
  });

  it('a stale-heartbeat presence row does not confer liveness — claim released', async () => {
    await seedItem('F-005', 'su-stale', 30);
    await sql`INSERT INTO harness_shared.coord_presence VALUES ('su-stale', now() - interval '1 hour')`;
    const r = await reclaimStaleWorkItemClaims(sql);
    expect(r.released.map((c) => c.feature_id)).toEqual(['F-005']);
  });

  it('claims inside the grace window are NEVER touched, even with a dead holder', async () => {
    await seedItem('F-006', 'opspawn-justdied', 2); // 2 min < 10 min grace
    const r = await reclaimStaleWorkItemClaims(sql);
    expect(r.released).toHaveLength(0);
  });

  it('a mid-flight (in_progress) row is REQUEUED → todo and re-enters the pool (GAP 1, P-001)', async () => {
    await seedItem('F-007', 'opspawn-dead-mid', 30, 'in_progress');
    const r = await reclaimStaleWorkItemClaims(sql);
    expect(r.released[0]).toMatchObject({
      feature_id: 'F-007',
      former_status: 'in_progress',
      new_status: 'todo',
      action: 'requeued',
      requeue_count: 1,
    });
    expect(await statusOf('F-007')).toMatchObject({ status: 'todo', requeue_count: 1, taken_by: null });
  });

  it('a `validating` row is also requeued (any non-terminal, non-blocked state)', async () => {
    await seedItem('F-007b', 'opspawn-dead-val', 30, 'validating');
    const r = await reclaimStaleWorkItemClaims(sql);
    expect(r.released[0]).toMatchObject({ former_status: 'validating', new_status: 'todo', action: 'requeued' });
  });

  it('the requeue counter increments each sweep until the cap, then DEAD-LETTERS to blocked (P-002, D-007)', async () => {
    // Seed already at cap-1 (default cap 3 → requeue_count 2): the next reclaim is
    // the 3rd, which exhausts the cap and parks the poison item in `blocked`.
    await seedItem('F-010', 'opspawn-dead-poison', 30, 'in_progress', 2);
    const r = await reclaimStaleWorkItemClaims(sql);
    expect(r.released[0]).toMatchObject({
      feature_id: 'F-010',
      former_status: 'in_progress',
      new_status: 'blocked',
      action: 'dead-lettered',
      requeue_count: 3,
    });
    expect(await statusOf('F-010')).toMatchObject({ status: 'blocked', requeue_count: 3 });
  });

  it('honors a custom requeueCap option', async () => {
    await seedItem('F-011', 'opspawn-dead-cap1', 30, 'in_progress', 0);
    const r = await reclaimStaleWorkItemClaims(sql, { requeueCap: 1 });
    // cap 1 → first reclaim already exhausts it.
    expect(r.released[0]).toMatchObject({ new_status: 'blocked', action: 'dead-lettered', requeue_count: 1 });
  });

  it('a TERMINAL (passed) row is freed but NOT requeued or re-broadcast (the F-FIX-038 fix)', async () => {
    await seedItem('F-012', 'opspawn-dead-done', 30, 'passed', 0);
    const r = await reclaimStaleWorkItemClaims(sql);
    expect(r.released[0]).toMatchObject({ former_status: 'passed', new_status: 'passed', action: 'freed-terminal' });
    expect(await statusOf('F-012')).toMatchObject({ status: 'passed', taken_by: null });
  });

  it('a `deprecated` row is freed but kept terminal', async () => {
    await seedItem('F-012b', 'opspawn-dead-dep', 30, 'deprecated', 0);
    const r = await reclaimStaleWorkItemClaims(sql);
    expect(r.released[0]).toMatchObject({ former_status: 'deprecated', new_status: 'deprecated', action: 'freed-terminal' });
  });

  it('a `blocked` row is freed but kept blocked (its own delegator-notify signal path)', async () => {
    await seedItem('F-013', 'opspawn-dead-blk', 30, 'blocked', 1);
    const r = await reclaimStaleWorkItemClaims(sql);
    expect(r.released[0]).toMatchObject({ former_status: 'blocked', new_status: 'blocked', action: 'freed-blocked' });
    // requeue_count untouched for a blocked freed row.
    expect(await statusOf('F-013')).toMatchObject({ status: 'blocked', requeue_count: 1, taken_by: null });
  });

  it('untaken rows are ignored', async () => {
    await seedItem('F-008', null, 0);
    const r = await reclaimStaleWorkItemClaims(sql);
    expect(r.released).toHaveLength(0);
  });

  it('the freed item is immediately claimable again by a live agent', async () => {
    await seedItem('F-009', 'opspawn-dead-9', 30);
    await reclaimStaleWorkItemClaims(sql);
    const updated = await sql<{ feature_id: string }[]>`
      UPDATE harness_shared.harness_features_consolidated
         SET taken_by = 'opspawn-new-bee', taken_at = now()
       WHERE feature_id = 'F-009' AND (taken_by IS NULL OR taken_by = '')
       RETURNING feature_id`;
    expect(updated).toHaveLength(1);
  });
});
