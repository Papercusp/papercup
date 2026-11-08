import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { PassThrough, Writable } from 'node:stream';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, InitializeRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { expect, it } from 'vitest';
import { createPtoolStdioTransport, createPtoolStdioBridge, enablePtoolMemoryReceipts } from './ptool.mjs';
import { openDeliveryLedger } from './hooks/inject/delivery-ledger.mjs';

it.each(['codex', 'claude', 'omp'])('records %s MCP output only after the real writable callback', async client => {
  const home = await mkdtemp(join(tmpdir(), 'ptool-stdout-'));
  const env = { PAPERCUSP_HOME: home, PAPERCUSP_SID: 'su-stdio', PAPERCUSP_AGENT: client };
  const input = new PassThrough();
  let finish: ((error?: Error | null) => void) | undefined;
  let bytes = '';
  const output = new Writable({ write(chunk, _encoding, callback) { bytes += String(chunk); finish = callback; } });
  const transport = await createPtoolStdioTransport({ stdin: input, stdout: output, env });
  const rendered = '- memory: approval required after the final condition ☃';
  const fragment = { kind: 'memory', id: 'memory-stdio', epoch: 4, port: 'claim', rendered,
    bodySha256: createHash('sha256').update(rendered).digest('hex'), bodyBytes: Buffer.byteLength(rendered) };
  const message = { jsonrpc: '2.0' as const, id: 11, result: { content: [{ type: 'text', text: rendered }],
    _meta: { 'papercusp/memoryEmission': { owner: env.PAPERCUSP_SID, token: 'stdout-11', fragments: [fragment] } } } };
  try {
    const sent = transport.send(message);
    // A true write() return is only buffer acceptance. No receipt exists yet.
    expect(bytes).toBe(JSON.stringify(message) + '\n');
    expect(openDeliveryLedger(env.PAPERCUSP_SID, env)!.confirmedMemoryDeliveries()).toEqual([]);
    finish!();
    await sent;
    const { rendered: _text, ...manifest } = fragment;
    expect(openDeliveryLedger(env.PAPERCUSP_SID, env)!.confirmedMemoryDeliveries())
      .toEqual([{ token: 'stdout-11', fragments: [manifest] }]);
    const calls: unknown[] = [];
    const bridge = createPtoolStdioBridge({
      listTools: async () => ({ tools: [] }),
      callTool: async (request: unknown) => { calls.push(request); return { content: [] }; },
    }, { env, listTools: async () => [{ name: 'fixture:read', inputSchema: { type: 'object' },
      _meta: { 'papercusp/servingGeneration': 'receipt-generation' } }] });
    await bridge.listTools();
    await bridge.callTool({ name: 'fixture:read', arguments: { original: 'unchanged' } });
    expect(calls).toMatchObject([{ name: 'fixture:read', arguments: { original: 'unchanged' }, _meta: {
      'papercusp/memoryReceipt': { version: 1, confirmations: [{ token: 'stdout-11', fragments: [manifest] }] },
    } }]);
  } finally {
    await transport.close(); input.destroy(); output.destroy();
    await rm(home, { recursive: true, force: true });
  }
});

it('never records a buffered MCP response whose stdout callback reports EPIPE', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ptool-epipe-'));
  const env = { PAPERCUSP_HOME: home, PAPERCUSP_SID: 'su-epipe', PAPERCUSP_AGENT: 'codex' };
  const input = new PassThrough();
  const output = new Writable({ write(_chunk, _encoding, callback) {
    setImmediate(() => callback(Object.assign(new Error('broken pipe'), { code: 'EPIPE' })));
  } });
  const transport = await createPtoolStdioTransport({ stdin: input, stdout: output, env });
  try {
    await expect(transport.send({ jsonrpc: '2.0', id: 12, result: { content: [],
      _meta: { 'papercusp/memoryEmission': { owner: env.PAPERCUSP_SID, token: 'lost-12', fragments: [] } } } }))
      .rejects.toThrow('broken pipe');
    expect(openDeliveryLedger(env.PAPERCUSP_SID, env, 'mcp')!.confirmed()).toBeNull();
  } finally {
    await transport.close(); input.destroy(); output.destroy();
    await rm(home, { recursive: true, force: true });
  }
});

