// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { DBOS, DBOSClient } from '@dbos-inc/dbos-sdk';
import { z } from 'zod';
import {
  defineTool, dispatchProjectedTool, lookupByMcpName, _resetCatalogForTests,
  type DispatchProjectedDeps, type ProjectedTool, type ToolExecutionRequest, type UnifiedToolContext,
} from '@papercusp/tooldef';
import { createOrgTestDb, type OrgTestDb } from '../test/_org-test-db';

// Redirect only the host connection. Both the invocation observer and the actual
// DBOS SDK use this private migrated Postgres database; neither ledger is mocked.
const connection = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async original => ({
  ...(await original<object>()), getOrgPg: () => ({ sql: connection.sql }),
}));
vi.mock('@papercusp/flags/server', async original => ({
  ...(await original<object>()), getFlag: vi.fn(async () => false),
}));
vi.mock('@papercusp/testing-shell/llm', async original => ({
  ...(await original<object>()), getOverride: vi.fn(() => undefined),
}));
vi.mock('./decision-ledger/emit', async original => ({
  ...(await original<object>()), recordDecisionLedger: vi.fn(),
}));
vi.mock('./agent-tools/coordination/dispatch-heartbeat', () => ({ maybeBeatPresenceOnDispatch: vi.fn() }));
// Exercise the production request-side path even though this test also hosts
// the isolated executor. enqueue/getWorkflow/listWorkflowSteps remain real SDK IO.
vi.mock('./dbos/bootstrap', () => ({ dbosStarted: () => false, withDbosIdleTxGrace: (v: string) => v }));

import { PROJECTED_DEPS, flushPendingTelemetry } from './projected-tool-deps';
import {
  configureDurableOrchestrationRuntime, startDurableOrchestration,
  bindDurableOrchestrationExecution, DURABLE_ORCHESTRATION_EXECUTION_ADAPTER,
  type DurableOrchestrationClient,
} from './dbos/durable-orchestration-workflow';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

let db: OrgTestDb;
let client: DBOSClient;
let launched = false;
const workspaceId = 'p003-original-invocation-dbos';
const ownerId = 'su-original-invocation-dbos';
const holds = new Map<string, { entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> }>();
// This is a synthetic business tool, not an executor double: the real durable
// runner checkpoints its real SQL effect as a real DBOS step.
const effectTool = {
  pluginName: 'p003-dbos-probe', description: 'Private original invocation effect',
  inputSchema: { type: 'object' }, capabilities: [], effect: 'write', idempotent: true,
  expose: { mcp: { name: 'probe:original_invocation_effect' } },
  fn: async (args: { key: string }) => {
    const hold = holds.get(args.key)!;
    await db.adminSql`INSERT INTO harness_shared.original_invocation_dbos_effects VALUES (${args.key}, 1)`;
    hold.entered.resolve();
    await hold.release.promise;
    return { content: [{ type: 'text' as const, text: JSON.stringify({ key: args.key, value: 1 }) }] };
  },
} as ProjectedTool;

beforeAll(async () => {
  db = await createOrgTestDb(); connection.sql = db.adminSql;
  await db.adminSql.unsafe(`CREATE TABLE harness_shared.original_invocation_dbos_effects (
    call_id text PRIMARY KEY, value integer NOT NULL
  )`);
  DBOS.setConfig({ name: 'p003-original-invocation-dbos', systemDatabaseUrl: db.adminDsn,
    systemDatabaseSchemaName: 'dbos', applicationVersion: 'bg-host-v1', runAdminServer: false });
  configureDurableOrchestrationRuntime({
    tools: () => [effectTool], allowedFor: () => new Set(['probe:original_invocation_effect']),
    excluded: new Set(), deps: () => ({}), inner: (_tool, _name, _args, ctx, next) => next(ctx),
  });
  await DBOS.launch(); launched = true;
  client = await DBOSClient.create({ systemDatabaseUrl: db.adminDsn, systemDatabaseSchemaName: 'dbos' });
}, 180_000);

afterAll(async () => {
  for (const hold of holds.values()) hold.release.resolve();
  if (launched) await DBOS.shutdown();
  await client?.destroy();
  configureDurableOrchestrationRuntime(null);
  _resetCatalogForTests();
  await flushPendingTelemetry();
  await db?.cleanup();
});

function context(controller: AbortController, request: ToolExecutionRequest): UnifiedToolContext {
  return {
    workspaceId, harnessSlug: 'papercusp', role: 'operator', uiClientId: ownerId,
    isSuperuser: true, runId: 'run-original-dbos', spawnId: 'spawn-original-dbos', transport: 'mcp',
    executionDeadlineAtMs: Date.now() + 60_000, transportResponseDeadlineAtMs: Date.now() + 55_000,
    signal: controller.signal, toolExecution: request, log: () => {}, progress: () => {}, emit: () => {},
    principal: { slug: 'principal-original-dbos', kind: 'system', workspaceId,
      authMethod: 'process-internal', trust: 'trusted', capabilities: new Set(['tasks:read']), roles: new Set(['operator']) },
  };
}

async function invocation(ref: string) {
  const rows = await db.adminSql<{ metadata_json: Record<string, any> }[]>`
    SELECT metadata_json FROM harness_shared.tool_invocations
    WHERE workspace_id=${workspaceId} AND id=${ref.substring('tool-invocation:'.length)}::bigint`;
  expect(rows).toHaveLength(1);
  return rows[0].metadata_json;
}

