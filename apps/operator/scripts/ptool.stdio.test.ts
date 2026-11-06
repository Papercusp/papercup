import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { expect, it } from 'vitest';

// A local protocol fixture: no operator, shared database or platform credentials.
it('carries the downstream listed generation across the real CLI stdio boundary without replay', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ptool-stdio-'));
  const tokenFile = join(home, 'token');
  await writeFile(tokenFile, 'stdio-fixture-token', { mode: 0o600 });
  let generation = 'serving-generation-v1:first';
  const calls: Array<Record<string, unknown>> = [];
  const upstream = createServer(async (request, response) => {
    if (request.headers.authorization !== 'Bearer stdio-fixture-token') {
      response.writeHead(401).end();
      return;
    }
    const server = new Server({ name: 'generation-fixture', version: '1' }, { capabilities: { tools: {} } });
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
      '--url', `http://127.0.0.1:${address.port}`, '--token-file', tokenFile],
    env: Object.fromEntries(Object.entries({ ...process.env, HOME: home, PAPERCUSP_OPERATOR_HOME: home })
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
    stderr: 'pipe',
  });
  let diagnostics = '';
  transport.stderr?.on('data', chunk => { diagnostics += String(chunk); });
  const client = new Client({ name: 'legacy-metadata-free-client', version: '1' });
  try {
    await client.connect(transport, { timeout: 30_000 });
    expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(['tools:invoke']);
    const request = { name: 'tools:invoke', arguments: { name: 'fixture:missing', args: {} } };
    const first = await client.callTool(request);
    expect(first).toMatchObject({ isError: true, content: [{ text: 'unknown tool negative control' }] });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ arguments: { name: 'fixture:missing', args: '{}' },
      _meta: { 'papercusp/servingGeneration': generation } });
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