it('keeps pending stdout errors handled when the MCP input closes first', async () => {
  const input = new PassThrough();
  let finish: ((error?: Error | null) => void) | undefined;
  const output = new Writable({ write(_chunk, _encoding, callback) { finish = callback; } });
  const transport = await createPtoolStdioTransport({ stdin: input, stdout: output, env: {} });
  const sent = transport.send({ jsonrpc: '2.0', id: 13, result: { content: [] } });
  const rejected = expect(sent).rejects.toThrow('closed consumer');
  await transport.close();
  // Let immediate cleanup run before the outstanding write fails.
  await new Promise<void>(resolve => setImmediate(resolve));
  finish!(new Error('closed consumer'));
  await rejected;
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(output.listenerCount('error')).toBe(0);
  await expect(transport.send({ jsonrpc: '2.0', id: 14, result: { content: [] } })).rejects.toThrow('is closed');
  input.destroy(); output.destroy();
});

it('forwards initialize offers only with the unchanged instructions and waits for stdout proof', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ptool-initialize-'));
  const env = { PAPERCUSP_HOME: home, PAPERCUSP_SID: 'su-initialize', PAPERCUSP_AGENT: 'claude' };
  const input = new PassThrough();
  let finish: (() => void) | undefined;
  const output = new Writable({ write(_chunk, _encoding, callback) { finish = callback; } });
  const transport = await createPtoolStdioTransport({ stdin: input, stdout: output, env });
  const rendered = '- initialize memory with its complete condition ☃';
  const fragment = { kind: 'memory', id: 'initialize-memory', epoch: 2, port: 'initialize', rendered,
    bodySha256: createHash('sha256').update(rendered).digest('hex'), bodyBytes: Buffer.byteLength(rendered) };
  const offer = { owner: env.PAPERCUSP_SID, token: 'initialize-1', fragments: [fragment] };
  const requests: unknown[] = [];
  const client = { request: async (request: unknown) => {
    requests.push(request);
    return { instructions: rendered, _meta: { 'papercusp/memoryEmission': offer } };
  }, listTools: async () => ({ tools: [] }), callTool: async () => ({ content: [] }) };
  enablePtoolMemoryReceipts(client, env);
  const bridge = createPtoolStdioBridge(client, { env });
  try {
    await client.request({ method: 'initialize', params: { protocolVersion: '2025-03-26' } });
    expect(requests).toMatchObject([{ params: { _meta: { 'papercusp/memoryReceipt': {
      version: 1, confirmations: [],
    } } } }]);
    expect(bridge.initializeResult({ instructions: rendered + ' changed' })).not.toHaveProperty('_meta');
    const result = bridge.initializeResult({ instructions: rendered });
    expect(result._meta).toMatchObject({ 'papercusp/memoryEmission': offer });
    const sent = transport.send({ jsonrpc: '2.0', id: 1, result });
    expect(openDeliveryLedger(env.PAPERCUSP_SID, env, 'mcp')!.confirmedMemoryDeliveries()).toEqual([]);
    finish!(); await sent;
    const { rendered: _text, ...manifest } = fragment;
    expect(openDeliveryLedger(env.PAPERCUSP_SID, env, 'mcp')!.confirmedMemoryDeliveries())
      .toEqual([{ token: offer.token, fragments: [manifest] }]);
    await client.request({ method: 'initialize', params: {} });
    expect(requests[1]).toMatchObject({ params: { _meta: { 'papercusp/memoryReceipt': {
      confirmations: [{ token: offer.token, fragments: [manifest] }],
    } } } });
  } finally {
    await transport.close(); input.destroy(); output.destroy();
    await rm(home, { recursive: true, force: true });
  }
});

