/**
 * P-001 executable feasibility proof for desktop-agent-mcp-uds-2026-09-08.
 *
 * This is deliberately an installed-runtime test, not an SDK-only proxy:
 * the real `omp` binary loads an owned extension, exposes its MCP-backed tool
 * through OMP's native tool inventory, and runs a local RPC slash command that
 * performs initialize -> tools/list -> tools/call over UDS.  The same binary,
 * extension, credential, request sequence, fixture server, payload and result
 * are then driven over HTTP; only the transport address changes. P-008 extends
 * the original feasibility proof with the pre-registered three-round, >100
 * sample comparison and fixed rollout budgets from plan decision D-009.
 */
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { createServer as createNetServer, type Server as NetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

type JsonObject = Record<string, unknown>;
type Witness = {
  transport: 'uds' | 'http';
  method: string;
  authenticated: boolean;
  connection: number;
};

const TOKEN = 'p001-fixture-token';
const PROTOCOL_VERSION = '2025-06-18';
const WORKLOAD_VALUE = 'same-authenticated-workload';
const WARM_ROUNDS = 3;
const SAMPLES_PER_ROUND = 34;
const WARM_SAMPLES = WARM_ROUNDS * SAMPLES_PER_ROUND;
const roots: string[] = [];

function object(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function percentile(values: number[], quantile: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)]!;
}

function executableOnPath(name: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

type FixtureFault = 'missing-catalog' | 'different-payload' | 'missing-timing';

function responseFor(message: JsonObject, fault?: FixtureFault): JsonObject | null {
  const id = message.id;
  if (id === undefined || id === null) return null;
  const method = String(message.method ?? '');
  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'p001-shared-fixture', version: '1.0.0' },
        instructions: 'P-001 transport-only comparison fixture',
      },
    };
  }
  if (method === 'tools/list') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        tools: fault === 'missing-catalog' ? [] : [
          {
            name: 'echo',
            description: 'Echo one authenticated fixture value.',
            inputSchema: {
              type: 'object',
              properties: { value: { type: 'string' } },
              required: ['value'],
              additionalProperties: false,
            },
          },
        ],
      },
    };
  }
  if (method === 'tools/call') {
    const toolStarted = performance.now();
    const params = object(message.params);
    const args = object(params.arguments);
    const content = [{ type: 'text', text: `echo:${fault === 'different-payload' ? 'wrong-workload' : String(args.value ?? '')}` }];
    const toolExecutionMs = performance.now() - toolStarted;
    return {
      jsonrpc: '2.0',
      id,
      result: {
        content,
        _meta: {
          fixture: 'p001-shared-fixture', protocol: 'mcp',
          ...(fault === 'missing-timing' ? {} : { toolExecutionMs }),
        },
      },
    };
  }
  return {
    jsonrpc: '2.0',
    id,
    error: { code: -32601, message: `Unknown method ${method}` },
  };
}

