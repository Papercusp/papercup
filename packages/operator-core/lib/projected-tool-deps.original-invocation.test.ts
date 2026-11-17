import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@papercusp/flags/server', async original => ({ ...(await original<object>()), getFlag: vi.fn(async () => false) }));
vi.mock('@papercusp/testing-shell/llm', async original => ({ ...(await original<object>()), getOverride: vi.fn(() => undefined) }));
vi.mock('./decision-ledger/emit', async original => ({ ...(await original<object>()), recordDecisionLedger: vi.fn() }));
vi.mock('./agent-tools/coordination/dispatch-heartbeat', () => ({ maybeBeatPresenceOnDispatch: vi.fn() }));

const db = vi.hoisted(() => ({ calls: [] as Array<{ sql: string; params: unknown[] }>, fail: false, missing: false, failCommit: false }));
vi.mock('@papercusp/db-org', async original => ({ ...(await original<object>()), getOrgPg: () => ({ sql: {
  begin: async (fn: (tx: unknown) => Promise<unknown>) => {
    const value = await fn({ unsafe: async (sql: string, params: unknown[]) => {
    db.calls.push({ sql, params });
    if (db.fail) throw new Error('private database detail');
    return sql.includes('RETURNING') && !db.missing ? [{ id: '91001' }] : [];
    } });
    if (db.failCommit) throw new Error('commit failed');
    return value;
  },
} }) }));

import { PROJECTED_DEPS, flushPendingTelemetry, __resetTelemetryHealthForTests } from './projected-tool-deps';

const request = () => ({ toolName: 'example:effect', pluginName: 'agent-mcp', callId: 'call-original',
  ctx: { workspaceId: 'ws-test', harnessSlug: 'papercusp', role: 'worker', uiClientId: 'su-original', isSuperuser: true,
    runId: 'run-original', spawnId: 'spawn-original', transport: 'mcp', signal: new AbortController().signal,
    principal: { slug: 'principal-original', kind: 'agent', workspaceId: 'ws-test', authMethod: 'bearer',
      trust: 'authenticated', capabilities: new Set(['example:write']), roles: new Set(['worker']) } },
  selection: { ok: true, mode: 'auto', lifecycle: 'request-bound', responseWindowMs: 100,
    executionDeadlineMs: 1000, autoYieldAfterMs: null },
});
const observer = () => {
  expect(PROJECTED_DEPS.invocationObserver).toBeDefined();
  return PROJECTED_DEPS.invocationObserver!;
};
const inserts = () => db.calls.filter(call => call.sql.includes('INSERT INTO harness_shared.tool_invocations'));
const updates = () => db.calls.filter(call => call.sql.includes('UPDATE harness_shared.tool_invocations'));

