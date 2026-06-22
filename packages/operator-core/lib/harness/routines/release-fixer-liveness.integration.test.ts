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
import type postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../../../test/_pg-helpers';
import { releaseFixerSpawnAlive, decideReleaseFixerDispatch } from './release-actions';

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

beforeAll(async () => {
  db = await createFreshPgDb();
  sql = db.sql;
  await sql.unsafe('CREATE SCHEMA IF NOT EXISTS harness_shared');
  await sql.unsafe(SPAWNED_DDL);
}, 120_000);

afterAll(async () => {
  await db?.cleanup();
});

beforeEach(async () => {
  await sql`TRUNCATE harness_shared.spawned_agents`;
});

async function seedSpawn(spawnId: string, status: string, heartbeatAgoMin: number | null): Promise<void> {
  await sql`
    INSERT INTO harness_shared.spawned_agents (spawn_id, session_owner, run_id, status, heartbeat_at)
    VALUES (${spawnId}, ${spawnId}, ${spawnId}, ${status},
            ${heartbeatAgoMin == null ? null : sql`now() - make_interval(mins => ${heartbeatAgoMin})`})`;
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

  it('a RUNNING fixer with a STALE heartbeat (crashed mid-run, beats stopped) is gone → re-dispatch', async () => {
    await seedSpawn('s-fixer-stale', 'running', 30); // > 10-min STALE_MS window
    expect(await releaseFixerSpawnAlive(sql, 's-fixer-stale')).toBe(false);
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