async function readRequestBody(request: import('node:http').IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

async function startFixture(root: string, witnesses: Witness[], fault?: FixtureFault): Promise<{
  uds: NetServer;
  http: HttpServer;
  socketPath: string;
  httpUrl: string;
}> {
  const socketPath = join(root, 'mcp.sock');
  let connection = 0;
  const uds = createNetServer((socket) => {
    const connectionId = ++connection;
    let authenticated = false;
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const message = object(JSON.parse(line));
        const method = String(message.method ?? '');
        if (method === 'initialize') {
          const meta = object(object(message.params)._meta);
          authenticated = meta.authorization === `Bearer ${TOKEN}`;
        }
        witnesses.push({ transport: 'uds', method, authenticated, connection: connectionId });
        if (authenticated && method === 'tools/call') {
          // Interleave server-push traffic with every benchmark call. The
          // client must retain framing and match the subsequent response by id.
          socket.write(`${JSON.stringify({
            jsonrpc: '2.0', method: 'notifications/progress',
            params: { progressToken: String(message.id), progress: 0.5 },
          })}\n`);
        }
        const response = authenticated ? responseFor(message, fault === 'missing-catalog' ? fault : undefined) : {
          jsonrpc: '2.0', id: message.id, error: { code: -32001, message: 'unauthorized' },
        };
        if (response && message.id !== undefined) socket.write(`${JSON.stringify(response)}\n`);
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    uds.once('error', reject);
    uds.listen(socketPath, () => {
      uds.off('error', reject);
      resolve();
    });
  });
  chmodSync(socketPath, 0o600);

  const http = createHttpServer(async (request, response) => {
    const message = object(JSON.parse((await readRequestBody(request)) || '{}'));
    const authenticated = request.headers.authorization === `Bearer ${TOKEN}`;
    witnesses.push({
      transport: 'http',
      method: String(message.method ?? ''),
      authenticated,
      connection: ++connection,
    });
    if (!authenticated) {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    const payload = responseFor(message, fault === 'missing-catalog' ? undefined : fault);
    if (!payload) {
      response.writeHead(202);
      response.end();
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(payload));
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('HTTP fixture did not bind');
  return { uds, http, socketPath, httpUrl: `http://127.0.0.1:${address.port}/mcp` };
}

function extensionSource(): string {
  return String.raw`
import { once } from 'node:events';
import { writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { performance } from 'node:perf_hooks';

const socketPath = process.env.PC_UDS_PROOF_SOCKET;
const httpUrl = process.env.PC_UDS_PROOF_HTTP_URL;
const token = process.env.PC_UDS_PROOF_TOKEN;
const resultPath = process.env.PC_UDS_PROOF_RESULT;
const protocolVersion = process.env.PC_UDS_PROOF_PROTOCOL;
const workloadValue = process.env.PC_UDS_PROOF_VALUE;

function cpuMicros(start) {
  const used = process.cpuUsage(start);
  return used.user + used.system;
}

async function udsJourney(value) {
  const started = performance.now();
  const cpuStarted = process.cpuUsage();
  const socket = createConnection(socketPath);
  socket.setTimeout(4_000, () => socket.destroy(new Error('UDS fixture request deadline')));
  socket.setEncoding('utf8');
  let buffer = '';
  let nextId = 0;
  let notifications = 0;
  const pending = new Map();
  socket.on('data', (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const frame = JSON.parse(line);
      if (frame.method === 'notifications/progress') {
        notifications++;
        continue;
      }
      const waiter = pending.get(String(frame.id));
      if (!waiter) continue;
      pending.delete(String(frame.id));
      if (frame.error) waiter.reject(new Error(frame.error.message));
      else waiter.resolve(frame.result);
    }
  });
  socket.on('error', (error) => {
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  });
  socket.on('close', () => {
    for (const waiter of pending.values()) waiter.reject(new Error('UDS fixture disconnected'));
    pending.clear();
  });
  await once(socket, 'connect');
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const id = String(++nextId);
    pending.set(id, { resolve, reject });
    socket.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const initializeStarted = performance.now();
  const initialized = await request('initialize', {
    protocolVersion,
    capabilities: {},
    clientInfo: { name: 'omp-installed-uds-proof', version: '1.0.0' },
    _meta: { authorization: 'Bearer ' + token },
  });
  const initializeRoundTripMs = performance.now() - initializeStarted;
  socket.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');
  const transportStarted = performance.now();
  const listed = await request('tools/list');
  const listRoundTripMs = performance.now() - transportStarted;
  let called = null;
  let callRoundTripMs = null;
  if (value !== null) {
    const toolStarted = performance.now();
    called = await request('tools/call', { name: 'echo', arguments: { value } });
    callRoundTripMs = performance.now() - toolStarted;
  }
  socket.end();
  await once(socket, 'close');
  return {
    transport: 'uds', protocolVersion: initialized.protocolVersion,
    server: initialized.serverInfo.name,
    tools: listed.tools.map((tool) => tool.name), call: called,
    methods: value === null
      ? ['initialize', 'notifications/initialized', 'tools/list']
      : ['initialize', 'notifications/initialized', 'tools/list', 'tools/call'],
    initializeRoundTripMs, listRoundTripMs, callRoundTripMs,
    toolExecutionMs: called?._meta?.toolExecutionMs,
    notifications,
    nonToolCallRoundTripMs: called ? callRoundTripMs - called._meta.toolExecutionMs : null,
    endToEndMs: performance.now() - started, cpuMicros: cpuMicros(cpuStarted),
  };
}

async function httpJourney(value) {
  const started = performance.now();
  const cpuStarted = process.cpuUsage();
  let nextId = 0;
  const request = async (method, params = {}, notification = false) => {
    const frame = notification
      ? { jsonrpc: '2.0', method, params }
      : { jsonrpc: '2.0', id: String(++nextId), method, params };
    const response = await fetch(httpUrl, {
      method: 'POST',
      signal: AbortSignal.timeout(4_000),
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
      body: JSON.stringify(frame),
    });
    if (!response.ok) throw new Error('HTTP MCP request failed: ' + response.status);
    return notification ? null : (await response.json()).result;
  };
  const initializeStarted = performance.now();
  const initialized = await request('initialize', {
    protocolVersion,
    capabilities: {},
    clientInfo: { name: 'omp-installed-uds-proof', version: '1.0.0' },
  });
  const initializeRoundTripMs = performance.now() - initializeStarted;
  await request('notifications/initialized', {}, true);
  const transportStarted = performance.now();
  const listed = await request('tools/list');
  const listRoundTripMs = performance.now() - transportStarted;
  const toolStarted = performance.now();
  const called = await request('tools/call', { name: 'echo', arguments: { value } });
  const callRoundTripMs = performance.now() - toolStarted;
  return {
    transport: 'http', protocolVersion: initialized.protocolVersion,
    server: initialized.serverInfo.name,
    tools: listed.tools.map((tool) => tool.name), call: called,
    methods: ['initialize', 'notifications/initialized', 'tools/list', 'tools/call'],
    initializeRoundTripMs, listRoundTripMs, callRoundTripMs,
    toolExecutionMs: called._meta.toolExecutionMs,
    nonToolCallRoundTripMs: callRoundTripMs - called._meta.toolExecutionMs,
    endToEndMs: performance.now() - started, cpuMicros: cpuMicros(cpuStarted),
  };
}

export default async function (pi) {
  const discovery = await udsJourney(null);
  if (!discovery.tools.includes('echo')) throw new Error('UDS discovery did not return echo');
  const nativeResults = [];
  for (const transport of ['uds', 'http']) {
    pi.registerTool({
      name: 'fixture_' + transport + '_echo',
      label: 'Fixture ' + transport + ' echo',
      description: 'P-001 MCP tool backed by the authenticated fixture.',
      parameters: pi.zod.object({ value: pi.zod.string() }),
      approval: 'read',
      mcpServerName: 'fixture-' + transport,
      mcpToolName: 'echo',
      async execute(_callId, params) {
        const journey = await (transport === 'uds' ? udsJourney : httpJourney)(params.value);
        nativeResults.push(journey);
        return { content: journey.call.content, details: { journey } };
      },
    });
  }
  // Deterministic local inference, NOT another agent or a remote provider:
  // the installed OMP agent loop must execute both registered tools itself.
  let inferenceTurn = 0;
  pi.registerProvider('p001-fixture', {
    api: 'p001-fixture-api', apiKey: 'local-fixture-only', baseUrl: 'http://unused.invalid',
    models: [{
      id: 'proof', name: 'Offline proof', reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000, maxTokens: 1024,
    }],
    streamSimple(model) {
      const transport = ['uds', 'http'][inferenceTurn++];
      if (inferenceTurn > 3) throw new Error('Unexpected extra inference turn');
      const content = transport
        ? [{ type: 'toolCall', id: 'native-' + transport, name: 'fixture_' + transport + '_echo',
            arguments: { value: workloadValue } }]
        : [{ type: 'text', text: 'Both native MCP tool calls completed.' }];
      const message = {
        role: 'assistant', content, api: model.api, provider: model.provider, model: model.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: transport ? 'toolUse' : 'stop', timestamp: Date.now(),
      };
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: 'start', partial: message };
          if (transport) yield { type: 'toolcall_end', contentIndex: 0, toolCall: content[0], partial: message };
          yield { type: 'done', reason: message.stopReason, message };
        },
        result: async () => message,
      };
    },
  });
  pi.registerCommand('uds-proof', {
    description: 'Run the deterministic direct-UDS and equivalent HTTP MCP proof.',
    handler: async () => {
      const uds = await udsJourney(workloadValue);
      const http = await httpJourney(workloadValue);
      const samples = { uds: [], http: [] };
      // D-009: three bounded rounds and >100 warm samples per transport.
      // Counterbalance every pair and invert the first transport each round so
      // neither route owns all early/cold or late/warm positions.
      for (let round = 0; round < 3; round++) {
        for (let i = 0; i < 34; i++) {
          const udsFirst = (round + i) % 2 === 0;
          for (const transport of (udsFirst ? ['uds', 'http'] : ['http', 'uds'])) {
            samples[transport].push({
              ...await (transport === 'uds' ? udsJourney : httpJourney)(workloadValue),
              round,
            });
          }
        }
      }
      const largeValue = workloadValue.repeat(4096);
      const large = {
        uds: await udsJourney(largeValue),
        http: await httpJourney(largeValue),
      };
      const concurrent = {};
      for (const transport of ['uds', 'http']) {
        const started = performance.now();
        const calls = await Promise.all(Array.from({ length: 8 }, (_, i) =>
          (transport === 'uds' ? udsJourney : httpJourney)(workloadValue + '-concurrent-' + i)));
        const elapsedMs = performance.now() - started;
        concurrent[transport] = { calls, elapsedMs, throughputPerSec: calls.length * 1000 / elapsedMs };
      }
      await writeFile(resultPath, JSON.stringify({
        installedRuntime: 'omp', discovery, nativeResults, uds, http, samples, large, concurrent,
        workload: { value: workloadValue, tokenIdentity: 'p001-fixture-token' },
      }, null, 2));
    },
  });
}
`;
}

async function waitFor<T>(read: () => T | undefined, child: ChildProcessWithoutNullStreams, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    if (child.exitCode !== null || child.signalCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`OMP proof timed out or exited (${child.exitCode ?? child.signalCode ?? 'running'})`);
}

async function closeServer(server: NetServer | HttpServer): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const ompBin = executableOnPath('omp');

describe.skipIf(!ompBin)('installed OMP direct MCP transport proof', () => {
  async function runProof(fault?: FixtureFault): Promise<void> {
    const root = mkdtempSync(join(tmpdir(), 'omp-uds-p001-'));
    roots.push(root);
    const agentDir = join(root, 'agent');
    const sessionDir = join(root, 'sessions');
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(sessionDir, { recursive: true });
    const extensionPath = join(root, 'uds-proof.ts');
    const resultPath = join(root, 'result.json');
    writeFileSync(extensionPath, extensionSource(), { mode: 0o600 });

    const witnesses: Witness[] = [];
    const fixture = await startFixture(root, witnesses, fault);
    expect(statSync(fixture.socketPath).mode & 0o777).toBe(0o600);

    const frames: JsonObject[] = [];
    let stderr = '';
    const launchStarted = performance.now();
    const child = spawn(
      ompBin!,
      [
        '--mode', 'rpc',
        '--no-extensions',
        '--no-skills',
        '--no-rules',
        '--no-session',
        '--extension', extensionPath,
        '--model', 'p001-fixture/proof',
      ],
      {
        cwd: root,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          PATH: process.env.PATH,
          LANG: process.env.LANG ?? 'C.UTF-8',
          PI_CODING_AGENT_DIR: agentDir,
          PI_CODING_AGENT_SESSION_DIR: sessionDir,
          PC_UDS_PROOF_SOCKET: fixture.socketPath,
          PC_UDS_PROOF_HTTP_URL: fixture.httpUrl,
          PC_UDS_PROOF_TOKEN: TOKEN,
          PC_UDS_PROOF_RESULT: resultPath,
          PC_UDS_PROOF_PROTOCOL: PROTOCOL_VERSION,
          PC_UDS_PROOF_VALUE: WORKLOAD_VALUE,
        },
      },
    );
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    let stdout = '';
    const parseErrors: string[] = [];
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      let newline: number;
      while ((newline = stdout.indexOf('\n')) >= 0) {
        const line = stdout.slice(0, newline).trim();
        stdout = stdout.slice(newline + 1);
        if (line) {
          try { frames.push(object(JSON.parse(line))); }
          catch { parseErrors.push(line.slice(0, 500)); }
        }
      }
    });
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-8_000);
    });

    const request = async (id: string, type: string, extra: JsonObject = {}): Promise<JsonObject> => {
      child.stdin.write(`${JSON.stringify({ id, type, ...extra })}\n`);
      const response = await waitFor(
        () => frames.find((frame) => frame.type === 'response' && frame.id === id),
        child,
      );
      expect(response.success, JSON.stringify(response)).toBe(true);
      return response;
    };

    try {
      await waitFor(() => frames.find((frame) => frame.type === 'ready'), child);
      const runtimeReadyMs = performance.now() - launchStarted;
      const before = object((await request('state-before', 'get_state')).data);
      const beforeSessionId = String(before.sessionId ?? '');
      expect(beforeSessionId).not.toBe('');
      const systemPrompt = Array.isArray(before.systemPrompt) ? before.systemPrompt.join('\n') : '';
      expect(
        /xd:\/\/[^\s`]*(?:fixture[-_]uds|fixture_uds_echo)/i.test(systemPrompt),
        `OMP did not expose positive MCP route evidence. stderr: ${stderr}`,
      ).toBe(true);

      await request('native', 'prompt', { message: 'Exercise both fixture tools.' });
      await waitFor(() => frames.find((frame) => frame.type === 'agent_end'), child);
      const executions = frames.filter((frame) => frame.type === 'tool_execution_end');
      expect(executions.map((frame) => frame.toolName)).toEqual(['fixture_uds_echo', 'fixture_http_echo']);
      expect(executions.every((frame) => frame.isError === false)).toBe(true);
      expect(parseErrors).toEqual([]);
      await request('proof', 'prompt', { message: '/uds-proof' });
      await waitFor(() => existsSync(resultPath) ? true : undefined, child);
      const after = object((await request('state-after', 'get_state')).data);
      expect(after.sessionId).toBe(beforeSessionId);

      const result = object(JSON.parse(readFileSync(resultPath, 'utf8')));
      const discovery = object(result.discovery);
      const uds = object(result.uds);
      const http = object(result.http);
      const nativeResults = result.nativeResults as JsonObject[];
      expect(nativeResults.map((row) => row.transport)).toEqual(['uds', 'http']);
      for (const row of nativeResults) {
        expect(object(row.call).content, 'non-equivalent workload').toEqual([{ type: 'text', text: `echo:${WORKLOAD_VALUE}` }]);
      }
      expect(discovery.tools).toEqual(['echo']);
      expect(uds.protocolVersion).toBe(PROTOCOL_VERSION);
      expect(http.protocolVersion).toBe(PROTOCOL_VERSION);
      expect(uds.server).toBe(http.server);
      expect(uds.tools).toEqual(http.tools);
      expect(uds.methods).toEqual(http.methods);
      expect(object((uds.call as JsonObject)).content).toEqual(object((http.call as JsonObject)).content);
      expect(JSON.stringify(object((uds.call as JsonObject)).content))
        .toBe(JSON.stringify(object((http.call as JsonObject)).content));
      expect(object((uds.call as JsonObject))._meta).toMatchObject({
        fixture: 'p001-shared-fixture', protocol: 'mcp',
      });
      expect(object((http.call as JsonObject))._meta).toMatchObject({
        fixture: 'p001-shared-fixture', protocol: 'mcp',
      });
      expect(object(result.workload)).toEqual({
        value: WORKLOAD_VALUE,
        tokenIdentity: TOKEN,
      });
      for (const journey of [uds, http]) {
        for (const field of ['initializeRoundTripMs', 'listRoundTripMs', 'callRoundTripMs', 'toolExecutionMs', 'nonToolCallRoundTripMs', 'endToEndMs', 'cpuMicros']) {
          expect(Number(journey[field]), `${String(journey.transport)} ${field}`).toBeGreaterThanOrEqual(0);
        }
      }
      expect(Number(uds.notifications)).toBe(1);

      const fullMethods = ['initialize', 'notifications/initialized', 'tools/list', 'tools/call'];
      // native invocation + cold comparison + warm matrix + one large result
      // + eight concurrent clients. Keep this exact: a missing or duplicate
      // journey must change the wire census rather than hide in a lower bound.
      const comparedJourneys = 2 + WARM_SAMPLES + 1 + 8;
      const udsConnections = Map.groupBy(
        witnesses.filter((row) => row.transport === 'uds'),
        row => row.connection,
      );
      expect([...udsConnections.values()].filter(rows => rows.length === 3).map(rows => rows.map(row => row.method)))
        .toEqual([['initialize', 'notifications/initialized', 'tools/list']]);
      const fullUdsConnections = [...udsConnections.values()].filter(rows => rows.length === 4);
      expect(fullUdsConnections).toHaveLength(comparedJourneys);
      expect(fullUdsConnections.every(rows => rows.map(row => row.method).join(',') === fullMethods.join(',')))
        .toBe(true);
      const httpMethods = witnesses.filter((row) => row.transport === 'http').map((row) => row.method);
      expect(httpMethods).toHaveLength(comparedJourneys * fullMethods.length);
      for (const method of fullMethods) {
        expect(httpMethods.filter(candidate => candidate === method)).toHaveLength(comparedJourneys);
      }
      expect(witnesses.every((row) => row.authenticated)).toBe(true);
      const samples = object(result.samples);
      const summary: JsonObject = {};
      for (const transport of ['uds', 'http']) {
        const journeys = samples[transport] as JsonObject[];
        expect(journeys).toHaveLength(WARM_SAMPLES);
        expect(new Set(journeys.map(journey => Number(journey.round)))).toEqual(new Set([0, 1, 2]));
        summary[transport] = Object.fromEntries(
          ['initializeRoundTripMs', 'listRoundTripMs', 'callRoundTripMs', 'toolExecutionMs', 'nonToolCallRoundTripMs', 'endToEndMs', 'cpuMicros'].map((field) => {
            const values = journeys.map((journey) => Number(journey[field])).sort((a, b) => a - b);
            expect(values.every((value) => Number.isFinite(value) && value >= 0)).toBe(true);
            return [field, { p50: percentile(values, 0.5), p95: percentile(values, 0.95) }];
          }),
        );
      }
      const udsSummary = object(summary.uds);
      const httpSummary = object(summary.http);
      const at = (summaryRow: JsonObject, field: string, quantile: string) =>
        Number(object(summaryRow[field])[quantile]);
      const udsCallP50 = at(udsSummary, 'callRoundTripMs', 'p50');
      const httpCallP50 = at(httpSummary, 'callRoundTripMs', 'p50');
      const udsE2eP95 = at(udsSummary, 'endToEndMs', 'p95');
      const httpE2eP95 = at(httpSummary, 'endToEndMs', 'p95');
      const udsCpuP50 = at(udsSummary, 'cpuMicros', 'p50');
      const httpCpuP50 = at(httpSummary, 'cpuMicros', 'p50');
      // D-009's immutable pre-comparison budgets. These are ratios against the
      // same in-run HTTP arm, never absolute host-speed assertions.
      expect(udsCallP50).toBeLessThanOrEqual(httpCallP50 * 0.8);
      expect(udsE2eP95).toBeLessThanOrEqual(Math.max(httpE2eP95 * 1.1, httpE2eP95 + 2));
      expect(udsCpuP50).toBeLessThanOrEqual(Math.max(httpCpuP50 * 1.25, httpCpuP50 + 2_000));
      expect(1 / udsCallP50).toBeGreaterThanOrEqual((1 / httpCallP50) * 0.9);
      expect(Number(uds.endToEndMs)).toBeLessThanOrEqual(Number(http.endToEndMs) + 500);
      const large = object(result.large);
      const largeUds = object(large.uds);
      const largeHttp = object(large.http);
      expect(object(largeUds.call).content).toEqual(object(largeHttp.call).content);
      expect(JSON.stringify(object(largeUds.call).content).length).toBeGreaterThan(32_000);
      expect(Number(largeUds.notifications)).toBe(1);
      const concurrent = object(result.concurrent);
      const concurrentUds = object(concurrent.uds);
      const concurrentHttp = object(concurrent.http);
      expect(concurrentUds.calls).toHaveLength(8);
      expect(concurrentHttp.calls).toHaveLength(8);
      expect(Number(concurrentUds.throughputPerSec))
        .toBeGreaterThanOrEqual(Number(concurrentHttp.throughputPerSec) * 0.9);
      expect((concurrentUds.calls as JsonObject[]).every(call => Number(call.notifications) === 1)).toBe(true);
      console.info('P001_TRANSPORT_BASELINE', JSON.stringify({ runtimeReadyMs, ...summary }));

      // Rebind this fixture-owned endpoint after an actual dead process leaves
      // a socket inode behind. This is not the production stale-path policy:
      // P-004 must reject an endpoint still owned by a live peer.
      await closeServer(fixture.uds);
      expect(existsSync(fixture.socketPath)).toBe(false);
      const staleProducer = spawnSync(process.execPath, [
        '-e', 'require("node:net").createServer().listen(process.argv[1],()=>process.exit(0))',
        fixture.socketPath,
      ], { timeout: 2_000 });
      expect(staleProducer.status, String(staleProducer.stderr)).toBe(0);
      expect(statSync(fixture.socketPath).isSocket()).toBe(true);
      rmSync(fixture.socketPath);
      await new Promise<void>((resolve) => fixture.uds.listen(fixture.socketPath, resolve));
      chmodSync(fixture.socketPath, 0o600);
      rmSync(resultPath);
      await request('reconnect-proof', 'prompt', { message: '/uds-proof' });
      await waitFor(() => existsSync(resultPath) ? true : undefined, child);
      const reconnected = object(JSON.parse(readFileSync(resultPath, 'utf8')));
      expect(object(object(reconnected.uds).call).content).toEqual(object(uds.call).content);
      expect(Number(object(reconnected.uds).endToEndMs)).toBeLessThanOrEqual(5_000);
      expect(object((await request('state-reconnected', 'get_state')).data).sessionId).toBe(beforeSessionId);
      expect(statSync(fixture.socketPath).mode & 0o777).toBe(0o600);
    } catch (error) {
      throw new Error(
        `${String(error)}\nOMP stderr: ${stderr}\nRecent frames: ${JSON.stringify(frames.slice(-6))}\nParse errors: ${JSON.stringify(parseErrors)}`,
        { cause: error },
      );
    } finally {
      child.stdin.end();
      await Promise.race([
        once(child, 'close'),
        new Promise((resolve) => setTimeout(resolve, 2_000)),
      ]);
      if (child.exitCode === null && child.signalCode === null) {
        const closed = once(child, 'close');
        child.kill('SIGKILL');
        await closed;
      }
      await Promise.all([closeServer(fixture.uds), closeServer(fixture.http)]);
    }
    expect(existsSync(fixture.socketPath)).toBe(false);
  }

  it('runs an equivalent authenticated tools/list + tools/call journey over UDS and HTTP',
    () => runProof(), 45_000);
  it('rejects an installed runtime whose UDS catalog is unavailable',
    async () => {
      await expect(runProof('missing-catalog')).rejects.toThrow('UDS discovery did not return echo');
    }, 30_000);
  it('rejects a comparison that returns a different authenticated workload',
    async () => {
      await expect(runProof('different-payload')).rejects.toThrow('non-equivalent workload');
    }, 30_000);
  it('rejects a comparison with missing server tool-execution measurements',
    async () => {
      await expect(runProof('missing-timing')).rejects.toThrow('http toolExecutionMs');
    }, 30_000);
});
