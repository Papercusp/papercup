import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type postgres from 'postgres';
import {
  defineTool, dispatchProjectedTool, lookupByMcpName, _resetCatalogForTests,
  type DispatchProjectedDeps, type BatchResult, type UnifiedToolContext,
} from '@papercusp/tooldef';
import { createOrgTestDb, type OrgTestDb } from '../test/_org-test-db';

// Only the connection is substituted: statements, transactions, constraints and
// commit visibility run against the maintained, migrated private Postgres fixture.
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

import { PROJECTED_DEPS, flushPendingTelemetry } from './projected-tool-deps';
import { idopAuthorityValue } from './agent-identities/permission-input-data';

type Observer = NonNullable<DispatchProjectedDeps['invocationObserver']>;
type Begin = Parameters<Observer['begin']>[0];
type Settle = Parameters<Observer['settle']>[0];
let db: OrgTestDb;
const observer = PROJECTED_DEPS.invocationObserver!;
const workspaceId = 'p003-original-invocation-pg';
const ownerId = 'su-original-invocation-pg';

beforeAll(async () => {
  db = await createOrgTestDb();
  connection.sql = db.adminSql;
  await db.adminSql.unsafe(`CREATE TABLE harness_shared.original_invocation_probe_effects (
    call_id text PRIMARY KEY, value integer NOT NULL
  )`);
}, 180_000);
afterEach(() => _resetCatalogForTests());
afterAll(async () => { await flushPendingTelemetry(); await db?.cleanup(); });

function request(): Begin {
  return {
    toolName: 'example:p003_original', pluginName: 'agent-mcp', callId: randomUUID(),
    ctx: {
      workspaceId, harnessSlug: 'papercusp', role: 'worker', uiClientId: ownerId,
      isSuperuser: true, runId: 'run-original', spawnId: 'spawn-original',
      transport: 'mcp', signal: new AbortController().signal,
      log: () => {}, progress: () => {}, emit: () => {},
      principal: {
        slug: 'principal-original', kind: 'system', workspaceId, authMethod: 'process-internal',
        trust: 'trusted', capabilities: new Set(['example:write']), roles: new Set(['worker']),
      },
    },
    selection: { ok: true, mode: 'auto', lifecycle: 'request-bound', responseWindowMs: 100,
      executionDeadlineMs: 1000, autoYieldAfterMs: null },
  };
}

