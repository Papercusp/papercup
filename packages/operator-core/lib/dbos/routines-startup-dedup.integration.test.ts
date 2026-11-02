/** POLICY-IDEMPOTENT: actual routine enqueue and DBOS queue admission on private PG.
 * Only the terminal action is a counting fixture; queue conflicts are never mocked.
 * Unrelated scheduled maintenance is not registered in this isolated executor.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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

beforeAll(async () => {
  db = await createOrgTestDb();
  h.sql = db.adminSql;
  ({ DBOS } = await import('@dbos-inc/dbos-sdk'));
  DBOS.setConfig({ name: 'papercusp-startup-dedup-test', systemDatabaseUrl: db.adminDsn,
    systemDatabaseSchemaName: 'dbos', applicationVersion: 'startup-dedup-test', runAdminServer: false });
  const scheduled = vi.spyOn(DBOS, 'registerScheduled').mockImplementation(() => {});
  try {
    ({ enqueueRoutineFire: enqueue } = await import('./routines-workflow'));
  } finally { scheduled.mockRestore(); }
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
  finally { await db?.cleanup(); }
});

async function routine(): Promise<RoutineFireRow> {
  const id = `startup-dedup-${randomUUID()}`;
  const row: RoutineFireRow = { id, workspaceId: workspace, installSlug: 'startup-dedup-test', name: id,
    targetRole: `system:${action}`, triggerConfig: { cron: '0 * * * * *' },
    payloadTemplate: null, rescheduleIntervalSec: null, targetOwnerId: null };
  await db.adminSql`INSERT INTO harness_shared.routines
    (id, workspace_id, install_slug, name, trigger_kind, trigger_config, target_role, active)
    VALUES (${id}, ${workspace}, ${row.installSlug}, ${id}, 'schedule',
      ${JSON.stringify(row.triggerConfig)}::text::jsonb, ${row.targetRole}, true)`;
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
});
