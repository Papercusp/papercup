/**
 * spawner-ipc-client.test.ts — WI-344 ③ (plan spawner-sidecar-offload-2026-06-30).
 *
 * Proves the two properties the wrapper depends on, against a REAL line-delimited
 * JSON-RPC Unix-socket server (no mocks of net):
 *   1. id-correlated request/response — concurrent calls resolve to their OWN
 *      results even when the server replies out of order; an error reply rejects.
 *   2. server→client PUSH routing — `spawn:pid` / `spawn:outputActivity`
 *      notifications (method + params, NO id) route to the per-request `onPid` /
 *      `onOutputActivity` callbacks, keyed by `params.requestId`, with no bleed
 *      between two concurrent in-flight requests.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { SpawnerIpcClient } from './spawner-ipc-client';

// Short tmpdir socket path (Unix socket paths cap ~108 chars; the scratchpad path
// is too long).
function socketPath(): string {
  return path.join(os.tmpdir(), `spawner-ipc-test-${process.pid}-${Math.random().toString(36).slice(2)}.sock`);
}

/**
 * A minimal line-delimited JSON-RPC server that exercises every client path.
 * Methods:
 *   echo   { value, delayMs? } → reply result:{ value }, optionally delayed (to
 *                                force out-of-order completion).
 *   invoke { pid }            → push spawn:pid{requestId,pid} + 2× spawn:outputActivity{requestId},
 *                                then reply result:{ output:'ok', exitCode:0, stderr:'' }.
 *   boom                      → reply error{ code:-32001, message:'kaboom' }.
 */
function startServer(sock: string): Promise<net.Server> {
  const server = net.createServer((socket) => {
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        const req = JSON.parse(line) as { method: string; params?: any; id: number };
        const send = (obj: unknown): void => void socket.write(JSON.stringify(obj) + '\n');
        if (req.method === 'echo') {
          const reply = (): void => send({ jsonrpc: '2.0', result: { value: req.params?.value }, id: req.id });
          if (req.params?.delayMs) setTimeout(reply, req.params.delayMs);
          else reply();
        } else if (req.method === 'invoke') {
          send({ jsonrpc: '2.0', method: 'spawn:pid', params: { requestId: req.id, pid: req.params?.pid } });
          send({ jsonrpc: '2.0', method: 'spawn:outputActivity', params: { requestId: req.id } });
          send({ jsonrpc: '2.0', method: 'spawn:outputActivity', params: { requestId: req.id } });
          send({ jsonrpc: '2.0', result: { output: 'ok', exitCode: 0, stderr: '' }, id: req.id });
        } else if (req.method === 'boom') {
          send({ jsonrpc: '2.0', error: { code: -32001, message: 'kaboom' }, id: req.id });
        }
      }
    });
    socket.on('error', () => {});
  });
  return new Promise((resolve) => server.listen(sock, () => resolve(server)));
}

let server: net.Server;
let client: SpawnerIpcClient;
let sock: string;

beforeEach(async () => {
  sock = socketPath();
  server = await startServer(sock);
  client = new SpawnerIpcClient(sock);
});

afterEach(async () => {
  client.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (fs.existsSync(sock)) { try { fs.unlinkSync(sock); } catch { /* removed by server.close */ } }
});

describe('SpawnerIpcClient — id-correlated request/response', () => {
  it('resolves concurrent calls to their OWN results even when replies arrive out of order', async () => {
    // The first call is delayed so the second completes first — only correct id
    // correlation gives each its own value.
    const slow = client.call<{ value: string }>('echo', { value: 'first', delayMs: 60 });
    const fast = client.call<{ value: string }>('echo', { value: 'second' });
    expect(await fast).toEqual({ value: 'second' });
    expect(await slow).toEqual({ value: 'first' });
  });

  it('rejects on an error response', async () => {
    await expect(client.call('boom')).rejects.toThrow(/RPC error -32001: kaboom/);
  });
});

describe('SpawnerIpcClient — server→client PUSH (notification) routing', () => {
  it('routes spawn:pid / spawn:outputActivity to the per-request callbacks and still resolves the result', async () => {
    const pids: number[] = [];
    let activity = 0;
    const result = await client.call<{ output: string; exitCode: number; stderr: string }>(
      'invoke',
      { pid: 4242 },
      { onPid: (pid) => pids.push(pid), onOutputActivity: () => { activity += 1; } },
    );
    expect(result).toEqual({ output: 'ok', exitCode: 0, stderr: '' });
    expect(pids).toEqual([4242]);
    expect(activity).toBe(2);
  });

  it('keys callbacks per-request — two concurrent invokes never cross their notifications', async () => {
    const aPids: number[] = [];
    const bPids: number[] = [];
    const a = client.call('invoke', { pid: 111 }, { onPid: (p) => aPids.push(p) });
    const b = client.call('invoke', { pid: 222 }, { onPid: (p) => bPids.push(p) });
    await Promise.all([a, b]);
    expect(aPids).toEqual([111]);
    expect(bPids).toEqual([222]);
  });

  it('surfaces the assigned request id synchronously via onRequestId (for cancel wiring)', async () => {
    let captured: number | undefined;
    await client.call('echo', { value: 'x' }, { onRequestId: (id) => { captured = id; } });
    expect(typeof captured).toBe('number');
    expect(captured).toBeGreaterThan(0);
  });
});
