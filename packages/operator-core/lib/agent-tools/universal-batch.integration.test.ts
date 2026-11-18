/** P-002: operator compatibility exports and the production MCP batching boundary. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import Ajv2020 from 'ajv/dist/2020';
import {
  _resetCatalogForTests, _resetProjectionRegistryForTests, clearEntityResolvers, defineTool, entityRef, listMcpProjections,
  lookupByMcpName, runDispatchStack, setEntityResolver, setJsonSchemaAdapter, zodJsonSchemaAdapter,
  type BatchResult, type DispatchProjectedDeps, type StandardSchemaV1,
  type ToolBatchDeclaration, type UnifiedToolContext,
} from '@papercusp/tooldef';
import { runBulk as frameworkRunBulk } from '@papercusp/tooldef/_bulk';
import { runBulk as compatibilityRunBulk } from '@papercusp/agent-mcp/_bulk';
import { dispatchProjectedToolToMcp } from '@papercusp/tooldef-mcp';
import { buildCgroupLimits, buildUlimitFloor } from '../p2p/sandbox/cgroup-limits';
import { runBulk } from './_bulk';
import { applyResultDoorAsync, resetResultDoorAggregatesForTests } from '../result-door';
import { _resetScratchUsageForTests } from '../scratch-gc';
import { capabilityReadDefinition } from './capability/read-handler';

afterEach(() => { _resetCatalogForTests(); _resetProjectionRegistryForTests(); clearEntityResolvers(); });

const name = 'universal_batch_fixture:operate';
const operation = z.strictObject({ key: z.string(), amount: z.number().int().optional() });
const item = (key: string, itemId?: string) => ({ args: { key }, ...(itemId ? { itemId } : {}) });
const context = (): UnifiedToolContext => ({
  log: vi.fn(), signal: new AbortController().signal, progress: vi.fn(), emit: vi.fn(),
  workspaceId: 'universal-batch-fixture', role: 'operator', runId: 'batch-parent', requestedStructured: true,
});

async function call(input: unknown, options: {
  deps?: DispatchProjectedDeps; ctx?: Partial<UnifiedToolContext>; legacy?: boolean;
} = {}) {
  const tool = lookupByMcpName(name);
  expect(tool).toBeDefined();
  return dispatchProjectedToolToMcp(tool!, name, input, { ...context(), ...options.ctx }, options.deps ?? {},
    { 'papercusp/batchResponseVersion': options.legacy ? 'operation-v0' : 'batch-v1' });
}

function data(result: Awaited<ReturnType<typeof call>>): BatchResult {
  expect(result.structuredContent).toMatchObject({ results: expect.any(Array), counts: expect.any(Object) });
  return result.structuredContent as unknown as BatchResult;
}

describe('universal batching in the operator', () => {
  it('authorizes each resource independently before its business effect', async () => {
    const effects: string[] = [];
    const authorize = vi.fn(async ({ input }: { input: unknown }) => ({
      allow: (input as { key: string }).key === 'allowed', reason: 'resource ownership',
    }));
    defineTool({ name, requirePrincipal: false, capability: 'test:write', effect: 'write', args: operation,
      authorize, handler: async value => { effects.push(value.key); return { data: value }; } });
    const result = data(await call({ _batch: 1, items: [item('denied', 'denied'), item('allowed', 'allowed')] }));
    expect(effects).toEqual(['allowed']);
    expect(authorize.mock.calls.map(([request]) => (request.input as { key: string }).key)).toEqual(['denied', 'allowed']);
    expect(result.results[0]).toMatchObject({ itemId: 'denied', ok: false, error: { code: 'authorization_denied' } });
    expect(result.results[1]).toMatchObject({ itemId: 'allowed', ok: true });
  });

  it('atomically admits only one concurrent child when one quota slot remains', async () => {
    const effects: string[] = [];
    let occupied = 0;
    const settle = vi.fn(async (_outcome: 'commit' | 'release') => {});
    const reserveQuota = vi.fn<NonNullable<DispatchProjectedDeps['reserveQuota']>>(async request => {
      expect(request.limit).toBe(1);
      if (occupied === 1) return { allowed: false as const, count: occupied };
      occupied++;
      return { allowed: true as const, settle };
    });
    defineTool({ name, requirePrincipal: false, capability: 'test:write', effect: 'write', args: operation,
      rolesQuota: { operator: { perRun: 1 } }, batch: { maxConcurrency: 3, independent: true },
      handler: async value => { effects.push(value.key); await Promise.resolve(); return { data: value }; } });
    const result = data(await call({ _batch: 1, items: ['a', 'b', 'c'].map(key => item(key, key)) }, {
      deps: { reserveQuota },
    }));
    expect(result.counts).toEqual({ ok: 1, failed: 2 });
    expect(result.results.filter(row => !row.ok)).toMatchObject([
      { error: { code: 'quota_exceeded' } }, { error: { code: 'quota_exceeded' } },
    ]);
    expect(effects).toHaveLength(1);
    expect(settle.mock.calls).toEqual([['commit']]);
    expect(reserveQuota).toHaveBeenCalledTimes(3);
  });

  it('settles each child quota reservation once and counts operations independently of the parent', async () => {
    const effects: string[] = [];
    const reservations: string[] = [];
    const settlements: Array<[string, string]> = [];
    const records: Array<{ callId?: string; status: string }> = [];
    defineTool({ name, requirePrincipal: false, capability: 'test:write', effect: 'write', args: operation,
      rolesQuota: { operator: { perRun: 3 } },
      authorize: async ({ input }) => ({ allow: input.key !== 'denied' }),
      handler: async value => { effects.push(value.key); return { data: value }; } });
    const result = data(await call({ _batch: 1, items: ['denied', 'a', 'b'].map(key => item(key, key)) }, {
      deps: {
        reserveQuota: async ({ callId }) => {
          reservations.push(callId);
          return { allowed: true, settle: async outcome => { settlements.push([callId, outcome]); } };
        },
        recordInvocation: async record => { records.push(record); },
      },
    }));
    expect(result.counts).toEqual({ ok: 2, failed: 1 });
    expect(effects).toEqual(['a', 'b']);
    expect(reservations).toHaveLength(3);
    expect(new Set(reservations).size).toBe(3);
    expect(settlements).toEqual([[reservations[0], 'release'], [reservations[1], 'commit'], [reservations[2], 'commit']]);
    expect(records.filter(record => record.status === 'ok').map(record => record.callId)).toEqual(reservations.slice(1));
  });

  it('enforces declarative child preconditions before invoking an effect', async () => {
    const effects: string[] = [];
    const state = vi.fn(async (args: Record<string, unknown>) => ({ ready: args.key === 'ready' }));
    const auditAuth = vi.fn();
    defineTool({ name, requirePrincipal: false, capability: 'test:write', effect: 'write', args: operation,
      requires: [{ id: 'resource-ready', state, when: { 'state.ready': true } }],
      handler: async value => { effects.push(value.key); return { data: value }; } });
    const result = data(await call({ _batch: 1, items: [item('not-ready', 'denied'), item('ready', 'allowed')] }, {
      deps: { auditAuth },
    }));
    expect(effects).toEqual(['ready']);
    expect(state.mock.calls.map(([args]) => args.key)).toEqual(['not-ready', 'ready']);
    expect(result.results[0]).toMatchObject({ ok: false, error: { code: 'precondition_failed' } });
    expect(result.results[1].ok).toBe(true);
    expect(auditAuth).toHaveBeenCalledWith(expect.objectContaining({ gate: 'precondition', decision: 'deny' }));
  });

  it.each([false, true])('checks singleton and child entity references for requirePrincipal=%s', async requirePrincipal => {
    const effects: string[] = [];
    setEntityResolver('batch-fixture-target', async values => ({ unknown: values.filter(value => value !== 'exists') }));
    const args = z.strictObject({ key: entityRef('batch-fixture-target') });
    const definition = { name, capability: 'test:write' as const, effect: 'write' as const, args,
      handler: async (value: z.infer<typeof args>) => { effects.push(value.key); return { data: value }; } };
    if (requirePrincipal) defineTool(definition);
    else defineTool({ ...definition, requirePrincipal: false });
    const ctx: Partial<UnifiedToolContext> = { principal: { kind: 'system', slug: 'entity-caller',
      workspaceId: 'universal-batch-fixture', capabilities: new Set(['test:write']) } };
    const tool = lookupByMcpName(name)!;
    const ordinary = await runDispatchStack({ ...tool, batchContract: undefined }, name,
      { key: 'missing' }, { ...context(), ...ctx }, {});
    const result = data(await call({ _batch: 1, items: [item('missing', 'denied'), item('exists', 'allowed')] }, { ctx }));
    expect(effects).toEqual(['exists']);
    expect(ordinary).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    expect(result.results[0]).toMatchObject({ itemId: 'denied', ok: false,
      error: { code: 'invalid_input', message: expect.stringContaining('missing') } });
    expect(result.results[1]).toMatchObject({ itemId: 'allowed', ok: true });
  });

  it('rejects malformed and unconfirmed child premises before irreversible effects', async () => {
    const effects: string[] = [];
    const resolvePremises = vi.fn<NonNullable<DispatchProjectedDeps['resolvePremises']>>(async refs =>
      refs.map(ref => ({ ref, status: ref === 'confirmed-fact' ? 'confirmed' as const : 'unknown' as const })));
    defineTool({ name, requirePrincipal: false, capability: 'test:write', effect: 'write', args: operation,
      irreversible: true, handler: async value => { effects.push(value.key); return { data: value }; } });
    const result = data(await call({ _batch: 1, items: [
      { itemId: 'malformed', args: { key: 'malformed', premises: [7] } },
      { itemId: 'unconfirmed', args: { key: 'unconfirmed', premises: ['unknown-fact'] } },
      { itemId: 'allowed', args: { key: 'allowed', premises: ['confirmed-fact'] } },
    ] }, { deps: { resolvePremises } }));
    expect(effects).toEqual(['allowed']);
    expect(result.results).toMatchObject([
      { itemId: 'malformed', ok: false, error: { code: 'invalid_input' } },
      { itemId: 'unconfirmed', ok: false, error: { code: 'premise_unconfirmed' } },
      { itemId: 'allowed', ok: true },
    ]);
    expect(resolvePremises).toHaveBeenCalledTimes(2);
  });

  it.each(['lock', 'confirmation', 'irreversible'] as const)(
    'retains the ordinary host %s requirement for each child', async requirement => {
      const effects: string[] = [];
      const args = z.strictObject({ key: z.string(), confirm: z.boolean() });
      const peerLocks = new Set(['denied']);
      const approvedIrreversibleTargets = new Set(['allowed']);
      defineTool({ name, requirePrincipal: false, capability: 'test:write', effect: 'write', args,
        irreversible: requirement === 'irreversible',
        authorize: async ({ input }) => ({ allow: true, obligations: { target: input.key } }),
        handler: async value => { effects.push(value.key); return { data: value }; } });
      const deps: DispatchProjectedDeps = { aroundInvoke: async ({ tool, input, authorization, invoke }) => {
        const value = input as z.infer<typeof args>;
        expect(authorization).toMatchObject({ status: 'allowed', decision: { obligations: { target: value.key } } });
        const allowed = requirement === 'lock' ? !peerLocks.has(value.key)
          : requirement === 'confirmation' ? value.confirm
          : tool.irreversible === true && approvedIrreversibleTargets.has(value.key);
        if (!allowed) return { content: [], isError: true,
          structuredContent: { ok: false, error: { code: 'host_' + requirement + '_required', target: value.key } } };
        return invoke();
      } };
      const inputs = [{ key: 'denied', confirm: false }, { key: 'allowed', confirm: true }];
      const tool = lookupByMcpName(name)!;
      const ordinary = [];
      for (const input of inputs) ordinary.push(await runDispatchStack({ ...tool, batchContract: undefined }, name,
        input, context(), deps));
      expect(effects).toEqual(['allowed']);
      effects.length = 0;
      const result = data(await call({ _batch: 1, items: inputs.map(args => ({ itemId: args.key, args })) }, { deps }));
      expect(result.results.map(row => row.output)).toEqual(ordinary.map(row => row.result));
      expect(result.results[0]).toMatchObject({ ok: false, output: { structuredContent: {
        error: { code: 'host_' + requirement + '_required', target: 'denied' },
      } } });
      expect(result.results[1].ok).toBe(true);
      expect(effects).toEqual(['allowed']);
    },
  );

  it('checks each same-record CAS revision at the ordinary host invocation seam', async () => {
    let revision = 1;
    const effects: number[] = [];
    const args = z.strictObject({ key: z.string(), expectedRevision: z.number().int() });
    defineTool({ name, requirePrincipal: false, capability: 'test:write', effect: 'write', args,
      handler: async () => { effects.push(++revision); return { data: { revision } }; } });
    const deps: DispatchProjectedDeps = { aroundInvoke: async ({ input, invoke }) => {
      const expected = (input as z.infer<typeof args>).expectedRevision;
      if (expected !== revision) return { content: [], isError: true, structuredContent: {
        ok: false, error: { code: 'revision_conflict', expected, actual: revision },
      } };
      return invoke();
    } };
    const inputs = [1, 1, 2].map(expectedRevision => ({ key: 'same-record', expectedRevision }));
    const tool = lookupByMcpName(name)!;
    const ordinary = [];
    for (const input of inputs) ordinary.push(await runDispatchStack({ ...tool, batchContract: undefined }, name,
      input, context(), deps));
    expect(effects).toEqual([2, 3]);
    revision = 1; effects.length = 0;
    const result = data(await call({ _batch: 1, items: inputs.map((args, index) => ({ itemId: String(index), args })) }, { deps }));
    expect(result.results.map(row => row.output)).toEqual(ordinary.map(row => row.result));
    expect(result.results.map(row => row.ok)).toEqual([true, false, true]);
    expect(result.results[1].output?.structuredContent).toMatchObject({
      error: { code: 'revision_conflict', expected: 1, actual: 2 },
    });
    expect(effects).toEqual([2, 3]);
    expect(revision).toBe(3);
  });

  it('rechecks native revocation at effect time without reserving or settling a child twice', async () => {
    const effects: string[] = [];
    const enforcements = new Map<string, number>();
    const reservations: string[] = [];
    const settlements: Array<[string, string]> = [];
    const handler = vi.fn(async (value: { key: string }) => ({ data: value }));
    const execute = vi.fn<NonNullable<ToolBatchDeclaration<{ key: string }>['execute']>>(async items => items.map(child => {
      effects.push(child.args.key);
      return { itemId: child.itemId, response: { data: child.args } };
    }));
    defineTool({ name, requirePrincipal: false, capability: 'test:read', effect: 'read', args: operation,
      rolesQuota: { operator: { perRun: 2 } }, batch: { execute }, handler });
    const result = data(await call({ _batch: 1, items: [item('revoked', 'revoked'), item('allowed', 'allowed')] }, {
      deps: {
        reserveQuota: async ({ callId }) => {
          reservations.push(callId);
          return { allowed: true, settle: async outcome => { settlements.push([callId, outcome]); } };
        },
        kernelEnforcement: request => {
          if (request.phase === 'enforce') {
            const key = (request.args as { key: string }).key;
            const count = (enforcements.get(key) ?? 0) + 1;
            enforcements.set(key, count);
            if (key === 'revoked' && count === 2) return { decision: 'deny', reason: 'revoked while group waited' };
          }
          return { decision: 'allow' };
        },
      },
    }));
    expect(effects).toEqual(['allowed']);
    expect(result.results[0]).toMatchObject({ itemId: 'revoked', ok: false, error: { code: 'authorization_denied' } });
    expect(result.results[1]).toMatchObject({ itemId: 'allowed', ok: true });
    expect(execute).toHaveBeenCalledOnce();
    expect(handler).not.toHaveBeenCalled();
    expect(enforcements.get('revoked')).toBe(2);
    expect(enforcements.get('allowed')).toBe(2);
    expect(reservations).toHaveLength(2);
    expect(new Set(reservations).size).toBe(2);
    // D-012 conservatively charges entry into the potentially effectful
    // prepareInvocation seam, even when native revalidation later revokes it.
    expect(settlements).toEqual([[reservations[0], 'commit'], [reservations[1], 'commit']]);
  });

  it('caps active child deadlines at the parent deadline and leaves expired siblings unstarted', async () => {
    vi.useFakeTimers();
    try {
      const deadlineAtMs = Date.now() + 30;
      const entered: string[] = [];
      const signals: AbortSignal[] = [];
      defineTool({ name, requirePrincipal: false, capability: 'test:read', effect: 'read', args: operation,
        timeoutSec: 60, handler: async (value, ctx) => {
          entered.push(value.key);
          signals.push(ctx.signal);
          expect(ctx.deadlineAtMs).toBe(deadlineAtMs);
          return new Promise((_resolve, reject) => ctx.signal.addEventListener('abort',
            () => reject(new Error('parent deadline reached')), { once: true }));
        } });
      const pending = call({ _batch: 1, items: [item('active', 'active'), item('later', 'later')] }, {
        ctx: { deadlineAtMs },
      });
      await vi.advanceTimersByTimeAsync(30);
      const result = data(await pending);
      expect(entered).toEqual(['active']);
      expect(signals.map(signal => signal.aborted)).toEqual([true]);
      expect(result.results).toMatchObject([
        { itemId: 'active', ok: false, error: { code: 'timeout' } },
        { itemId: 'later', ok: false, status: 'not-started' },
      ]);
    } finally { vi.useRealTimers(); }
  });

  it('enforces the declared single-child concurrency ceiling across awaited effects', async () => {
    vi.useFakeTimers();
    try {
      let active = 0;
      let peak = 0;
      const started: string[] = [];
      defineTool({ name, requirePrincipal: false, capability: 'test:write', effect: 'write', args: operation,
        batch: { maxConcurrency: 1 }, handler: async value => {
          peak = Math.max(peak, ++active);
          started.push(value.key);
          await new Promise(resolve => setTimeout(resolve, 5));
          active--;
          return { data: value };
        } });
      const pending = call({ _batch: 1, items: ['a', 'b', 'c'].map(key => item(key, key)) });
      await vi.advanceTimersByTimeAsync(20);
      expect(data(await pending).counts).toEqual({ ok: 3, failed: 0 });
      expect(peak).toBe(1);
      expect(active).toBe(0);
      expect(started).toEqual(['a', 'b', 'c']);
    } finally { vi.useRealTimers(); }
  });

  it('preserves an incomplete business page and its continuation inside each child output', async () => {
    const page = { rows: [{ id: 'first' }], total: 17, complete: false, hasMore: true,
      nextCursor: 'original-business-page-2' };
    const handler = vi.fn(async () => ({ data: page }));
    defineTool({ name, requirePrincipal: false, capability: 'test:read', args: operation, handler });
    const result = data(await call({ _batch: 1, items: [item('page', 'page')] }));
    expect(result.results[0].output?.structuredContent).toEqual(page);
    expect(handler).toHaveBeenCalledOnce();
    expect(result.results[0].output?.structuredContent).not.toHaveProperty('complete', true);
  });

  it('retains independently owned child handles after the parent response and cancellation', async () => {
    const adapter = { id: 'existing-session-runtime', auditRef: 'P003:runtime-fixture', ownsExecution: true as const,
      transactionScope: 'independent' as const, outcome: 'business' as const, durability: 'session' as const,
      cancellation: 'owner-managed' as const, progress: 'reported' as const };
    const jobs = new Map<string, { handle: string; ownerId: string; state: 'accepted' | 'completed' }>();
    const handler = vi.fn(async () => ({ data: { unexpectedInlineExecution: true } }));
    defineTool({ name, requirePrincipal: false, capability: 'test:write', effect: 'write', args: operation,
      execution: { lifecycle: 'independent', adapter }, handler });
    const parent = new AbortController();
    const result = data(await call({ _batch: 1, items: [item('a', 'left'), item('b', 'right')] }, {
      ctx: { signal: parent.signal, uiClientId: 'original-runtime-owner', toolExecution: { mode: 'async' } },
      deps: { executionAdapter: ({ input }) => ({ id: adapter.id,
        verifyAdmission: async admission => {
          const original = jobs.get(admission.handle);
          return original?.ownerId === admission.ownerId && original.state === admission.state;
        },
        dispatch: async () => {
          const handle = 'runtime:' + (input as { key: string }).key;
          const admission = { handle, ownerId: 'original-runtime-owner', state: 'accepted' as const };
          jobs.set(handle, admission);
          return { result: { content: [] }, admission };
        },
      }) },
    }));
    expect(result.counts).toEqual({ ok: 2, failed: 0 });
    expect(result.results.map(row => row.output?._meta?.toolExecution)).toEqual([
      expect.objectContaining({ handle: 'runtime:a', ownerId: 'original-runtime-owner', terminal: false }),
      expect.objectContaining({ handle: 'runtime:b', ownerId: 'original-runtime-owner', terminal: false }),
    ]);
    parent.abort();
    expect([...jobs.values()].map(job => [job.handle, job.state])).toEqual([
      ['runtime:a', 'accepted'], ['runtime:b', 'accepted'],
    ]);
    jobs.get('runtime:a')!.state = 'completed';
    expect(jobs.get('runtime:a')?.state).toBe('completed');
    expect(handler).not.toHaveBeenCalled();
  });

  it('preserves ordinary host wrapper order and isolated caller scope with one effect per child', async () => {
    const seen: unknown[] = [];
    const transaction = { rlsScope: 'original-workspace' };
    defineTool({ name, requirePrincipal: false, capability: 'test:write', effect: 'write', args: operation,
      needsWorkspaceTx: true, handler: async (value, ctx) => {
        seen.push(['effect', value.key, ctx.principal?.slug, ctx.workspaceId, ctx.tx]);
        return { data: value };
      } });
    const deps: DispatchProjectedDeps = { aroundInvoke: async ({ input, ctx, invoke }) => {
      const key = (input as { key: string }).key;
      expect(ctx.principal?.slug).toBe('original-caller');
      expect(ctx.workspaceId).toBe('original-workspace');
      ctx.principal = { kind: 'system', slug: 'scoped-' + key, workspaceId: 'original-workspace',
        capabilities: new Set(['test:write']) };
      seen.push(['enter', key]);
      const first = await invoke();
      expect(await invoke()).toBe(first);
      seen.push(['settle', key]);
      return first;
    } };
    const host = (): Partial<UnifiedToolContext> => ({ tx: transaction, workspaceId: 'original-workspace',
      principal: { kind: 'system', slug: 'original-caller', workspaceId: 'original-workspace',
        capabilities: new Set(['test:write']) } });
    const tool = lookupByMcpName(name)!;
    for (const key of ['a', 'b']) expect((await runDispatchStack({ ...tool, batchContract: undefined }, name,
      { key }, { ...context(), ...host() }, deps)).ok).toBe(true);
    const ordinary = [...seen];
    seen.length = 0;
    const result = data(await call({ _batch: 1, items: [item('a'), item('b')] }, { deps, ctx: host() }));
    expect(result.counts).toEqual({ ok: 2, failed: 0 });
    expect(seen).toEqual(ordinary);
    expect(seen).toHaveLength(6);
  });

  it.each(['role', 'capability'] as const)('enforces the ordinary %s gate for every child', async gate => {
    const handler = vi.fn(async (value: { key: string }) => ({ data: value }));
    defineTool({ name, requirePrincipal: false, capability: 'test:write', args: operation, handler });
    const tool = lookupByMcpName(name)!;
    if (gate === 'role') tool.agentRoles = ['architect'];
    const ctx: Partial<UnifiedToolContext> = { role: 'operator', principal: {
      kind: 'system', slug: 'limited-caller', workspaceId: 'universal-batch-fixture',
      capabilities: new Set(gate === 'role' ? ['test:write'] : []),
    } };
    const input = { _batch: 1, items: [item('a', 'a'), item('b', 'b')] };
    const refused = data(await call(input, { ctx }));
    expect(refused.results.map(row => row.error)).toMatchObject([
      { code: gate === 'role' ? 'role_not_allowed' : 'missing_capability' },
      { code: gate === 'role' ? 'role_not_allowed' : 'missing_capability' },
    ]);
    expect(handler).not.toHaveBeenCalled();
    expect(data(await call(input, { ctx: { ...ctx, role: 'architect', principal: {
      ...ctx.principal!, capabilities: new Set(['test:write']),
    } } })).counts).toEqual({ ok: 2, failed: 0 });
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('propagates cancellation once and never replays an uncertain write or starts its sibling', async () => {
    const parent = new AbortController();
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    let disposals = 0;
    const effects: string[] = [];
    defineTool({ name, requirePrincipal: false, capability: 'test:write', effect: 'write', args: operation,
      handler: async (value, ctx) => {
        effects.push(value.key);
        return new Promise((_resolve, reject) => {
          ctx.signal.addEventListener('abort', () => {
            disposals++;
            reject(Object.assign(new Error('response lost after effect'), { dispatchMetadata: {
              abortCompletionReceipt: { status: 'unknown', attemptId: 'original-write-attempt', retrySafe: false },
            } }));
          }, { once: true });
          entered();
        });
      } });
    const pending = call({ _batch: 1, items: [item('active', 'active'), item('later', 'later')] }, {
      ctx: { signal: parent.signal },
    });
    await started;
    parent.abort(); parent.abort();
    const result = data(await pending);
    expect(disposals).toBe(1);
    expect(effects).toEqual(['active']);
    expect(result.results).toMatchObject([
      { itemId: 'active', ok: false, status: 'unknown-effect' },
      { itemId: 'later', ok: false, status: 'not-started' },
    ]);
    expect(result.results[0].receipt).toEqual({ status: 'unknown', attemptId: 'original-write-attempt', retrySafe: false });
    expect(result.results[0].receipt).not.toHaveProperty('retrySafe', true);
  });

  it.each([20, 100])('recovers original caller-bound outputs and receipts after projecting %i dispatched children', async count => {
    const sandbox = mkdtempSync(join(tmpdir(), 'batch-recovery-'));
    vi.stubEnv('PAPERCUSP_SCRATCH_ROOT', join(sandbox, 'scratch'));
    vi.stubEnv('PAPERCUSP_FS_MUTEX_LOCK_DIR', join(sandbox, 'locks'));
    vi.stubEnv('PAPERCUSP_DOORS_CONFIG_OFF', '1');
    vi.stubEnv('PAPERCUSP_FORBID_REAL_PG', '1');
    vi.stubEnv('PAPERCUSP_RESULT_DOOR_OFF', '');
    resetResultDoorAggregatesForTests();
    _resetScratchUsageForTests();
    try {
      const effects: string[] = [];
      defineTool({ name, requirePrincipal: false, capability: 'test:write', effect: 'write', args: operation,
        handler: async value => {
          effects.push(value.key);
          if (Number(value.key) % 5 === 0) throw Object.assign(new Error('nested operation refused'), {
            dispatchMetadata: { abortCompletionReceipt: { status: 'recorded', callId: 'durable-' + value.key } },
          });
          return { data: { key: value.key, body: 'original-é-output-'.repeat(80) } };
        } });
      const items = Array.from({ length: count }, (_, index) =>
        item(String(index), (count === 100 ? 'é'.repeat(60) : 'request-') + index));
      const response = await call({ _batch: 1, items });
      const original = data(response);
      expect(original.results).toHaveLength(count);
      expect(original.results[0].receipt).toEqual({ status: 'recorded', callId: 'durable-0' });
      const caller = { projectDir: sandbox, workspaceId: 'universal-batch-fixture', ownerId: 'batch-caller',
        isSuperuser: true, uiClientId: 'batch-caller' };
      const out = await applyResultDoorAsync(response, { ...caller, toolName: name, effect: 'write',
        runId: '11111111-2222-4333-8444-555555555555' });
      const text = (out.content[0] as { text: string }).text;
      const projected = JSON.parse(text);
      const shown = projected.results as BatchResult['results'];
      expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(6_000);
      expect(shown.length).toBeGreaterThan(0);
      expect(shown).toEqual(original.results.slice(0, shown.length).map(({ itemId, ok, status }) => ({ itemId, ok, status })));
      if (count === 20) expect(shown).toHaveLength(count);
      else expect(projected._projection.arrayTruncations).toEqual([{ path: '$.results',
        shownCount: shown.length, renderedCount: shown.length, omittedCount: count - shown.length }]);
      type PageArgs = { file_path?: string; uri?: string; byte_offset: number; byte_limit: number };
      const cursor = projected._projection.cursor;
      expect(cursor.bodyOffsetInPayload).toEqual(expect.any(Number));
      const initial = cursor.args as PageArgs;
      const read = async (args: PageArgs, ctx = caller) => {
        const result = await capabilityReadDefinition.handler(args as never, ctx as never);
        return JSON.parse((result.content[0] as { text: string }).text);
      };
      expect(await read(initial)).toMatchObject({ ok: true, encoding: 'base64' });
      for (const foreign of [{ ...caller, ownerId: 'another-caller', uiClientId: 'another-caller' },
        { ...caller, workspaceId: 'another-workspace' }]) {
        const denied = await read(initial, foreign);
        expect(denied.ok).toBe(false);
        expect(denied).not.toHaveProperty('data');
        expect(JSON.stringify(denied)).not.toContain('original-é-output-');
      }
      const chunks: Buffer[] = [];
      let next: PageArgs | null = initial;
      let pages = 0;
      while (next) {
        expect(++pages).toBeLessThan(200);
        const page = await read(next);
        expect(page, JSON.stringify(page)).toMatchObject({ ok: true, encoding: 'base64' });
        chunks.push(Buffer.from(page.data, 'base64'));
        next = page.next_cursor?.args ?? null;
      }
      const recovered = Buffer.concat(chunks).subarray(cursor.bodyOffsetInPayload).toString('utf8');
      expect(JSON.parse(recovered)).toEqual(original);
      expect(effects).toEqual(Array.from({ length: count }, (_, index) => String(index)));
    } finally {
      vi.unstubAllEnvs();
      resetResultDoorAggregatesForTests();
      _resetScratchUsageForTests();
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it('refuses an over-byte-budget request before child gates or effects', async () => {
    const input = { _batch: 1, items: [item('éé', 'one')] };
    const bytes = new TextEncoder().encode(JSON.stringify(input)).byteLength;
    const handler = vi.fn(async (value: { key: string }) => ({ data: value }));
    const authorize = vi.fn(async () => ({ allow: true }));
    defineTool({ name, requirePrincipal: false, capability: 'test:read', args: operation,
      batch: { maxInputBytes: bytes - 1 }, authorize, handler });
    expect(await call(input)).toMatchObject({ isError: true });
    expect(authorize).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
    expect(data(await call({ key: 'ok' })).counts).toEqual({ ok: 1, failed: 0 });
    expect(handler).toHaveBeenCalledOnce();
  });

  it('reuses the schema-neutral bulk executor through both compatibility imports', async () => {
    expect(runBulk).toBe(frameworkRunBulk);
    expect(compatibilityRunBulk).toBe(frameworkRunBulk);
    const result = await runBulk(['same', 'same', 'denied'], async (key, index) =>
      ({ ok: key !== 'denied', key, index }));
    expect(result.results).toEqual([
      { ok: true, key: 'same', index: 0 }, { ok: true, key: 'same', index: 1 },
      { ok: false, key: 'denied', index: 2 },
    ]);
    expect(result.counts).toEqual({ ok: 2, failed: 1 });
    expect(result.ok).toBe(false);
  });

  it('publishes executable singleton and batch schemas from the sole operation declaration', async () => {
    defineTool({ name, requirePrincipal: false, capability: 'test:read', args: operation,
      handler: async value => ({ data: value }) });
    const listing = listMcpProjections().find(tool => tool.name === name)!;
    const ajv = new Ajv2020({ strict: false });
    const validate = ajv.compile(listing.inputSchema);
    const validateOutput = ajv.compile(listing.outputSchema!);
    for (const input of [{ key: 'one' }, { items: [item('one')] },
      { _batch: 1, items: item('one') }, { _batch: 1, items: [item('one')] }]) {
      expect(validate(input), JSON.stringify(validate.errors)).toBe(true);
      const result = data(await call(input));
      expect(result.counts).toEqual({ ok: 1, failed: 0 });
      expect(result.results[0].output?.structuredContent).toEqual({ key: 'one' });
      expect(validateOutput(result), JSON.stringify(validateOutput.errors)).toBe(true);
    }
    expect(validate({ key: 7 })).toBe(false);
    expect(() => defineTool({ name: 'universal_batch_fixture:scalar', requirePrincipal: false,
      capability: 'test:read', args: z.string(), handler: async value => ({ data: value }) }))
      .toThrow(/object/i);
  });

  it('preserves singleton mutations, host bindings and business emissions through ordinary dispatch', async () => {
    const state = new Map<string, number>();
    const emissions: unknown[] = [];
    const transaction = { name: 'bound-operation-transaction' };
    defineTool({ name, requirePrincipal: false, capability: 'test:write', args: operation,
      needsWorkspaceTx: true, events: { changed: z.object({ key: z.string(), amount: z.number() }) },
      handler: async (value, ctx) => {
        expect(ctx.tx).toBe(transaction);
        state.set(value.key, (state.get(value.key) ?? 0) + (value.amount ?? 1));
        ctx.emit('changed', { key: value.key, amount: value.amount ?? 1 });
        return { data: { key: value.key, total: state.get(value.key) } };
      } });
    const emit: UnifiedToolContext['emit'] = (kind, event) => { if (kind === 'changed') emissions.push(event); };
    const input = { key: 'same', amount: 3 };
    const flat = data(await call(input, { ctx: { tx: transaction, emit } }));
    const firstState = [...state]; state.clear();
    const marked = data(await call({ _batch: 1, items: [{ args: input }] }, { ctx: { tx: transaction, emit } }));
    expect(flat.results).toEqual(marked.results);
    expect([...state]).toEqual(firstState);
    expect(emissions).toEqual([{ key: 'same', amount: 3 }, { key: 'same', amount: 3 }]);
  });

  it('validates Standard Schema operations without a schema-library-specific business wrapper', async () => {
    const seen: unknown[] = [];
    const schema: StandardSchemaV1<unknown, { key: string }> = { '~standard': {
      version: 1, vendor: 'operator-contract-fixture', validate(input) {
        seen.push(input);
        if (typeof input === 'object' && input !== null && 'key' in input && typeof input.key === 'string')
          return { value: { key: input.key } };
        return { issues: [{ message: 'key must be a string', path: ['key'] }] };
      },
    } };
    const fn = vi.fn(async (value: { key: string }) => ({ data: value }));
    setJsonSchemaAdapter(value => value === schema
      ? { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] }
      : zodJsonSchemaAdapter(value));
    try {
      defineTool({ name, requirePrincipal: false, capability: 'test:read', args: schema, handler: fn });
    } finally { setJsonSchemaAdapter(zodJsonSchemaAdapter); }
    const invalid = { key: 7, unknownBusinessField: 'preserve until validation' };
    const result = data(await call({ _batch: 1, items: [item('valid', 'good'), { itemId: 'bad', args: invalid }] }));
    expect(result.results.map(row => [row.itemId, row.ok])).toEqual([['good', true], ['bad', false]]);
    expect(seen).toContainEqual(invalid);
    expect(fn).toHaveBeenCalledOnce();
    expect(result.results[1].error).toMatchObject({ code: 'invalid_input' });
  });

  it.each([1, 3])('uses the original operation schema minimum %i for batch child validation', async minimum => {
    const args = z.strictObject({ key: z.string().min(minimum) });
    const handler = vi.fn(async (value: z.infer<typeof args>) => ({ data: value }));
    defineTool({ name, requirePrincipal: false, capability: 'test:read', args, handler });
    // The same submitted operation changes validity when only its declaration changes.
    const result = data(await call({ _batch: 1, items: [item('ab', 'changed'), item('valid', 'control')] }));
    expect(result.results.map(row => [row.itemId, row.ok])).toEqual([
      ['changed', minimum <= 2], ['control', true],
    ]);
    expect(handler.mock.calls.map(([value]) => value.key)).toEqual(minimum <= 2 ? ['ab', 'valid'] : ['valid']);
    if (minimum > 2) expect(result.results[0].error).toMatchObject({ code: 'invalid_input' });
  });

  it('retains real child process CPU and memory limits from ordinary host dispatch', async () => {
    const limits = buildUlimitFloor(buildCgroupLimits({ cpuMaxPercent: 50,
      memoryMaxBytes: 64 * 1024 * 1024, ioMaxBytesPerSec: 1024 * 1024 }));
    const transaction = { processLimits: limits };
    const child = promisify(execFile);
    defineTool({ name, requirePrincipal: false, capability: 'test:read', args: operation,
      needsWorkspaceTx: true, handler: async (_value, ctx) => {
        const floor = (ctx.tx as unknown as typeof transaction).processLimits;
        const { stdout } = await child('/usr/bin/prlimit', [
          '--cpu=' + floor.cpuSeconds + ':' + floor.cpuSeconds,
          '--as=' + floor.addressSpaceBytes + ':' + floor.addressSpaceBytes,
          '--', '/usr/bin/cat', '/proc/self/limits',
        ], { timeout: 5000, maxBuffer: 8192 });
        const cpu = /^Max cpu time\s+(\d+)\s+(\d+)\s+seconds\s*$/m.exec(stdout);
        const memory = /^Max address space\s+(\d+)\s+(\d+)\s+bytes\s*$/m.exec(stdout);
        expect(cpu, stdout).not.toBeNull(); expect(memory, stdout).not.toBeNull();
        return { data: { cpu: cpu!.slice(1).map(Number), memory: memory!.slice(1).map(Number) } };
      } });
    const tool = lookupByMcpName(name)!;
    // Removing the batching contract selects the ordinary operation stack. Both
    // routes receive the same host-bound profile; dispatch installs its tx guard.
    const host = () => ({ ...context(), tx: transaction });
    const ordinary = await runDispatchStack({ ...tool, batchContract: undefined }, name, { key: 'ordinary' }, host(), {});
    expect(ordinary.ok, JSON.stringify(ordinary)).toBe(true);
    const expected = { cpu: [limits.cpuSeconds, limits.cpuSeconds],
      memory: [limits.addressSpaceBytes, limits.addressSpaceBytes] };
    expect(ordinary.result?.structuredContent).toEqual(expected);
    const result = data(await call({ _batch: 1, items: [item('first', 'first'), item('second', 'second')] }, {
      deps: { aroundInvoke: async ({ ctx, invoke }) => {
        expect(ctx.tx).toBe(transaction);
        return invoke();
      } }, ctx: host(),
    }));
    expect(result.counts, JSON.stringify(result)).toEqual({ ok: 2, failed: 0 });
    expect(result.results.map(row => [row.itemId, row.ok, row.output?.structuredContent])).toEqual([
      ['first', true, expected], ['second', true, expected],
    ]);
  });

  it('keeps native event-producing reads on ordered fallback with keyed terminal results', async () => {
    const emissions: unknown[] = [];
    const execute = vi.fn<NonNullable<ToolBatchDeclaration<{ key: string }>['execute']>>(async items =>
      items.map(item => ({ itemId: item.itemId, response: { data: { key: item.args.key } } })));
    defineTool({ name, requirePrincipal: false, capability: 'test:read', effect: 'read', args: operation,
      events: { sample: z.object({ key: z.string(), sequence: z.number() }) }, batch: { execute },
      handler: async (value, ctx) => {
        ctx.emit('sample', { key: value.key, sequence: 1 });
        ctx.emit('sample', { key: value.key, sequence: 2 });
        return { data: { key: value.key } };
      } });
    const result = data(await call({ _batch: 1, items: [item('a', 'left'), item('b', 'right')] }, {
      ctx: { emit: (kind, event) => { if (kind === 'sample') emissions.push(event); } },
    }));
    expect(execute).not.toHaveBeenCalled();
    expect(emissions).toEqual([{ key: 'a', sequence: 1 }, { key: 'a', sequence: 2 },
      { key: 'b', sequence: 1 }, { key: 'b', sequence: 2 }]);
    expect(result.results.map(row => [row.itemId, row.status, row.output?.structuredContent])).toEqual([
      ['left', 'completed', { key: 'a' }], ['right', 'completed', { key: 'b' }],
    ]);
  });

  it('keeps duplicate business keys distinct and reserves later supplied identities', async () => {
    const effects: string[] = [];
    defineTool({ name, requirePrincipal: false, capability: 'test:write', args: operation,
      handler: async value => { effects.push(value.key); return { data: { key: value.key, ordinal: effects.length } }; } });
    const result = data(await call({ _batch: 1, items: [item('same'), item('same', 'item-1')] }));
    expect(effects).toEqual(['same', 'same']);
    expect(new Set(result.results.map(row => row.itemId)).size).toBe(2);
    expect(result.results[1].itemId).toBe('item-1');
    expect(result.results.map(row => row.output?.structuredContent)).toEqual([
      { key: 'same', ordinal: 1 }, { key: 'same', ordinal: 2 },
    ]);
  });

  it('retains structured refusals and typed successful outputs in one keyed envelope', async () => {
    defineTool({ name, requirePrincipal: false, capability: 'test:read', args: operation,
      handler: async value => value.key === 'denied'
        ? { content: [], structuredContent: { ok: false, error: { code: 'business_refused', retryAfter: 12 } }, isError: true }
        : { data: { key: value.key, found: false, count: 7, nested: { enabled: true } } } });
    const response = await call({ _batch: 1, items: [item('denied', 'bad'), item('found', 'good')] });
    const result = data(response);
    expect(response.isError).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.counts).toEqual({ ok: 1, failed: 1 });
    expect(result.results[0]).toMatchObject({ itemId: 'bad', ok: false, output: {
      structuredContent: { ok: false, error: { code: 'business_refused', retryAfter: 12 } },
    } });
    expect(result.results[1]).toMatchObject({ itemId: 'good', ok: true, output: {
      structuredContent: { key: 'found', found: false, count: 7, nested: { enabled: true } },
    } });
  });

  it.each([
    ['marker', { _batch: 2, items: [item('one')] }],
    ['outer metadata', { _batch: 1, items: [item('one')], extra: true }],
    ['item metadata', { _batch: 1, items: [{ ...item('one'), extra: true }] }],
    ['empty identity', { _batch: 1, items: [{ ...item('one'), itemId: '' }] }],
    ['non-string identity', { _batch: 1, items: [{ ...item('one'), itemId: 7 }] }],
    ['oversized identity', { _batch: 1, items: [item('one', 'x'.repeat(129))] }],
    ['duplicate identity', { _batch: 1, items: [item('a', 'same'), item('b', 'same')] }],
    ['empty items', { _batch: 1, items: [] }],
    ['tool ceiling', { _batch: 1, items: [item('a'), item('b'), item('c')] }],
  ] as const)('rejects malformed %s before authorization or business effects', async (_label, input) => {
    const handler = vi.fn(async (value: { key: string }) => ({ data: value }));
    const authorize = vi.fn(async () => ({ allow: true }));
    defineTool({ name, requirePrincipal: false, capability: 'test:write', args: operation,
      batch: { maxItems: 2 }, authorize, handler });
    expect(await call(input)).toMatchObject({ isError: true });
    expect(authorize).not.toHaveBeenCalled(); expect(handler).not.toHaveBeenCalled();
  });

  it('admits exactly 100 default items and rejects 101 before any additional effect', async () => {
    const handler = vi.fn(async (value: { key: string }) => ({ data: value }));
    defineTool({ name, requirePrincipal: false, capability: 'test:read', args: operation, handler });
    const items = Array.from({ length: 100 }, () => item('same'));
    expect(data(await call({ _batch: 1, items })).counts).toEqual({ ok: 100, failed: 0 });
    expect(await call({ _batch: 1, items: [...items, item('extra')] })).toMatchObject({ isError: true });
    expect(handler).toHaveBeenCalledTimes(100);
  });

  it('groups native reads by admitted principal while preserving host transaction and finalization', async () => {
    const transaction = { name: 'existing-host-transaction' };
    const backend = vi.fn<NonNullable<ToolBatchDeclaration<{ key: string }>['execute']>>(async items => {
      expect(new Set(items.map(item => item.ctx.principal?.slug)).size).toBe(1);
      for (const item of items) {
        expect(item.ctx.tx).toBe(transaction);
        expect(item.ctx.runId).toBe('host-' + item.args.key);
        expect(item.signal).toBe(item.ctx.signal);
      }
      return [...items].reverse().map(item => ({ itemId: item.itemId, response: { data: { key: item.args.key } } }));
    });
    const handler = vi.fn(async (value: { key: string }) => ({ data: value }));
    defineTool({ name, requirePrincipal: false, capability: 'test:read', effect: 'read', args: operation,
      needsWorkspaceTx: true, handler, batch: { execute: backend,
        result: (_response, value) => ({ data: { key: value.key, finalized: true } }) } });
    const result = data(await call({ _batch: 1, items: [item('a', 'left'), item('b', 'middle'), item('a', 'right')] }, {
      ctx: { tx: transaction }, deps: { aroundInvoke: async ({ input, ctx, invoke }) => {
        const key = (input as { key: string }).key;
        ctx.principal = { kind: 'system', slug: key, workspaceId: 'universal-batch-fixture', capabilities: new Set(['test:read']) };
        ctx.runId = 'host-' + key;
        return invoke();
      } },
    }));
    expect(result.results.map(row => [row.itemId, row.output?.structuredContent])).toEqual([
      ['left', { key: 'a', finalized: true }], ['middle', { key: 'b', finalized: true }], ['right', { key: 'a', finalized: true }],
    ]);
    expect(backend.mock.calls.map(([items]) => items.map(item => item.itemId))).toEqual([['left', 'right'], ['middle']]);
    expect(handler).not.toHaveBeenCalled();
  });

  it.each(['missing', 'duplicate', 'foreign'] as const)('rejects %s native outcomes without replaying effects', async mode => {
    const handler = vi.fn(async (value: { key: string }) => ({ data: value }));
    const execute = vi.fn<NonNullable<ToolBatchDeclaration<{ key: string }>['execute']>>(async items => {
      const first = { itemId: items[0].itemId, response: { data: { done: true } } };
      return mode === 'missing' ? [first] : [first, { ...first, itemId: mode === 'foreign' ? 'foreign' : first.itemId }];
    });
    defineTool({ name, requirePrincipal: false, capability: 'test:read', effect: 'read', args: operation, handler, batch: { execute } });
    const result = data(await call({ _batch: 1, items: [item('a', 'a'), item('b', 'b')] }));
    // A verified successful effect remains successful; malformed/missing outcomes
    // fail their own item and the envelope, without re-executing either item.
    expect(result.results.map(row => [row.itemId, row.ok])).toEqual([['a', mode !== 'duplicate'], ['b', false]]);
    expect(result.ok).toBe(false);
    expect(result.results[1].error).toBeDefined();
    expect(execute).toHaveBeenCalledOnce(); expect(handler).not.toHaveBeenCalled();
  });

  it('chooses ordered fallback before any write override can start', async () => {
    const effects: string[] = [];
    const execute = vi.fn<NonNullable<ToolBatchDeclaration<{ key: string }>['execute']>>(async () => []);
    defineTool({ name, requirePrincipal: false, capability: 'test:write', effect: 'write', args: operation,
      batch: { execute }, handler: async value => { effects.push(value.key); return { data: value }; } });
    const result = data(await call({ _batch: 1, items: [item('first'), item('second')] }));
    expect(result.counts).toEqual({ ok: 2, failed: 0 });
    expect(effects).toEqual(['first', 'second']); expect(execute).not.toHaveBeenCalled();
  });

  it('keeps business arrays intact and negotiates legacy output before execution', async () => {
    const args = z.strictObject({ items: z.array(operation), args: z.string().optional() });
    const handler = vi.fn(async (value: z.infer<typeof args>) => ({ data: value }));
    defineTool({ name, requirePrincipal: false, capability: 'test:write', args, handler });
    const input = { items: [{ key: 'a' }, { key: 'b' }], args: 'business metadata' };
    const flat = data(await call(input));
    const marked = data(await call({ _batch: 1, items: [{ args: input }] }));
    expect(flat.results).toEqual(marked.results);
    expect(flat.results).toHaveLength(1);
    expect(await call(input, { legacy: true })).toMatchObject({ structuredContent: input });
    expect(await call({ _batch: 1, items: [{ args: input }, { args: input }] }, { legacy: true }))
      .toMatchObject({ isError: true });
    expect(handler.mock.calls.map(([value]) => value)).toEqual([input, input, input]);
  });
});
