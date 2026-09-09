/**
 * P-001 executable feasibility proof for desktop-agent-mcp-uds-2026-09-08.
 *
 * This is deliberately an installed-runtime test, not an SDK-only proxy:
 * the real `omp` binary loads an owned extension, exposes its MCP-backed tool
 * through OMP's native tool inventory, and runs a local RPC slash command that
 * performs initialize -> tools/list -> tools/call over UDS.  The same binary,
 * extension, credential, request sequence, fixture server, payload and result
 * are then driven over HTTP; only the transport address changes.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
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
const roots: string[] = [];

function object(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function executableOnPath(name: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function responseFor(message: JsonObject): JsonObject | null {
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
        tools: [
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
    const params = object(message.params);
    const args = object(params.arguments);
    return {
      jsonrpc: '2.0',
      id,
      result: {
        content: [{ type: 'text', text: `echo:${String(args.value ?? '')}` }],
        _meta: { fixture: 'p001-shared-fixture', protocol: 'mcp' },
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

async function startFixture(root: string, witnesses: Witness[]): Promise<{
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
        const response = authenticated ? responseFor(message) : {
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
    const payload = responseFor(message);
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
  socket.setEncoding('utf8');
  let buffer = '';
  let nextId = 0;
  const pending = new Map();
  socket.on('data', (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const frame = JSON.parse(line);
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
  const startupMs = performance.now() - initializeStarted;
  socket.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');
  const transportStarted = performance.now();
  const listed = await request('tools/list');
  const transportMs = performance.now() - transportStarted;
  let called = null;
  let toolExecutionMs = null;
  if (value !== null) {
    const toolStarted = performance.now();
    called = await request('tools/call', { name: 'echo', arguments: { value } });
    toolExecutionMs = performance.now() - toolStarted;
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
    startupMs, transportMs, toolExecutionMs,
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
  const startupMs = performance.now() - initializeStarted;
  await request('notifications/initialized', {}, true);
  const transportStarted = performance.now();
  const listed = await request('tools/list');
  const transportMs = performance.now() - transportStarted;
  const toolStarted = performance.now();
  const called = await request('tools/call', { name: 'echo', arguments: { value } });
  const toolExecutionMs = performance.now() - toolStarted;
  return {
    transport: 'http', protocolVersion: initialized.protocolVersion,
    server: initialized.serverInfo.name,
    tools: listed.tools.map((tool) => tool.name), call: called,
    methods: ['initialize', 'notifications/initialized', 'tools/list', 'tools/call'],
    startupMs, transportMs, toolExecutionMs,
    endToEndMs: performance.now() - started, cpuMicros: cpuMicros(cpuStarted),
  };
}

export default async function (pi) {
  const discovery = await udsJourney(null);
  if (!discovery.tools.includes('echo')) throw new Error('UDS discovery did not return echo');
  pi.registerTool({
    name: 'fixture_uds_echo',
    label: 'Fixture UDS echo',
    description: 'P-001 MCP tool discovered from the fixture UDS server.',
    parameters: pi.zod.object({ value: pi.zod.string() }),
    approval: 'read',
    loadMode: 'discoverable',
    mcpServerName: 'fixture-uds',
    mcpToolName: 'echo',
    async execute(_callId, params) {
      const journey = await udsJourney(params.value);
      return { content: journey.call.content, details: { journey } };
    },
  });
  pi.registerCommand('uds-proof', {
    description: 'Run the deterministic direct-UDS and equivalent HTTP MCP proof.',
    handler: async () => {
      const uds = await udsJourney(workloadValue);
      const http = await httpJourney(workloadValue);
      await writeFile(resultPath, JSON.stringify({
        installedRuntime: 'omp', discovery, uds, http,
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
  it('runs an equivalent authenticated tools/list + tools/call journey over UDS and HTTP', async () => {
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
    const fixture = await startFixture(root, witnesses);
    expect(statSync(fixture.socketPath).mode & 0o777).toBe(0o600);

    const frames: JsonObject[] = [];
    let stderr = '';
    const child = spawn(
      ompBin!,
      [
        '--mode', 'rpc',
        '--no-extensions',
        '--no-skills',
        '--no-rules',
        '--no-session',
        '--extension', extensionPath,
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
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      let newline: number;
      while ((newline = stdout.indexOf('\n')) >= 0) {
        const line = stdout.slice(0, newline).trim();
        stdout = stdout.slice(newline + 1);
        if (line) frames.push(object(JSON.parse(line)));
      }
    });
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-8_000);
    });

    const request = async (id: string, type: string, extra: JsonObject = {}): Promise<JsonObject> => {
      child.stdin.write(`${JSON.stringify({ id, type, ...extra })}\n`);
      return waitFor(
        () => frames.find((frame) => frame.type === 'response' && frame.id === id),
        child,
      );
    };

    try {
      await waitFor(() => frames.find((frame) => frame.type === 'ready'), child);
      const before = object((await request('state-before', 'get_state')).data);
      const beforeSessionId = String(before.sessionId ?? '');
      expect(beforeSessionId).not.toBe('');
      const systemPrompt = Array.isArray(before.systemPrompt) ? before.systemPrompt.join('\n') : '';
      expect(
        /xd:\/\/[^\s`]*(?:fixture[-_]uds|fixture_uds_echo)/i.test(systemPrompt),
        `OMP did not expose positive MCP route evidence. stderr: ${stderr}`,
      ).toBe(true);

      await request('proof', 'prompt', { message: '/uds-proof' });
      await waitFor(() => existsSync(resultPath) ? true : undefined, child);
      const after = object((await request('state-after', 'get_state')).data);
      expect(after.sessionId).toBe(beforeSessionId);

      const result = object(JSON.parse(readFileSync(resultPath, 'utf8')));
      const discovery = object(result.discovery);
      const uds = object(result.uds);
      const http = object(result.http);
      expect(discovery.tools).toEqual(['echo']);
      expect(uds.protocolVersion).toBe(PROTOCOL_VERSION);
      expect(http.protocolVersion).toBe(PROTOCOL_VERSION);
      expect(uds.server).toBe(http.server);
      expect(uds.tools).toEqual(http.tools);
      expect(uds.methods).toEqual(http.methods);
      expect(object((uds.call as JsonObject)).content).toEqual(object((http.call as JsonObject)).content);
      expect(object(result.workload)).toEqual({
        value: WORKLOAD_VALUE,
        tokenIdentity: TOKEN,
      });
      for (const journey of [uds, http]) {
        for (const field of ['startupMs', 'transportMs', 'toolExecutionMs', 'endToEndMs', 'cpuMicros']) {
          expect(Number(journey[field]), `${String(journey.transport)} ${field}`).toBeGreaterThanOrEqual(0);
        }
      }

      const fullMethods = ['initialize', 'notifications/initialized', 'tools/list', 'tools/call'];
      expect(witnesses.filter((row) => row.transport === 'uds').map((row) => row.method)).toEqual([
        'initialize', 'notifications/initialized', 'tools/list', ...fullMethods,
      ]);
      expect(witnesses.filter((row) => row.transport === 'http').map((row) => row.method)).toEqual(fullMethods);
      expect(witnesses.every((row) => row.authenticated)).toBe(true);
    } finally {
      child.stdin.end();
      await Promise.race([
        once(child, 'close'),
        new Promise((resolve) => setTimeout(resolve, 2_000)),
      ]);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await Promise.all([closeServer(fixture.uds), closeServer(fixture.http)]);
    }
    expect(existsSync(fixture.socketPath)).toBe(false);
  }, 30_000);
});
