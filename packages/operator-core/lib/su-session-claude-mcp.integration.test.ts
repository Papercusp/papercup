/** Real installed CLI + Agent SDK + MCP SDK, with a private deterministic API.
 * This proves the native carrier, not production principal/capture authority. */
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { expect, it, vi } from 'vitest';
import { SU_SESSION_PROTOCOL_VERSION, SU_SESSION_SCHEMA } from '@papercusp/chat-protocol';
import { registerProjectedTool, unregisterProjectedToolsForPlugin, runDispatchStack, type ProjectedTool, type UnifiedToolContext } from '@papercusp/tooldef';
import { verifyNativeRuntimeBearer } from '@papercusp/agent-mcp/provisioning';
import { startDedicatedNativePg, type DedicatedNativePg } from '@papercusp/test-config/pg';
import { resolveAgentBinarySync } from './agent-bin-detect';
import { createClaudeNativeMcpServer } from './su-session-claude-mcp';
import { startClaudeSuEngine, type ClaudeSuEngine } from './su-session-claude-engine';
import { nativeInstalledPerUseTurns } from './agent-tools/per-use-chokepoint';
import { retainNativeRequestPrincipalForDispatch, runNativeMcpTargetOnOwner, type BuiltSpawnContext } from './endpoint-route/routes/transport/_mcp-host';
import { _configureSuSessionRoutingForTest, localSuSessionHostOwner } from './su-session-owner-routing';
import { sqlMiningFixture } from '../test/_sql-mining-fixture';
import type { BootstrapSuResult } from './endpoint-route/routes/agent-mcp/bootstrap-su';

