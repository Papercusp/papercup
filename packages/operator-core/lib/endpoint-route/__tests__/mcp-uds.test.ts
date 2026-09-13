import { afterEach, describe, expect, it, vi } from 'vitest';
import { lstat, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { createConnection } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { UdsMcpTransport } from '@papercusp/tooldef-mcp';
import {
  AGENT_MCP_AUTH_META, startAgentMcpServer, type AgentMcpHost, type AgentMcpListener,
} from '../routes/transport/_mcp-uds';
import type { BuiltSpawnContext } from '../routes/transport/_mcp-host';
import { acquireMcpBodyAdmission, getMcpAdmissionSnapshot } from '../routes/transport/mcp-admission';

const live: AgentMcpListener[] = [];
const clients: Client[] = [];
afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map(c => c.close()));
  await Promise.allSettled(live.splice(0).map(s => s.close()));
});

function context(): BuiltSpawnContext {
  return {
    workspaceId: 'test-workspace', harnessSlug: 'test-harness', role: 'operator',
    uiClientId: 'test-session', runId: 'r', spawnId: 's', parentSpawnId: null,
    featureId: null, chunkId: null, detectorSessionKey: null, isSuperuser: true,
  };
}

async function fixture(authTimeoutMs?: number, runtimeDir?: string) {
  let ctx = context();
  let revoked = false;
  const dispatched = vi.fn();
  const verify = vi.fn<AgentMcpHost['verify']>(async (extra) => {
    const info = (extra as { requestInfo: { headers: Record<string, string> } }).requestInfo;
    return revoked || info.headers.authorization !== 'Bearer fixture-token'
      ? { kind: 'failed', reason: 'fixture-denied' }
      : { kind: 'ok', ctx: { ...ctx, runId: crypto.randomUUID(), spawnId: crypto.randomUUID() } };
  });
  const host: AgentMcpHost = {
    verify, options: { capabilities: { tools: {} } },
    register(server) {
      server.server.setRequestHandler(ListToolsRequestSchema, async () => {
        dispatched('list');
        return { tools: [{ name: 'echo', inputSchema: { type: 'object' } }] };
      });
      server.server.setRequestHandler(CallToolRequestSchema, async request => {
        dispatched('call');
        const text = request.params.arguments?.text === 'oversized'
          ? 'x'.repeat(4 * 1024 * 1024 + 1) : String(request.params.arguments?.text);
        return { content: [{ type: 'text' as const, text }] };
      });
    },
  };
  const listener = await startAgentMcpServer({ port: 3170, host, authTimeoutMs, runtimeDir });
  live.push(listener);
  return {
    listener, verify, dispatched, revoke: () => { revoked = true; },
    scopeChange: () => { ctx = { ...ctx, workspaceId: 'other' }; },
    unverified: () => { ctx = { ...ctx, isSuperuser: false }; },
  };
}

function credentials(listener: AgentMcpListener) {
  return {
    version: 1, operatorId: listener.endpoint.operatorId, generation: listener.endpoint.generation,
    url: 'http://127.0.0.1:3170/api/mcp?superuser=1&workspace=test-workspace',
    headers: { authorization: 'Bearer fixture-token' },
  };
}

function connection(listener: AgentMcpListener, value: unknown = credentials(listener)) {
  const wire = new UdsMcpTransport({ path: listener.endpoint.socketPath });
  const send = wire.send.bind(wire);
  wire.send = message => send('method' in message && message.method === 'initialize'
    ? { ...message, params: { ...message.params, _meta: { [AGENT_MCP_AUTH_META]: value } } }
    : message);
  const client = new Client({ name: 'uds-contract', version: '1' });
  clients.push(client);
  return { client, wire, send };
}

