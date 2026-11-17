/** P-002: operator compatibility exports and the production MCP batching boundary. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import Ajv2020 from 'ajv/dist/2020';
import {
  _resetCatalogForTests, _resetProjectionRegistryForTests, defineTool, listMcpProjections,
  lookupByMcpName, setJsonSchemaAdapter, zodJsonSchemaAdapter,
  type BatchResult, type DispatchProjectedDeps, type StandardSchemaV1,
  type ToolBatchDeclaration, type UnifiedToolContext,
} from '@papercusp/tooldef';
import { runBulk as frameworkRunBulk } from '@papercusp/tooldef/_bulk';
import { runBulk as compatibilityRunBulk } from '@papercusp/agent-mcp/_bulk';
import { dispatchProjectedToolToMcp } from '@papercusp/tooldef-mcp';
import { runBulk } from './_bulk';

afterEach(() => { _resetCatalogForTests(); _resetProjectionRegistryForTests(); });

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