let authorityDb: Awaited<ReturnType<typeof sqlMiningFixture>> | undefined;
let registerAuthorityHost: ((server: McpServer) => void) | undefined;
// The fixture supplies a private workspace transaction and a single MCP target;
// issuer/verification SQL, native engine/CLI, transport, principal retention and
// dispatcher ACL all execute their maintained implementations.
vi.mock('@papercusp/db-org', async original => ({
  ...await original<typeof import('@papercusp/db-org')>(),
  withWorkspace: async (workspace: string, callback: (tx: unknown) => Promise<unknown>) => {
    if (!authorityDb) throw new Error('Private authority database unavailable');
    return authorityDb.db.appSql.begin(async tx => {
      await tx`SELECT set_config('app.workspace_id', ${workspace}, true)`;
      return callback(tx);
    });
  },
}));
vi.mock('./endpoint-route/routes/transport/_mcp-host', async original => ({
  ...await original<typeof import('./endpoint-route/routes/transport/_mcp-host')>(),
  registerMcpHost: (server: McpServer) => {
    if (!registerAuthorityHost) throw new Error('Private authority MCP target unavailable');
    registerAuthorityHost(server);
  },
}));
vi.mock('./superuser-token', async original => ({
  ...await original<typeof import('./superuser-token')>(), readSuperuserToken: () => 'private-fixture-operator-token',
}));
vi.mock('./cupboard/identity-activation-gate-io', () => ({ admitNativeIdentityInference: async () => ({ ok: true }) }));
vi.mock('./su-session-persistence', async original => ({
  ...await original<typeof import('./su-session-persistence')>(),
  persistSuSessionDescriptor: async () => true, bindSuSessionToAdvSession: async () => ({ status: 'bound' }),
  readDurableSuSession: async () => null,
}));
vi.mock('./su-session-commands', async original => ({
  ...await original<typeof import('./su-session-commands')>(), loadSuOwnerTurnReceipts: async () => [],
}));

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
  const nativeInputId = randomUUID();
  const toolName = 'mcp__papercusp-su__carrier_probe';
  const calls = ['toolu_native_fixture_1', 'toolu_native_fixture_2'];
  const inputs = calls.map((_, index) => ({ index, session_id: 'model-forged-session', callId: 'model-forged-call' }));
  const observations: Array<{ sessionId: string; meta: unknown; arguments: unknown }> = [];
  const events: SDKMessage[] = [];
  const matchedNativeCalls: Array<{ id: string; name: string; input: unknown }> = [];
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  const errors: string[] = [];
  const httpNativeHeaders: unknown[] = [];
  const privateHeaders: Array<Record<string, unknown> | undefined> = [];
  const listed: string[][] = [];
  const runtimeBearer = 'runtime_private_' + randomUUID().replaceAll('-', '');
  let permissionCalls = 0;
  const hosts: McpServer[] = [];
  const register = (mcp: McpServer) => {
    hosts.push(mcp);
    mcp.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'carrier_probe',
    description: 'Private carrier fixture', inputSchema: { type: 'object', properties: {
      index: { type: 'integer' }, session_id: { type: 'string' }, callId: { type: 'string' },
    }, required: ['index', 'session_id', 'callId'] } }] }));
    mcp.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    privateHeaders.push(extra.requestInfo?.headers);
    // The accepted native input has its own chain UUID. It is a scope for
    // these observations, not Claude's internal native/billing turn UUID.
    expect(events).toContainEqual(expect.objectContaining({ type: 'user', uuid: nativeInputId,
      session_id: nativeId, parent_tool_use_id: null }));
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
  };
  const createMcp = () => {
    const mcp = new McpServer({ name: 'papercusp-su', version: '1' }, { capabilities: { tools: {} } });
    register(mcp); return mcp;
  };
  const mcp = transportKind === 'sdk' ? await createClaudeNativeMcpServer({
    url: 'http://127.0.0.1/api/mcp?superuser=1', headers: { 'x-papercusp-native-session': nativeId }, runtimeBearer,
    beforeToolCall: async callId => events.some(event => event.type === 'assistant'
      && event.session_id === nativeId && event.parent_tool_use_id === null
      && event.message.content.some(block => block.type === 'tool_use' && block.id === callId)),
    onToolsListed: tools => { listed.push(tools.map(tool => tool.name)); },
  }, { register, options: () => ({ capabilities: { tools: {} } }) }) : createMcp();
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
  let releaseInput!: () => void;
  const inputReady = new Promise<void>(resolve => { releaseInput = resolve; });
  async function* prompt() {
    await inputReady;
    yield { type: 'user' as const, uuid: nativeInputId, session_id: nativeId, parent_tool_use_id: null,
      message: { role: 'user' as const, content: 'Exercise the private MCP carrier twice.' } };
  }
  const run = query({ prompt: prompt(), options: {
    abortController,
    extraArgs: { 'replay-user-messages': null },
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
    spawnClaudeCodeProcess(options) {
      expect(JSON.stringify({ args: options.args, env: options.env })).not.toContain(runtimeBearer);
      return spawn(options.command, options.args, { cwd: options.cwd, env: options.env,
        stdio: ['pipe', 'pipe', 'pipe'], signal: options.signal });
    },
  } });
  const consume = (async () => { for await (const event of run) events.push(event); })();
  try {
    await run.initializationResult();
    if (transportKind === 'http') {
      let status = (await run.mcpServerStatus()).find(server => server.name === 'papercusp-su');
      while (status && ['pending', 'connecting'].includes(status.status) && !abortController.signal.aborted) {
        await new Promise(resolve => setTimeout(resolve, 20));
        status = (await run.mcpServerStatus()).find(server => server.name === 'papercusp-su');
      }
      expect(status?.status).toBe('connected');
      expect(status?.tools).toContainEqual(expect.objectContaining({ name: 'carrier_probe' }));
    }
    releaseInput();
    await consume;
    expect(errors).toEqual([]);
    expect(mainRequests).toBe(3);
    expect(observations).toEqual(calls.map((callId, index) => ({ sessionId: nativeId,
      meta: expect.objectContaining({ 'claudecode/toolUseId': callId }), arguments: inputs[index] })));
    expect(permissionCalls).toBe(0);
    if (transportKind === 'sdk') {
      expect(listed).toContainEqual(['carrier_probe']);
      expect(privateHeaders).toEqual(calls.map(() => expect.objectContaining({
        'x-papercusp-native-session': nativeId, 'x-papercusp-native-runtime': runtimeBearer,
      })));
      expect(JSON.stringify(requests)).not.toContain(runtimeBearer);
      expect(JSON.stringify(events)).not.toContain(runtimeBearer);
    }
    expect(httpNativeHeaders).toEqual(transportKind === 'http' ? [nativeId, nativeId] : []);
    expect(matchedNativeCalls).toEqual(calls.map((id, index) => ({ id, name: toolName, input: inputs[index] })));
    const init = events.find(event => event.type === 'system' && event.subtype === 'init');
    expect(init).toMatchObject({ session_id: nativeId });
    expect(events.filter(event => 'session_id' in event).every(event => event.session_id === nativeId)).toBe(true);
    const results = events.filter(event => event.type === 'result');
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ type: 'result', subtype: 'success', is_error: false });
    // Installed CLI versions may send lifecycle frames after the result that
    // the installed SDK's declared message union does not yet describe.
    console.info('CLAUDE_NATIVE_INPUT_PROOF', JSON.stringify({ nativeId, nativeInputId,
      lifecycle: events.filter((event: unknown) => event !== null && typeof event === 'object'
        && 'type' in event && event.type === 'command_lifecycle') }));
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
    releaseInput();
    clearTimeout(deadline);
    run.close();
    await Promise.all(hosts.map(host => host.close()));
    api.closeAllConnections();
    await new Promise<void>((resolve, reject) => api.close(error => error ? reject(error) : resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);

it('withholds the private bearer from missing and unobserved call metadata', async () => {
  const seen: unknown[] = [], checked: string[] = [];
  const inventories: unknown[] = [];
  const host = await createClaudeNativeMcpServer({ url: 'http://127.0.0.1/api/mcp?superuser=1', headers: {},
    runtimeBearer: 'host-private-only', beforeToolCall: async callId => { checked.push(callId); return callId === 'observed'; },
    onToolsListed: tools => { inventories.push(tools); },
  }, { options: () => ({ capabilities: { tools: {} } }), register(server) {
    server.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
      { name: 'read', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
      { name: 'write', inputSchema: { type: 'object' }, annotations: { readOnlyHint: false } },
      { name: 'unknown', inputSchema: { type: 'object' } },
    ] }));
    server.server.setRequestHandler(CallToolRequestSchema, async (_request, extra) => {
      seen.push(extra.requestInfo?.headers?.['x-papercusp-native-runtime']);
      return { content: [{ type: 'text', text: 'ordinary result' }] };
    });
  } });
  const client = new Client({ name: 'private-custody-fixture', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await host.connect(serverTransport); await client.connect(clientTransport);
    await client.listTools();
    expect(inventories).toEqual([[{ name: 'read', annotations: { readOnly: true } },
      { name: 'write', annotations: { readOnly: false } }, { name: 'unknown' }]]);
    for (const callId of [undefined, 'unobserved', 'observed']) {
      await client.callTool({ name: 'probe', arguments: { 'x-papercusp-native-runtime': 'model-forgery' },
        ...(callId ? { _meta: { 'claudecode/toolUseId': callId } } : {}) });
    }
    expect(checked).toEqual(['unobserved', 'observed']);
    expect(seen).toEqual([undefined, undefined, 'host-private-only']);
  } finally { await client.close(); await host.close(); }
});

