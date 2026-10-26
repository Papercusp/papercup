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
const { taskTerminalEventKey, emitTaskTerminalEvent } = await import('./task-terminal-events');
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

  async function insertTask(taskId: string) {
    await h.sql`
      INSERT INTO harness_shared.task_ledger (
        task_id, workspace_id, root_task_id, harness_slug, class, title,
        argv, launched_by, confined, state, detail
      ) VALUES (${taskId}, ${h.ws}, ${taskId}, 'papercusp', 'bash-job', ${taskId},
        '[]'::jsonb, 'su-terminal-owner', true, 'running', '{}'::jsonb)
    `;
  }

  it('recovers persisted delivery failure after losing the closer and wakes the exact waiter once', async () => {
    const taskId = 'terminal-restart-retry';
    const eventKey = taskTerminalEventKey(taskId);
    await insertTask(taskId);
    await eventStore.registerAwait({ subscriberId: 'su-restart-waiter', eventKey, policy: 'wake' });
    await expect(taskStore.closeTask(taskId, { state: 'exited', exitCode: 7, exitReason: 'runner-log' }, undefined, {
      emitTerminal: event => emitTaskTerminalEvent(event, { emit: async () => { throw new Error('event backend unavailable'); }, warn: () => {} }),
    })).resolves.toBe(true);
    expect(await h.sql`SELECT state, exit_code, detail -> 'terminalEventPending' AS pending
      FROM harness_shared.task_ledger WHERE task_id = ${taskId}`)
      .toEqual([{ state: 'exited', exit_code: 7, pending: true }]);
    expect(await h.sql`SELECT event_key FROM harness_shared.event_key_fires WHERE event_key = ${eventKey}`).toHaveLength(0);
    // No closure-local memory or original emitter survives into this call.
    await expect(taskStore.recoverPendingTaskTerminalEvents(h.ws)).resolves.toBe(1);
    const { fire, delivery } = await waitForEmission(eventKey);
    expect(fire.last_payload).toMatchObject({ taskId, state: 'exited', exitCode: 7, exitReason: 'runner-log' });
    expect(delivery.payload).toEqual(fire.last_payload);
    await expect(taskStore.recoverPendingTaskTerminalEvents(h.ws)).resolves.toBe(0);
    expect(await h.sql`SELECT fire_count FROM harness_shared.event_key_fires WHERE event_key = ${eventKey}`)
      .toEqual([{ fire_count: 1 }]);
  });

  it('backfills an existing terminal row with no pending marker and no exact fire', async () => {
    const taskId = 'terminal-legacy-missing-fire';
    const eventKey = taskTerminalEventKey(taskId);
    await insertTask(taskId);
    await h.sql`UPDATE harness_shared.task_ledger SET state = 'exited', exit_code = 2, ended_at = now()
      WHERE task_id = ${taskId}`;
    await eventStore.registerAwait({ subscriberId: 'su-legacy-waiter', eventKey, policy: 'wake' });
    await expect(taskStore.recoverPendingTaskTerminalEvents('other-workspace')).resolves.toBe(0);
    await expect(taskStore.recoverPendingTaskTerminalEvents(h.ws)).resolves.toBe(1);
    expect((await waitForEmission(eventKey)).fire.last_payload).toMatchObject({ taskId, state: 'exited', exitCode: 2 });
    await expect(taskStore.recoverPendingTaskTerminalEvents(h.ws)).resolves.toBe(0);
  });

  it('retries a fail-soft latch failure so late exact waiters have durable fire evidence', async () => {
    const taskId = 'terminal-latch-write-failed';
    const eventKey = taskTerminalEventKey(taskId);
    await insertTask(taskId);
    await eventStore.registerAwait({ subscriberId: 'su-latch-waiter', eventKey, policy: 'wake' });
    await h.sql.unsafe(`CREATE FUNCTION harness_shared.reject_terminal_test_fire() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.event_key = 'task:terminal:terminal-latch-write-failed' THEN
        RAISE EXCEPTION 'injected terminal latch failure'; END IF; RETURN NEW; END $$`);
    await h.sql.unsafe(`CREATE TRIGGER reject_terminal_test_fire BEFORE INSERT OR UPDATE ON harness_shared.event_key_fires
      FOR EACH ROW EXECUTE FUNCTION harness_shared.reject_terminal_test_fire()`);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(taskStore.closeTask(taskId, { state: 'exited', exitCode: 0 })).resolves.toBe(true);
      expect(await h.sql`SELECT detail -> 'terminalEventPending' AS pending FROM harness_shared.task_ledger WHERE task_id = ${taskId}`)
        .toEqual([{ pending: true }]);
      expect(await h.sql`SELECT event_key FROM harness_shared.event_key_fires WHERE event_key = ${eventKey}`).toHaveLength(0);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('injected terminal latch failure'));
    } finally {
      warn.mockRestore();
      await h.sql.unsafe('DROP TRIGGER reject_terminal_test_fire ON harness_shared.event_key_fires');
      await h.sql.unsafe('DROP FUNCTION harness_shared.reject_terminal_test_fire()');
    }
    await expect(taskStore.recoverPendingTaskTerminalEvents(h.ws)).resolves.toBe(1);
    expect((await waitForEmission(eventKey)).fire.last_payload).toMatchObject({ taskId, state: 'exited', exitCode: 0 });
    // This is the unconditional evidence queried by events:await's late-registration latch.
    expect(await h.sql`SELECT fire_count FROM harness_shared.event_key_fires WHERE event_key = ${eventKey}`)
      .toEqual([{ fire_count: 1 }]);
    expect(await h.sql`SELECT count(*)::int AS count FROM harness_shared.event_wake_deliveries WHERE event_key = ${eventKey}`)
      .toEqual([{ count: 1 }]);
  });

  it('does not acknowledge a newer terminal tuple with an older in-flight emit', async () => {
    const taskId = 'terminal-upgrade-during-emit';
    await insertTask(taskId);
    await taskStore.closeTask(taskId, { state: 'ended_unobserved' }, undefined, { emitTerminal: async () => {
      await h.sql`UPDATE harness_shared.task_ledger SET state = 'exited', exit_code = 9,
        exit_reason = 'late-runner-log' WHERE task_id = ${taskId}`;
    } });
    expect(await h.sql`SELECT detail -> 'terminalEventPending' AS pending FROM harness_shared.task_ledger WHERE task_id = ${taskId}`)
      .toEqual([{ pending: true }]);
    const emitted = vi.fn(async () => true);
    await expect(taskStore.recoverPendingTaskTerminalEvents(h.ws, undefined, emitted)).resolves.toBe(1);
    expect(emitted).toHaveBeenCalledWith(expect.objectContaining({ taskId, state: 'exited', exitCode: 9, exitReason: 'late-runner-log' }));
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