// A local protocol fixture: no operator, shared database or platform credentials.
it.each(['http', 'auto'])('carries the downstream listed generation across the real %s CLI stdio boundary without replay', async transportMode => {
  const home = await mkdtemp(join(tmpdir(), 'ptool-stdio-'));
  const tokenFile = join(home, 'token');
  await writeFile(tokenFile, 'stdio-fixture-token', { mode: 0o600 });
  let generation = 'serving-generation-v1:first';
  const calls: Array<Record<string, unknown>> = [];
  const initializations: unknown[] = [];
  const instructions = 'Keep these upstream native instructions.\n\nComplete condition ☃';
  const fragment = { kind: 'memory', id: 'initialize-cli-memory', epoch: 3, port: 'initialize',
    rendered: instructions, bodySha256: createHash('sha256').update(instructions).digest('hex'),
    bodyBytes: Buffer.byteLength(instructions) };
  const offer = { owner: 'su-stdio-cli', token: 'cli-initialize-1', fragments: [fragment] };
  const upstream = createServer(async (request, response) => {
    if (request.headers.authorization !== 'Bearer stdio-fixture-token') {
      response.writeHead(401).end();
      return;
    }
    const server = new Server({ name: 'generation-fixture', version: '1' }, {
      capabilities: { tools: {} }, instructions,
    });
    server.setRequestHandler(InitializeRequestSchema, async ({ params }) => {
      initializations.push(structuredClone(params));
      return { protocolVersion: '2025-03-26', capabilities: { tools: {} },
        serverInfo: { name: 'generation-fixture', version: '1' }, instructions,
        _meta: { 'papercusp/memoryEmission': offer } };
    });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{
      name: 'tools:invoke', inputSchema: { type: 'object', properties: {
        name: { type: 'string' }, args: { type: 'string' },
      } }, _meta: { 'papercusp/servingGeneration': generation },
    }] }));
    server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
      calls.push(structuredClone(params));
      return { isError: true, content: [{ type: 'text', text:
        params._meta?.['papercusp/servingGeneration'] === generation
          ? 'unknown tool negative control' : 'stale_tool_contract' }] };
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    response.on('close', () => { void server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(request, response);
    } catch {
      if (!response.headersSent) response.writeHead(500).end();
    }
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  if (!address || typeof address === 'string') throw new Error('fixture_address_missing');
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('./ptool.mjs', import.meta.url)), 'tools:invoke', '--stdio',
      '--transport', transportMode,
      '--url', `http://127.0.0.1:${address.port}`, '--token-file', tokenFile],
    env: Object.fromEntries(Object.entries({ ...process.env, HOME: home, PAPERCUSP_OPERATOR_HOME: home,
      PAPERCUSP_HOME: home, PAPERCUSP_SID: offer.owner, PAPERCUSP_AGENT: 'claude' })
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
    stderr: 'pipe',
  });
  let diagnostics = '';
  transport.stderr?.on('data', chunk => { diagnostics += String(chunk); });
  const client = new Client({ name: 'legacy-metadata-free-client', version: '1' });
  try {
    await client.connect(transport, { timeout: 30_000 });
    expect(client.getInstructions()).toBe(instructions);
    expect(initializations).toMatchObject([{ clientInfo: { name: 'ptool-claude' },
      _meta: { 'papercusp/memoryReceipt': { version: 1, confirmations: [] } } }]);
    expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(['tools:invoke']);
    const request = { name: 'tools:invoke', arguments: { name: 'fixture:missing', args: {} } };
    const first = await client.callTool(request);
    expect(first).toMatchObject({ isError: true, content: [{ text: 'unknown tool negative control' }] });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ arguments: { name: 'fixture:missing', args: '{}' },
      _meta: { 'papercusp/servingGeneration': generation } });
    const { rendered: _text, ...manifest } = fragment;
    expect(calls[0]._meta).toMatchObject({ 'papercusp/memoryReceipt': {
      version: 1, confirmations: [{ token: offer.token, fragments: [manifest] }],
    } });
    generation = 'serving-generation-v1:second';
    expect(await client.callTool(request)).toMatchObject({ isError: true,
      content: [{ text: 'stale_tool_contract' }] });
    expect(calls).toHaveLength(2);
    expect(calls[1]._meta).toMatchObject({ 'papercusp/servingGeneration': 'serving-generation-v1:first' });
    await client.listTools();
    expect(await client.callTool(request)).toMatchObject({ isError: true,
      content: [{ text: 'unknown tool negative control' }] });
    expect(calls).toHaveLength(3);
    expect(calls[2]._meta).toMatchObject({ 'papercusp/servingGeneration': generation });
    await expect(client.callTool({ ...request,
      _meta: { 'papercusp/servingGeneration': 'foreign-generation' } })).rejects.toThrow(/caller generation/);
    expect(calls).toHaveLength(3);
  } catch (error) {
    throw new Error(`${String(error)}\nptool diagnostics: ${diagnostics}`, { cause: error });
  } finally {
    await client.close();
    await transport.close();
    upstream.closeAllConnections();
    await new Promise<void>((resolve, reject) => upstream.close(error => error ? reject(error) : resolve()));
    await rm(home, { recursive: true, force: true });
  }
}, 60_000);
