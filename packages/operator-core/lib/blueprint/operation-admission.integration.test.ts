import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { compileAgentSpecification, type Blueprint } from '@papercusp/orchestrator/blueprint';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { projectBlueprintToPg } from './project-to-pg';
import {
  BLUEPRINT_PROGRAM_COMPLETION_OWNER, blueprintProgramCompletionRef,
  getBlueprintOperationResult, getBlueprintOperationStatus, submitBlueprintOperation,
} from './operation-service';
import { getWorkItem, setWorkItemState } from '../work-items';
import { runWithWorkspace } from '../workspace-als';
import {
  coordProgramWorkflowId, findUnstartedAcceptedCoordPrograms, loadAcceptedCoordProgramBlueprint,
  loadAcceptedCoordProgramChild, settleAcceptedCoordProgram, submitAcceptedCoordProgramChild,
  awaitAcceptedCoordProgramChild,
} from '../dbos/coord-program-workflow';

const connection = vi.hoisted(() => ({ sql: undefined as unknown as Sql }));
vi.mock('@papercusp/db-org', async (original) => ({
  ...(await original<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: connection.sql }),
}));

const workspaceId = 'program-child-pin-it';
const harnessSlug = 'program-child-pin-harness';
let db: OrgTestDb;
let sql: Sql;

beforeAll(async () => {
  db = await createOrgTestDb();
  sql = db.adminSql;
  connection.sql = sql;
  await sql`CREATE SCHEMA IF NOT EXISTS dbos`;
  await sql`CREATE TABLE IF NOT EXISTS dbos.workflow_status (
    workflow_uuid text PRIMARY KEY, status text NOT NULL
  )`;
  await sql`
    INSERT INTO harness_shared.pots (workspace_id, pot_home_slug, public_key, keychain_id, created_at)
    VALUES (${workspaceId}, ${harnessSlug}, ${Buffer.from([0])}, 'kc-program-child-pin-harness', 0)
    ON CONFLICT (workspace_id, pot_home_slug) DO NOTHING
  `;
}, 120_000);
afterAll(async () => db?.cleanup(), 120_000);

const definition = (version: string) => compileAgentSpecification({
  source: {
    id: 'program-child-pin', version, workItem: { kind: 'feature' },
    roles: [{ id: 'worker' }],
    spine: { steps: [{ id: 'open', op: 'coord:thread-open', args: { title: 'Pinned program' } }] },
    operations: [{
      id: 'leaf', version,
      target: { kind: 'work-item', itemKind: 'feature' },
      execution: { kind: 'agent', role: 'worker' },
      inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
      acceptance: { resultSchema: { type: 'object' } },
    }, {
      id: 'root', version,
      target: { kind: 'work-item', itemKind: 'feature' },
      execution: { kind: 'program' },
      inputSchema: { type: 'object' },
      acceptance: { resultSchema: { type: 'object' } },
    }, {
      id: 'rootTask', version,
      target: { kind: 'work-item', itemKind: 'task' },
      execution: { kind: 'program' },
      inputSchema: { type: 'object' },
      acceptance: { resultSchema: { type: 'object' } },
    }],
  },
});

