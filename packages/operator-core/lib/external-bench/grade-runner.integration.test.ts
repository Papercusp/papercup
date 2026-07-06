/**
 * Integration test for the grade trigger (P-010) against a real (testcontainer)
 * Postgres. Uses an INJECTED grader (the real path needs docker) to prove the
 * orchestration: status → grading → done, and the verdict map is persisted to the
 * per-task rows + rolled up into resolvedCount/gradedCount via applyGradeMap.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import type { OrgSql } from './reproducibility/db';

vi.mock('../sync-sse', () => ({ notifySyncInvalidate: vi.fn(async () => {}) }));

import { gradeBenchRun } from './grade-runner';
import { upsertBenchRun, upsertBenchRunTask, getBenchRunDetail } from './run-store';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = resolve(__dirname, '../../../../libs/papercusp/libs/db/sql');
const WS = 'bench-grade-test-ws';

function migrationSql(file: string): string {
  return readFileSync(resolve(SQL_DIR, file), 'utf8')
    .split('\n')
    .filter((l) => !/^\s*\\/.test(l) && !/\bGRANT\b/.test(l) && !/^\s*(BEGIN|COMMIT);\s*$/.test(l))
    .join('\n');
}

let db: FreshPgDb;
let sql: OrgSql;
let scope: { sql: OrgSql; workspaceId: string };

beforeAll(async () => {
  db = await createFreshPgDb('benchgrade');
  sql = db.sql as unknown as OrgSql;
  await db.sql.unsafe(migrationSql('296-bench-run-operational-store.sql'));
  await db.sql.unsafe(migrationSql('298-bench-run-infra-excluded.sql'));
  // D-007 pot-rename: mig 296 creates bench_runs.hive_slug; mig 523 renamed it → pot_slug.
  // Replaying only 296/298 predates the rename, so apply it in-place to match the write path.
  await db.sql.unsafe(`ALTER TABLE harness_shared.bench_runs RENAME COLUMN hive_slug TO pot_slug`);
  await db.sql.unsafe(`
    ALTER TABLE harness_shared.bench_runs       DISABLE ROW LEVEL SECURITY;
    ALTER TABLE harness_shared.bench_run_tasks  DISABLE ROW LEVEL SECURITY;
    ALTER TABLE harness_shared.bench_run_events DISABLE ROW LEVEL SECURITY;
  `);
  scope = { sql, workspaceId: WS };
}, 120_000);

afterAll(async () => {
  await db?.cleanup();
});

beforeEach(async () => {
  await sql`DELETE FROM harness_shared.bench_runs WHERE workspace_id = ${WS}`;
});

describe('gradeBenchRun (P-010)', () => {
  it('runs the (injected) grader, persists the verdict map + rolls up resolved counts, status → done', async () => {
    await upsertBenchRun({ id: 'g1', arm: 'hive-realqueen', taskSetId: '11-task-pilot', model: 'opus', status: 'done' }, scope);
    for (const id of ['instance_a', 'instance_b', 'instance_c']) {
      await upsertBenchRunTask('g1', { instanceId: id, taskStatus: 'collected', diffBytes: 100 }, scope);
    }

    const grade = vi.fn(async () => ({ instance_a: true, instance_b: false, instance_c: true }));
    const res = await gradeBenchRun('g1', { scope, grade });
    expect('runId' in res).toBe(true);
    if ('error' in res) throw new Error(res.error);
    await res.done;

    expect(grade).toHaveBeenCalledTimes(1);
    const detail = await getBenchRunDetail('g1', scope);
    expect(detail!.status).toBe('done');
    expect(detail!.gradedCount).toBe(3);
    expect(detail!.resolvedCount).toBe(2);
    expect(detail!.resolvedPct).toBeCloseTo(2 / 3);
    const a = detail!.perTask.find((t) => t.instanceId === 'instance_a')!;
    expect(a.resolved).toBe(true);
    const b = detail!.perTask.find((t) => t.instanceId === 'instance_b')!;
    expect(b.resolved).toBe(false);
  });

  it('a grader failure marks the run status=error (does not silently pass)', async () => {
    await upsertBenchRun({ id: 'g2', arm: 'hive-realqueen', taskSetId: '11-task-pilot', model: 'opus', status: 'done' }, scope);
    await upsertBenchRunTask('g2', { instanceId: 'instance_a', taskStatus: 'collected' }, scope);
    const grade = vi.fn(async () => {
      throw new Error('docker not available');
    });
    const res = await gradeBenchRun('g2', { scope, grade });
    if ('error' in res) throw new Error(res.error);
    await res.done;
    const detail = await getBenchRunDetail('g2', scope);
    expect(detail!.status).toBe('error');
    expect(detail!.runError).toMatch(/grade failed/);
  });

  it('returns run_not_found for an unknown run', async () => {
    const res = await gradeBenchRun('nope', { scope, grade: async () => ({}) });
    expect(res).toEqual({ error: 'run_not_found' });
  });
});
