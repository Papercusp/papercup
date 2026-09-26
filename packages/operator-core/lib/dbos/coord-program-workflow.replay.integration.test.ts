import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import type { DBOS as DBOSType } from '@dbos-inc/dbos-sdk';
import { compileAgentSpecification, type Blueprint } from '@papercusp/orchestrator/blueprint';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';

const connection = vi.hoisted(() => ({ sql: undefined as unknown as Sql }));
vi.mock('@papercusp/db-org', async (original) => ({
  ...(await original<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: connection.sql }),
}));

const workspaceId = 'accepted-program-replay-it';
const harnessSlug = 'accepted-program-replay-harness';
let db: OrgTestDb;
let sql: Sql;
let DBOS: typeof DBOSType;
let workflow: typeof import('./coord-program-workflow');
let service: typeof import('../blueprint/operation-service');

beforeAll(async () => {
  db = await createOrgTestDb();
  sql = db.adminSql;
  connection.sql = sql;
  await sql`
    INSERT INTO harness_shared.pots (workspace_id, pot_home_slug, public_key, keychain_id, created_at)
    VALUES (${workspaceId}, ${harnessSlug}, ${Buffer.from([0])}, 'kc-accepted-program-replay', 0)
    ON CONFLICT (workspace_id, pot_home_slug) DO NOTHING
  `;
  ({ DBOS } = await import('@dbos-inc/dbos-sdk'));
  DBOS.setConfig({
    name: 'accepted-program-replay-test', systemDatabaseUrl: db.adminDsn,
    systemDatabaseSchemaName: 'dbos', applicationVersion: 'test-v1', runAdminServer: false,
  });
  workflow = await import('./coord-program-workflow');
  service = await import('../blueprint/operation-service');
  await DBOS.launch();
  const { projectBlueprintToPg } = await import('../blueprint/project-to-pg');
  const specification = compileAgentSpecification({ source: {
    id: 'accepted-program-replay', version: '1', workItem: { kind: 'feature' },
    roles: [{ id: 'worker' }],
    spine: { steps: [{ id: 'aggregate', op: 'vote:aggregate', args: { posts: [] } }] },
    operations: [{
      id: 'root', version: '1', target: { kind: 'work-item', itemKind: 'feature' },
      execution: { kind: 'program' }, inputSchema: { type: 'object' },
      acceptance: { resultSchema: { type: 'object' } },
    }, {
      id: 'rootInvalid', version: '1', target: { kind: 'work-item', itemKind: 'feature' },
      execution: { kind: 'program' }, inputSchema: { type: 'object' },
      acceptance: { resultSchema: { type: 'object', required: ['approved'],
        properties: { approved: { const: true } } } },
    }],
  } });
  await projectBlueprintToPg(sql, { workspaceId, harnessSlug,
    blueprint: specification.configuration as Blueprint, specification });
}, 120_000);

afterAll(async () => {
  if (DBOS) await DBOS.shutdown();
  await db?.cleanup();
}, 120_000);

async function acceptedRoot(requestKey: string, operationId = 'root') {
  const handle = await service.submitBlueprintOperation(sql, {
    workspaceId, harnessSlug, callerId: 'program-replay-caller', operationId,
    requestKey, input: {}, title: `Program ${requestKey}`,
  });
  const input = (await workflow.findUnstartedAcceptedCoordPrograms(sql))
    .find((candidate) => candidate.acceptedOperation?.receiptId === handle.receiptId);
  expect(input).toBeDefined();
  return { handle, input: input! };
}

describe('accepted program on real DBOS persistence', () => {
  it('settles one canonical result and replays it after a DBOS restart', async () => {
    const { handle, input } = await acceptedRoot('replay-root');
    const workflowId = await workflow.startCoordProgram(input);
    expect(await DBOS.getResult(workflowId, 30)).toMatchObject({ outcome: 'done', resolved: true });
    expect(await service.getBlueprintOperationResult(sql, handle, 'program-replay-caller'))
      .toMatchObject({ state: 'ready', output: { outcome: 'done', resolved: true } });
    expect((await workflow.findUnstartedAcceptedCoordPrograms(sql))
      .some((candidate) => candidate.acceptedOperation?.receiptId === handle.receiptId)).toBe(false);

    await DBOS.shutdown();
    await DBOS.launch();
    expect(await DBOS.retrieveWorkflow(workflowId).getResult())
      .toMatchObject({ outcome: 'done', resolved: true });
    expect(await service.getBlueprintOperationResult(sql, handle, 'program-replay-caller'))
      .toMatchObject({ state: 'ready', output: { outcome: 'done', resolved: true } });
  }, 90_000);

  it('turns a pre-launch cancellation into canonical cancelled settlement', async () => {
    const { handle, input } = await acceptedRoot('cancel-root');
    if (handle.target.kind !== 'work-item') throw new Error('program root must be a work item');
    await sql`
      UPDATE harness_shared.work_items
         SET payload = jsonb_set(payload, '{blueprintCancellation}', '{"eventId":"test"}'::jsonb, true)
       WHERE workspace_id = ${workspaceId} AND feature_id = ${handle.target.id}
    `;
    const workflowId = await workflow.startCoordProgram(input);
    expect(await DBOS.getResult(workflowId, 30))
      .toMatchObject({ outcome: 'cancelled', resolved: false });
    expect(await service.getBlueprintOperationStatus(sql, handle, 'program-replay-caller'))
      .toMatchObject({ phase: 'terminal', outcome: 'cancelled' });
    expect(await service.getBlueprintOperationResult(sql, handle, 'program-replay-caller'))
      .toMatchObject({ state: 'cancelled' });
  }, 90_000);

  it('returns canonical failure when a program result violates its pinned output contract', async () => {
    const { handle, input } = await acceptedRoot('invalid-output-root', 'rootInvalid');
    const workflowId = await workflow.startCoordProgram(input);
    expect(await DBOS.getResult(workflowId, 30))
      .toMatchObject({ outcome: 'failed', resolved: false });
    expect(await service.getBlueprintOperationResult(sql, handle, 'program-replay-caller'))
      .toMatchObject({ state: 'failed', status: { phase: 'terminal', outcome: 'failed' } });
  }, 90_000);
});