describe('program child admission pins the root specification', () => {
  it('bounds nested program operations by the retained recursion limit', async () => {
    const specification = definition('bounded-nesting');
    await projectBlueprintToPg(sql, { workspaceId, harnessSlug,
      blueprint: specification.configuration as Blueprint, specification });
    const root = await submitBlueprintOperation(sql, {
      workspaceId, harnessSlug, callerId: 'bounded-caller', operationId: 'root',
      requestKey: 'bounded-root', input: {}, title: 'Bounded root',
    });
    const parent = (await findUnstartedAcceptedCoordPrograms(sql))
      .find((entry) => entry.acceptedOperation?.receiptId === root.receiptId);
    expect(parent).toBeDefined();
    const child = await submitAcceptedCoordProgramChild(sql, parent!, {
      stepId: 'op-inner', operationId: 'rootTask', input: {},
    });
    const childParent = (await findUnstartedAcceptedCoordPrograms(sql))
      .find((entry) => entry.acceptedOperation?.receiptId === child.receiptId);
    expect(childParent).toBeDefined();
    await expect(submitAcceptedCoordProgramChild(sql, childParent!, {
      stepId: 'op-nested', operationId: 'root', input: {},
    })).rejects.toThrow('exceeds the accepted recursion depth');
    const receipts = await sql<Array<{ id: string }>>`
      SELECT id::text FROM harness_shared.blueprint_operation_invocations
       WHERE workspace_id = ${workspaceId} AND request_key = ${`program:${child.receiptId}:op-nested`}
    `;
    expect(receipts).toHaveLength(0);
  }, 90_000);

  it('does not relaunch a legacy terminal issue-family program root', async () => {
    const specification = definition('legacy-terminal');
    await projectBlueprintToPg(sql, { workspaceId, harnessSlug,
      blueprint: specification.configuration as Blueprint, specification });
    const root = await submitBlueprintOperation(sql, {
      workspaceId, harnessSlug, callerId: 'terminal-caller', operationId: 'rootTask',
      requestKey: 'legacy-terminal-root', input: {}, title: 'Legacy terminal root',
    });
    if (root.target.kind !== 'work-item') throw new Error('program root must be a work item');
    await sql`UPDATE harness_shared.work_items SET status = 'resolved'
      WHERE workspace_id = ${workspaceId} AND feature_id = ${root.target.id}`;
    expect((await findUnstartedAcceptedCoordPrograms(sql))
      .some((entry) => entry.acceptedOperation?.receiptId === root.receiptId)).toBe(false);
  }, 90_000);

  it('replays a child step against its root receipt and refuses a stale root attempt', async () => {
    const first = definition('child-A');
    const second = definition('child-B');
    await projectBlueprintToPg(sql, { workspaceId, harnessSlug,
      blueprint: first.configuration as Blueprint, specification: first });
    const root = await submitBlueprintOperation(sql, {
      workspaceId, harnessSlug, callerId: 'program-child-caller', operationId: 'root',
      requestKey: 'child-parent', input: {}, title: 'Parent program',
    });
    const pending = await findUnstartedAcceptedCoordPrograms(sql);
    const parent = pending.find((entry) => entry.acceptedOperation?.receiptId === root.receiptId);
    expect(parent).toBeDefined();
    await projectBlueprintToPg(sql, { workspaceId, harnessSlug,
      blueprint: second.configuration as Blueprint, specification: second });
    const call = { stepId: 'op-create-leaf', operationId: 'leaf', input: { value: 'pinned' }, title: 'Child leaf' };
    const child = await submitAcceptedCoordProgramChild(sql, parent!, call);
    expect(child.specificationRevision).toBe(first.specificationRevision);
    expect(child.target.kind).toBe('work-item');
    expect(await submitAcceptedCoordProgramChild(sql, parent!, call)).toEqual(child);
    expect(await loadAcceptedCoordProgramChild(sql, parent!, 'create-leaf', 'leaf')).toEqual(child);
    await expect(loadAcceptedCoordProgramChild(sql, parent!, 'other-leaf', 'leaf'))
      .rejects.toThrow('receipt is missing');
    await expect(awaitAcceptedCoordProgramChild(sql, parent!, {
      invokeStepId: 'create-leaf', operationId: 'leaf', deadlineAt: new Date(0).toISOString(),
    })).rejects.toThrow('did not settle before its deadline');
    await expect(submitAcceptedCoordProgramChild(sql, parent!, { ...call, input: { value: 'changed' } }))
      .rejects.toThrow('reused with different input');
    await expect(submitAcceptedCoordProgramChild(sql, parent!, { ...call, operationId: 'root' }))
      .rejects.toThrow('distinct declared operation');
    await sql`UPDATE harness_shared.work_items SET updated_ts = updated_ts + 1
      WHERE workspace_id = ${workspaceId} AND feature_id = ${(root.target as { id: string }).id}`;
    await expect(submitAcceptedCoordProgramChild(sql, parent!, { ...call, stepId: 'late-leaf' }))
      .rejects.toThrow('root attempt changed');
    await expect(awaitAcceptedCoordProgramChild(sql, parent!, {
      invokeStepId: 'create-leaf', operationId: 'leaf', deadlineAt: new Date(0).toISOString(),
    })).rejects.toThrow('root attempt changed');
  }, 90_000);

  it('accepts revision A after pointer B and refuses a changed replay', async () => {
    const first = definition('A');
    const second = definition('B');
    await projectBlueprintToPg(sql, { workspaceId, harnessSlug,
      blueprint: first.configuration as Blueprint, specification: first });
    await projectBlueprintToPg(sql, { workspaceId, harnessSlug,
      blueprint: second.configuration as Blueprint, specification: second });

    const request = { workspaceId, harnessSlug, callerId: 'program-root-1', operationId: 'leaf',
      requestKey: 'root:step-1', input: { value: 'original' }, title: 'Pinned child' };
    const accepted = await submitBlueprintOperation(sql, request,
      { expectedSpecificationRevision: first.specificationRevision });
    expect(accepted.specificationRevision).toBe(first.specificationRevision);
    expect(accepted.target.kind).toBe('work-item');
    const replay = await submitBlueprintOperation(sql, request,
      { expectedSpecificationRevision: first.specificationRevision });
    expect(replay).toEqual(accepted);
    await expect(submitBlueprintOperation(sql, request,
      { expectedSpecificationRevision: second.specificationRevision }))
      .rejects.toThrow('receipt differs from the expected specification revision');

    const [item] = await sql<Array<{ payload: { blueprintOperation: { specificationRevision: string } } }>>`
      SELECT payload FROM harness_shared.work_items
       WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug}
         AND feature_id = ${(accepted.target as { id: string }).id}
    `;
    expect(item.payload.blueprintOperation.specificationRevision).toBe(first.specificationRevision);
  }, 90_000);

  it('loads an accepted program from revision A after the mutable pointer moves to B', async () => {
    const first = definition('A');
    const second = definition('B');
    await projectBlueprintToPg(sql, { workspaceId, harnessSlug,
      blueprint: first.configuration as Blueprint, specification: first });
    const accepted = await submitBlueprintOperation(sql, {
      workspaceId, harnessSlug, callerId: 'program-caller', operationId: 'root',
      requestKey: 'pinned-root', input: {}, title: 'Pinned root',
    });
    if (accepted.target.kind !== 'work-item') throw new Error('program root must be a work item');
    const rootId = accepted.target.id;
    await projectBlueprintToPg(sql, { workspaceId, harnessSlug,
      blueprint: second.configuration as Blueprint, specification: second });

    const pinned = await loadAcceptedCoordProgramBlueprint(sql, accepted, 'program-caller');
    expect(pinned.version).toBe('A');
    expect(pinned.spine.steps?.[0]?.id).toBe('open');
    const pending = await findUnstartedAcceptedCoordPrograms(sql);
    expect(pending.map((input) => input.acceptedOperation?.receiptId)).toContain(accepted.receiptId);
    const run = { blueprintId: pinned.id, payload: {}, callerId: 'program-caller',
      workspaceId, harnessSlug, workItemId: rootId, runId: 'first',
      acceptedOperation: accepted };
    expect(coordProgramWorkflowId(run)).toBe(`coord-program:operation:${workspaceId}:${accepted.receiptId}`);
    expect(coordProgramWorkflowId({ ...run, runId: 'lost-response-retry' })).toBe(coordProgramWorkflowId(run));
    await sql`INSERT INTO dbos.workflow_status (workflow_uuid, status)
      VALUES (${coordProgramWorkflowId(run)}, 'PENDING')`;
    expect((await findUnstartedAcceptedCoordPrograms(sql))
      .some((input) => input.acceptedOperation?.receiptId === accepted.receiptId)).toBe(false);
    await sql`DELETE FROM dbos.workflow_status WHERE workflow_uuid = ${coordProgramWorkflowId(run)}`;
    expect((await findUnstartedAcceptedCoordPrograms(sql))
      .filter((input) => input.acceptedOperation?.receiptId === accepted.receiptId)).toHaveLength(1);
    await expect(loadAcceptedCoordProgramBlueprint(sql, accepted, 'different-caller'))
      .rejects.toThrow('handle does not match its durable receipt');
    await expect(loadAcceptedCoordProgramBlueprint(sql,
      { ...accepted, specificationRevision: second.specificationRevision }, 'program-caller'))
      .rejects.toThrow('handle does not match its durable receipt');
    const [root] = await sql<Array<{ updated_ts: string | number }>>`
      SELECT updated_ts FROM harness_shared.work_items
       WHERE workspace_id = ${workspaceId} AND feature_id = ${rootId}`;
    const attempt = { workspaceId, harnessSlug, workItemId: rootId,
      receiptId: accepted.receiptId, operationId: accepted.operationId,
      specificationRevision: accepted.specificationRevision,
      updatedTs: Number(root.updated_ts), requireUncancelled: true };
    const closed = await runWithWorkspace(workspaceId, () => setWorkItemState(rootId, 'done', {
      harness: harnessSlug, by: BLUEPRINT_PROGRAM_COMPLETION_OWNER,
      completionRef: blueprintProgramCompletionRef(accepted, 'succeeded'),
      completionAuthority: 'validated', outputPayload: { outcome: 'done', resolved: true },
      acceptedProgramAttempt: attempt,
    }));
    expect(closed?.state).toBe('done');
    expect(await getBlueprintOperationResult(sql, accepted, 'program-caller'))
      .toMatchObject({ state: 'ready', output: { outcome: 'done', resolved: true } });
    expect((await findUnstartedAcceptedCoordPrograms(sql))
      .some((input) => input.acceptedOperation?.receiptId === accepted.receiptId)).toBe(false);
  }, 90_000);

  it('fences a successful program close after cancellation and settles the canonical root as cancelled', async () => {
    const first = definition('cancel');
    await projectBlueprintToPg(sql, { workspaceId, harnessSlug,
      blueprint: first.configuration as Blueprint, specification: first });
    const accepted = await submitBlueprintOperation(sql, {
      workspaceId, harnessSlug, callerId: 'program-caller', operationId: 'root',
      requestKey: 'cancel-root', input: {}, title: 'Cancelled root',
    });
    if (accepted.target.kind !== 'work-item') throw new Error('program root must be a work item');
    const rootId = accepted.target.id;
    const [root] = await sql<Array<{ updated_ts: string | number }>>`
      SELECT updated_ts FROM harness_shared.work_items
       WHERE workspace_id = ${workspaceId} AND feature_id = ${rootId}`;
    const attempt = { workspaceId, harnessSlug, workItemId: rootId,
      receiptId: accepted.receiptId, operationId: accepted.operationId,
      specificationRevision: accepted.specificationRevision,
      updatedTs: Number(root.updated_ts), requireUncancelled: true };
    await sql`UPDATE harness_shared.work_items
      SET payload = jsonb_set(payload, '{blueprintCancellation}', '{"eventId":"test"}'::jsonb, true)
      WHERE workspace_id = ${workspaceId} AND feature_id = ${rootId}`;
    const raced = await runWithWorkspace(workspaceId, () => setWorkItemState(rootId, 'done', {
      harness: harnessSlug, by: BLUEPRINT_PROGRAM_COMPLETION_OWNER,
      completionRef: blueprintProgramCompletionRef(accepted, 'succeeded'),
      completionAuthority: 'validated', outputPayload: { outcome: 'done', resolved: true },
      acceptedProgramAttempt: attempt,
    }));
    expect(raced).toBeNull();
    const cancelled = await runWithWorkspace(workspaceId, () => setWorkItemState(rootId, 'dropped', {
      harness: harnessSlug, by: BLUEPRINT_PROGRAM_COMPLETION_OWNER,
      completionRef: `blueprint-program:cancelled:receipt:${accepted.receiptId}`,
      completionAuthority: 'validated',
      acceptedProgramAttempt: { ...attempt, requireUncancelled: false },
    }));
    expect(cancelled?.state).toBe('dropped');
    expect(await getBlueprintOperationStatus(sql, accepted, 'program-caller'))
      .toMatchObject({ phase: 'terminal', outcome: 'cancelled' });
  }, 90_000);

  it('stores a typed result on a canonical issue-family program root', async () => {
    const specification = definition('task-root');
    await projectBlueprintToPg(sql, { workspaceId, harnessSlug,
      blueprint: specification.configuration as Blueprint, specification });
    const accepted = await submitBlueprintOperation(sql, {
      workspaceId, harnessSlug, callerId: 'program-caller', operationId: 'rootTask',
      requestKey: 'task-root', input: {}, title: 'Task root',
    });
    if (accepted.target.kind !== 'work-item') throw new Error('program root must be a work item');
    const rootId = accepted.target.id;
    const canonical = await runWithWorkspace(workspaceId, () => getWorkItem(rootId, harnessSlug));
    expect({ id: canonical?.id, harness: canonical?.harness })
      .toEqual({ id: rootId, harness: harnessSlug });
    const pending = await findUnstartedAcceptedCoordPrograms(sql);
    const input = pending.find((entry) => entry.acceptedOperation?.receiptId === accepted.receiptId);
    expect(input).toBeDefined();
    const settled = await settleAcceptedCoordProgram(sql, input!, { outcome: 'done', resolved: true });
    expect(settled).toMatchObject({ phase: 'terminal', outcome: 'succeeded' });
    expect(await settleAcceptedCoordProgram(sql, input!, { outcome: 'failed', resolved: false }))
      .toMatchObject({ phase: 'terminal', outcome: 'succeeded' });
    expect(await getBlueprintOperationResult(sql, accepted, 'program-caller'))
      .toMatchObject({ state: 'ready', output: { outcome: 'done', resolved: true } });
  }, 90_000);

  it('records an unresolved program as a canonical failed root', async () => {
    const specification = definition('unresolved');
    await projectBlueprintToPg(sql, { workspaceId, harnessSlug,
      blueprint: specification.configuration as Blueprint, specification });
    const accepted = await submitBlueprintOperation(sql, {
      workspaceId, harnessSlug, callerId: 'program-caller', operationId: 'root',
      requestKey: 'unresolved-root', input: {}, title: 'Unresolved root',
    });
    const pending = await findUnstartedAcceptedCoordPrograms(sql);
    const input = pending.find((entry) => entry.acceptedOperation?.receiptId === accepted.receiptId);
    expect(input).toBeDefined();
    expect(await settleAcceptedCoordProgram(sql, input!, { outcome: 'no-gate-match', resolved: false }))
      .toMatchObject({ phase: 'terminal', outcome: 'failed' });
    expect(await getBlueprintOperationResult(sql, accepted, 'program-caller'))
      .toMatchObject({ state: 'failed' });
  }, 90_000);
});