async function read(ref: string) {
  const rows = await db.adminSql<{ id: string; status: string; metadata_json: Record<string, any> }[]>`
    SELECT id::text, status, metadata_json FROM harness_shared.tool_invocations
    WHERE workspace_id=${workspaceId} AND id=${ref.substring('tool-invocation:'.length)}::bigint`;
  expect(rows).toHaveLength(1);
  return rows[0];
}
const settle = (req: Begin, ref: string, changes: Partial<Settle> = {}) => observer.settle({
  ...req, invocationRef: ref, result: { content: [] }, receipt: null, error: null, refusal: null, ...changes,
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe('original invocation ledger (real Postgres)', () => {
  it('UTB-forbidden-effects admits the allowed sibling without writing the forbidden record', async () => {
    const name = 'example:p003_forbidden';
    const keys = [randomUUID(), randomUUID()];
    const handler = vi.fn(async ({ key }: { key: string }) => {
      await db.adminSql`INSERT INTO harness_shared.original_invocation_probe_effects (call_id,value) VALUES (${key},1)`;
      return { data: { key } };
    });
    defineTool({ name, args: z.object({ key: z.string() }), requirePrincipal: false,
      capability: 'example:write', authorize: ({ input }) => ({ allow: input.key !== keys[0] }), handler });
    const result = await dispatchProjectedTool(lookupByMcpName(name)!, name, { _batch: 1,
      items: keys.map(key => ({ itemId: key, args: { key } })) }, request().ctx, { invocationObserver: observer });
    const batch = result.result!.structuredContent as unknown as BatchResult;
    expect(batch.results.map(item => [item.itemId, item.ok])).toEqual([[keys[0], false], [keys[1], true]]);
    expect(handler).toHaveBeenCalledOnce();
    const rows = await db.adminSql`SELECT call_id FROM harness_shared.original_invocation_probe_effects WHERE call_id IN ${db.adminSql(keys)}`;
    expect(rows.map(row => row.call_id)).toEqual([keys[1]]);
  });

  it('UTB-cancel-unstarted stops the next write after the first effect cancels its parent', async () => {
    const name = 'example:p003_cancel';
    const abort = new AbortController();
    const keys = [randomUUID(), randomUUID()];
    const entered = deferred();
    const release = deferred();
    const handler = vi.fn(async ({ key }: { key: string }) => {
      await db.adminSql`INSERT INTO harness_shared.original_invocation_probe_effects (call_id,value) VALUES (${key},1)`;
      entered.resolve();
      await release.promise;
      return { data: { key } };
    });
    defineTool({ name, args: z.object({ key: z.string() }), requirePrincipal: false,
      capability: 'example:write', handler });
    const pending = dispatchProjectedTool(lookupByMcpName(name)!, name, { _batch: 1,
      items: keys.map(key => ({ itemId: key, args: { key } })) }, { ...request().ctx, signal: abort.signal },
    { invocationObserver: observer });
    await entered.promise;
    abort.abort();
    release.resolve();
    const result = await pending;
    const batch = result.result!.structuredContent as unknown as BatchResult;
    expect(batch.results).toHaveLength(2);
    expect(batch.results[1]).toMatchObject({ itemId: keys[1], ok: false, status: 'not-started' });
    expect(handler).toHaveBeenCalledOnce();
    const rows = await db.adminSql`SELECT call_id FROM harness_shared.original_invocation_probe_effects WHERE call_id IN ${db.adminSql(keys)}`;
    expect(rows.map(row => row.call_id)).toEqual([keys[0]]);
  });

  it('UTB-same-record-order refuses a stale second write at the real PostgreSQL effect boundary', async () => {
    const name = 'example:p003_cas';
    const key = randomUUID();
    await db.adminSql`INSERT INTO harness_shared.original_invocation_probe_effects (call_id,value) VALUES (${key},0)`;
    const native = vi.fn(async () => []);
    const handler = vi.fn(async ({ revision }: { revision: number }) => {
      const rows = await db.adminSql`UPDATE harness_shared.original_invocation_probe_effects
        SET value=value+1 WHERE call_id=${key} AND value=${revision} RETURNING value`;
      return rows.length ? { data: { revision: rows[0].value } }
        : { isError: true, content: [{ type: 'text' as const, text: 'stale revision' }] };
    });
    defineTool({ name, args: z.object({ revision: z.number().int() }), requirePrincipal: false,
      capability: 'example:write', effect: 'write', batch: { execute: native }, handler });
    const result = await dispatchProjectedTool(lookupByMcpName(name)!, name, { _batch: 1,
      items: ['first', 'stale'].map(itemId => ({ itemId, args: { revision: 0 } })) }, request().ctx,
    { invocationObserver: observer });
    const batch = result.result!.structuredContent as unknown as BatchResult;
    expect(batch.results.map(item => [item.itemId, item.ok])).toEqual([['first', true], ['stale', false]]);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(native).not.toHaveBeenCalled();
    const rows = await db.adminSql`SELECT value FROM harness_shared.original_invocation_probe_effects WHERE call_id=${key}`;
    expect(rows[0].value).toBe(1);
  });

  it('UTB-uncertain-replay retains a committed write after a lost response without retrying it', async () => {
    const name = 'example:p003_uncertain';
    const keys = [randomUUID(), randomUUID()];
    const abort = new AbortController();
    const native = vi.fn(async () => []);
    const handler = vi.fn(async ({ key }: { key: string }) => {
      await db.adminSql`INSERT INTO harness_shared.original_invocation_probe_effects (call_id,value) VALUES (${key},1)`;
      abort.abort();
      return { data: { key } };
    });
    defineTool({ name, args: z.object({ key: z.string() }), requirePrincipal: false,
      capability: 'example:write', effect: 'write', batch: { execute: native }, handler });
    const result = await dispatchProjectedTool(lookupByMcpName(name)!, name, { _batch: 1,
      items: keys.map(key => ({ itemId: key, args: { key } })) }, { ...request().ctx, signal: abort.signal },
    { invocationObserver: observer });
    const batch = result.result!.structuredContent as unknown as BatchResult;
    expect(batch.results.map(item => [item.itemId, item.status])).toEqual([
      [keys[0], 'unknown-effect'], [keys[1], 'not-started'],
    ]);
    expect(batch.results[0].receipt).toMatchObject({ status: 'recovery-incomplete', attemptId: expect.any(String) });
    expect(handler.mock.calls.map(([args]) => args.key)).toEqual([keys[0]]);
    expect(native).not.toHaveBeenCalled();
    const rows = await db.adminSql`SELECT call_id,value FROM harness_shared.original_invocation_probe_effects WHERE call_id IN ${db.adminSql(keys)} ORDER BY call_id`;
    expect(rows.map(row => row.call_id)).toEqual([keys[0]]);
    expect(rows.map(row => row.value)).toEqual([1]);
    const attempts = await db.adminSql`SELECT metadata_json FROM harness_shared.tool_invocations
      WHERE workspace_id=${workspaceId} AND tool_name=${name}`;
    expect(attempts).toHaveLength(1);
    expect(batch.results[0].receipt).toMatchObject({ attemptId: attempts[0].metadata_json.originalInvocation.callId });
  });

  it.each(['ok', 'refused'])('counts legacy %s calls with null metadata before reserving another slot', async status => {
    const req = request();
    req.ctx.runId = randomUUID();
    const windowKey = 'run:' + req.ctx.runId;
    const ref = await observer.begin(req);
    await db.adminSql`UPDATE harness_shared.tool_invocations
      SET status=${status}, metadata_json=NULL, window_key=${windowKey}
      WHERE workspace_id=${workspaceId} AND id=${ref.substring('tool-invocation:'.length)}::bigint`;
    expect(await PROJECTED_DEPS.readQuotaState!(req.toolName, req.ctx, windowKey)).toEqual({ count: 1 });
    expect(await PROJECTED_DEPS.reserveQuota!({ ...req, callId: randomUUID(), windowKey,
      limit: 1, signal: req.ctx.signal! })).toEqual({ allowed: false, count: 1 });
  });

  it('UTB-atomic-quota admits one effect for simultaneous parents and reuses the reserved invocation', async () => {
    const name = 'example:p003_quota';
    const runId = randomUUID();
    const handler = vi.fn(async ({ key }: { key: string }, ctx: UnifiedToolContext) => {
      await db.adminSql`INSERT INTO harness_shared.original_invocation_probe_effects (call_id,value) VALUES (${key},1)`;
      ctx.metadata?.({ quotaReservation: { state: 'released' } });
      return { data: { key } };
    });
    defineTool({ name, requirePrincipal: false, capability: 'example:write',
      args: z.object({ key: z.string() }), handler });
    const tool = lookupByMcpName(name)!;
    tool.rolesQuota = { worker: { perRun: 1 } };
    const admissions = deferred();
    let waiting = 0;
    const deps: DispatchProjectedDeps = { reserveQuota: async input => {
      if (++waiting === 2) admissions.resolve();
      await admissions.promise;
      return PROJECTED_DEPS.reserveQuota!(input);
    },
      readQuotaState: PROJECTED_DEPS.readQuotaState, invocationObserver: observer,
      recordInvocation: PROJECTED_DEPS.recordInvocation };
    const keys = [randomUUID(), randomUUID()];
    const ctx = { ...request().ctx, runId };
    const results = await Promise.all(keys.map(key => dispatchProjectedTool(tool, name, { key }, ctx, deps)));
    const items = results.flatMap(result => (result.result!.structuredContent as unknown as BatchResult).results);
    expect(waiting).toBe(2);
    expect(items.map(item => item.ok).sort()).toEqual([false, true]);
    expect(handler).toHaveBeenCalledOnce();
    const effects = await db.adminSql`SELECT * FROM harness_shared.original_invocation_probe_effects WHERE call_id IN ${db.adminSql(keys)}`;
    expect(effects).toHaveLength(1);
    await flushPendingTelemetry();
    expect(await deps.readQuotaState!(name, ctx, 'run:' + runId)).toEqual({ count: 1 });
    const rows = await db.adminSql`SELECT metadata_json FROM harness_shared.tool_invocations
      WHERE workspace_id=${workspaceId} AND tool_name=${name} AND run_id=${runId}
        AND metadata_json ? 'quotaReservation'`;
    expect(rows).toHaveLength(1);
    expect(rows[0].metadata_json.quotaReservation.state).toBe('committed');
    expect(rows[0].metadata_json.originalInvocation.callId).toBe(rows[0].metadata_json.quotaReservation.callId);
    expect(rows[0].metadata_json.executionObservation.state).toBe('succeeded');
  });

  it('releases a denied child so the next sibling can claim its slot', async () => {
    const name = 'example:p003_quota_release';
    const ctx = { ...request().ctx, runId: randomUUID() };
    const handler = vi.fn(async ({ key }: { key: string }) => ({ data: { key } }));
    defineTool({ name, requirePrincipal: false, capability: 'example:write',
      args: z.object({ key: z.string() }), authorize: async ({ input }) => ({ allow: input.key !== 'denied' }), handler });
    const tool = lookupByMcpName(name)!;
    tool.rolesQuota = { worker: { perRun: 1 } };
    const result = await dispatchProjectedTool(tool, name, { _batch: 1,
      items: [{ args: { key: 'denied' } }, { args: { key: 'ok' } }] }, ctx, {
      reserveQuota: PROJECTED_DEPS.reserveQuota, invocationObserver: observer,
      recordInvocation: PROJECTED_DEPS.recordInvocation,
    });
    expect((result.result!.structuredContent as unknown as BatchResult).results.map(item => item.ok)).toEqual([false, true]);
    expect(handler).toHaveBeenCalledOnce();
    await flushPendingTelemetry();
    expect(await PROJECTED_DEPS.readQuotaState!(name, ctx, 'run:' + ctx.runId)).toEqual({ count: 1 });
    const rows = await db.adminSql`SELECT metadata_json->'quotaReservation'->>'state' AS state
      FROM harness_shared.tool_invocations WHERE workspace_id=${workspaceId} AND tool_name=${name}
        AND run_id=${ctx.runId} AND metadata_json ? 'quotaReservation' ORDER BY id`;
    expect(rows.map(row => row.state)).toEqual(['released', 'committed']);
  });

  it('refuses to bind a different call to a quota reservation', async () => {
    const req = request();
    const reservation = await PROJECTED_DEPS.reserveQuota!({ ...req, windowKey: randomUUID(),
      limit: 1, signal: req.ctx.signal! });
    expect(reservation.allowed).toBe(true);
    if (!reservation.allowed) throw new Error('fixture reservation refused');
    await expect(observer.begin({ ...request(), invocationRef: reservation.invocationRef })).rejects.toThrow();
    await Promise.all([reservation.settle('release'), reservation.settle('release')]);
    expect((await read(reservation.invocationRef!)).metadata_json.quotaReservation.state).toBe('released');
  });

  it('commits the original audience and budgets before returning a recoverable reference', async () => {
    const req = request();
    const ref = await observer.begin(req);
    const row = await read(ref); // different committed transaction
    expect(row.status).toBe('pending');
    expect(row.metadata_json).toMatchObject({
      originalInvocation: { callId: req.callId, ownerId, workspaceId, harnessSlug: 'papercusp',
        audience: { ownerId, principal: { slug: 'principal-original', capabilities: ['example:write'] } },
        selection: { responseWindowMs: 100, executionDeadlineMs: 1000 } },
      executionObservation: { state: 'unknown' }, responseObservation: { state: 'pending', delivery: 'unknown' },
    });
  });

  it('commits exact observed privilege and session evidence to the same immutable original row', async () => {
    const req = request();
    req.ctx.isPowerUser = false;
    req.ctx.advSessionId = 291;
    req.ctx.gateBypass = { role: true, capability: false, quota: false };
    const ref = await observer.begin(req);
    const before = (await read(ref)).metadata_json.originalInvocation;
    expect(before.permissionContext).toMatchObject({ schemaVersion: 1,
      scope: 'original-dispatch-context-projection', status: 'captured' });
    const data = idopAuthorityValue(before.permissionContext.data) as UnifiedToolContext;
    expect(data).toMatchObject({ workspaceId, uiClientId: ownerId, isSuperuser: true,
      isPowerUser: false, advSessionId: 291, gateBypass: req.ctx.gateBypass });
    expect(data.principal?.capabilities).toEqual(new Set(['example:write']));
    expect(data).not.toHaveProperty('signal');
    expect(before.runtime.pid).toBe(process.pid);
    req.ctx.gateBypass.capability = true;
    await settle(req, ref);
    expect((await read(ref)).metadata_json.originalInvocation).toEqual(before);
    expect(data.gateBypass?.capability).toBe(false);
  });

  it.each(['request-expired', 'response-lost', 'unknown'] as const)(
    'persists %s separately from the existing runtime handle and original budgets', async response => {
      const req = request(); const ref = await observer.begin(req);
      const before = (await read(ref)).metadata_json.originalInvocation;
      const abort = new AbortController();
      if (response === 'request-expired') abort.abort();
      await settle({ ...req, ctx: { ...req.ctx, signal: abort.signal } }, ref, {
        receipt: {
          schemaVersion: 'tool-execution-receipt-v2', invocationRef: ref, mode: 'auto',
          responseWindowMs: 100, executionDeadlineMs: 1000,
          lifecycle: 'independent', durability: 'restart', handle: 'runtime-original', ownerId,
          adapterId: 'dbos:durable-orchestration', authority: { bindingRef: ref, fingerprint: 'original' },
          terminal: response !== 'unknown', observation: {
            response: response === 'unknown' ? 'returned' : response,
            outcome: response === 'unknown' ? 'unknown' : 'succeeded',
            observedAtMs: Date.now(), evidenceRef: ref,
          },
        },
      });
      const after = await read(ref);
      expect(after.metadata_json.originalInvocation).toEqual(before);
      expect(after.metadata_json.executionObservation).toMatchObject({ handle: 'runtime-original', ownerId,
        state: response === 'unknown' ? 'unknown' : 'succeeded' });
      expect(after.metadata_json.responseObservation).toMatchObject({
        state: response === 'unknown' ? 'returned' : response, delivery: 'unknown',
      });
    });

  it.each(['callId', 'ownerId'] as const)('rejects a missing persisted %s join, then recovers the same row', async key => {
    const req = request(); const ref = await observer.begin(req);
    const original = (await read(ref)).metadata_json.originalInvocation;
    await db.adminSql`UPDATE harness_shared.tool_invocations
      SET metadata_json=jsonb_set(metadata_json, '{originalInvocation}', (metadata_json->'originalInvocation') - ${key})
      WHERE id=${ref.substring('tool-invocation:'.length)}::bigint`;
    await expect(settle(req, ref)).rejects.toThrow('settlement join is unavailable');
    expect((await read(ref)).status).toBe('pending');
    await db.adminSql`UPDATE harness_shared.tool_invocations
      SET metadata_json=jsonb_set(metadata_json, '{originalInvocation}', ${db.adminSql.json(original)})
      WHERE id=${ref.substring('tool-invocation:'.length)}::bigint`;
    await settle(req, ref);
    expect((await read(ref)).metadata_json.executionObservation.state).toBe('succeeded');
    const rows = await db.adminSql`SELECT id FROM harness_shared.tool_invocations
      WHERE metadata_json->'originalInvocation'->>'callId'=${req.callId}`;
    expect(rows).toHaveLength(1);
  });

  it('preserves original authority against advisory enrichment and refuses duplicate settlement', async () => {
    const req = request(); const ref = await observer.begin(req);
    const claimTransactions = [{ schemaVersion: 'work-item-claim-transaction-v1', itemId: 'EI-private', transactionId: '42' }];
    await db.adminSql`UPDATE harness_shared.tool_invocations
      SET metadata_json=jsonb_set(metadata_json, '{workItemClaims}', ${db.adminSql.json(claimTransactions)})
      WHERE id=${ref.substring('tool-invocation:'.length)}::bigint`;
    await settle(req, ref);
    const before = await read(ref);
    await PROJECTED_DEPS.recordInvocation!({ ...req, invocationRef: ref, windowKey: 'run:original', durationMs: 12,
      status: 'ok', metadataJson: { originalInvocation: { ownerId: 'foreign' },
        executionObservation: { state: 'cancelled' }, responseObservation: { delivery: 'acknowledged' },
        workItemClaims: [{ itemId: 'forged-advisory-claim', transactionId: 'foreign' }] },
    });
    await flushPendingTelemetry();
    expect((await read(ref)).metadata_json).toMatchObject(before.metadata_json);
    expect((await read(ref)).metadata_json.workItemClaims).toEqual(claimTransactions);
    await expect(settle(req, ref)).rejects.toThrow('settlement join is unavailable');
    expect((await read(ref)).metadata_json).toMatchObject(before.metadata_json);
  });

  it.each([false, true])('dispatches a real SQL effect once and records a thrown outcome as unknown (throws=%s)', async throws => {
    const key = randomUUID();
    const definition = defineTool({
      name: `example:p003_persisted_effect_${throws ? 'throw' : 'success'}`, description: 'Private invocation observer integration fixture',
      capability: 'tasks:read', requirePrincipal: false, agentRoles: ['operator'], args: z.object({}),
      handler: async () => {
        await db.adminSql`INSERT INTO harness_shared.original_invocation_probe_effects VALUES (${key}, 1)`;
        if (throws) throw new Error('synthetic-private-secret');
        return { content: [{ type: 'text' as const, text: 'effect completed' }] };
      },
    });
    const tool = lookupByMcpName(definition.name)!;
    let observationError: unknown;
    const observed: Observer = {
      begin: async req => {
        try { return await observer.begin(req); }
        catch (error) { observationError = error; throw error; }
      },
      settle: async req => {
        try { await observer.settle(req); }
        catch (error) { observationError = error; throw error; }
      },
    };
    const authenticated = request().ctx;
    const result = await dispatchProjectedTool(tool, definition.name, {}, {
      ...authenticated,
      principal: { ...authenticated.principal!, capabilities: new Set(['tasks:read']) },
      workspaceId, harnessSlug: 'papercusp', role: 'operator', uiClientId: ownerId,
      runId: 'run-original', spawnId: 'spawn-original', signal: new AbortController().signal,
      log: () => {}, progress: () => {}, emit: () => {},
    }, { invocationObserver: observed, aroundInvoke: async ({ invoke }) => {
      // A host may request its continuation twice; dispatch owns memoization.
      const [first, second] = await Promise.all([invoke(), invoke()]);
      expect(first).toBe(second); return first;
    } });
    expect(observationError).toBeUndefined();
    // The canonical batch transport returns an envelope even when its child
    // throws. Check the child disposition separately from transport success;
    // the mandatory ledger below must still retain the unknown effect outcome.
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok || !result.result) throw new Error('Missing batch response');
    expect(result.result.isError === true).toBe(throws);
    expect(result.result.structuredContent).toMatchObject({
      ok: !throws, counts: { ok: throws ? 0 : 1, failed: throws ? 1 : 0 },
      results: [{ ok: !throws, status: throws ? 'failed' : 'completed' }],
    });
    const effects = await db.adminSql`SELECT * FROM harness_shared.original_invocation_probe_effects WHERE call_id=${key}`;
    expect(effects).toHaveLength(1);
    const rows = await db.adminSql`SELECT metadata_json FROM harness_shared.tool_invocations
      WHERE workspace_id=${workspaceId} AND tool_name=${definition.name}`;
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.metadata_json.executionObservation.state).toBe(throws ? 'unknown' : 'succeeded');
    expect(JSON.stringify(row.metadata_json)).not.toContain('synthetic-private-secret');
  });
});
