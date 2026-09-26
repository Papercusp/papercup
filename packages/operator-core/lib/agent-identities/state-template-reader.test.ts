import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UnifiedToolContext } from '@papercusp/agent-mcp';
import { dispatchProjectedTool as realDispatch, type ProjectedTool } from '@papercusp/tooldef';

const mocks = vi.hoisted(() => ({ lookup: vi.fn(), dispatch: vi.fn() }));
vi.mock('@papercusp/agent-mcp', async (original) => ({
  ...(await original<object>()), lookupByMcpName: mocks.lookup, dispatchProjectedTool: mocks.dispatch,
}));
vi.mock('@papercusp/db-org', async (original) => ({
  ...(await original<object>()), withWorkspace: async (_workspace: string, fn: (tx: unknown) => unknown) => fn({}),
}));
vi.mock('../projected-tool-deps', () => ({ PROJECTED_DEPS: {} }));

import { registerCell, __resetCellRegistryForTests, type CellSpec } from '../cell-registry';
import { dispatchReadOnlyTool } from '../events/await/predicate-watch';
import { createIdentityTemplateCellReader } from './state-template-reader';
import { evaluateIdentityStateTemplate } from './state-template';

function context(over: Partial<UnifiedToolContext> = {}): UnifiedToolContext {
  return {
    workspaceId: 'ws-template', harnessSlug: 'papercusp', role: 'su',
    principal: { slug: 'wearer-principal', workspaceId: 'ws-template', capabilities: new Set(['read:status', 'read:private', 'write:status']) },
    signal: new AbortController().signal, runId: 'run-template', spawnId: 'spawn-template',
    parentSpawnId: null, featureId: null, chunkId: null, uiClientId: null,
    isSuperuser: true, gateBypass: { capability: true, quota: true },
    profile: 'engineer', transport: 'in_process', tx: {} as UnifiedToolContext['tx'],
    log: () => {}, progress: () => {}, emit: () => {}, ...over,
  };
}
function spec(over: Partial<CellSpec> = {}): CellSpec {
  return {
    cell: 'template.status', owner: 'test', headline: 'value',
    nullable: false, whyTotal: 'The fixture always supplies a boolean or rejects.',
    callerRelativity: { kind: 'global' },
    provenance: { obtainedBy: 'isolated test resolver', liveExercised: true, evidence: 'state-template-reader.test.ts' },
    resolver: 'template:status', visibility: { kind: 'workspace' }, federation: { kind: 'local' },
    changeSignal: { kind: 'poll', tool: 'template:status', path: 'value' }, shape: '{ value, assessment }',
    assessment: { path: 'assessment', codes: { measured: { meaning: 'The boolean was measured.', safeAction: 'Use the measured value.' } }, evidence: ['source'] },
    ...over,
  };
}
beforeEach(() => {
  __resetCellRegistryForTests();
  mocks.lookup.mockReset().mockReturnValue({ effect: 'read' });
  mocks.dispatch.mockReset().mockResolvedValue({ ok: true, result: { structuredContent: { value: false, assessment: 'measured', source: 'fixture' } } });
});
afterEach(() => __resetCellRegistryForTests());

