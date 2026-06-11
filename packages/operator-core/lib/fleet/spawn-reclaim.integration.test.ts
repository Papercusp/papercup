/**
 * spawn-reclaim.integration.test.ts — orphaned-spawn reclaim (P-011, real PG).
 *
 * Plan: unify-agent-spawn-chokepoint-2026-06-06. A 'running'/'restarting'
 * spawned_agents row whose launching host died (heartbeat went stale) is
 * reclaimed to 'failed' so it stops counting against the concurrency ceiling; a
 * freshly-heartbeated row is left alone; terminal rows are never touched.
 * heartbeatSpawns bumps the lease for live spawns.
 */
import { hostname } from 'node:os';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import { reclaimOrphanedSpawns, heartbeatSpawns, recordSpawnPid, isSpawnProcessAlive } from './spawn-reclaim';

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
    heartbeat_at timestamptz NOT NULL DEFAULT now(),
    pid integer, launcher_host text)`;

const WS = 'default';
const STALE = { staleMs: 5 * 60_000 };
// EI-85: same-host candidates whose pid is alive are kept; everything else is
// reclaimed. The OS liveness check is injected so the alive/dead branches are
// deterministic — `alivePids` decides which recorded pids read as alive.
const alivePids = new Set<number>();
const fakeAlive = (pid: number) => alivePids.has(pid);
const STALE_FAKE = { ...STALE, isAlive: fakeAlive };
let db: FreshPgDb;

/** Insert a spawn row with an explicit heartbeat age (seconds ago) + status,
 *  optionally with a recorded pid + launcher host (EI-85). */
async function insertSpawn(
  spawnId: string,
  status: string,
  heartbeatAgoSec: number,
  rec: { pid?: number; host?: string } = {},
) {
  await db.sql`
    INSERT INTO harness_shared.spawned_agents
      (spawn_id, workspace_id, harness_slug, child_role, run_id, status, started_at, heartbeat_at, pid, launcher_host)
    VALUES (${spawnId}, ${WS}, 'papercup', 'worker', ${'r-' + spawnId}, ${status},
            now() - interval '10 minutes', now() - ${heartbeatAgoSec}::int * interval '1 second',
            ${rec.pid ?? null}, ${rec.host ?? null})`;
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
beforeEach(async () => { await db.sql`TRUNCATE harness_shared.spawned_agents`; alivePids.clear(); });

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

describe('reclaimOrphanedSpawns liveness gate (EI-85: host-died vs child-died)', () => {
  const ME = hostname();

  it('a stale same-host row whose child is ALIVE is NOT reclaimed — its heartbeat is bumped', async () => {
    await insertSpawn('survivor', 'running', 10 * 60, { pid: 4242, host: ME });
    alivePids.add(4242); // /proc says the child is still running (host was only paused)
    const r = await reclaimOrphanedSpawns(db.sql, STALE_FAKE);
    expect(r.reclaimed).toBe(0);
    expect(await statusOf('survivor')).toBe('running');
    // Heartbeat bumped so the next sweep also skips it (no longer stale).
    const [row] = await db.sql<{ stale_now: boolean }[]>`
      SELECT heartbeat_at > now() - interval '30 seconds' AS stale_now
        FROM harness_shared.spawned_agents WHERE spawn_id = 'survivor'`;
    expect(row.stale_now).toBe(true);
  });

  it('a stale same-host row whose child is DEAD is reclaimed with a "confirmed dead" reason', async () => {
    await insertSpawn('killed', 'running', 10 * 60, { pid: 9999, host: ME });
    // 9999 not in alivePids → child confirmed dead.
    const r = await reclaimOrphanedSpawns(db.sql, STALE_FAKE);
    expect(r.reclaimed).toBe(1);
    expect(await statusOf('killed')).toBe('failed');
    const [row] = await db.sql<{ error_message: string }[]>`
      SELECT error_message FROM harness_shared.spawned_agents WHERE spawn_id = 'killed'`;
    expect(row.error_message).toMatch(/child process \(pid 9999\) confirmed dead/);
  });

  it('a DIFFERENT-host stale row can\'t be liveness-checked → reclaimed as host-presumed-dead', async () => {
    await insertSpawn('remote', 'running', 10 * 60, { pid: 4242, host: 'some-other-box' });
    alivePids.add(4242); // even though THIS pid is alive locally, it's another host's row
    const r = await reclaimOrphanedSpawns(db.sql, STALE_FAKE);
    expect(r.reclaimed).toBe(1);
    const [row] = await db.sql<{ error_message: string }[]>`
      SELECT error_message FROM harness_shared.spawned_agents WHERE spawn_id = 'remote'`;
    expect(row.error_message).toMatch(/heartbeat stale .* host presumed dead/);
  });

  it('mixed batch: keeps the live survivor, reclaims the dead + the pid-less legacy row', async () => {
    await insertSpawn('alive', 'running', 10 * 60, { pid: 100, host: ME });
    await insertSpawn('dead', 'running', 10 * 60, { pid: 200, host: ME });
    await insertSpawn('legacy', 'running', 10 * 60); // predates pid recording (NULL pid)
    alivePids.add(100);
    const r = await reclaimOrphanedSpawns(db.sql, STALE_FAKE);
    expect(r.reclaimed).toBe(2);
    expect(r.spawnIds.sort()).toEqual(['dead', 'legacy']);
    expect(await statusOf('alive')).toBe('running');
  });
});

describe('recordSpawnPid + isSpawnProcessAlive (EI-85)', () => {
  it('records the pid + this host on an active row only', async () => {
    await insertSpawn('a', 'running', 5);
    await insertSpawn('term', 'done', 5);
    await recordSpawnPid(db.sql, 'a', 31337);
    await recordSpawnPid(db.sql, 'term', 31338); // terminal → WHERE excludes it
    const rows = await db.sql<{ spawn_id: string; pid: number | null; launcher_host: string | null }[]>`
      SELECT spawn_id, pid, launcher_host FROM harness_shared.spawned_agents ORDER BY spawn_id`;
    const a = rows.find((r) => r.spawn_id === 'a')!;
    expect(a.pid).toBe(31337);
    expect(a.launcher_host).toBe(hostname());
    expect(rows.find((r) => r.spawn_id === 'term')!.pid).toBeNull();
  });

  it('isSpawnProcessAlive: a bogus pid reads as dead (never a false alive)', () => {
    // pid 1 is guarded out; a very high pid almost certainly does not exist, and
    // even if it did its cmdline would not name invoke-once.
    expect(isSpawnProcessAlive(1)).toBe(false);
    expect(isSpawnProcessAlive(2_147_480_000)).toBe(false);
    expect(isSpawnProcessAlive(-5)).toBe(false);
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
