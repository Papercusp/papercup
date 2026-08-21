/**
 * release-fixer-liveness.integration.test.ts — the IMPURE half of the P-014 / D-009
 * self-heal: does releaseFixerSpawnAlive correctly read a dispatched fixer's
 * liveness off spawned_agents (the same status + STALE_MS heartbeat rule the
 * fleet_assignment view + the stale-claim reconciler use)? Paired with the pure
 * decideReleaseFixerDispatch unit tests, this proves the full chain that fixes the
 * 2026-06-21 incident: a DEAD fixer → fixerAlive=false → re-dispatch; a LIVE fixer
 * → fixerAlive=true → skip.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hostname } from 'node:os';
import type postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../../../test/_pg-helpers';
import { launcherBootId } from '../../fleet/spawn-reclaim';
import { releaseFixerSpawnAlive, decideReleaseFixerDispatch } from './release-actions';

const SPAWNED_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.spawned_agents (
    spawn_id text PRIMARY KEY,
    workspace_id text NOT NULL,
    session_owner text,
    run_id text,
    status text NOT NULL,
    started_at timestamptz NOT NULL DEFAULT now(),
    heartbeat_at timestamptz,
    pid integer,
    launcher_host text,
    launcher_boot_id text
  )`;

const TASK_LEDGER_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.task_ledger (
    task_id text PRIMARY KEY,
    workspace_id text NOT NULL,
    class text NOT NULL,
    launched_by text NOT NULL,
    state text NOT NULL,
    last_seen_at timestamptz NOT NULL,
    detail jsonb NOT NULL DEFAULT '{}'::jsonb
  )`;

let db: FreshPgDb;
let sql: postgres.Sql;

beforeAll(async () => {
  db = await createFreshPgDb();
  sql = db.sql;
  await sql.unsafe('CREATE SCHEMA IF NOT EXISTS harness_shared');
  await sql.unsafe(SPAWNED_DDL);
  await sql.unsafe(TASK_LEDGER_DDL);
}, 120_000);

afterAll(async () => {
  await db?.cleanup();
});

beforeEach(async () => {
  await sql`TRUNCATE harness_shared.spawned_agents, harness_shared.task_ledger`;
});

async function seedSpawn(
  spawnId: string,
  status: string,
  heartbeatAgoMin: number | null,
  identity: { pid?: number | null; launcherHost?: string | null; launcherBootId?: string | null } = {},
): Promise<void> {
  await sql`
    INSERT INTO harness_shared.spawned_agents
      (spawn_id, workspace_id, session_owner, run_id, status, heartbeat_at, pid, launcher_host, launcher_boot_id)
    VALUES (${spawnId}, 'papercusp-workspace', ${spawnId}, ${spawnId}, ${status},
            ${heartbeatAgoMin == null ? null : sql`now() - make_interval(mins => ${heartbeatAgoMin})`},
            ${identity.pid ?? null}, ${identity.launcherHost ?? null}, ${identity.launcherBootId ?? null})`;
}

async function seedTaskScope(
  spawnId: string,
  state: string,
  lastSeenAgoMin = 0,
): Promise<void> {
  await sql`
    INSERT INTO harness_shared.task_ledger
      (task_id, workspace_id, class, launched_by, state, last_seen_at, detail)
    VALUES (${`task-${spawnId}`}, 'papercusp-workspace', 'agent-session',
            'orchestrator:release-fixer', ${state},
            now() - make_interval(mins => ${lastSeenAgoMin}),
            jsonb_build_object('spawnRecordId', ${spawnId}::text))`;
}

describe('releaseFixerSpawnAlive (P-014 / D-009 — the liveness-detection half)', () => {
  it('a RUNNING fixer with a fresh heartbeat is ALIVE → covered (skip re-dispatch)', async () => {
    await seedSpawn('s-fixer-live', 'running', 1);
    expect(await releaseFixerSpawnAlive(sql, 's-fixer-live')).toBe(true);
  });

  it('a fixer whose spawn FAILED is gone → re-dispatch (the incident: a dead fixer)', async () => {
    await seedSpawn('s-fixer-dead', 'failed', 1);
    expect(await releaseFixerSpawnAlive(sql, 's-fixer-dead')).toBe(false);
  });

  it('a terminal spawn row with a live correlated task scope remains covered', async () => {
    await seedSpawn('s-fixer-handed-off', 'failed', 30, {
      launcherHost: hostname(),
      launcherBootId: launcherBootId(),
      pid: 999_999_999,
    });
    await seedTaskScope('s-fixer-handed-off', 'running');

    expect(await releaseFixerSpawnAlive(sql, 's-fixer-handed-off')).toBe(true);
  });

  it('a correlated scope stops covering once the task reconciler closes it', async () => {
    await seedSpawn('s-fixer-scope-ended', 'failed', 30);
    await seedTaskScope('s-fixer-scope-ended', 'exited');

    expect(await releaseFixerSpawnAlive(sql, 's-fixer-scope-ended')).toBe(false);
  });

  it('a stale correlated task row does not keep a dead fixer covered', async () => {
    await seedSpawn('s-fixer-scope-stale', 'failed', 30);
    await seedTaskScope('s-fixer-scope-stale', 'running', 30);

    expect(await releaseFixerSpawnAlive(sql, 's-fixer-scope-stale')).toBe(false);
  });

  it('a RUNNING fixer with a STALE heartbeat (crashed mid-run, beats stopped) is gone → re-dispatch', async () => {
    await seedSpawn('s-fixer-stale', 'running', 30); // > 10-min STALE_MS window
    expect(await releaseFixerSpawnAlive(sql, 's-fixer-stale')).toBe(false);
  });

  it('a same-host fixer from a prior launcher boot is gone even with a fresh heartbeat and no PID', async () => {
    await seedSpawn('s-fixer-prior-boot', 'running', 1, {
      launcherHost: hostname(),
      launcherBootId: 'prior-launcher-boot',
      pid: null,
    });
    expect(await releaseFixerSpawnAlive(sql, 's-fixer-prior-boot')).toBe(false);
  });

  it('a same-host fixer with a recorded but absent PID is gone', async () => {
    await seedSpawn('s-fixer-absent-pid', 'running', 1, {
      launcherHost: hostname(),
      launcherBootId: launcherBootId(),
      pid: 999_999_999,
    });
    expect(await releaseFixerSpawnAlive(sql, 's-fixer-absent-pid')).toBe(false);
  });

  it('a COMPLETED (done) fixer is no longer covering the gate → re-dispatch', async () => {
    await seedSpawn('s-fixer-done', 'done', 1);
    expect(await releaseFixerSpawnAlive(sql, 's-fixer-done')).toBe(false);
  });

  it('a missing spawn row → not alive → re-dispatch', async () => {
    expect(await releaseFixerSpawnAlive(sql, 's-never-recorded')).toBe(false);
  });

  it('no spawn id (DBOS-durable fire / legacy record) → null (unknown → presumed covered)', async () => {
    expect(await releaseFixerSpawnAlive(sql, null)).toBeNull();
    expect(await releaseFixerSpawnAlive(sql, undefined)).toBeNull();
  });

  it('end-to-end: a DEAD fixer spawn drives decideReleaseFixerDispatch to RE-DISPATCH', async () => {
    const now = Date.now();
    await seedSpawn('s-fixer-x', 'failed', 1);
    const fixerAlive = await releaseFixerSpawnAlive(sql, 's-fixer-x');
    const d = decideReleaseFixerDispatch({
      lf: { signature: 'sig', at: now - 30 * 60_000, spawnId: 's-fixer-x' },
      signature: 'sig',
      now,
      fixerAlive,
    });
    expect(d).toMatchObject({ dispatch: true, reason: 'self-heal' });
  });

  it('end-to-end: a LIVE fixer spawn drives decideReleaseFixerDispatch to SKIP', async () => {
    const now = Date.now();
    await seedSpawn('s-fixer-y', 'running', 1);
    const fixerAlive = await releaseFixerSpawnAlive(sql, 's-fixer-y');
    const d = decideReleaseFixerDispatch({
      lf: { signature: 'sig', at: now - 30 * 60_000, spawnId: 's-fixer-y' },
      signature: 'sig',
      now,
      fixerAlive,
    });
    expect(d).toMatchObject({ dispatch: false, reason: 'covered' });
  });
});