describe('identity template reader through canonical cell and read-only dispatch', () => {
  it('keeps the real wearer and narrows grants while clearing capability/quota bypasses', async () => {
    registerCell(spec());
    const ctx = context();
    const read = createIdentityTemplateCellReader({
      resolveWearer: async () => ({ ownerId: 'wearer-1', context: ctx, capabilityCeiling: new Set(['read:status']) }),
      declaredNeeds: ['read:status', 'read:private'],
    });
    const result = await evaluateIdentityStateTemplate({ template: 'Ready: {{ status }}', cells: { status: { cell: 'template.status' } } }, {
      readCell: read, signal: new AbortController().signal, timeoutMs: 500, maxBytes: 1024,
    });
    expect(result).toMatchObject({ status: 'value', text: 'Ready: false' });
    const dispatched = mocks.dispatch.mock.calls[0]![3] as UnifiedToolContext;
    expect(dispatched.principal?.slug).toBe('wearer-principal');
    expect([...dispatched.principal!.capabilities]).toEqual(['read:status']);
    expect(dispatched.gateBypass).toBeUndefined();
    expect(dispatched.isSuperuser).toBe(false);
    expect(dispatched.runId).toBe(ctx.runId);
    expect(ctx.principal!.capabilities.size).toBe(3);
  });

  it('checks registry visibility before dispatch without distinguishing absent from private', async () => {
    registerCell(spec({ visibility: { kind: 'owner', ref: 'different-wearer' } }));
    const read = createIdentityTemplateCellReader({
      resolveWearer: async () => ({ ownerId: 'wearer-1', context: context(), capabilityCeiling: new Set(['*']) }),
      declaredNeeds: ['*'],
    });
    expect(await read({ cell: 'template.status' }, new AbortController().signal)).toEqual({ status: 'absent', cell: 'template.status' });
    expect(await read({ cell: 'missing.cell' }, new AbortController().signal)).toEqual({ status: 'absent', cell: 'missing.cell' });
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it('resolves live authority each time and preserves normal gate refusals', async () => {
    registerCell(spec());
    let grant = true;
    mocks.dispatch.mockImplementation(async (_tool, _name, _args, ctx: UnifiedToolContext) =>
      ctx.principal?.capabilities.has('read:status')
        ? { ok: true, result: { structuredContent: { value: true, assessment: 'measured', source: 'fixture' } } }
        : { ok: false, error: { code: 'missing_capability', message: 'read:status revoked' } });
    const read = createIdentityTemplateCellReader({
      resolveWearer: async () => ({ ownerId: 'wearer-1', context: context({ principal: {
        slug: 'wearer-principal', workspaceId: 'ws-template', capabilities: new Set(grant ? ['*'] : []),
      } }), capabilityCeiling: new Set(['*']) }), declaredNeeds: ['read:status'],
    });
    expect(await read({ cell: 'template.status' }, new AbortController().signal)).toMatchObject({ status: 'value', value: true });
    grant = false;
    expect(await read({ cell: 'template.status' }, new AbortController().signal)).toMatchObject({ status: 'unknown', unknown: { code: 'not-measured' } });
  });

  it('refuses write-effect resolvers and mismatched authority scope before dispatch', async () => {
    registerCell(spec());
    mocks.lookup.mockReturnValue({ effect: 'write' });
    const read = createIdentityTemplateCellReader({
      resolveWearer: async () => ({ ownerId: 'wearer-1', context: context(), capabilityCeiling: new Set(['*']) }), declaredNeeds: ['*'],
    });
    expect(await read({ cell: 'template.status' }, new AbortController().signal)).toMatchObject({ status: 'unknown' });
    mocks.lookup.mockReturnValue({ effect: 'read' });
    await expect(dispatchReadOnlyTool('template:status', {}, {
      workspaceId: 'other-workspace', harnessSlug: 'papercusp', role: 'su', onBehalfOf: 'wearer-1', spawnId: 'test', callerContext: context(),
    })).rejects.toThrow('authority does not match');
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it('forwards cancellation to the resolver and refuses missing principals', async () => {
    registerCell(spec());
    const parent = new AbortController();
    let seen!: AbortSignal;
    mocks.dispatch.mockImplementation(async (_tool, _name, _args, ctx: UnifiedToolContext) => {
      seen = ctx.signal;
      return { ok: true, result: { structuredContent: { value: true, assessment: 'measured', source: 'fixture' } } };
    });
    const make = (ctx: UnifiedToolContext) => createIdentityTemplateCellReader({
      resolveWearer: async () => ({ ownerId: 'wearer-1', context: ctx, capabilityCeiling: new Set(['*']) }), declaredNeeds: ['*'],
    });
    await make(context())({ cell: 'template.status' }, parent.signal);
    expect(seen.aborted).toBe(false);
    parent.abort(); expect(seen.aborted).toBe(true);
    mocks.dispatch.mockClear();
    expect(await make(context({ principal: null }))({ cell: 'template.status' }, new AbortController().signal))
      .toMatchObject({ status: 'unknown', unknown: { code: 'not-measured' } });
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it('uses the real dispatcher to enforce capabilities, role and quota with a passing control', async () => {
    registerCell(spec());
    const handler = vi.fn(async () => ({ content: [{ type: 'text' as const, text: JSON.stringify({ value: true, assessment: 'measured', source: 'fixture' }) }] }));
    const projected: ProjectedTool = {
      pluginName: 'fixture', description: 'read status', effect: 'read', inputSchema: { type: 'object' },
      capabilities: ['read:status'], agentRoles: ['su'], expose: { mcp: { name: 'template:status' } }, fn: handler,
      rolesQuota: { su: { perRun: 1 } },
    };
    mocks.lookup.mockReturnValue(projected);
    let used = 0;
    mocks.dispatch.mockImplementation((tool, name, args, ctx) => realDispatch(tool, name, args, ctx, {
      readQuotaState: async () => ({ count: used }),
    }));
    const ctx = context();
    const make = (needs: string[]) => createIdentityTemplateCellReader({
      resolveWearer: async () => ({ ownerId: 'wearer-1', context: ctx, capabilityCeiling: new Set(['read:status']) }),
      declaredNeeds: needs,
    });
    const ref = { cell: 'template.status' };
    expect(await make(['read:status'])(ref, new AbortController().signal)).toMatchObject({ status: 'value', value: true });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(await make([])(ref, new AbortController().signal)).toMatchObject({ status: 'unknown', unknown: { code: 'not-measured' } });
    used = 1;
    expect(await make(['read:status'])(ref, new AbortController().signal)).toMatchObject({ status: 'unknown', unknown: { code: 'resolver-failed', detail: expect.stringContaining('quota_exceeded') } });
    used = 0;
    ctx.role = 'worker';
    expect(await make(['read:status'])(ref, new AbortController().signal)).toMatchObject({ status: 'unknown', unknown: { code: 'not-measured' } });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('refuses a cancelled wearer context even when the template signal is still live', async () => {
    registerCell(spec());
    const parent = new AbortController(); parent.abort();
    const read = createIdentityTemplateCellReader({
      resolveWearer: async () => ({ ownerId: 'wearer-1', context: context({ signal: parent.signal }), capabilityCeiling: new Set(['*']) }),
      declaredNeeds: ['*'],
    });
    expect(await read({ cell: 'template.status' }, new AbortController().signal)).toMatchObject({ status: 'unknown' });
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });
});
