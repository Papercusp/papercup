/**
 * WI-3519 regression — the fast-orphan reap branch must NOT cancel healthy
 * BACKLOGGED fires (proven against real PG).
 *
 * THE BUG (2026-07-09, plan p2p-git-live-activation-2026-07-09 P-002): in this
 * DBOS version `dbos.workflow_queue` holds no rows even for never-dequeued
 * ENQUEUED workflows, so the fast-orphan branch's "no live queue row" guard is
 * vacuous. Under queue-slot starvation (routines-critical concurrency=2, two
 * slow fires under host CPU pressure) every git-sync fire waiting >10min was
 * cancelled+requeued each 2-min sweep (oddsmith reaped_count hit 114) — the
 * WI-1415 "firing but not committing" flap, reintroduced by the reaper itself.
 *
 * THE PROPERTY proven here: an over-window ENQUEUED routineFire is reaped ONLY
 * when its QUEUE is dead — no sibling on the same queue_name either actively
 * PENDING (recent updated_at) or recently drained to SUCCESS/ERROR. A healthy
 * backlog behind live workers is left alone; the reaper's own CANCELLED rows do
 * not count as liveness (they must not self-mask a genuinely wedged queue).
 *
 * Run: npx vitest run --config vitest.integration.config.ts \
 *        lib/dbos/dbos-executor-reaper-queue-liveness.integration.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { reapDeadExecutorWorkflows } from './dbos-executor-reaper';

let org: OrgTestDb;
let sql: Sql;
const WS = 'ws-reaper-liveness';
const HARNESS = 'papercup';

// Explicit windows so the test is deterministic and only the fast-orphan branch
// is in play: liveness 5m (all seeded executors stay "alive" via recent
// updated_at), scheduler 90s (no routinesTick rows seeded), no-output 60m
// (targets are younger), orphan 10m (targets are older).
const LIVENESS_MS = 5 * 60 * 1000;
const SCHEDULER_MS = 90 * 1000;
const NO_OUTPUT_MS = 60 * 60 * 1000;
const ORPHAN_MS = 10 * 60 * 1000;

beforeAll(async () => {
  org = await createOrgTestDb();
  sql = org.adminSql;
  // Minimal dbos schema — exactly the columns reapDeadExecutorWorkflows touches.
  await sql`CREATE SCHEMA IF NOT EXISTS dbos`;
  await sql`
    CREATE TABLE IF NOT EXISTS dbos.workflow_status (
      workflow_uuid TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      executor_id TEXT,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL,
      deduplication_id TEXT,
      queue_name TEXT,
      workflow_deadline_epoch_ms BIGINT
    )`;
  await sql`
    CREATE TABLE IF NOT EXISTS dbos.operation_outputs (
      workflow_uuid TEXT NOT NULL,
      function_id INT NOT NULL
    )`;
  await sql`
    CREATE TABLE IF NOT EXISTS dbos.workflow_queue (
      workflow_uuid TEXT NOT NULL,
      executor_id TEXT,
      completed_at_epoch_ms BIGINT
    )`;
});
afterAll(async () => {
  await org?.cleanup();
});
beforeEach(async () => {
  await sql`DELETE FROM dbos.workflow_status`;
  await sql`DELETE FROM dbos.operation_outputs`;
  await sql`DELETE FROM dbos.workflow_queue`;
  await sql`DELETE FROM harness_shared.routines WHERE workspace_id = ${WS}`;
});

type WfSeed = {
  uuid: string;
  name?: string;
  status: 'ENQUEUED' | 'PENDING' | 'SUCCESS' | 'ERROR' | 'CANCELLED';
  queue: string;
  createdAgoMs: number;
  updatedAgoMs: number;
  dedup?: string | null;
};

async function seedWf(w: WfSeed): Promise<void> {
  const now = Date.now();
  await sql`
    INSERT INTO dbos.workflow_status
      (workflow_uuid, name, status, executor_id, created_at, updated_at, deduplication_id, queue_name)
    VALUES (
      ${w.uuid}, ${w.name ?? 'routineFire'}, ${w.status}, 'exec-live',
      ${now - w.createdAgoMs}, ${now - w.updatedAgoMs}, ${w.dedup ?? null}, ${w.queue}
    )`;
}

async function seedRoutine(id: string): Promise<void> {
  await sql`
    INSERT INTO harness_shared.routines
      (id, install_slug, name, trigger_kind, trigger_config, target_role, active, workspace_id, metadata)
    VALUES (${id}, ${HARNESS}, 'git-sync', 'cron', '{}'::jsonb, 'su', TRUE, ${WS}, '{}'::jsonb)`;
}

/** The over-orphan-window ENQUEUED fire under test (no op outputs, no queue row). */
async function seedBackloggedTarget(queue: string, routineId: string): Promise<string> {
  const uuid = `wf-target-${queue}`;
  await seedWf({
    uuid,
    status: 'ENQUEUED',
    queue,
    createdAgoMs: 15 * 60 * 1000, // past the 10m orphan window, below the 60m no-output window
    updatedAgoMs: 30 * 1000, // executor recently active → dead-executor branch stays out of play
    dedup: `routine:${routineId}`,
  });
  await seedRoutine(routineId);
  return uuid;
}

