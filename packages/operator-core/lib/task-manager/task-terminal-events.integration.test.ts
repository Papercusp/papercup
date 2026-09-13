// @vitest-environment node
/**
 * CAP-CONTRACT-P003 task-terminal bridge proof against real Postgres.
 *
 * Exercises the production closeTask -> dynamic event-engine import -> await
 * store path. The unit tests pin the emitted tuple; this integration test pins
 * the cross-module persistence boundary and first-terminal exactly-once rule.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import type { OrgTestDb } from '../../test/_org-test-db';
import { DEFAULT_COORD_WORKSPACE } from '@papercusp/coordination/event-log';

const h = vi.hoisted(() => ({ sql: null as unknown as postgres.Sql, ws: 'ws-task-terminal' }));

vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: h.sql }),
}));
vi.mock('../workspace-registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../workspace-registry')>()),
  activeWorkspaceId: () => h.ws,
  backgroundWorkspaceIds: () => [h.ws],
}));

const taskStore = await import('./store');
const eventStore = await import('../events/await/store');
const eventEngine = await import('../events/await/engine');
const { taskTerminalEventKey } = await import('./task-terminal-events');
const { createOrgTestDb } = await import('../../test/_org-test-db');

async function waitForEmission(eventKey: string): Promise<{
  fire: Record<string, any>;
  delivery: Record<string, any>;
}> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const [fire] = await h.sql`
      SELECT fire_count, last_payload, last_fired_by
        FROM harness_shared.event_key_fires
       WHERE workspace_id = ${DEFAULT_COORD_WORKSPACE} AND event_key = ${eventKey}
    `;
    const [delivery] = await h.sql`
      SELECT payload, summary, source
        FROM harness_shared.event_wake_deliveries
       WHERE workspace_id = ${DEFAULT_COORD_WORKSPACE} AND event_key = ${eventKey}
    `;
    if (fire && delivery) return { fire, delivery };
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const taskRows = await h.sql`
    SELECT state, exit_code, exit_reason, ended_at
      FROM harness_shared.task_ledger
     WHERE task_id = 'task-terminal-integration'
  `;
  const fireRows = await h.sql`
    SELECT workspace_id, event_key, fire_count
      FROM harness_shared.event_key_fires
     WHERE event_key = ${eventKey}
  `;
  throw new Error(
    `task-terminal event did not fire for ${eventKey}; ` +
      `task=${JSON.stringify(taskRows)} fires=${JSON.stringify(fireRows)}`,
  );
}

describe('task terminal awaited-event bridge (real PG)', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
    h.sql = db.adminSql;
    // The test asserts durable queue creation, not host delivery. Disabling the
    // asynchronous pump keeps the proof deterministic and process-local.
    eventEngine.setAutoPumpEnabledForTests(false);
  }, 120_000);

  afterAll(async () => {
    eventEngine.setAutoPumpEnabledForTests(true);
    await db?.cleanup();
  });

  it('fires and queues exactly one event after the first authoritative terminal update', async () => {
    const taskId = 'task-terminal-integration';
    const eventKey = taskTerminalEventKey(taskId);
    await h.sql`
      INSERT INTO harness_shared.task_ledger (
        task_id, workspace_id, root_task_id, harness_slug, class, title,
        argv, launched_by, confined, state, detail
      ) VALUES (
        ${taskId}, ${h.ws}, ${taskId}, 'papercusp', 'pty', 'integration PTY',
        '[]'::jsonb, 'su-terminal-owner', true, 'running', '{}'::jsonb
      )
    `;
    await eventStore.registerAwait({
      subscriberId: 'su-terminal-waiter',
      eventKey,
      policy: 'wake',
    });

    await expect(taskStore.closeTask(taskId, { state: 'exited', exitCode: 0 })).resolves.toBe(true);
    const { fire, delivery } = await waitForEmission(eventKey);
    expect(fire).toMatchObject({
      fire_count: 1,
      last_fired_by: 'task-manager',
      last_payload: {
        taskId,
        state: 'exited',
        exitCode: 0,
        exitReason: null,
        taskClass: 'pty',
        harness: 'papercusp',
        launchedBy: 'su-terminal-owner',
      },
    });

    const [awaitRow] = await h.sql`
      SELECT fired_at
        FROM harness_shared.event_awaits
       WHERE workspace_id = ${DEFAULT_COORD_WORKSPACE} AND event_key = ${eventKey}
    `;
    expect(awaitRow?.fired_at).toBeTruthy();
    expect(delivery).toEqual({
      payload: fire.last_payload,
      summary: `Managed pty task ${taskId} entered terminal state exited.`,
      source: 'task-manager',
    });

    // A competing/idempotent closer cannot write ended_at again, so it must
    // neither re-fire the latch nor queue a second delivery.
    await expect(taskStore.closeTask(taskId, { state: 'killed', exitReason: 'late close' })).resolves.toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await h.sql`
      SELECT fire_count FROM harness_shared.event_key_fires
       WHERE workspace_id = ${DEFAULT_COORD_WORKSPACE} AND event_key = ${eventKey}
    `).toEqual([{ fire_count: 1 }]);
    expect(await h.sql`
      SELECT count(*)::int AS count FROM harness_shared.event_wake_deliveries
       WHERE workspace_id = ${DEFAULT_COORD_WORKSPACE} AND event_key = ${eventKey}
    `).toEqual([{ count: 1 }]);
  });
});
