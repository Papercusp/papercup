// @vitest-environment node
/** A request-only host persists a durable spawn before the executor exists. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DBOS as DBOSType, DBOSClient as DBOSClientType } from '@dbos-inc/dbos-sdk';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';

const h = vi.hoisted(() => ({
  invoke: vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({ ok: true, exitCode: 0, agentOutput: 'decision: done' }), { status: 200 })),
}));
vi.mock('../loopback-fetch', () => ({ loopbackFetch: h.invoke }));

let db: OrgTestDb;
let DBOS: typeof DBOSType;
let client: DBOSClientType;
let durableSpawnFire: typeof import('./durable-spawn').durableSpawnFire;
let launched = false;

beforeAll(async () => {
  db = await createOrgTestDb();
  const sdk = await import('@dbos-inc/dbos-sdk');
  DBOS = sdk.DBOS;
  DBOS.setConfig({
    name: 'durable-spawn-request-only-test',
    systemDatabaseUrl: db.adminDsn,
    systemDatabaseSchemaName: 'dbos',
    applicationVersion: 'bg-host-v1',
    runAdminServer: false,
  });
  ({ durableSpawnFire } = await import('./durable-spawn'));
  // Initialize the DBOS system schema, then stop the executor. The request
  // below is accepted while no executor is alive, as on a request-only host.
  await DBOS.launch();
  await DBOS.shutdown();
  client = await sdk.DBOSClient.create({ systemDatabaseUrl: db.adminDsn, systemDatabaseSchemaName: 'dbos' });
}, 120_000);

afterAll(async () => {
  if (launched) await DBOS.shutdown();
  await client?.destroy();
  await db?.cleanup();
});

describe('request-only durable spawn acceptance', () => {
  it('persists request-only and lost-response enqueues before executor launch, then starts each child once', async () => {
    const input = {
      url: 'http://invalid.invalid/invoke?role=worker',
      body: { kickoff: 'go', spawnModel: 'codex' },
      idempotencyKey: `request-only-${Date.now()}`,
      label: 'test/worker',
    };
    const workflowId = `durable-spawn:${input.idempotencyKey}`;
    const deps = { remoteClient: async () => client };
    expect(await durableSpawnFire(input, deps)).toBe(true);
    expect((await client.getWorkflow(workflowId))?.status).toBe('ENQUEUED');
    const uncertain = { ...input, idempotencyKey: `${input.idempotencyKey}-uncertain` };
    const uncertainWorkflowId = `durable-spawn:${uncertain.idempotencyKey}`;
    const lostReplyClient = {
      enqueue: async (options: Parameters<DBOSClientType['enqueue']>[0], request: typeof uncertain) => {
        await client.enqueue(options, request);
        throw new Error('enqueue response lost after commit');
      },
      getWorkflow: (id: string) => client.getWorkflow(id),
    };
    expect(await durableSpawnFire(uncertain, { remoteClient: async () => lostReplyClient })).toBe(true);
    expect((await client.getWorkflow(uncertainWorkflowId))?.status).toBe('ENQUEUED');
    expect(h.invoke).not.toHaveBeenCalled();

    await DBOS.launch();
    launched = true;
    await DBOS.getResult(workflowId, 20);
    await DBOS.getResult(uncertainWorkflowId, 20);
    expect(h.invoke).toHaveBeenCalledTimes(2);
    const childIds = h.invoke.mock.calls.map((call) =>
      JSON.parse((call[1] as RequestInit).body as string).spawnRecordId as string,
    );
    expect(childIds.sort()).toEqual([workflowId, uncertainWorkflowId].sort());

    // A retry with the same accepted key finds the same workflow, not a child.
    expect(await durableSpawnFire(input, deps)).toBe(true);
    expect(await durableSpawnFire(uncertain, deps)).toBe(true);
    expect(h.invoke).toHaveBeenCalledTimes(2);
  }, 60_000);
});
