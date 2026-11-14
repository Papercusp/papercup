import { randomUUID } from 'node:crypto';
import { createServer, type Server as HttpServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { registerNativeMcp, type NativeExtensionApi } from '../src/native-extension';
import { openDeliveryLedger, recordOmpMcpEmission } from '../../../apps/operator/scripts/hooks/inject/delivery-ledger.mjs';

type Tool = Parameters<NativeExtensionApi['registerTool']>[0];
let http: HttpServer;
let shutdown: (() => Promise<void>) | undefined;
let tools: Tool[];
let calls: Record<string, unknown>[];
let nativeCall: Parameters<NativeExtensionApi['on']>[1] | undefined;
let nativeResult: typeof nativeCall;
let observeOriginal: ReturnType<typeof vi.fn>;
let receiptHome: string;
let emission: Record<string, unknown> | undefined;
let beforeAgentStart: ((event: { systemPrompt: string[] }) => Promise<{ systemPrompt: string[] }>) | undefined;
const initializedInstructions = 'Native MCP initialization: approval remains required ☃';

beforeEach(async () => {
  tools = []; calls = []; shutdown = undefined; nativeCall = undefined; nativeResult = undefined;
  beforeAgentStart = undefined;
  observeOriginal = vi.fn(async () => undefined);
  receiptHome = mkdtempSync(join(tmpdir(), 'omp-native-memory-')); emission = undefined;
  vi.stubEnv('PAPERCUSP_HOME', receiptHome);
  vi.stubEnv('PAPERCUSP_SID', 'su-native-memory');
  const server = new Server({ name: 'native-call-fixture', version: '1' }, {
    capabilities: { tools: {} }, instructions: initializedInstructions,
  });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'echo',
    inputSchema: { type: 'object' as const, additionalProperties: true } }] }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    calls.push(request.params);
    return { content: [{ type: 'text', text: JSON.stringify(request.params.arguments) }],
      ...(emission ? { _meta: { 'papercusp/memoryEmission': emission } } : {}) };
  });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, enableJsonResponse: true });
  await server.connect(transport);
  http = createServer((request, response) => {
    void transport.handleRequest(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('fixture did not bind');
  await registerNativeMcp({ registerTool: tool => { tools.push(tool); },
    on: (name, handler) => {
      if (name === 'session_shutdown') shutdown = handler as () => Promise<void>;
      else if (name === 'tool_call') nativeCall = handler as typeof nativeCall;
      else if (String(name) === 'before_agent_start') beforeAgentStart = handler as unknown as typeof beforeAgentStart;
      else nativeResult = handler as typeof nativeResult;
    } }, {
    papercuspNativeMcp: { version: 1, mode: 'http',
      servers: { 'papercusp-su': { url: `http://127.0.0.1:${address.port}/mcp`,
        headers: { 'x-papercusp-client': 'su-native-memory' } } } },
  }, { observe: observeOriginal, close: () => {} });
  // Closing the SDK server also releases its SSE stream.
  const close = shutdown!;
  shutdown = async () => { await close(); await server.close(); };
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await shutdown?.();
  http.closeAllConnections();
  await new Promise<void>(resolve => http.close(() => resolve()));
  rmSync(receiptHome, { recursive: true, force: true });
});

describe('owned OMP native MCP call identity', () => {
  it('mounts initialized server instructions on each native turn without claiming emission', async () => {
    expect(beforeAgentStart).toBeTypeOf('function');
    const original = ['Existing system instructions'];
    const first = await beforeAgentStart!({ systemPrompt: original });
    expect(first.systemPrompt[0]).toBe(original[0]);
    expect(first.systemPrompt.join('\n')).toContain(initializedInstructions);
    expect(original).toEqual(['Existing system instructions']);
    const resumed = await beforeAgentStart!({ systemPrompt: first.systemPrompt });
    expect(resumed.systemPrompt).toEqual(first.systemPrompt);
    expect(openDeliveryLedger('su-native-memory', process.env, 'mcp')!.confirmedMemoryDeliveries()).toEqual([]);
  });

  it('returns only final stdout fragment receipts on the next MCP call, never on execute completion', async () => {
    const text = 'Approval remains required ☃';
    const fragment = { kind: 'memory', id: randomUUID(), epoch: 2, port: 'orient', rendered: text,
      bodySha256: createHash('sha256').update(text).digest('hex'), bodyBytes: Buffer.byteLength(text) };
    emission = { owner: 'su-native-memory', token: 'native-receipt', fragments: [fragment] };
    const result = await tools[0]!.execute('native-call', { context: text }, undefined, undefined,
      { sessionManager: { getSessionId: () => 'native-session' } });
    expect(calls[0]!._meta).toMatchObject({ 'papercusp/memoryReceipt': { version: 1, confirmations: [] } });
    const ledger = openDeliveryLedger('su-native-memory', process.env, 'mcp')!;
    expect(ledger.confirmedMemoryDeliveries()).toEqual([]);
    const payload = JSON.stringify({ type: 'tool_execution_end', toolCallId: 'native-call', toolName: tools[0]!.name, result }) + '\n';
    expect(recordOmpMcpEmission(payload, 'su-native-memory', 'native-session')).toBe(true);
    emission = undefined;
    await tools[0]!.execute('next-call', {}, undefined, undefined,
      { sessionManager: { getSessionId: () => 'native-session' } });
    expect(calls[1]!._meta).toMatchObject({ 'papercusp/memoryReceipt': { version: 1,
      confirmations: ledger.confirmedMemoryDeliveries() } });
    expect(ledger.confirmedMemoryDeliveries()).toHaveLength(1);
  });

  it('awaits the parent with a detached original native input, including built-ins', async () => {
    let release!: () => void;
    observeOriginal.mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
    const event = { toolCallId: 'shell-call', toolName: 'bash', input: { command: 'original' } };
    let finished = false;
    const result = nativeCall!(event, { sessionManager: { getSessionId: () => 'native-session' } })
      .then(value => { finished = true; return value; });
    event.input.command = 'rewritten';
    await Promise.resolve(); expect(finished).toBe(false);
    expect(observeOriginal).toHaveBeenCalledWith({ nativeSessionId: 'native-session', callId: 'shell-call',
      tool: 'bash', arguments: { command: 'original' } });
    release(); await expect(result).resolves.toBeUndefined();
  });

  it('blocks rather than executing when the private host refuses an observation', async () => {
    observeOriginal.mockRejectedValue(new Error('host no longer owns this input'));
    await expect(nativeCall!({ toolCallId: 'call', toolName: 'bash', input: {} },
      { sessionManager: { getSessionId: () => 'native-session' } })).resolves.toMatchObject({ block: true });
  });

  it('joins rewritten execution input to the detached original without replacing it', async () => {
    const context = { sessionManager: { getSessionId: () => 'native-session' } };
    const original = { toolCallId: 'shell-call', toolName: 'bash', input: { command: 'original' } };
    await nativeCall!(original, context);
    original.input.command = 'later mutation';
    const executed = { ...original, input: { command: 'executed' } };
    await nativeResult!(executed, context);
    executed.input.command = 'later execution mutation';
    expect(observeOriginal.mock.calls).toEqual([
      [{ nativeSessionId: 'native-session', callId: 'shell-call', tool: 'bash', arguments: { command: 'original' } }],
      [{ nativeSessionId: 'native-session', callId: 'shell-call', tool: 'bash', arguments: { command: 'original' },
        executedArguments: { command: 'executed' } }],
    ]);
    await expect(nativeResult!(executed, context)).rejects.toThrow('execution_observation_refused');
  });

  it.each(['missing', 'session', 'tool', 'refused'] as const)('refuses an unjoined execution: %s', async reason => {
    const event = { toolCallId: 'call', toolName: 'bash', input: { command: 'original' } };
    let session = 'native-session';
    const context = { sessionManager: { getSessionId: () => session } };
    if (reason !== 'missing') await nativeCall!(event, context);
    if (reason === 'session') session = 'other-session';
    if (reason === 'tool') event.toolName = 'browser';
    if (reason === 'refused') observeOriginal.mockRejectedValue(new Error('host closed'));
    await expect(nativeResult!(event, context)).rejects.toThrow('execution_observation_refused');
  });

  it('sends the native callback call and live session on the SDK wire, outside model arguments', async () => {
    const session = randomUUID();
    const args = { threadId: 'model-supplied-session', callId: 'model-supplied-call', value: 7 };
    const controller = new AbortController();
    await tools[0]!.execute('native-call-1', args, controller.signal, undefined,
      { sessionManager: { getSessionId: () => session } });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.arguments).toEqual(args);
    expect(calls[0]!._meta).toMatchObject({ threadId: session, callId: 'native-call-1' });
  });

  it('reads each callback context again after a native session change', async () => {
    let session = randomUUID();
    const first = session;
    const context = { sessionManager: { getSessionId: () => session } };
    await tools[0]!.execute('call-a', {}, undefined, undefined, context);
    session = randomUUID();
    await tools[0]!.execute('call-b', {}, undefined, undefined, context);
    expect(calls.map(call => call._meta)).toEqual([
      expect.objectContaining({ threadId: first, callId: 'call-a' }),
      expect.objectContaining({ threadId: session, callId: 'call-b' }),
    ]);
  });

  it.each([
    { call: '', session: randomUUID() },
    { call: 'call', session: '' },
    { call: 'invalid call', session: randomUUID() },
    { call: 'call', session: 'invalid session' },
    { call: 'c'.repeat(257), session: randomUUID() },
    { call: 'call', session: 's'.repeat(129) },
  ])('does not invent a partial native identity from environment or arguments: $call/$session', async value => {
    vi.stubEnv('PAPERCUSP_NATIVE_SESSION_ID', 'inherited-parent');
    vi.stubEnv('CODEX_SESSION_ID', 'unrelated-codex');
    await tools[0]!.execute(value.call, { threadId: 'argument-session', callId: 'argument-call' }, undefined, undefined,
      { sessionManager: { getSessionId: () => value.session } });
    expect(calls).toHaveLength(1);
    expect(calls[0]!._meta ?? {}).not.toHaveProperty('threadId');
    expect(calls[0]!._meta ?? {}).not.toHaveProperty('callId');
  });

  it('keeps a legacy callback unbound when native context is unavailable', async () => {
    await tools[0]!.execute('call', {});
    expect(calls[0]!._meta ?? {}).not.toHaveProperty('threadId');
    expect(calls[0]!._meta ?? {}).not.toHaveProperty('callId');
  });
});
