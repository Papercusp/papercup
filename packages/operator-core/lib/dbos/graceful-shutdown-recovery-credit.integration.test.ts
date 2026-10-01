/**
 * The graceful-shutdown recovery credit against real Postgres (WI-10004954).
 *
 * The dequeue step below is the DBOS SDK 4.27.x claim flip reduced to the columns that
 * matter (`recovery_attempts = recovery_attempts + 1` on ENQUEUED→PENDING); the unit
 * test pins that the installed SDK still does this. Inline DDL carries only the columns
 * the credit reads (createFreshPgDb replays no migrations).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import { creditGracefulShutdownRecoveryAttempts } from './graceful-shutdown-recovery-credit';

const EXEC = 'bg-host-3270';
const OTHER_EXEC = 'desktop-dev-3070';
/** routineFire's registered budget; the claim refuses once attempts > max + 1. */
const MAX_RECOVERY_ATTEMPTS = 5;

let db: FreshPgDb;
let sql: Sql;

beforeAll(async () => {
  db = await createFreshPgDb('dbosgraceful');
  sql = db.sql as unknown as Sql;
  await db.sql.unsafe(`
    CREATE SCHEMA dbos;
    CREATE TABLE dbos.workflow_status (
      workflow_uuid text PRIMARY KEY,
      status text NOT NULL,
      executor_id text,
      recovery_attempts bigint NOT NULL DEFAULT 0,
      workflow_deadline_epoch_ms bigint
    );
  `);
}, 120_000);

afterAll(async () => {
  await db?.cleanup();
});

beforeEach(async () => {
  await db.sql.unsafe('TRUNCATE dbos.workflow_status');
});

async function enqueue(id: string, opts: { deadline?: boolean } = {}): Promise<void> {
  await db.sql`
    INSERT INTO dbos.workflow_status (workflow_uuid, status, workflow_deadline_epoch_ms)
    VALUES (${id}, 'ENQUEUED', ${opts.deadline === false ? null : Date.now() + 24 * 3_600_000})`;
}

/** DBOS's claim flip: ENQUEUED→PENDING with recovery_attempts + 1. Returns the new count. */
async function dequeue(id: string, executor = EXEC): Promise<number> {
  const [row] = await db.sql<{ recovery_attempts: string }[]>`
    UPDATE dbos.workflow_status
       SET status = 'PENDING', executor_id = ${executor},
           recovery_attempts = recovery_attempts + 1
     WHERE workflow_uuid = ${id} AND status = 'ENQUEUED'
    RETURNING recovery_attempts`;
  return Number(row!.recovery_attempts);
}

/** DBOS boot recovery: re-enqueue every PENDING workflow this executor owned. */
async function recoverOnBoot(executor = EXEC): Promise<void> {
  await db.sql`
    UPDATE dbos.workflow_status SET status = 'ENQUEUED'
     WHERE executor_id = ${executor} AND status = 'PENDING'`;
}

function wouldDeadLetter(attempts: number): boolean {
  return attempts > MAX_RECOVERY_ATTEMPTS + 1;
}

async function attempts(id: string): Promise<number> {
  const [row] = await db.sql<{ recovery_attempts: string }[]>`
    SELECT recovery_attempts FROM dbos.workflow_status WHERE workflow_uuid = ${id}`;
  return Number(row!.recovery_attempts);
}

describe('creditGracefulShutdownRecoveryAttempts', () => {
  it('CONTROL: without the credit, routine restarts alone dead-letter a long fire', async () => {
    await enqueue('wf-long');
    let n = await dequeue('wf-long');
    for (let restart = 0; restart < 6; restart++) {
      await recoverOnBoot();
      n = await dequeue('wf-long');
    }
    expect(n).toBe(7);
    expect(wouldDeadLetter(n)).toBe(true);
  });

  it('keeps a long fire at one attempt across any number of graceful restarts', async () => {
    await enqueue('wf-long');
    let n = await dequeue('wf-long');
    for (let restart = 0; restart < 20; restart++) {
      const credited = await creditGracefulShutdownRecoveryAttempts(sql, EXEC);
      expect(credited).toEqual(['wf-long']);
      await recoverOnBoot();
      n = await dequeue('wf-long');
    }
    expect(n).toBe(1);
    expect(wouldDeadLetter(n)).toBe(false);
  });

  it('still counts crashes, so a poison workflow is still dead-lettered', async () => {
    await enqueue('wf-poison');
    let n = await dequeue('wf-poison');
    // Two graceful restarts are forgiven...
    for (let i = 0; i < 2; i++) {
      await creditGracefulShutdownRecoveryAttempts(sql, EXEC);
      await recoverOnBoot();
      n = await dequeue('wf-poison');
    }
    expect(n).toBe(1);
    // ...but a crash runs no credit, and six of them exceed the budget.
    for (let crash = 0; crash < 6; crash++) {
      await recoverOnBoot();
      n = await dequeue('wf-poison');
    }
    expect(n).toBe(7);
    expect(wouldDeadLetter(n)).toBe(true);
  });

  it('credits only PENDING, deadline-bounded workflows of this executor, never below zero', async () => {
    await enqueue('wf-mine');
    await dequeue('wf-mine');
    await enqueue('wf-other-executor');
    await dequeue('wf-other-executor', OTHER_EXEC);
    await enqueue('wf-no-deadline', { deadline: false });
    await dequeue('wf-no-deadline');
    await enqueue('wf-still-enqueued');
    await db.sql`
      INSERT INTO dbos.workflow_status (workflow_uuid, status, executor_id, recovery_attempts, workflow_deadline_epoch_ms)
      VALUES ('wf-done', 'SUCCESS', ${EXEC}, 3, ${Date.now()}),
             ('wf-zero', 'PENDING', ${EXEC}, 0, ${Date.now()})`;

    const credited = await creditGracefulShutdownRecoveryAttempts(sql, EXEC);

    expect(credited).toEqual(['wf-mine']);
    expect(await attempts('wf-mine')).toBe(0);
    expect(await attempts('wf-other-executor')).toBe(1);
    expect(await attempts('wf-no-deadline')).toBe(1);
    expect(await attempts('wf-still-enqueued')).toBe(0);
    expect(await attempts('wf-done')).toBe(3);
    expect(await attempts('wf-zero')).toBe(0);
  });

  it('is a no-op without an executor id', async () => {
    await enqueue('wf-mine');
    await dequeue('wf-mine');
    expect(await creditGracefulShutdownRecoveryAttempts(sql, '')).toEqual([]);
    expect(await attempts('wf-mine')).toBe(1);
  });
});