async function reap() {
  return reapDeadExecutorWorkflows(sql, LIVENESS_MS, SCHEDULER_MS, NO_OUTPUT_MS, ORPHAN_MS);
}

async function wfStatus(uuid: string): Promise<string> {
  const r = await sql<{ status: string }[]>`
    SELECT status FROM dbos.workflow_status WHERE workflow_uuid = ${uuid}`;
  return r[0]?.status ?? 'MISSING';
}

async function routineMeta(id: string): Promise<Record<string, unknown> | null> {
  const r = await sql<{ metadata: Record<string, unknown> | null }[]>`
    SELECT metadata FROM harness_shared.routines WHERE id = ${id}`;
  return r[0]?.metadata ?? null;
}

describe('fast-orphan reap requires a DEAD queue (WI-3519, real PG)', () => {
  it('leaves a backlogged ENQUEUED fire alone while a sibling PENDING worker is live on the queue', async () => {
    const target = await seedBackloggedTarget('q-live-pending', 'rt-live-pending');
    // The healthy-but-slow worker occupying a concurrency slot (recent updated_at).
    await seedWf({
      uuid: 'wf-worker',
      status: 'PENDING',
      queue: 'q-live-pending',
      createdAgoMs: 20 * 60 * 1000,
      updatedAgoMs: 2 * 60 * 1000,
    });

    const res = await reap();

    expect(res.staleWorkflowIds).not.toContain(target);
    expect(res.requeuedRoutineIds).not.toContain('rt-live-pending');
    expect(await wfStatus(target)).toBe('ENQUEUED');
    expect((await routineMeta('rt-live-pending'))?.reaped_count).toBeUndefined();
  });

  it('leaves a backlogged ENQUEUED fire alone when the queue recently drained a fire to SUCCESS', async () => {
    const target = await seedBackloggedTarget('q-live-drain', 'rt-live-drain');
    await seedWf({
      uuid: 'wf-drained',
      status: 'SUCCESS',
      queue: 'q-live-drain',
      createdAgoMs: 30 * 60 * 1000,
      updatedAgoMs: 3 * 60 * 1000,
    });

    const res = await reap();

    expect(res.staleWorkflowIds).not.toContain(target);
    expect(await wfStatus(target)).toBe('ENQUEUED');
  });

  it('reaps + requeues the fire when the queue is genuinely dead (no live sibling, no recent drain)', async () => {
    const target = await seedBackloggedTarget('q-dead', 'rt-q-dead');

    const res = await reap();

    expect(res.staleWorkflowIds).toContain(target);
    expect(res.requeuedRoutineIds).toContain('rt-q-dead');
    expect(await wfStatus(target)).toBe('CANCELLED');
    const meta = await routineMeta('rt-q-dead');
    expect(meta?.reaped_count).toBe(1);
    expect(String(meta?.last_error ?? '')).toContain('executor reaper cancelled the stuck fire');
  });

  it("the reaper's own CANCELLED rows are NOT liveness — a wedged queue full of prior cancels still reaps", async () => {
    const target = await seedBackloggedTarget('q-self-mask', 'rt-self-mask');
    // A fresh cancel from a prior sweep on the same queue must not read as "alive".
    await seedWf({
      uuid: 'wf-prior-cancel',
      status: 'CANCELLED',
      queue: 'q-self-mask',
      createdAgoMs: 25 * 60 * 1000,
      updatedAgoMs: 60 * 1000,
    });

    const res = await reap();

    expect(res.staleWorkflowIds).toContain(target);
    expect(await wfStatus(target)).toBe('CANCELLED');
  });
});
