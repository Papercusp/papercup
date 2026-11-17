/** Published batch schemas and dispatch through the real MCP SDK transport. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import Ajv2020 from 'ajv/dist/2020';
import { z } from 'zod';
import { _resetProjectionRegistryForTests, defineTool, listMcpProjections, lookupByMcpName,
  type BatchResult, type DispatchProjectedDeps, type ToolBatchDeclaration, type UnifiedToolContext } from '@papercusp/tooldef';
import { dispatchProjectedToolToMcp } from './index';

afterEach(() => _resetProjectionRegistryForTests());

async function wire(run: (request: (method: string, params?: Record<string, unknown>) => Promise<unknown>) => Promise<void>,
  options: { deps?: DispatchProjectedDeps; ctx?: Partial<UnifiedToolContext> } = {}) {
  let id = 0;
  await run(async (method, params) => {
    // Stateless SDK transports own exactly one HTTP request, as in production.
    const server = new Server({ name: 'batch-contract-fixture', version: '1' }, { capabilities: { tools: {} } });
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: listMcpProjections() }));
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const tool = lookupByMcpName(request.params.name);
      if (!tool) throw new Error('unknown_fixture_tool');
      return await dispatchProjectedToolToMcp(tool, request.params.name, request.params.arguments, {
        signal: extra.signal, log: vi.fn(), progress: vi.fn(), emit: vi.fn(), role: 'worker',
        workspaceId: 'wire-fixture', runId: 'wire-fixture', requestedStructured: true, ...options.ctx,
      }, options.deps ?? {}, request.params._meta) as CallToolResult;
    });
    await server.connect(transport);
    try {
      const response = await transport.handleRequest(new Request('http://127.0.0.1/mcp', {
        method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, ...(params ? { params } : {}) }),
      }));
      expect(response.status).toBe(200);
      const body = await response.json() as { result?: unknown; error?: unknown };
      expect(body.error).toBeUndefined();
      expect(body).toHaveProperty('result');
      return body.result;
    } finally { await server.close(); }
  });
}

const name = 'wirebatch:operation';
const args = z.strictObject({ key: z.string() });
const item = (key: string, itemId?: string) => ({ args: { key }, ...(itemId ? { itemId } : {}) });
const batchData = (result: unknown): BatchResult => {
  expect(result).toMatchObject({ structuredContent: { results: expect.any(Array) } });
  return (result as CallToolResult).structuredContent as unknown as BatchResult;
};

describe('canonical batching over MCP SDK tools/list and tools/call', () => {
  it('advertises executable singleton/envelope grammar and exact batch limits', async () => {
    defineTool({ name, requirePrincipal: false, capability: 'test:read', args, batch: { maxItems: 2 },
      handler: async value => ({ data: value }) });
    await wire(async request => {
      const listing = await request('tools/list') as { tools: Array<{ name: string; inputSchema: object; outputSchema: object }> };
      const tool = listing.tools.find(tool => tool.name === name)!;
      expect(tool).toBeDefined();
      const ajv = new Ajv2020({ strict: false });
      const validate = ajv.compile(tool.inputSchema);
      const validateOutput = ajv.compile(tool.outputSchema);
      for (const input of [{ key: 'one' }, { _batch: 1, items: [item('one')] },
        { _batch: 1, items: item('one') }, { items: [item('one')] }]) {
        expect(validate(input), JSON.stringify(validate.errors)).toBe(true);
        const result = await request('tools/call', { name, arguments: input });
        expect(batchData(result).counts).toEqual({ ok: 1, failed: 0 });
        expect(validateOutput((result as CallToolResult).structuredContent)).toBe(true);
      }
      for (const input of [{ _batch: 2, items: [item('one')] }, { _batch: 1, items: [] },
        { _batch: 1, items: [item('a'), item('b'), item('c')] }]) expect(validate(input)).toBe(false);
    });
  });

  it('preserves singleton parity, per-child authorization and mixed keyed outcomes', async () => {
    const effects: string[] = [];
    defineTool({ name, requirePrincipal: false, capability: 'test:write', args,
      authorize: async ({ input }) => (input as { key: string }).key === 'denied'
        ? { allow: false, reason: 'fixture denial' } : { allow: true },
      handler: async value => { effects.push(value.key); return { data: value }; } });
    await wire(async request => {
      const call = (input: object) => request('tools/call', { name, arguments: input,
        _meta: { 'papercusp/batchResponseVersion': 'batch-v1' } });
      const flat = batchData(await call({ key: 'one' }));
      const marked = batchData(await call({ _batch: 1, items: [item('one')] }));
      expect(flat.results).toEqual(marked.results);
      const mixed = await call({ _batch: 1, items: [item('denied', 'denied'),
        { itemId: 'invalid', args: { key: 7 } }, item('last', 'success')] });
      expect(mixed).toMatchObject({ isError: true });
      const data = batchData(mixed);
      expect(data.counts).toEqual({ ok: 1, failed: 2 });
      expect(data.results.map(row => [row.itemId, row.ok])).toEqual([
        ['denied', false], ['invalid', false], ['success', true],
      ]);
      expect(data.results[1].error).toMatchObject({ code: 'invalid_input' });
      expect(data.results[2].output?.structuredContent).toEqual({ key: 'last' });
      expect(effects).toEqual(['one', 'one', 'last']);
    });
  });

  it.each([
    ['marker', { _batch: 2, items: [item('one')] }],
    ['outer metadata', { _batch: 1, items: [item('one')], extra: true }],
    ['item metadata', { _batch: 1, items: [{ ...item('one'), extra: true }] }],
    ['empty id', { _batch: 1, items: [{ ...item('one'), itemId: '' }] }],
    ['non-string id', { _batch: 1, items: [{ ...item('one'), itemId: 7 }] }],
    ['oversized id', { _batch: 1, items: [item('one', 'x'.repeat(129))] }],
    ['duplicate id', { _batch: 1, items: [item('one', 'same'), item('two', 'same')] }],
    ['empty batch', { _batch: 1, items: [] }],
    ['oversized batch', { _batch: 1, items: [item('a'), item('b'), item('c')] }],
  ] as const)('refuses malformed %s before any child admission or effect', async (_label, input) => {
    const handler = vi.fn(async (value: z.infer<typeof args>) => ({ data: value }));
    const authorize = vi.fn(async () => ({ allow: true }));
    defineTool({ name, requirePrincipal: false, capability: 'test:write', args,
      batch: { maxItems: 2 }, authorize, handler });
    await wire(async request => {
      const result = await request('tools/call', { name, arguments: input });
      expect(result).toMatchObject({ isError: true, content: [{ type: 'text', text: expect.stringContaining('invalid_input') }] });
      expect(handler).not.toHaveBeenCalled();
      expect(authorize).not.toHaveBeenCalled();
    });
  });

  it('retains an ambiguous business items array as a single operation', async () => {
    const business = z.strictObject({ items: z.array(args), args: z.string().optional() });
    const handler = vi.fn(async (value: z.infer<typeof business>) => ({ data: value }));
    defineTool({ name, requirePrincipal: false, capability: 'test:read', args: business, handler });
    const value = { items: [{ key: 'one' }, { key: 'two' }], args: 'business metadata' };
    await wire(async request => {
      const flat = batchData(await request('tools/call', { name, arguments: value }));
      const marked = batchData(await request('tools/call', { name, arguments: { _batch: 1, items: [{ args: value }] } }));
      expect(flat.results).toHaveLength(1);
      expect(flat.results).toEqual(marked.results);
      expect(handler.mock.calls.map(([input]) => input)).toEqual([value, value]);
    });
  });

  it('preserves native principal groups, host metadata and transaction bindings through normal result finalization', async () => {
    const calls: string[][] = [];
    const transaction = { id: 'host-bound-transaction' };
    const handler = vi.fn(async (value: { key: string }) => ({ data: value }));
    const batch: ToolBatchDeclaration<{ key: string }> = {
      result: (response, value) => ({ data: Object.assign({},
        'data' in response ? response.data : response.structuredContent, { adapted: value.key }) }),
      execute: async items => {
        expect(Object.isFrozen(items)).toBe(true);
        expect(new Set(items.map(item => item.ctx.principal?.slug)).size).toBe(1);
        calls.push(items.map(item => item.itemId));
        for (const item of items) {
          expect(item.ctx.tx).toBe(transaction);
          expect(item.ctx.runId).toBe('host-' + item.args.key);
          expect(item.callId).toBeTruthy();
          expect(item.signal).toBe(item.ctx.signal);
        }
        return [...items].reverse().map(item => ({ itemId: item.itemId,
          response: { data: { key: item.args.key, typed: { count: 7 } } } }));
      },
    };
    defineTool({ name, requirePrincipal: false, capability: 'test:read', effect: 'read',
      needsWorkspaceTx: true, args, batch, handler });
    await wire(async request => {
      const data = batchData(await request('tools/call', { name,
        arguments: { _batch: 1, items: [item('a', 'left'), item('b', 'right'), item('a', 'again')] } }));
      expect(data.results.filter(row => !row.ok), JSON.stringify(data.results)).toEqual([]);
      expect(data.results.map(row => [row.itemId, row.output?.structuredContent])).toEqual([
        ['left', { key: 'a', typed: { count: 7 }, adapted: 'a' }],
        ['right', { key: 'b', typed: { count: 7 }, adapted: 'b' }],
        ['again', { key: 'a', typed: { count: 7 }, adapted: 'a' }],
      ]);
      expect(calls).toEqual([['left', 'again'], ['right']]);
      expect(handler).not.toHaveBeenCalled();
    }, { ctx: { tx: transaction }, deps: { aroundInvoke: async ({ input, ctx, invoke }) => {
      const key = (input as { key: string }).key;
      ctx.principal = { kind: 'system', slug: key, workspaceId: 'wire-fixture', capabilities: new Set(['test:read']) };
      ctx.runId = 'host-' + key;
      return invoke();
    } } });
  });

  it('waits for host admission and excludes refused items before one native backend call', async () => {
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const entered: string[] = [];
    const handler = vi.fn(async (value: { key: string }) => ({ data: value }));
    const execute = vi.fn<NonNullable<ToolBatchDeclaration<{ key: string }>['execute']>>(async items =>
      items.map(item => ({ itemId: item.itemId, response: { data: item.args } })));
    defineTool({ name, requirePrincipal: false, capability: 'test:read', effect: 'read', args, batch: { execute }, handler });
    await wire(async request => {
      const pending = request('tools/call', { name, arguments: { _batch: 1,
        items: [item('first', 'first'), item('slow', 'slow'), item('denied', 'denied')] } });
      await vi.waitFor(() => expect(entered).toHaveLength(3));
      expect(execute).not.toHaveBeenCalled();
      release();
      const result = await pending;
      expect(result).toMatchObject({ isError: true });
      expect(batchData(result).results.map(row => [row.itemId, row.ok])).toEqual([
        ['first', true], ['slow', true], ['denied', false],
      ]);
      expect(execute).toHaveBeenCalledOnce();
      expect(execute.mock.calls[0][0].map(item => item.itemId)).toEqual(['first', 'slow']);
      expect(handler).not.toHaveBeenCalled();
    }, { deps: { aroundInvoke: async ({ input, invoke }) => {
      const key = (input as { key: string }).key;
      entered.push(key);
      if (key === 'denied') return { isError: true, content: [] };
      if (key === 'slow') await barrier;
      return invoke();
    } } });
  });

  it('fails missing or duplicated native outcomes without replaying successful effects', async () => {
    const handler = vi.fn(async (value: { key: string }) => ({ data: value }));
    defineTool({ name, requirePrincipal: false, capability: 'test:read', effect: 'read', args,
      batch: { execute: async () => [
        { itemId: 'ok', response: { data: { key: 'ok' } } },
        { itemId: 'duplicate', response: { data: {} } },
        { itemId: 'duplicate', response: { data: {} } },
        { itemId: 'foreign', response: { data: {} } },
      ] }, handler });
    await wire(async request => {
      const result = await request('tools/call', { name, arguments: { _batch: 1,
        items: [item('ok', 'ok'), item('missing', 'missing'), item('duplicate', 'duplicate')] } });
      expect(result).toMatchObject({ isError: true });
      const data = batchData(result);
      expect(data.counts).toEqual({ ok: 1, failed: 2 });
      expect(data.results.map(row => [row.itemId, row.ok])).toEqual([
        ['ok', true], ['missing', false], ['duplicate', false],
      ]);
      expect(data.results[0].output?.structuredContent).toEqual({ key: 'ok' });
      expect(handler).not.toHaveBeenCalled();
    });
  });

  it('enforces the default 100-item ceiling and reserves supplied IDs before generating any ID', async () => {
    const handler = vi.fn(async (value: { key: string }) => ({ data: value }));
    defineTool({ name, requirePrincipal: false, capability: 'test:write', args, handler });
    await wire(async request => {
      const items = Array.from({ length: 100 }, (_, index) => item('same', index === 99 ? 'item-1' : undefined));
      const data = batchData(await request('tools/call', { name, arguments: { _batch: 1, items } }));
      expect(data.counts).toEqual({ ok: 100, failed: 0 });
      expect(new Set(data.results.map(row => row.itemId)).size).toBe(100);
      expect(data.results[99].itemId).toBe('item-1');
      expect(handler).toHaveBeenCalledTimes(100);
      const oversized = await request('tools/call', { name, arguments: { _batch: 1, items: [...items, item('extra')] } });
      expect(oversized).toMatchObject({ isError: true });
      expect(handler).toHaveBeenCalledTimes(100);
    });
  });

  it('preserves declared legacy callers and refuses their multi-item request before effects', async () => {
    const handler = vi.fn(async (value: { key: string }) => ({ data: value }));
    defineTool({ name, requirePrincipal: false, capability: 'test:write', args, handler });
    await wire(async request => {
      const call = (input: object) => request('tools/call', { name, arguments: input,
        _meta: { 'papercusp/batchResponseVersion': 'operation-v0' } });
      expect(await call({ key: 'one' })).toMatchObject({ structuredContent: { key: 'one' } });
      expect(await call({ _batch: 1, items: [item('a'), item('b')] })).toMatchObject({ isError: true });
      expect(handler).toHaveBeenCalledOnce();
    });
  });
});
