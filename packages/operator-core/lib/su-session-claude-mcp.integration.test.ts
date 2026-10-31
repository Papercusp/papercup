/** Real installed CLI + Agent SDK + MCP SDK, with a private deterministic API.
 * This proves the native carrier, not production principal/capture authority. */
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { expect, it } from 'vitest';
import { resolveAgentBinarySync } from './agent-bin-detect';

function message(response: ServerResponse, sequence: number, tool?: { id: string; name: string; input: object }) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const send = (value: { type: string; [key: string]: unknown }) => response.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`);
  send({ type: 'message_start', message: { id: `msg_fixture_${sequence}`, type: 'message', role: 'assistant',
    model: 'claude-sonnet-4-5', content: [], stop_reason: null, stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 0 } } });
  if (tool) {
    send({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: tool.id, name: tool.name, input: {} } });
    send({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(tool.input) } });
  } else {
    send({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } });
  }
  send({ type: 'content_block_stop', index: 0 });
  send({ type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } });
  send({ type: 'message_stop' });
  response.end();
}

it.each(['sdk', 'http'] as const)('retains real CLI tool-use IDs at the %s MCP session seam without permission hooks', async transportKind => {
  const binary = resolveAgentBinarySync('claude');
  expect(binary, 'installed Claude is required; do not substitute a protocol peer').toBeTruthy();
  const dir = mkdtempSync(join(tmpdir(), 'claude-native-mcp-'));
  const nativeId = randomUUID();
  const toolName = 'mcp__papercusp-su__carrier_probe';
  const calls = ['toolu_native_fixture_1', 'toolu_native_fixture_2'];
  const inputs = calls.map((_, index) => ({ index, session_id: 'model-forged-session', callId: 'model-forged-call' }));
  const observations: Array<{ sessionId: string; meta: unknown; arguments: unknown }> = [];
  const events: SDKMessage[] = [];
  const matchedNativeCalls: Array<{ id: string; name: string; input: unknown }> = [];
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  const errors: string[] = [];
  const httpNativeHeaders: unknown[] = [];
  let permissionCalls = 0;
  const hosts: McpServer[] = [];
  const createMcp = () => {
    const mcp = new McpServer({ name: 'papercusp-su', version: '1' }, { capabilities: { tools: {} } });
    hosts.push(mcp);
    mcp.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'carrier_probe',
    description: 'Private carrier fixture', inputSchema: { type: 'object', properties: {
      index: { type: 'integer' }, session_id: { type: 'string' }, callId: { type: 'string' },
    }, required: ['index', 'session_id', 'callId'] } }] }));
    mcp.server.setRequestHandler(CallToolRequestSchema, async request => {
    // The host must independently observe this exact native call before it
    // could retain a request principal. A matching session closure alone does
    // not prove the call's target or arguments; permission hooks may not run.
    const nativeCall = events.flatMap(event => event.type === 'assistant'
      && event.session_id === nativeId && event.parent_tool_use_id === null ? event.message.content : [])
      .find(block => block.type === 'tool_use' && block.id === request.params._meta?.['claudecode/toolUseId']);
    expect(nativeCall).toMatchObject({ type: 'tool_use', name: toolName, input: request.params.arguments });
    if (!nativeCall || nativeCall.type !== 'tool_use') throw new Error('No independently observed root native call');
    matchedNativeCalls.push({ id: nativeCall.id, name: nativeCall.name, input: nativeCall.input });
    observations.push({ sessionId: nativeId, meta: request.params._meta, arguments: request.params.arguments });
    return { content: [{ type: 'text', text: 'private carrier observed' }] };
    });
    return mcp;
  };
  const mcp = createMcp();
  let mainRequests = 0;
  const api = createServer(async (request, response) => {
    try {
      let text = '';
      for await (const chunk of request) text += chunk;
      const body = text ? JSON.parse(text) : {};
      if (request.url === '/mcp') {
        if (body.method === 'tools/call') httpNativeHeaders.push(request.headers['x-papercusp-native-session']);
        const host = createMcp();
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        await host.connect(transport);
        await transport.handleRequest(request, response, body);
        return;
      }
      requests.push({ path: request.url ?? '', body });
      if (!request.url?.startsWith('/v1/messages')) {
        response.writeHead(404); response.end('{}'); return;
      }
      // Count-token and auxiliary requests are not model turns.
      if (request.url.startsWith('/v1/messages/count_tokens')) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ input_tokens: 10 })); return;
      }
      const advertised = Array.isArray(body.tools) && body.tools.some((tool: { name?: string }) => tool.name === toolName);
      if (!advertised) {
        response.writeHead(400); response.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'native MCP fixture not advertised' } })); return;
      }
      const index = mainRequests++;
      message(response, index, index < calls.length ? { id: calls[index]!, name: toolName, input: inputs[index]! } : undefined);
    } catch (error) {
      errors.push(String(error)); response.writeHead(500); response.end('{}');
    }
  });
  api.listen(0, '127.0.0.1');
  await once(api, 'listening');
  const address = api.address();
  if (!address || typeof address === 'string') throw new Error('Private API has no port');
  const abortController = new AbortController();
  const deadline = setTimeout(() => abortController.abort(), 20_000);
  const run = query({ prompt: 'Exercise the private MCP carrier twice.', options: {
    abortController,
    pathToClaudeCodeExecutable: binary!, cwd: dir, sessionId: nativeId,
    // Construct the entire child environment. No subscription credential,
    // gateway, inherited parent session or real operator is reachable by config.
    env: { HOME: dir, PATH: process.env.PATH, CLAUDE_CONFIG_DIR: dir,
      ANTHROPIC_API_KEY: 'private-fixture-token', ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1',
      CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1' },
    model: 'claude-sonnet-4-5', systemPrompt: 'Private offline carrier test.', tools: [],
    settingSources: [], settings: { disableAllHooks: true }, strictMcpConfig: true,
    mcpServers: { 'papercusp-su': transportKind === 'sdk'
      ? { type: 'sdk', name: 'papercusp-su', instance: mcp }
      : { type: 'http', url: `http://127.0.0.1:${address.port}/mcp`, headers: { 'x-papercusp-native-session': nativeId } } },
    allowedTools: [toolName], maxTurns: 3, persistSession: false,
    canUseTool: async () => { permissionCalls++; return { behavior: 'deny', message: 'This test must not need permission callbacks' }; },
  } });
  try {
    for await (const event of run) events.push(event);
    expect(errors).toEqual([]);
    expect(mainRequests).toBe(3);
    expect(observations).toEqual(calls.map((callId, index) => ({ sessionId: nativeId,
      meta: expect.objectContaining({ 'claudecode/toolUseId': callId }), arguments: inputs[index] })));
    expect(permissionCalls).toBe(0);
    expect(httpNativeHeaders).toEqual(transportKind === 'http' ? [nativeId, nativeId] : []);
    expect(matchedNativeCalls).toEqual(calls.map((id, index) => ({ id, name: toolName, input: inputs[index] })));
    const init = events.find(event => event.type === 'system' && event.subtype === 'init');
    expect(init).toMatchObject({ session_id: nativeId });
    expect(events.filter(event => 'session_id' in event).every(event => event.session_id === nativeId)).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'result', subtype: 'success', is_error: false });
    const toolResults = requests.flatMap(request => Array.isArray(request.body.messages) ? request.body.messages : [])
      .flatMap((entry: { content?: unknown }) => Array.isArray(entry.content) ? entry.content : [])
      .filter((block: { type?: string }) => block.type === 'tool_result');
    for (const id of calls) {
      const results = toolResults.filter((block: { tool_use_id?: string }) => block.tool_use_id === id);
      expect(results.length).toBeGreaterThan(0);
      // Native Anthropic messages omit is_error on success.
      expect(results.every((block: { is_error?: boolean }) => block.is_error !== true)).toBe(true);
      expect(results[0]).toMatchObject({ content: expect.arrayContaining([
        expect.objectContaining({ type: 'text', text: expect.stringContaining('private carrier observed') }),
      ]) });
    }
  } finally {
    clearTimeout(deadline);
    run.close();
    await Promise.all(hosts.map(host => host.close()));
    api.closeAllConnections();
    await new Promise<void>((resolve, reject) => api.close(error => error ? reject(error) : resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
