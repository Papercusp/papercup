import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { applyMigrationForTest, createFreshPgDb, type FreshPgDb } from '../../../test/_pg-helpers';
import { evaluateByocReadiness, readByocReadiness, readByocReleaseSubject } from './byoc-readiness';
import { releaseStageInputHash } from '../../../../../scripts/lib/release-task-journal';

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

  it('binds and probes only the selected journal publication; a later unknown or wrong scope cannot borrow it', async () => {
    const publication = {
      bundleSha256: 'a'.repeat(64),
      manifestSha256: createHash('sha256').update('{}').digest('hex'),
    };
    const receipts = [
      { sequence: 0, operationId: emptyJournal.operationId, requestIdentity: 'build-req', stage: 'release.build.linux',
        state: 'committed', inputHash: 'b'.repeat(64), evidenceRefs: ['build:fixture'], recordedAt: '2026-09-20T00:00:00Z' },
      { sequence: 1, operationId: emptyJournal.operationId, requestIdentity: 'publish-req', stage: 'publish.finalize',
        state: 'committed', inputHash: releaseStageInputHash(publication),
        evidenceRefs: [`provider:finalization:${publication.manifestSha256}`], recordedAt: '2026-09-20T00:00:01Z' },
    ];
    const journal = {
      ...emptyJournal, source: { sha: '1'.repeat(40) },
      artifactIdentity: { bundleSha256: publication.bundleSha256 },
      currentStage: 'publish.finalize', currentState: 'committed', cursor: receipts.length, receipts,
    };
    await insert(subject.taskId, { journal });
    await expect(readByocReleaseSubject(subject, db.sql)).resolves.toMatchObject({
      publicationInput: { ...publication, taskId: subject.taskId, operationId: journal.operationId },
    });
    const fetcher = vi.fn(async () => new Response('{}'));
    // A real SQL-selected journal reaches the real probe: the invalid fetched bytes cannot pass.
    await expect(readByocReadiness({ ...subject, bar: 'R-4' }, db.sql, fetcher)).resolves.toMatchObject({
      verdict: 'fail', failedMilestones: expect.arrayContaining(['publication:manifest:incomplete']),
    });
    expect(fetcher).toHaveBeenCalledOnce();
    fetcher.mockClear();
    await readByocReadiness({ ...subject, workspaceId: 'foreign', bar: 'R-4' }, db.sql, fetcher);
    await readByocReadiness({ ...subject, workItemId: 'foreign', bar: 'R-4' }, db.sql, fetcher);
    expect(fetcher).not.toHaveBeenCalled();
    await db.sql`
      UPDATE harness_shared.task_ledger
         SET detail = jsonb_build_object('release', ${JSON.stringify({
           ...journal, cursor: 3, currentState: 'unknown',
           receipts: [...receipts, { ...receipts[1], sequence: 2, state: 'unknown' }],
         })}::text::jsonb)
       WHERE task_id = ${subject.taskId}
    `;
    await expect(readByocReadiness({ ...subject, bar: 'R-4' }, db.sql, fetcher)).resolves.toMatchObject({
      verdict: 'unknown', unverifiedEvidence: expect.arrayContaining(['public-bytes', 'signature']),
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