describe('original invocation observer with real DBOS and Postgres', () => {
  it.each(['request-expired', 'response-lost'] as const)(
    'retains the original real workflow and single SQL effect after %s, then reattaches from a fresh dispatcher', async response => {
      const key = randomUUID(), hold = { entered: deferred(), release: deferred() };
      holds.set(key, hold);
      const controller = new AbortController();
      const enqueue = vi.fn<DurableOrchestrationClient['enqueue']>((options, input) => client.enqueue(options, input));
      const requestClient: DurableOrchestrationClient = {
        enqueue, getWorkflow: id => client.getWorkflow(id), listWorkflowSteps: id => client.listWorkflowSteps(id),
        cancelWorkflow: id => client.cancelWorkflow(id), send: (id, msg, topic, dedup) => client.send(id, msg, topic, dedup),
      };
      const clientDeps = { client: async () => requestClient };
      const handler = vi.fn(async (_args: {}, ctx: UnifiedToolContext) => {
        const admitted = await startDurableOrchestration({
          runKey: key, script: `return await tools.call('probe:original_invocation_effect', { key: '${key}' });`,
          caller: { ownerId: ctx.uiClientId!, workspaceId: ctx.workspaceId!, harnessSlug: ctx.harnessSlug,
            role: ctx.role!, principal: { kind: ctx.principal!.kind, slug: ctx.principal!.slug,
              workspaceId: ctx.principal!.workspaceId } },
          pin: { sourceSha256: 'private-original-script', bindingsSha256: 'private-original-bindings' }, timeoutSec: 60,
        }, clientDeps);
        await hold.entered.promise; // a committed effect, with its DBOS step still running
        if (response === 'request-expired') controller.abort();
        return { content: [{ type: 'text' as const, text: JSON.stringify(admitted) }], structuredContent: admitted };
      });
      const definition = defineTool({ name: 'example:original_dbos_' + response.replace('-', '_'),
        description: 'Private real DBOS invocation integration fixture', capability: 'tasks:read',
        requirePrincipal: false, agentRoles: ['operator'], args: z.object({}), handler,
        execution: { lifecycle: 'independent', adapter: DURABLE_ORCHESTRATION_EXECUTION_ADAPTER },
      });
      const tool = lookupByMcpName(definition.name)!;
      const observed = PROJECTED_DEPS.invocationObserver!;
      let originalRef = '', originalSelection: unknown;
      const deps: DispatchProjectedDeps = {
        invocationObserver: {
          begin: async req => {
            originalSelection = structuredClone(req.selection);
            return originalRef = await observed.begin(req);
          }, settle: req => observed.settle(req),
        }, executionAdapter: req => bindDurableOrchestrationExecution(req, clientDeps),
      };
      try {
        const produced = await dispatchProjectedTool(tool, definition.name, {}, context(controller, { mode: 'async' }), deps);
        expect(produced, JSON.stringify(produced)).toMatchObject({ ok: true });
        const pending = await invocation(originalRef);
        const handle = pending.executionObservation.handle as string;
        expect(handle).toBe('orchestrate-durable:' + workspaceId + ':' + key);
        expect(pending.originalInvocation.selection).toEqual(originalSelection);
        expect(pending.originalInvocation).toMatchObject({ ownerId, workspaceId, harnessSlug: 'papercusp',
          audience: { ownerId, principal: { slug: 'principal-original-dbos' } } });
        expect(pending.responseObservation).toMatchObject({
          state: response === 'request-expired' ? 'request-expired' : 'produced', delivery: 'unknown',
        });
        expect(pending.executionObservation).toMatchObject({ handle, ownerId, state: 'running', terminal: false });
        expect((await client.getWorkflow(handle))?.status).toBe('PENDING');

        // The transport deliberately discards `produced`. Recovery reads the
        // persisted original reference; no caller result supplies its handle.
        hold.release.resolve();
        const outcome = await DBOS.getResult(handle, 30);
        expect(outcome).toMatchObject({ status: 'succeeded', summary: { key, value: 1 } });
        vi.resetModules();
        const freshDispatcher = (await import('@papercusp/tooldef')).dispatchProjectedTool;
        const recoveryDeps: DispatchProjectedDeps = {
          invocationObserver: observed,
          executionAdapter: req => bindDurableOrchestrationExecution(req, clientDeps),
        };
        const recovered = await freshDispatcher(tool, definition.name, {}, context(new AbortController(), { mode: 'sync', handle }), recoveryDeps);
        expect(recovered, JSON.stringify(recovered)).toMatchObject({ ok: true, result: { _meta: {
          toolExecution: { handle, ownerId, state: 'succeeded', terminal: true },
        } } });
        expect(recovered.ok && JSON.stringify(recovered.result)).toContain(key);
        expect(await invocation(originalRef)).toEqual(pending);
        expect(handler).toHaveBeenCalledOnce(); expect(enqueue).toHaveBeenCalledOnce();
        const effects = await db.adminSql`SELECT * FROM harness_shared.original_invocation_dbos_effects WHERE call_id=${key}`;
        expect(effects).toEqual([expect.objectContaining({ call_id: key, value: 1 })]);
      } finally { hold.release.resolve(); }
    }, 60_000);
});