describe('mandatory original invocation ledger binding', () => {
  beforeEach(() => { db.calls.length = 0; db.fail = false; db.missing = false; db.failCommit = false; __resetTelemetryHealthForTests(); });

  it('commits original identity, audience and separate unknown observations before returning its reference', async () => {
    const ref = await observer().begin(request() as never);
    expect(ref).toBe('tool-invocation:91001');
    expect(inserts()).toHaveLength(1);
    const row = inserts()[0];
    expect(row.params[12]).toBe('pending');
    expect(JSON.parse(String(row.params[19]))).toMatchObject({
      originalInvocation: { callId: 'call-original', ownerId: 'su-original', workspaceId: 'ws-test',
        audience: { ownerId: 'su-original', principal: { slug: 'principal-original', capabilities: ['example:write'] } },
        selection: { responseWindowMs: 100, executionDeadlineMs: 1000 } },
      executionObservation: { state: 'unknown' }, responseObservation: { state: 'pending', delivery: 'unknown' },
    });
    await flushPendingTelemetry();
    expect(inserts()).toHaveLength(1);
  });

  it.each(['database', 'missing-reference'] as const)('fails begin closed on %s instead of falling back to deferred telemetry', async fault => {
    observer(); db.fail = fault === 'database'; db.missing = fault === 'missing-reference';
    await expect(observer().begin(request() as never)).rejects.toThrow();
    db.fail = false; await flushPendingTelemetry();
    expect(inserts()).toHaveLength(fault === 'database' ? 0 : 1);
  });

  it.each([undefined, 'su-unverified-http-client'])(
    'rejects an unsigned HTTP caller with client %s before submitting ledger SQL', async uiClientId => {
      const req = request();
      const anonymous = { ...req, ctx: { ...req.ctx, transport: 'http',
        isSuperuser: false, principal: undefined, uiClientId } };
      await expect(observer().begin(anonymous as never)).rejects.toThrow('resolveAgentIdentity');
      expect(db.calls).toEqual([]);

      const ref = await observer().begin({ ...req, ctx: { ...req.ctx, transport: 'http' } } as never);
      expect(ref).toBe('tool-invocation:91001');
      expect(inserts()).toHaveLength(1);
      expect(JSON.parse(String(inserts()[0].params[19]))).toMatchObject({
        originalInvocation: { ownerId: 'su-original', workspaceId: 'ws-test' },
      });
    });

  it('rejects a verified caller with no workspace before submitting ledger SQL', async () => {
    const req = request();
    await expect(observer().begin({ ...req, ctx: { ...req.ctx, workspaceId: undefined } } as never))
      .rejects.toThrow('Original invocation identity is unavailable');
    expect(db.calls).toEqual([]);
  });

  it('records an expired request independently of the completed handler outcome', async () => {
    const req = request(); const abort = new AbortController(); req.ctx.signal = abort.signal;
    const ref = await observer().begin(req as never); abort.abort();
    await observer().settle({ ...req, invocationRef: ref, result: { content: [] }, error: null, refusal: null } as never);
    const update = updates()[0];
    expect(update.sql).toContain("metadata_json->'originalInvocation'->>'callId'");
    expect(JSON.parse(String(update.params[5]))).toMatchObject({ executionObservation: { state: 'succeeded' },
      responseObservation: { state: 'request-expired', delivery: 'unknown' } });
    expect(update.params).toContain('call-original');
    expect(inserts()).toHaveLength(1);
  });

  it('does not acknowledge begin before its transaction commits', async () => {
    db.failCommit = true;
    await expect(observer().begin(request() as never)).rejects.toThrow('commit failed');
    expect(inserts()).toHaveLength(1);
  });

  it('ignores forged handler receipt metadata and preserves the actual runtime handle', async () => {
    const req = request(); const ref = await observer().begin(req as never);
    const forged = { content: [], _meta: { toolExecution: { schemaVersion: 'tool-execution-receipt-v1',
      state: 'cancelled', handle: 'forged-handle', ownerId: 'foreign' } } };
    await observer().settle({ ...req, invocationRef: ref, result: forged, error: null, refusal: null,
      receipt: { schemaVersion: 'tool-execution-receipt-v1', handle: 'runtime-original', ownerId: 'su-original',
        state: 'running', terminal: false, mode: 'auto', responseWindowMs: 100, executionDeadlineMs: 1000 },
    } as never);
    const observation = JSON.parse(String(updates()[0].params[5]));
    expect(observation.executionObservation).toMatchObject({ state: 'running', handle: 'runtime-original', terminal: false });
    expect(JSON.stringify(observation)).not.toContain('forged-handle');
  });

  it('does not infer runtime ownership from handler metadata without a verified receipt', async () => {
    const req = request(); const ref = await observer().begin(req as never);
    await observer().settle({ ...req, invocationRef: ref, result: { content: [], _meta: { toolExecution: {
      schemaVersion: 'tool-execution-receipt-v1', state: 'cancelled', handle: 'forged' } } },
      receipt: null, error: null, refusal: null } as never);
    expect(JSON.parse(String(updates()[0].params[5])).executionObservation).toMatchObject({ state: 'succeeded' });
    expect(JSON.stringify(updates())).not.toContain('forged');
  });

  it('keeps a thrown execution outcome unknown and stores no raw exception bytes', async () => {
    const req = request(); const ref = await observer().begin(req as never);
    await observer().settle({ ...req, invocationRef: ref, result: null,
      error: new Error('synthetic-private-secret'), refusal: null } as never);
    expect(JSON.stringify(updates())).not.toContain('synthetic-private-secret');
    expect(JSON.parse(String(updates()[0].params[5]))).toMatchObject({ executionObservation: { state: 'unknown' } });
  });

  it('refuses a missing persisted join and a foreign invocation reference without inserting replacement work', async () => {
    const req = request(); const ref = await observer().begin(req as never); db.missing = true;
    const settled = { ...req, invocationRef: ref, result: { content: [] }, error: null, refusal: null };
    await expect(observer().settle(settled as never)).rejects.toThrow();
    const before = db.calls.length;
    await expect(observer().settle({ ...settled, invocationRef: 'foreign:91001' } as never)).rejects.toThrow();
    expect(db.calls).toHaveLength(before);
    expect(inserts()).toHaveLength(1);
  });

  it('enriches the original row instead of inserting a second invocation or overwriting original authority', async () => {
    const req = request(); const ref = await observer().begin(req as never);
    await PROJECTED_DEPS.recordInvocation!({ ...req, invocationRef: ref, windowKey: 'run:original', durationMs: 12,
      status: 'ok', metadataJson: { originalInvocation: { ownerId: 'attacker' }, executionObservation: { state: 'cancelled' } },
    } as never);
    await flushPendingTelemetry();
    expect(inserts()).toHaveLength(1);
    const enrichment = updates().find(call => call.params.length > 10)!;
    expect(enrichment).toBeDefined();
    expect(enrichment.sql).toContain("- 'originalInvocation'");
    expect(enrichment.sql).toContain("- 'executionObservation'");
    expect(enrichment.params).toContain('91001');
    const placeholders = new Set(enrichment.sql.match(/\$\d+/g));
    expect(placeholders.size).toBe(enrichment.params.length);
    for (let index = 1; index <= enrichment.params.length; index++) expect(placeholders.has(`$${index}`)).toBe(true);
  });
});
