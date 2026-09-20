import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { applyMigrationForTest, createFreshPgDb, type FreshPgDb } from '../../../test/_pg-helpers';
import { evaluateByocReadiness, readByocReleaseSubject } from './byoc-readiness';

let db: FreshPgDb;
const subject = { workspaceId: 'byoc-exact-subject', workItemId: 'WI-acceptance', taskId: 'selected-old-task' };
const emptyJournal = {
  schemaVersion: 1, operationId: 'release-operation', cursor: 0,
  currentStage: null, currentState: null, receipts: [], spentOperationIds: [],
};

async function insert(
  taskId: string,
  overrides: { workspaceId?: string; workItemId?: string; journal?: unknown; updatedAt?: string } = {},
) {
  await db.sql`
    INSERT INTO harness_shared.task_ledger (
      task_id, workspace_id, root_task_id, class, title, argv, launched_by,
      work_item_id, confined, state, detail, updated_at
    ) VALUES (
      ${taskId}, ${overrides.workspaceId ?? subject.workspaceId}, ${taskId},
      'deploy', ${taskId}, '[]'::jsonb, 'test', ${overrides.workItemId ?? subject.workItemId},
      true, 'running', jsonb_build_object('release', ${JSON.stringify(overrides.journal ?? emptyJournal)}::text::jsonb),
      ${overrides.updatedAt ?? '2026-09-20T00:00:00Z'}::timestamptz
    )
  `;
}

beforeAll(async () => {
  db = await createFreshPgDb('byoc-readiness');
  await applyMigrationForTest(db.sql, fileURLToPath(
    new URL('../../../../../libs/papercusp/libs/db/sql/696-task-ledger.sql', import.meta.url),
  ));
});
afterAll(async () => { await db?.cleanup(); });
beforeEach(async () => { await db.sql`DELETE FROM harness_shared.task_ledger`; });

describe('BYOC acceptance exact task-ledger selection', () => {
  it('finds the explicitly selected task outside the latest-three carry window and isolates its scope', async () => {
    await insert(subject.taskId, { updatedAt: '2026-09-19T00:00:00Z' });
    for (let index = 0; index < 5; index += 1) await insert(`newer-task-${index}`);
    const selected = await readByocReleaseSubject(subject, db.sql);
    expect(selected).toMatchObject({ taskId: subject.taskId, workItemId: subject.workItemId });
    await expect(readByocReleaseSubject({ ...subject, workspaceId: 'foreign' }, db.sql)).resolves.toBeNull();
    await expect(readByocReleaseSubject({ ...subject, workItemId: 'WI-foreign' }, db.sql)).resolves.toBeNull();
    await expect(readByocReleaseSubject({ ...subject, taskId: 'missing' }, db.sql)).resolves.toBeNull();
    // The positive control still resolves after every wrong-scope read.
    await expect(readByocReleaseSubject(subject, db.sql)).resolves.toMatchObject({ taskId: subject.taskId });
  });

  it('does not certify fabricated receipt references or hide a malformed selected journal behind a healthy sibling', async () => {
    const receipts = ['release.build.linux', 'publish.finalize'].map((stage, sequence) => ({
      operationId: emptyJournal.operationId, sequence, stage, state: 'committed',
      requestIdentity: `request-${sequence}`, inputHash: 'a'.repeat(64),
      recordedAt: '2026-09-20T00:00:00Z', evidenceRefs: ['claimed:everything-verified'],
    }));
    await insert(subject.taskId, {
      journal: { ...emptyJournal, cursor: receipts.length, receipts,
        artifactIdentity: { bundleSha256: 'a'.repeat(64) },
        currentStage: 'publish.finalize', currentState: 'committed' },
    });
    const selected = await readByocReleaseSubject(subject, db.sql);
    expect(selected).not.toBeNull();
    expect(evaluateByocReadiness('R-4', subject.workItemId, [selected!])).toMatchObject({
      verdict: 'unknown', missingMilestones: [], unverifiedEvidence: expect.arrayContaining(['public-bytes', 'signature']),
    });
    await insert('healthy-sibling');
    await db.sql`
      UPDATE harness_shared.task_ledger SET detail = '{"release":{"cursor":0}}'::jsonb
      WHERE task_id = ${subject.taskId}
    `;
    await expect(readByocReleaseSubject(subject, db.sql)).resolves.toBeNull();
  });
});
