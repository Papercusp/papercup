/** Published batch schemas and dispatch through the real MCP SDK transport. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import Ajv2020 from 'ajv/dist/2020';
import { z } from 'zod';
import { _resetProjectionRegistryForTests, defineTool, listMcpProjections, lookupByMcpName, type BatchResult } from '@papercusp/tooldef';
import { dispatchProjectedToolToMcp } from './index';

afterEach(() => _resetProjectionRegistryForTests());

async function wire(run: (request: (method: string, params?: Record<string, unknown>) => Promise<unknown>) => Promise<void>) {
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
        workspaceId: 'wire-fixture', runId: 'wire-fixture', requestedStructured: true,
      }, {}, request.params._meta) as CallToolResult;
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
});