describe('private MCP listener lifecycle and connection authority', () => {
  it('uses distinct generation directories; closes only its own socket', async () => {
    const a = await fixture();
    const b = await fixture();
    expect(a.listener.endpoint.operatorId).toBe(b.listener.endpoint.operatorId);
    expect(a.listener.endpoint.generation).not.toBe(b.listener.endpoint.generation);
    const path = a.listener.endpoint.socketPath;
    expect((await lstat(dirname(path))).mode & 0o777).toBe(0o700);
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    await a.listener.close();
    await expect(lstat(path)).rejects.toThrow();
    expect((await lstat(b.listener.endpoint.socketPath)).isSocket()).toBe(true);
    await expect(lstat(dirname(path))).rejects.toThrow();
  });

  it('preserves unexpected files instead of recursively deleting the private directory', async () => {
    const f = await fixture();
    const dir = dirname(f.listener.endpoint.socketPath);
    const peer = join(dir, 'preserve-me');
    await writeFile(peer, 'peer content');
    await f.listener.close();
    expect(await readFile(peer, 'utf8')).toBe('peer content');
    await rm(dir, { recursive: true });
  });

  it('never adopts a stale or malicious socket filename from a parent directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'uds-parent-'));
    try {
      const stale = join(root, 'agent.sock');
      await writeFile(stale, 'stale but not ours');
      const f = await fixture(undefined, root);
      expect(dirname(dirname(f.listener.endpoint.socketPath))).toBe(root);
      expect(f.listener.endpoint.socketPath).not.toBe(stale);
      expect(await readFile(stale, 'utf8')).toBe('stale but not ours');
      await f.listener.close();
    } finally { await rm(root, { recursive: true }); }
  });

  it('authenticates initialize and each request, preserving full-duplex calls', async () => {
    const f = await fixture();
    const { client, wire } = connection(f.listener);
    await client.connect(wire);
    expect((await client.listTools()).tools.map(t => t.name)).toEqual(['echo']);
    const results = await Promise.all(['a', 'b'].map(text => client.callTool({ name: 'echo', arguments: { text } })));
    expect(results.map(x => x.content)).toEqual([
      [{ type: 'text', text: 'a' }], [{ type: 'text', text: 'b' }],
    ]);
    expect(f.verify).toHaveBeenCalledTimes(4);
    expect(f.dispatched.mock.calls).toEqual([['list'], ['call'], ['call']]);
    expect(getMcpAdmissionSnapshot().inFlight).toBe(0);
  });

  it.each(['missing', 'wrong-token', 'wrong-generation', 'wrong-operator', 'wrong-port',
    'missing-workspace', 'injected-host', 'injected-ui-principal'])('rejects %s before any catalog or tool', async defect => {
    const f = await fixture();
    const value = credentials(f.listener);
    if (defect === 'wrong-token') value.headers.authorization = 'Bearer wrong';
    if (defect === 'wrong-generation') value.generation = crypto.randomUUID();
    if (defect === 'wrong-operator') value.operatorId = 'f'.repeat(64);
    if (defect === 'wrong-port') value.url = value.url.replace('3170', '3070');
    if (defect === 'missing-workspace') value.url = value.url.split('&')[0];
    if (defect === 'injected-host') Object.assign(value.headers, { host: 'localhost' });
    if (defect === 'injected-ui-principal') Object.assign(value.headers, { 'x-papercusp-trust': 'trusted' });
    const { client, wire } = connection(f.listener, defect === 'missing' ? null : value);
    await expect(client.connect(wire)).rejects.toThrow('uds_auth_failed');
    expect(f.dispatched).not.toHaveBeenCalled();
  });

  it.each(['revoked', 'scope-changed'])('rejects %s on an already authenticated connection', async defect => {
    const f = await fixture();
    const { client, wire } = connection(f.listener);
    await client.connect(wire);
    await client.listTools();
    defect === 'revoked' ? f.revoke() : f.scopeChange();
    await expect(client.callTool({ name: 'echo', arguments: {} })).rejects.toThrow('uds_auth_failed');
    expect(f.dispatched.mock.calls).toEqual([['list']]);
  });

  it('rejects legacy unsigned contexts even if the HTTP soft-warning path returns ok', async () => {
    const f = await fixture();
    f.unverified();
    const { client, wire } = connection(f.listener);
    await expect(client.connect(wire)).rejects.toThrow('uds_auth_failed');
    expect(f.dispatched).not.toHaveBeenCalled();
  });

  it('rejects metadata rebind attempts after initialization', async () => {
    const f = await fixture();
    const { client, wire } = connection(f.listener);
    await client.connect(wire);
    await expect(client.callTool({
      name: 'echo', arguments: {},
      _meta: { [AGENT_MCP_AUTH_META]: credentials(f.listener) },
    })).rejects.toThrow('uds_auth_failed');
    expect(f.dispatched).not.toHaveBeenCalled();
  });

  it('bounds silent unauthenticated connections', async () => {
    const f = await fixture(30);
    const socket = createConnection(f.listener.endpoint.socketPath);
    const ended = once(socket, 'close');
    await once(socket, 'connect');
    await ended;
    expect(f.verify).not.toHaveBeenCalled();
    expect(f.dispatched).not.toHaveBeenCalled();
  });

  it('bounds stalled authentication and releases the operator admission lease', async () => {
    const f = await fixture(50);
    f.verify.mockImplementation(() => new Promise(() => {}));
    const { client, wire } = connection(f.listener);
    await expect(client.connect(wire)).rejects.toThrow();
    expect(f.dispatched).not.toHaveBeenCalled();
    expect(getMcpAdmissionSnapshot().inFlight).toBe(0);
  });

  it('rejects a tools/list frame before initialize, without calling verification or catalog', async () => {
    const f = await fixture();
    const wire = new UdsMcpTransport({ path: f.listener.endpoint.socketPath });
    const response = new Promise<unknown>(resolve => { wire.onmessage = resolve; });
    await wire.start();
    await wire.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(await response).toMatchObject({ id: 1, error: { code: -32001 } });
    expect(f.dispatched).not.toHaveBeenCalled();
    expect(f.verify).not.toHaveBeenCalled();
    await wire.close();
  });

  it('closes on an oversized SDK response instead of silently abandoning the pending caller', async () => {
    const f = await fixture();
    const { client, wire } = connection(f.listener);
    await client.connect(wire);
    await expect(client.callTool({ name: 'echo', arguments: { text: 'oversized' } }))
      .rejects.toThrow('closed');
    expect(f.dispatched.mock.calls).toEqual([['call']]);
    expect(getMcpAdmissionSnapshot().inFlight).toBe(0);
  }, 5_000);

  it('uses the shared admission bulkhead without dispatching or silently replaying shed calls', async () => {
    const f = await fixture();
    const { client, wire } = connection(f.listener);
    await client.connect(wire);
    const held: Array<{ release(): void }> = [];
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo' } });
    try {
      for (let i = 0; i < 1000; i++) {
        const result = acquireMcpBodyAdmission(body, credentials(f.listener).url, 'ok', true);
        if (result.response) break;
        if (result.lease) held.push(result.lease);
      }
      expect(held.length).toBeGreaterThan(0);
      await expect(client.callTool({ name: 'echo', arguments: { text: 'not-replayed' } }))
        .rejects.toThrow('saturated');
      expect(f.dispatched).not.toHaveBeenCalled();
    } finally { held.forEach(lease => lease.release()); }
    const result = await client.callTool({ name: 'echo', arguments: { text: 'explicit-new-call' } });
    expect(result.content).toEqual([{ type: 'text', text: 'explicit-new-call' }]);
    expect(f.dispatched.mock.calls).toEqual([['call']]);
  });
});
