import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { OrgTestDb } from '../test/_org-test-db';
import { getRunAsync, TestingRunSnapshotUnavailableError } from './testing-run-store';

const { createOrgTestDb } = await import('../test/_org-test-db');

describe('foreground evidence recovery (real PG)', () => {
  let db: OrgTestDb;
  const scope = { workspaceId: 'foreground-workspace', harnessSlug: 'foreground-harness', root: '/fixture' };
  const runId = 'foreground-origin';

  beforeAll(async () => { db = await createOrgTestDb(); }, 120_000);
  afterAll(async () => { await db?.cleanup(); });
  beforeEach(async () => {
    await db.adminSql`DELETE FROM harness_shared.task_ledger`;
  });

  async function insertTask(input: {
    taskId?: string; state?: string; workspace?: string; harness?: string; root?: string;
    launchedBy?: string; foreground?: boolean;
  } = {}) {
    const taskId = input.taskId ?? 'foreground-task';
    await db.adminSql`
      INSERT INTO harness_shared.task_ledger (
        task_id, root_task_id, workspace_id, harness_slug, cwd, class, title, argv, launched_by, state, detail
      ) VALUES (
        ${taskId}, ${taskId}, ${input.workspace ?? scope.workspaceId}, ${input.harness ?? scope.harnessSlug},
        ${input.root ?? scope.root}, 'test-run', 'foreground test', ${db.adminSql.json(['node', 'scripts/test-files.mjs'])},
        ${input.launchedBy ?? `testing:run:${runId}`}, ${input.state ?? 'running'},
        ${db.adminSql.json({ runGroup: runId, foreground: input.foreground ?? true })}
      )
    `;
  }

  it.each(['pending', 'running'])('preserves a %s foreground task with no snapshot', async state => {
    await insertTask({ state });
    await expect(getRunAsync(runId, db.adminSql, scope)).resolves.toMatchObject({
      runId, taskId: 'foreground-task', status: 'running', finishedAt: null, exitCode: null,
    });
  });

  it.each([
    { workspace: 'other-workspace' }, { harness: 'other-harness' }, { root: '/other-root' },
    { launchedBy: 'testing:run:other-origin' }, { foreground: false },
  ])('does not use a task outside the exact origin scope: %j', async input => {
    await insertTask(input);
    const positive = await db.adminSql`SELECT task_id FROM harness_shared.task_ledger WHERE task_id = 'foreground-task'`;
    expect(positive).toHaveLength(1);
    await expect(getRunAsync(runId, db.adminSql, scope)).resolves.toBeNull();
  });

  it('keeps an ambiguous foreground identity unknown', async () => {
    await insertTask();
    await insertTask({ taskId: 'other-foreground-task' });
    await expect(getRunAsync(runId, db.adminSql, scope)).rejects.toBeInstanceOf(TestingRunSnapshotUnavailableError);
  });

  it('does not use a stranded process as evidence that the whole task ended', async () => {
    await insertTask({ state: 'stranded' });
    await expect(getRunAsync(runId, db.adminSql, scope)).rejects.toBeInstanceOf(TestingRunSnapshotUnavailableError);
  });

  it('does not turn an ended foreground task into a passing test', async () => {
    await insertTask({ state: 'ended_unobserved' });
    await expect(getRunAsync(runId, db.adminSql, scope)).resolves.toBeNull();
  });
});