it('real Claude engine joins accepted input, PG possession, host principal and current ACL without inventing a billing turn', async () => {
  const binary = resolveAgentBinarySync('claude');
  expect(binary, 'installed Claude required; no protocol peer substitution').toBeTruthy();
  const dir = mkdtempSync(join(tmpdir(), 'claude-engine-authority-'));
  const nativeId = randomUUID(), owner = 'su-private-claude-authority', workspaceId = 'sql-mining-test';
  const harness = 'mining-test', canonical = 'native-authority:inspect', nativeName = 'mcp__papercusp-su__native_authority_inspect';
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  const promptFile = join(dir, 'su.md');
  writeFileSync(promptFile, 'Private offline SU authority integration.\n'.repeat(100));
  let engine: ClaudeSuEngine | undefined, allowed = true, requests = 0;
  let pg: DedicatedNativePg | undefined;
  const oldAdminUrl = process.env.PAPERCUSP_TEST_PG_ADMIN_URL;
  let phase = 'private-pg';
  const errors: string[] = [], bearerCopies: string[] = [], events: SDKMessage[] = [];
  const bodies: unknown[] = [], observed: Array<{ callId: string; principal: string | undefined; ok: boolean }> = [];
  const calls = ['toolu_authority_allowed', 'toolu_authority_revoked'];
  const args = { harness, query: 'private query', session_id: 'model-forged-session' };
  const fn = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'authorized private result' }] }));
  const authorize = vi.fn(async () => ({ allow: allowed, reason: 'private ACL revoked' }));
  const target: ProjectedTool = { pluginName: 'native-authority', description: 'Private authority test',
    inputSchema: { type: 'object' }, capabilities: [], expose: { mcp: { name: canonical } },
    requirePrincipal: true, authorize, fn };
  const api = createServer(async (request, response) => {
    try {
      let text = ''; for await (const chunk of request) text += chunk;
      const body = text ? JSON.parse(text) : {}; bodies.push(body);
      if (request.url?.startsWith('/v1/messages/count_tokens')) {
        response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"input_tokens":10}'); return;
      }
      if (!request.url?.startsWith('/v1/messages')) { response.writeHead(404); response.end('{}'); return; }
      expect(body.tools).toContainEqual(expect.objectContaining({ name: nativeName }));
      const index = requests++;
      message(response, index, index < calls.length ? { id: calls[index]!, name: nativeName, input: args } : undefined);
    } catch (error) { errors.push(String(error)); response.writeHead(500); response.end('{}'); }
  });
  try {
    pg = await startDedicatedNativePg({ baseDir: dir,
      settings: { max_connections: '120', fsync: 'off', synchronous_commit: 'off' } });
    process.env.PAPERCUSP_TEST_PG_ADMIN_URL = pg.getConnectionUri();
    phase = 'private-migrated-org';
    authorityDb = await sqlMiningFixture();
    const db = authorityDb.db;
    expect(new URL(db.adminDsn).port).toBe(String(pg.port));
    const [row] = await db.adminSql`INSERT INTO harness_shared.adv_sessions
      (workspace_id,mode,coord_owner_id,agent,session_id)
      VALUES (${workspaceId},'console',${owner},'claude',${nativeId}) RETURNING id`;
    const advSessionId = Number(row!.id);
    const principal = { kind: 'system' as const, slug: 'system:superuser', workspaceId,
      authMethod: 'bearer-token' as const, trust: 'trusted' as const, capabilities: new Set(['*']) };
    const resolvePrincipal = vi.fn(async () => principal);
    registerProjectedTool(target);
    const readOwner = vi.fn(async () => localSuSessionHostOwner());
    _configureSuSessionRoutingForTest({ readOwner });
    registerAuthorityHost = server => {
      server.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'native_authority_inspect',
        description: target.description, inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }] }));
      server.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
        try {
          const callId = String(request.params._meta?.['claudecode/toolUseId']);
          expect(calls).toContain(callId);
          const bearer = String(extra.requestInfo?.headers?.['x-papercusp-native-runtime'] ?? '');
          expect(bearer).not.toBe(''); bearerCopies.push(bearer);
          expect(await verifyNativeRuntimeBearer(bearer, { workspaceId, ownerId: owner, advSessionId, provider: 'claude' })).toBe(true);
          const spawn: BuiltSpawnContext = { workspaceId, harnessSlug: harness, role: 'operator', featureId: null,
            chunkId: null, runId: 'private-run', spawnId: 'private-request', parentSpawnId: null,
            uiClientId: owner, detectorSessionKey: null, advSessionId, isSuperuser: true,
            requestOrigin: { transport: 'mcp', nativeSession: { carrier: 'header:x-papercusp-native-session',
              binding: 'bound', candidateAdvSessionId: advSessionId, valueFingerprint: hash(nativeId), callIdFingerprint: hash(callId) } } };
          const retained = await retainNativeRequestPrincipalForDispatch(spawn, canonical, request.params.arguments, bearer);
          expect(retained.authenticatedPrincipal?.slug).toBe(principal.slug);
          const ctx = { workspaceId, harnessSlug: harness, uiClientId: owner, transport: 'mcp', role: 'operator',
            principal: retained.authenticatedPrincipal, requestOrigin: spawn.requestOrigin,
            signal: extra.signal, log: vi.fn(), progress: vi.fn(), emit: vi.fn() } as unknown as UnifiedToolContext;
          const response = await runNativeMcpTargetOnOwner({ toolName: canonical, args: request.params.arguments,
            spawn: retained, fullSource: false, structuredSource: false, indirect: false }, async () => {
            const result = await runDispatchStack(target, canonical, request.params.arguments, ctx, { aroundInvoke: async attempt => {
              // Native input identity is capture-only, not a fabricated native turn.
              expect(nativeInstalledPerUseTurns.resolve(attempt)).toBeNull();
              const append = vi.fn();
              expect(await nativeInstalledPerUseTurns.appendAuthorizedCapture(attempt, append)).toBe(false);
              expect(append).not.toHaveBeenCalled();
              return attempt.invoke();
            } });
            observed.push({ callId, principal: retained.authenticatedPrincipal?.slug, ok: result.ok });
            return { content: [{ type: 'text' as const, text: result.ok ? 'authorized private result' : 'private ACL denied' }], isError: !result.ok };
          }, 20_000);
          // The same exact-call principal cannot be borrowed a second time.
          expect((await retainNativeRequestPrincipalForDispatch(spawn, canonical, request.params.arguments, bearer)).authenticatedPrincipal).toBeUndefined();
          allowed = false;
          return response;
        } catch (error) { errors.push(String(error)); throw error; }
      });
    };
    api.listen(0, '127.0.0.1'); await once(api, 'listening');
    const address = api.address(); if (!address || typeof address === 'string') throw new Error('Private API unavailable');
    const boot = { status: 'ok', specificationRevision: 'fixture-spec', stateRevision: 'fixture-state', compositionSource: 'blueprint',
      agent: 'claude', sessionId: advSessionId, nativeSessionId: nativeId, workspaceId, harnessSlug: harness, planSlug: null,
      codexHome: null, coordExtPath: null, cwd: dir, promptFile,
      envelopeEnv: { PAPERCUSP_SID: owner, PAPERCUSP_WORKSPACE: workspaceId, CLAUDE_CONFIG_DIR: dir },
    } satisfies BootstrapSuResult;
    phase = 'engine-startup';
    engine = startClaudeSuEngine(boot, { operation: 'created', backend: 'claude', advSessionId, ownerId: owner,
      workspaceId, harnessSlug: harness, planSlug: null, nativeSession: null },
    { nativeSession: { backend: 'claude', source: 'adv_sessions', ownerId: owner, sessionId: nativeId,
      configDir: dir, configDirSource: 'live-process', configDirUnresolvedReason: null, exactResumeSupported: true, missingReason: null },
      transcriptPath: null }, { agentChatId: 'private-claude-authority',
      startupTimeoutMs: 20_000, deliveryTimeoutMs: 15_000, turnStallTimeoutMs: 20_000,
      resolveRequestPrincipal: resolvePrincipal, servedAccountReader: async () => null,
      query: input => {
        const run = query({ ...input, options: { ...input.options,
          pathToClaudeCodeExecutable: binary!, tools: [], allowedTools: [nativeName], maxTurns: 3,
          settingSources: [], strictMcpConfig: true, settings: { disableAllHooks: true }, persistSession: false,
          // No inherited provider credential, gateway, real operator or hooks.
          env: { HOME: dir, PATH: process.env.PATH, CLAUDE_CONFIG_DIR: dir,
            ANTHROPIC_API_KEY: 'private-fixture-token', ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1' },
          spawnClaudeCodeProcess(options) { return spawn(options.command, options.args, {
            cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'], signal: options.signal }); },
        } });
        return { [Symbol.asyncIterator]: async function* () { for await (const event of run) { events.push(event); yield event; } },
          initializationResult: () => run.initializationResult(), mcpServerStatus: () => run.mcpServerStatus(),
          interrupt: () => run.interrupt(), close: () => run.close() };
      },
    });
    await engine.ready;
    phase = 'native-owner-input';
    const host = engine.adapter.host;
    await host.startCommand({ schema: SU_SESSION_SCHEMA, protocolVersion: SU_SESSION_PROTOCOL_VERSION,
      issuedAt: new Date().toISOString(), target: host.descriptor().identity, type: 'owner_turn',
      commandId: 'private-authority', turnId: 'owner-private-authority', content: 'Exercise private authority twice.' }).terminal;
    phase = 'native-result';
    await vi.waitFor(() => expect(events.some(event => event.type === 'result')).toBe(true), { timeout: 20_000 });
    expect(errors).toEqual([]);
    expect(observed).toEqual(calls.map((callId, index) => ({ callId, principal: principal.slug, ok: index === 0 })));
    expect(fn).toHaveBeenCalledOnce(); expect(authorize).toHaveBeenCalledTimes(2);
    expect(readOwner).toHaveBeenCalledTimes(2);
    expect(resolvePrincipal.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(events).toContainEqual(expect.objectContaining({ type: 'user', session_id: nativeId, parent_tool_use_id: null }));
    expect(bearerCopies).toHaveLength(2); expect(bearerCopies[0]).toBe(bearerCopies[1]);
    expect(JSON.stringify({ bodies, events, descriptor: host.descriptor() })).not.toContain(bearerCopies[0]);
    // Terminal result synchronously withdraws the accepted-input scope.
    expect(await nativeInstalledPerUseTurns.resolveRequestPrincipal({ workspaceId, advSessionId, ownerId: owner,
      nativeSessionFingerprint: hash(nativeId), callIdFingerprint: hash(calls[1]!), toolName: canonical,
      arguments: args, runtimeBearer: bearerCopies[0]! })).toBeNull();
  } catch (error) {
    throw new Error(`Private Claude authority integration failed during ${phase}`, { cause: error });
  } finally {
    try {
      if (engine) { await engine.close(); engine.adapter.dispose(); }
      api.closeAllConnections(); if (api.listening) await new Promise<void>((resolve, reject) => api.close(error => error ? reject(error) : resolve()));
      unregisterProjectedToolsForPlugin('native-authority'); registerAuthorityHost = undefined;
      _configureSuSessionRoutingForTest();
      await authorityDb?.cleanup(); authorityDb = undefined;
    } finally {
      if (oldAdminUrl === undefined) delete process.env.PAPERCUSP_TEST_PG_ADMIN_URL;
      else process.env.PAPERCUSP_TEST_PG_ADMIN_URL = oldAdminUrl;
      await pg?.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  }
}, 120_000);
