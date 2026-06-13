/**
 * Integration test for the hive-eval PG store + migration 264. Validates the DDL applies and
 * the store round-trips, with the load-bearing property: runs key on (instance, scenario,
 * repeat), so N repeats of one scenario are N distinct rows (the P-022 distribution) — unlike
 * the beekeeper's UNIQUE(instance_id, case_id).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getTestPg } from '@papercusp/test-config';
import { createPgHiveEvalStore } from './store-pg';
import type { HiveEvalRunRow, HiveEvalScenarioRow, InstanceManifest } from './store';

const MIGRATION = '264-hive-eval-battery.sql';

function readMigration(): string {
  const candidates = [
    join(__dirname, '../../../../libs/papercusp/libs/db/sql/' + MIGRATION),
    join(__dirname, '../../../libs/papercusp/libs/db/sql/' + MIGRATION),
    '/home/marsh-office/papercupai-workspace/papercup/libs/papercusp/libs/db/sql/' + MIGRATION,
  ];
  for (const p of candidates) {
    try {
      return readFileSync(p, 'utf8');
    } catch {
      /* next */
    }
  }
  throw new Error(`could not locate ${MIGRATION}`);
}

describe('hive-eval PG store (migration 264)', () => {
  let sql: postgres.Sql;

  beforeAll(async () => {
    const adminUri = await getTestPg();
    const dbName = `hive_eval_${randomBytes(5).toString('hex')}`;
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
    await sql.unsafe(readMigration());
  }, 60_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
  });

  const instance: InstanceManifest = {
    instanceId: 'gen0-deadbe-ws',
    workspaceId: 'ws',
    codeSha: 'deadbe',
    createdAt: new Date(),
  };
  const scenario: HiveEvalScenarioRow = {
    scenarioId: 'serial-pipeline',
    title: 'Serial',
    shape: 'serial',
    idealWallClockUnits: 4,
    idealBeeCount: 1,
    totalUnits: 4,
    criticalPath: ['w1', 'w2', 'w3', 'w4'],
    workItemCount: 4,
    plantedBugLocation: 'src/ranker.js#topN',
  };
  const runRow = (repeat: number): HiveEvalRunRow => ({
    runId: `${instance.instanceId}::serial-pipeline::r${repeat}`,
    instanceId: instance.instanceId,
    scenarioId: 'serial-pipeline',
    shape: 'serial',
    repeat,
    seed: 100 + repeat,
    budgetUsdCap: 10,
    beeCap: 4,
    startedAt: new Date(),
  });

  it('round-trips instance + scenario + a finished run', async () => {
    const store = createPgHiveEvalStore(sql);
    await store.upsertInstance(instance);
    await store.upsertScenario(scenario);
    await store.startRun(runRow(0));
    await store.finishRun(runRow(0).runId, {
      finishedAt: new Date(),
      observations: {
        terminalState: 'drained',
        wallClockMs: 1234,
        frontierDrained: true,
        workItemsTotal: 4,
        workItemsCompleted: 4,
        costUsd: 0.5,
      },
      traceRef: 'trace://x',
    });

    const [row] = await sql`SELECT * FROM harness_shared.hive_eval_runs WHERE run_id = ${runRow(0).runId}`;
    expect(row.terminal_state).toBe('drained');
    expect(Number(row.wall_clock_ms)).toBe(1234);
    expect(row.frontier_drained).toBe(true);
    expect(row.observations.costUsd).toBe(0.5);
    const [sc] = await sql`SELECT * FROM harness_shared.hive_eval_scenarios WHERE scenario_id = 'serial-pipeline'`;
    expect(sc.ideal_bee_count).toBe(1);
    expect(sc.critical_path).toEqual(['w1', 'w2', 'w3', 'w4']);
  });

  it('keeps every repeat as a distinct row (the P-022 distribution)', async () => {
    const store = createPgHiveEvalStore(sql);
    await store.upsertInstance(instance);
    for (let r = 0; r < 3; r++) await store.startRun(runRow(r));
    const rows = await sql`SELECT run_id FROM harness_shared.hive_eval_runs WHERE scenario_id = 'serial-pipeline' AND instance_id = ${instance.instanceId} ORDER BY repeat`;
    expect(rows.map((x) => x.run_id)).toEqual([
      `${instance.instanceId}::serial-pipeline::r0`,
      `${instance.instanceId}::serial-pipeline::r1`,
      `${instance.instanceId}::serial-pipeline::r2`,
    ]);
  });

  it('startRun is idempotent — a re-run resets the row to a fresh attempt', async () => {
    const store = createPgHiveEvalStore(sql);
    await store.upsertInstance(instance);
    await store.startRun(runRow(0));
    await store.finishRun(runRow(0).runId, {
      finishedAt: new Date(),
      observations: { terminalState: 'drained', wallClockMs: 9, frontierDrained: true, workItemsTotal: 4, workItemsCompleted: 4, costUsd: 0 },
    });
    // re-run the same key
    await store.startRun(runRow(0));
    const [row] = await sql`SELECT terminal_state, finished_at FROM harness_shared.hive_eval_runs WHERE run_id = ${runRow(0).runId}`;
    expect(row.terminal_state).toBeNull(); // reset
    expect(row.finished_at).toBeNull();
  });
});
