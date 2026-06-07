/**
 * spawn-reclaim.integration.test.ts — orphaned-spawn reclaim (P-011, real PG).
 *
 * Plan: unify-agent-spawn-chokepoint-2026-06-06. A 'running'/'restarting'
 * spawned_agents row whose launching host died (heartbeat went stale) is
 * reclaimed to 'failed' so it stops counting against the concurrency ceiling; a
 * freshly-heartbeated row is left alone; terminal rows are never touched.
 * heartbeatSpawns bumps the lease for live spawns.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import { reclaimOrphanedSpawns, heartbeatSpawns } from './spawn-reclaim';

const SPAWNED_AGENTS_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.spawned_agents (
    spawn_id text PRIMARY KEY, workspace_id text NOT NULL, harness_slug text,
    parent_spawn_id text, parent_role text, child_role text NOT NULL,
    feature_id text, chunk_id text, run_id text,
    status text NOT NULL DEFAULT 'running', started_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz, duration_ms bigint, exit_code int, output_tail text, error_message text,
    cancel_requested boolean NOT NULL DEFAULT false, session_owner text,
    coordination_domain text NOT NULL DEFAULT 'default', plan_slug text, item_id text,
    restart_strategy text NOT NULL DEFAULT 'one_for_one', restart_count int NOT NULL DEFAULT 0,
    restart_window_start timestamptz, cancel_reason text, cancelled_at timestamptz,
    heartbeat_at timestamptz NOT NULL DEFAULT now())`;

const WS = 'default';
const STALE = { staleMs: 5 * 60_000 };
let db: FreshPgDb;

/** Insert a spawn row with an explicit heartbeat age (seconds ago) + status. */
async function insertSpawn(spawnId: string, status: string, heartbeatAgoSec: number) {
  await db.sql`
    INSERT INTO harness_shared.spawned_agents
      (spawn_id, workspace_id, harness_slug, child_role, run_id, status, started_at, heartbeat_at)
    VALUES (${spawnId}, ${WS}, 'papercup', 'worker', ${'r-' + spawnId}, ${status},
            now() - interval '10 minutes', now() - ${heartbeatAgoSec}::int * interval '1 second')`;
}

async function statusOf(spawnId: string): Promise<string> {
  const rows = await db.sql<{ status: string }[]>`
    SELECT status FROM harness_shared.spawned_agents WHERE spawn_id = ${spawnId}`;
  return rows[0]?.status ?? '(none)';
}

async function runningCount(): Promise<number> {
  const rows = await db.sql<{ n: string }[]>`
    SELECT count(*)::text AS n FROM harness_shared.spawned_agents
     WHERE workspace_id = ${WS} AND status IN ('running', 'restarting')`;
  return Number(rows[0]?.n ?? 0);
}

beforeAll(async () => {
  db = await createFreshPgDb('spawn-reclaim');
  await db.sql.unsafe(SPAWNED_AGENTS_DDL);
}, 90_000);
afterAll(async () => { await db.cleanup(); });
beforeEach(async () => { await db.sql`TRUNCATE harness_shared.spawned_agents`; });

describe('reclaimOrphanedSpawns (P-011, real PG)', () => {
  it('reclaims a running row whose heartbeat is stale beyond the threshold', async () => {
    await insertSpawn('stale', 'running', 10 * 60); // 10 min stale
    const r = await reclaimOrphanedSpawns(db.sql, STALE);
    expect(r.reclaimed).toBe(1);
    expect(r.spawnIds).toEqual(['stale']);
    // The freed workspace rides the result so callers announce the slot-free
    // (spawn-slot:freed:<ws>) to over-ceiling waiters (D-004).
    expect(r.workspaces).toEqual([WS]);
    expect(await statusOf('stale')).toBe('failed');
    const [row] = await db.sql<{ error_message: string; finished_at: Date | null; duration_ms: number | null }[]>`
      SELECT error_message, finished_at, duration_ms FROM harness_shared.spawned_agents WHERE spawn_id = 'stale'`;
    expect(row.error_message).toMatch(/reclaimed: spawn heartbeat stale/);
    expect(row.finished_at).not.toBeNull();
    expect(Number(row.duration_ms)).toBeGreaterThan(0);
  });

  it('frees the concurrency ceiling: a stale running row stops counting after reclaim', async () => {
    await insertSpawn('stale', 'running', 10 * 60);
    await insertSpawn('live', 'running', 5);
    expect(await runningCount()).toBe(2);
    await reclaimOrphanedSpawns(db.sql, STALE);
    expect(await runningCount()).toBe(1); // only the live one still holds a slot
  });

  it('leaves a freshly-heartbeated running row alone', async () => {
    await insertSpawn('fresh', 'running', 5);
    const r = await reclaimOrphanedSpawns(db.sql, STALE);
    expect(r.reclaimed).toBe(0);
    expect(r.workspaces).toEqual([]); // nothing freed → nothing to announce
    expect(await statusOf('fresh')).toBe('running');
  });

  it('never touches terminal rows (idempotent)', async () => {
    await insertSpawn('done', 'done', 10 * 60);
    await insertSpawn('failedRow', 'failed', 10 * 60);
    const r = await reclaimOrphanedSpawns(db.sql, STALE);
    expect(r.reclaimed).toBe(0);
    expect(await statusOf('done')).toBe('done');
    expect(await statusOf('failedRow')).toBe('failed');
  });

  it('reclaims restarting rows too (they also hold a slot)', async () => {
    await insertSpawn('restarting', 'restarting', 10 * 60);
    const r = await reclaimOrphanedSpawns(db.sql, STALE);
    expect(r.reclaimed).toBe(1);
    expect(await statusOf('restarting')).toBe('failed');
  });
});

describe('heartbeatSpawns keeps a live spawn out of reclaim range', () => {
  it('bumps heartbeat_at for active rows so a subsequent reclaim skips them', async () => {
    await insertSpawn('live', 'running', 10 * 60); // would be stale
    await heartbeatSpawns(db.sql, ['live']);       // ...but the host heartbeats it
    const r = await reclaimOrphanedSpawns(db.sql, STALE);
    expect(r.reclaimed).toBe(0);
    expect(await statusOf('live')).toBe('running');
  });

  it('is a no-op for an empty list and never resurrects a terminal row', async () => {
    await insertSpawn('terminal', 'done', 10 * 60);
    await heartbeatSpawns(db.sql, []);             // no-op
    await heartbeatSpawns(db.sql, ['terminal']);   // WHERE excludes terminal
    expect(await statusOf('terminal')).toBe('done');
  });
});
