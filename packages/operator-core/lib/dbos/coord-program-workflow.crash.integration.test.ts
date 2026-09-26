/** Real process-loss recovery of an accepted program while its child is pending. */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Sql } from 'postgres';
import { compileAgentSpecification, type Blueprint } from '@papercusp/orchestrator/blueprint';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';

const connection = vi.hoisted(() => ({ sql: undefined as unknown as Sql }));
vi.mock('@papercusp/db-org', async (original) => ({
  ...(await original<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: connection.sql }),
}));

const workspaceId = 'accepted-program-crash-it';
const harnessSlug = 'accepted-program-crash-harness';
const callerId = 'accepted-program-crash-caller';
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const childPath = resolve(packageRoot, 'test/_accepted-program-crash-child.ts');
let db: OrgTestDb;
let sql: Sql;
let rootReceiptId: number;
let rootId: string;
let service: typeof import('../blueprint/operation-service');

beforeAll(async () => {
  db = await createOrgTestDb();
  sql = db.adminSql;
  connection.sql = sql;
  await sql`
    INSERT INTO harness_shared.pots (workspace_id, pot_home_slug, public_key, keychain_id, created_at)
    VALUES (${workspaceId}, ${harnessSlug}, ${Buffer.from([0])}, 'kc-accepted-program-crash', 0)
    ON CONFLICT (workspace_id, pot_home_slug) DO NOTHING
  `;
  const { projectBlueprintToPg } = await import('../blueprint/project-to-pg');
  service = await import('../blueprint/operation-service');
  const specification = compileAgentSpecification({ source: {
    id: 'accepted-program-crash', version: '1', workItem: { kind: 'feature' },
    roles: [{ id: 'worker' }],
    spine: { steps: [
      { id: 'create-leaf', op: 'blueprint:invoke-child', args: { operationId: 'leaf', input: { value: 'once' } } },
      { id: 'wait-leaf', op: 'blueprint:await-child', args: { invokeStepId: 'create-leaf', operationId: 'leaf', timeoutSec: 120 } },
    ] },
    operations: [{
      id: 'root', version: '1', target: { kind: 'work-item', itemKind: 'feature' },
      execution: { kind: 'program' }, inputSchema: { type: 'object' },
      acceptance: { resultSchema: { type: 'object' } },
    }, {
      id: 'leaf', version: '1', target: { kind: 'work-item', itemKind: 'feature' },
      execution: { kind: 'agent', role: 'worker' },
      inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
      acceptance: { resultSchema: { type: 'object' } },
    }],
  } });
  await projectBlueprintToPg(sql, { workspaceId, harnessSlug,
    blueprint: specification.configuration as Blueprint, specification });
  const root = await service.submitBlueprintOperation(sql, {
    workspaceId, harnessSlug, callerId, operationId: 'root',
    requestKey: 'root-with-child', input: {}, title: 'Crash during child wait',
  });
  if (root.target.kind !== 'work-item') throw new Error('accepted root must be a work item');
  rootReceiptId = root.receiptId;
  rootId = root.target.id;
}, 120_000);

afterAll(async () => db?.cleanup(), 120_000);

function runChild(mode: 'crash' | 'recover') {
  return spawnSync(process.execPath, ['--import', 'tsx', childPath], {
    cwd: packageRoot,
    env: {
      ...process.env,
      ACCEPTED_PROGRAM_CRASH_MODE: mode,
      ACCEPTED_PROGRAM_CRASH_DSN: db.adminDsn,
      ACCEPTED_PROGRAM_CRASH_WORKSPACE: workspaceId,
      ACCEPTED_PROGRAM_CRASH_HARNESS: harnessSlug,
      ACCEPTED_PROGRAM_CRASH_CALLER: callerId,
      ACCEPTED_PROGRAM_CRASH_RECEIPT: String(rootReceiptId),
      ACCEPTED_PROGRAM_CRASH_ROOT: rootId,
      HARNESS_ADMIN_DATABASE_URL: db.adminDsn,
      HARNESS_DATABASE_URL: db.appDsn,
      PAPERCUSP_SKIP_PG_DISCOVERY: '1',
      PAPERCUSP_WORKSPACE_ID: workspaceId,
    },
    timeout: 150_000,
    encoding: 'utf8' as const,
  });
}

it('SIGKILL during canonical child wait resumes the same root and never invokes a second child', async () => {
  const crash = runChild('crash');
  expect(crash.signal, `crash child stdout:\n${crash.stdout}\nstderr:\n${crash.stderr}`).toBe('SIGKILL');
  const key = `program:${rootReceiptId}:op-create-leaf`;
  const before = await sql<Array<{ id: string; target_ref: string }>>`
    SELECT id::text, target_ref FROM harness_shared.blueprint_operation_invocations
     WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug}
       AND request_key = ${key}
  `;
  expect(before).toHaveLength(1);
  const workflowId = `coord-program:operation:${workspaceId}:${rootReceiptId}`;
  const [pending] = await sql<Array<{ status: string }>>`
    SELECT status FROM dbos.workflow_status WHERE workflow_uuid = ${workflowId}
  `;
  expect(pending?.status).toBe('PENDING');

  const recovered = runChild('recover');
  expect(recovered.status, `recovery child stdout:\n${recovered.stdout}\nstderr:\n${recovered.stderr}`).toBe(0);
  const after = await sql<Array<{ id: string; target_ref: string }>>`
    SELECT id::text, target_ref FROM harness_shared.blueprint_operation_invocations
     WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug}
       AND request_key = ${key}
  `;
  expect(after).toEqual(before);
  const [settled] = await sql<Array<{ status: string }>>`
    SELECT status FROM dbos.workflow_status WHERE workflow_uuid = ${workflowId}
  `;
  expect(settled?.status).toBe('SUCCESS');
  const root = await service.submitBlueprintOperation(sql, {
    workspaceId, harnessSlug, callerId, operationId: 'root',
    requestKey: 'root-with-child', input: {}, title: 'Crash during child wait',
  });
  expect(await service.getBlueprintOperationResult(sql, root, callerId))
    .toMatchObject({ state: 'cancelled', status: { phase: 'terminal', outcome: 'cancelled' } });
}, 300_000);
