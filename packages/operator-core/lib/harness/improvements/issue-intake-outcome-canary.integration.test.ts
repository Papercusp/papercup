/** Current-build, real-Postgres canary for the WI-10002739 intake/outcome repair. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { teardownTestPg } from '@papercusp/test-config/pg';
import { createOrgTestDb, type OrgTestDb } from '../../../test/_org-test-db';
import type { FilterNode } from '../../scheduler/claim-spec';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

const { captureImprovement } = await import('./capture-core');
const { runWorkItemAdmissionPromoter } = await import('../../work-items-admission-promoter');
const { readIssueClaimability } = await import('../../scheduler/get-next');
const { createWorkItem, setWorkItemState, getCompletionIntegrityStats } = await import('../../work-items');

let db: OrgTestDb;
beforeAll(async () => {
  db = await createOrgTestDb();
  h.sql = db.adminSql;
}, 180_000);
afterAll(async () => {
  await db?.cleanup();
  if (!process.env.KEEP_TEST_PG) await teardownTestPg();
});

describe('issue intake and declared outcome current-build canary', () => {
  it('moves an ordinary captured bug from pending to admitted before self-pull', async () => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const captured = await captureImprovement({
      title: `scoped intake transition ${suffix}`,
      kind: 'bug',
      scope: 'harness:papercusp',
      createdBy: 'su-canary',
    });
    expect(captured.created).toBe(true);
    const id = captured.issue!.id;
    const [before] = await db.adminSql<{ workspace_id: string; admission: string | null }[]>`
      SELECT workspace_id, admission FROM harness_shared.work_items WHERE feature_id = ${id}`;
    expect(before.admission).toBe('pending');
    const filter: FilterNode = { field: 'id', op: 'in', value: [id] };
    const claimable = () => readIssueClaimability(filter, {
      harness: 'papercusp', workspaceId: before.workspace_id, states: ['open'],
      assignee: 'su-canary', client: db.adminSql,
    }, { limit: 10 });
    expect((await claimable()).rows).toEqual([]);

    const llmCall = vi.fn(async () => { throw new Error('unique canary should not need model judgment'); });
    const promoted = await runWorkItemAdmissionPromoter({
      workspaceId: before.workspace_id, harnessSlug: 'papercusp', sql: db.adminSql,
      targetItemIds: [id], batchSize: 1, runId: `canary-${suffix}`, llmCall,
    });
    expect(promoted).toMatchObject({ promoted: 1, merged: 0, modelCalled: false });
    expect(llmCall).not.toHaveBeenCalled();
    const [after] = await db.adminSql<{ admission: string | null }[]>`
      SELECT admission FROM harness_shared.work_items WHERE feature_id = ${id}`;
    expect(after.admission).toBe('admitted');
    expect((await claimable()).rows.map((row) => row.id)).toEqual([id]);
  });

  it('persists a declared change and counts the earlier legacy close as unknown', async () => {
    const harness = 'papercusp';
    const changed = await createWorkItem({ kind: 'change', title: 'declared outcome canary', harness, createdBy: 'su-canary' });
    await setWorkItemState(changed.id, 'resolved', {
      harness, by: 'su-canary', completionAuthority: 'committed',
      completionEvidence: {
        verifiedHow: 'unit', testsRun: 'scoped real-PG canary', testResult: 'passed',
        workOutcome: 'introduced-change',
      },
    });
    const legacy = await createWorkItem({ kind: 'change', title: 'legacy outcome canary', harness, createdBy: 'su-canary' });
    await setWorkItemState(legacy.id, 'resolved', { harness, by: 'su-canary', completionRef: 'legacy verification' });
    const [row] = await db.adminSql<{ work_outcome: string | null }[]>`
      SELECT payload #>> '{_completionEvidence,workOutcome}' AS work_outcome
        FROM harness_shared.work_items WHERE feature_id = ${changed.id}`;
    expect(row.work_outcome).toBe('introduced-change');
    expect((await getCompletionIntegrityStats(harness)).declaredWorkOutcomes).toMatchObject({
      introducedChange: 1, unknown: 1,
    });
  });
});
