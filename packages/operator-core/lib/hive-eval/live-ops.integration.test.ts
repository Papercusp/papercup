/**
 * Integration test for the LIVE-ops DB READS (P-063 / D-011) — proves the SQL the live binding runs
 * against a throwaway hive's real tables is correct: the spawn-row mapping (bigint duration +
 * timestamptz → epoch ms + null handling), the HFC run-stats (total + `passed` completion count), and
 * the in-flight placement predicate (only non-terminal `hive_placements`). No LLM, no hive boot:
 * synthetic rows in minimal stub tables (the exact columns the reads query, verified against
 * 000-baseline.sql / 263-hive-placements.sql) — the same boundary b459e's ground-truth-live test drew.
 *
 * The lifecycle WRITE ops (createHive/registerMember/startHive) + the real Queen drive are owner-gated
 * (P-051) and validated at the first armed run; these reads are the part that CAN be verified now.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { getTestPg } from '@papercusp/test-config';
import { readMemberSpawnRows, readMemberRunStats, countHivePlacementsInFlight } from './live-ops';

describe('live-ops DB reads (P-063, synthetic hive rows)', () => {
  let sql: postgres.Sql;
  const ws = 'ws-test';

  beforeAll(async () => {
    const adminUri = await getTestPg();
    const dbName = `hive_eval_ops_${randomBytes(5).toString('hex')}`;
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
    // Minimal stubs — only the columns the live reads query (cf. 000-baseline + 263-hive-placements).
    await sql.unsafe(`
      CREATE TABLE harness_shared.harness_features_consolidated (
        workspace_id text NOT NULL,
        harness_slug text NOT NULL,
        feature_id text NOT NULL,
        status text,
        PRIMARY KEY (harness_slug, feature_id)
      );
      CREATE TABLE harness_shared.spawned_agents (
        spawn_id text PRIMARY KEY,
        workspace_id text NOT NULL,
        harness_slug text NOT NULL,
        feature_id text,
        status text NOT NULL,
        started_at timestamptz NOT NULL,
        finished_at timestamptz,
        duration_ms bigint
      );
      CREATE TABLE harness_shared.hive_placements (
        workspace_id text NOT NULL,
        install_slug text NOT NULL,
        work_item_id text NOT NULL,
        status text NOT NULL,
        PRIMARY KEY (workspace_id, install_slug, work_item_id)
      );
    `);
  }, 60_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
  });

  it('readMemberRunStats: total + the `passed` completion count, scoped to the member', async () => {
    const member = 'hevalm1';
    await sql`INSERT INTO harness_shared.harness_features_consolidated (workspace_id, harness_slug, feature_id, status) VALUES
      (${ws}, ${member}, 'w0', 'passed'),
      (${ws}, ${member}, 'w1', 'passed'),
      (${ws}, ${member}, 'w2', 'validating'),
      (${ws}, ${member}, 'w3', 'todo'),
      (${ws}, 'other-harness', 'w0', 'passed')`; // a different harness — must be excluded
    const stats = await readMemberRunStats(sql, member, ws);
    expect(stats).toEqual({ costUsd: 0, workItemsTotal: 4, workItemsCompleted: 2 });
  });

  it('readMemberSpawnRows: maps bigint duration + timestamptz → epoch ms, handles null finished/feature', async () => {
    const member = 'hevalm2';
    await sql`INSERT INTO harness_shared.spawned_agents (spawn_id, workspace_id, harness_slug, feature_id, status, started_at, finished_at, duration_ms) VALUES
      ('s1', ${ws}, ${member}, 'w0', 'done', ${new Date(1_000_000)}, ${new Date(1_050_000)}, ${50_000}),
      ('s2', ${ws}, ${member}, NULL, 'running', ${new Date(2_000_000)}, NULL, NULL),
      ('s3', ${ws}, 'other-harness', 'w0', 'done', ${new Date(3_000_000)}, ${new Date(3_001_000)}, ${1_000})`;
    const rows = await readMemberSpawnRows(sql, member, ws);
    expect(rows).toHaveLength(2); // s3 belongs to another harness
    const s1 = rows.find((r) => r.spawnId === 's1')!;
    expect(s1).toEqual({ spawnId: 's1', featureId: 'w0', status: 'done', startedAtMs: 1_000_000, finishedAtMs: 1_050_000, durationMs: 50_000 });
    const s2 = rows.find((r) => r.spawnId === 's2')!;
    expect(s2).toMatchObject({ featureId: null, finishedAtMs: null, durationMs: null, startedAtMs: 2_000_000 });
  });

  it('countHivePlacementsInFlight: only non-terminal (working/recovering) rows for the home', async () => {
    const home = 'heval-home1';
    await sql`INSERT INTO harness_shared.hive_placements (workspace_id, install_slug, work_item_id, status) VALUES
      (${ws}, ${home}, 'w0', 'working'),
      (${ws}, ${home}, 'w1', 'recovering'),
      (${ws}, ${home}, 'w2', 'completed'),
      (${ws}, ${home}, 'w3', 'cursed'),
      (${ws}, ${home}, 'w4', 'abandoned'),
      (${ws}, 'other-home', 'w0', 'working')`; // a different hive — excluded
    expect(await countHivePlacementsInFlight(sql, home, ws)).toBe(2); // working + recovering only
  });

  it('empty member/home → zeroes (a drained hive reads clean)', async () => {
    expect(await readMemberRunStats(sql, 'nope', ws)).toEqual({ costUsd: 0, workItemsTotal: 0, workItemsCompleted: 0 });
    expect(await readMemberSpawnRows(sql, 'nope', ws)).toEqual([]);
    expect(await countHivePlacementsInFlight(sql, 'nope', ws)).toBe(0);
  });
});
