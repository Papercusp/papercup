/** POLICY-IDEMPOTENT: actual routine enqueue and DBOS queue admission on private PG.
 * Only the terminal action is a counting fixture; queue conflicts are never mocked.
 * The real routinesTick schedule runs only against this private database;
 * unrelated periodic registrations are parked for the executor's lifetime.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import type { DBOS as DBOSType } from '@dbos-inc/dbos-sdk';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import type { RoutineFireRow } from './routines-workflow';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async original => ({
  ...await original<typeof import('@papercusp/db-org')>(), getOrgPg: () => ({ sql: h.sql }),
}));
vi.mock('./bootstrap', () => ({ dbosStarted: () => true, withDbosIdleTxGrace: (url: string) => url }));
vi.mock('../harness/routines/register-system-actions', () => ({}));
vi.mock('../harness/routines/configure-per-workspace', () => ({}));

let db: OrgTestDb;
let DBOS: typeof DBOSType;
let enqueue: typeof import('./routines-workflow').enqueueRoutineFire;
const executions = new Map<string, string[]>();
const blocked = new Map<string, { wait: Promise<void>; release: () => void }>();
const workspace = 'startup-dedup-test';
const action = 'startup-dedup-test-effect';
const schedules: Array<{ config: { crontab: string }; original: string }> = [];

beforeAll(async () => {
  db = await createOrgTestDb();
  h.sql = db.adminSql;
  ({ DBOS } = await import('@dbos-inc/dbos-sdk'));
  DBOS.setConfig({ name: 'papercusp-startup-dedup-test', systemDatabaseUrl: db.adminDsn,
    systemDatabaseSchemaName: 'dbos', applicationVersion: 'startup-dedup-test', runAdminServer: false });
  ({ enqueueRoutineFire: enqueue } = await import('./routines-workflow'));
  const registrations = DBOS.getAssociatedInfo('dbos.scheduler');
  expect(registrations.some(registration => registration.methodReg.name === 'routinesTick')).toBe(true);
  for (const registration of registrations) {
    const config = registration.methodConfig as { crontab: string };
    schedules.push({ config, original: config.crontab });
    config.crontab = registration.methodReg.name === 'routinesTick' ? '* * * * * *' : '0 0 0 1 1 *';
  }
  const { registerSystemAction } = await import('../harness/routines/system-actions');
  registerSystemAction(action, async context => {
    if (!context.workflowId || !context.routineId) throw new Error('Expected real routine and workflow identities');
    const prior = executions.get(context.routineId) ?? [];
    executions.set(context.routineId, [...prior, context.workflowId]);
    await blocked.get(context.routineId)?.wait;
    return { diagnostics: { privateCountingEffect: true } };
  }, { scheduling: 'on-demand' });
  await DBOS.launch();
}, 180_000);

afterAll(async () => {
  for (const gate of blocked.values()) gate.release();
  try { await DBOS?.shutdown(); }
  finally {
    for (const { config, original } of schedules) config.crontab = original;
    await db?.cleanup();
  }
});

afterEach(async () => {
  await db.adminSql`UPDATE harness_shared.routines SET active = false WHERE workspace_id = ${workspace}`;
});

async function routine(): Promise<RoutineFireRow> {
  const id = `startup-dedup-${randomUUID()}`;
  const row: RoutineFireRow = { id, workspaceId: workspace, installSlug: 'startup-dedup-test', name: id,
    targetRole: `system:${action}`, triggerConfig: { cron: '0 0 0 1 1 *' },
    payloadTemplate: null, rescheduleIntervalSec: null, targetOwnerId: null };
  await db.adminSql`INSERT INTO harness_shared.routines
    (id, workspace_id, install_slug, name, trigger_kind, trigger_config, target_role, active, tier, next_fire_at)
    VALUES (${id}, ${workspace}, ${row.installSlug}, ${id}, 'cron',
      ${JSON.stringify(row.triggerConfig)}::text::jsonb, ${row.targetRole}, true, 'durable', 'infinity')`;
  return row;
}

function hold(id: string): () => void {
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  blocked.set(id, { wait, release });
  return () => { blocked.delete(id); release(); };
}

async function complete(id: string): Promise<void> {
  await expect.poll(() => executions.get(id)?.length ?? 0, { timeout: 15_000 }).toBeGreaterThan(0);
  await DBOS.getResult<void>(executions.get(id)!.at(-1)!, 30);
}

describe('startup routine duplicate admission (real DBOS and PostgreSQL)', () => {
  it('admits one concurrent delivery per routine and permits a later distinct occurrence', async () => {
    const row = await routine();
    const release = hold(row.id);
    try {
      const deliveries = await Promise.all([enqueue(row), enqueue(row)]);
      expect(deliveries.map(result => result.status).sort()).toEqual(['deduplicated', 'enqueued']);
      expect(deliveries.every(result => result.ok && result.deduplicationId === `routine:${row.id}`)).toBe(true);
      await expect.poll(() => executions.get(row.id)?.length ?? 0, { timeout: 15_000 }).toBe(1);
    } finally { release(); }
    await complete(row.id);
    expect(executions.get(row.id)).toHaveLength(1);

    // The mutex guards concurrent deliveries, not every future occurrence of this routine.
    await expect(enqueue(row)).resolves.toMatchObject({ ok: true, status: 'enqueued' });
    await expect.poll(() => executions.get(row.id)?.length, { timeout: 15_000 }).toBe(2);
    await complete(row.id);
    expect(new Set(executions.get(row.id)).size).toBe(2);
  }, 90_000);

  it('does not collapse two distinct routine identities into one execution', async () => {
    const [first, second] = await Promise.all([routine(), routine()]);
    const releaseFirst = hold(first.id);
    const releaseSecond = hold(second.id);
    try {
      const deliveries = await Promise.all([enqueue(first), enqueue(second)]);
      expect(deliveries.map(result => result.status)).toEqual(['enqueued', 'enqueued']);
      expect(new Set(deliveries.map(result => result.deduplicationId)).size).toBe(2);
      await expect.poll(() => [executions.get(first.id)?.length ?? 0, executions.get(second.id)?.length ?? 0],
        { timeout: 15_000 }).toEqual([1, 1]);
    } finally { releaseFirst(); releaseSecond(); }
    await Promise.all([complete(first.id), complete(second.id)]);
    expect(executions.get(first.id)).toHaveLength(1);
    expect(executions.get(second.id)).toHaveLength(1);
  }, 60_000);

  it('collapses an automatic scheduler delivery during a manual fire, then runs a later scheduled occurrence', async () => {
    const row = await routine();
    const release = hold(row.id);
    try {
      await expect(enqueue(row)).resolves.toMatchObject({ ok: true, status: 'enqueued' });
      await expect.poll(() => executions.get(row.id)?.length ?? 0, { timeout: 15_000 }).toBe(1);
      await db.adminSql`UPDATE harness_shared.routines SET next_fire_at = now() - interval '1 second'
        WHERE id = ${row.id}`;
      // Only the actual scheduled tick can claim and advance this row: no tick
      // implementation, claim, enqueue or admission return value is mocked.
      await expect.poll(async () => {
        const [state] = await db.adminSql<{ claimed: boolean }[]>`
          SELECT last_fired_at IS NOT NULL AND next_fire_at > now() AS claimed
          FROM harness_shared.routines WHERE id = ${row.id}`;
        return state?.claimed;
      }, { timeout: 30_000 }).toBe(true);
      await expect.poll(async () => {
        const [state] = await db.adminSql<{ finished: boolean }[]>`
          SELECT EXISTS (SELECT 1 FROM dbos.workflow_status
            WHERE name = 'routinesTick' AND status = 'SUCCESS'
              AND updated_at >= (SELECT extract(epoch FROM last_fired_at) * 1000
                FROM harness_shared.routines WHERE id = ${row.id})) AS finished`;
        return state?.finished;
      }, { timeout: 30_000 }).toBe(true);
      expect(executions.get(row.id)).toHaveLength(1);
      expect(await db.adminSql`SELECT workflow_uuid FROM dbos.workflow_status
        WHERE deduplication_id = ${`routine:${row.id}`}`).toHaveLength(1);
    } finally { release(); }
    await complete(row.id);

    // A new due occurrence must reach the same real scheduler without being
    // mistaken for a replay of the earlier, already completed manual request.
    await db.adminSql`UPDATE harness_shared.routines SET next_fire_at = now() - interval '1 second'
      WHERE id = ${row.id}`;
    await expect.poll(() => executions.get(row.id)?.length ?? 0, { timeout: 30_000 }).toBe(2);
    await complete(row.id);
    expect(new Set(executions.get(row.id)).size).toBe(2);
    const { startupActivityFeatureId } = await import('../schedule-inventory');
    const featureId = startupActivityFeatureId({ source: 'routines', installSlug: row.installSlug,
      name: row.name, detail: {} }, { workspaceId: workspace });
    const starts = await db.adminSql<{ trigger: string }[]>`
      SELECT details->'startupActivity'->>'trigger' AS trigger FROM harness_shared.audit_log
      WHERE workspace_id = ${workspace} AND action = 'background-activity' AND subject = ${featureId}
      ORDER BY ts, id`;
    expect(starts.map(start => start.trigger).sort()).toEqual(['manual', 'timer']);
  }, 120_000);
});
