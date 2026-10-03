import { afterEach, describe, expect, it } from 'vitest';
import { connect, type Server } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { callLspDaemonRpc } from './lsp-daemon-client.ts';
import { runLspDaemonServer } from './lsp-daemon-server.ts';
import { LSP_DAEMON_SOCKET_ENV } from './lsp-daemon-socket.ts';
import type { CodeIntelAnswer } from './contracts.ts';

const root = mkdtempSync(join(tmpdir(), 'papercusp-lsp-rpc-'));
const path = join(root, 'daemon.sock');
const previous = process.env[LSP_DAEMON_SOCKET_ENV];
let server: Server | undefined;
afterEach(async () => {
  if (server) { await new Promise<void>((done) => server!.close(() => done())); server = undefined; }
  if (previous === undefined) delete process.env[LSP_DAEMON_SOCKET_ENV];
  else process.env[LSP_DAEMON_SOCKET_ENV] = previous;
  rmSync(root, { recursive: true, force: true });
});

describe('LSP daemon process boundary', () => {
  it('round-trips the closed request and aborts abandoned work without forging an empty answer', async () => {
    process.env[LSP_DAEMON_SOCKET_ENV] = path;
    const requests: Array<{ op: string; root?: string; aborted: boolean }> = [];
    const answer: CodeIntelAnswer = {
      backend: 'lsp-adapter', intent: 'references', query: 'fixture', sites: [{ path: '/fixture/x.ts', line1: 3, kind: 'reference' }],
      truncation: { truncated: false, totalAvailable: 1, continuation: null },
      freshness: { health: 'healthy', indexedAt: null, staleVsDisk: false, indexedCommit: null },
      latencyMs: 1, error: null,
    };
    let abandoned: AbortSignal | undefined;
    server = runLspDaemonServer(async (request, _id, signal) => {
      requests.push({ op: request.op, root: request.args.rootPath, aborted: signal.aborted });
      if (request.actorId === 'abandon') {
        abandoned = signal;
        await new Promise<void>((done) => signal.addEventListener('abort', () => done(), { once: true }));
      }
      return answer;
    });
    await once(server, 'listening');
    const result = await callLspDaemonRpc(path, { op: 'references', args: { rootPath: '/fixture', file: '/fixture/x.ts', line1: 3, character: 0 }, actorId: 'agent-a' });
    expect(result).toEqual(answer);
    expect(requests[0]).toEqual({ op: 'references', root: '/fixture', aborted: false });

    const socket = connect(path);
    await once(socket, 'connect');
    socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: 'abandoned', method: 'lsp:query', params: { op: 'references', args: { rootPath: '/fixture' }, actorId: 'abandon' } })}\n`);
    for (let tries = 0; !abandoned && tries < 50; tries++) await new Promise((done) => setTimeout(done, 10));
    expect(abandoned).toBeDefined();
    socket.destroy();
    await once(socket, 'close');
    expect(abandoned?.aborted).toBe(true);
  });
});
