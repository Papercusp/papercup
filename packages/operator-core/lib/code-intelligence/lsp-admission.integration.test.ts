/** Real daemon RPC + admission/receipt state machine; only the language server and PG storage are substituted. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Server } from 'node:net';
import type { CodeIntelAnswer } from './contracts';
import type { MemoryAdmissionQueueStore } from '../resource-governor/memory-admission-queue-store';
import type { GovernedExecutionDeps } from '../resource-governor/execution';

const seam = vi.hoisted(() => ({
  facade: vi.fn(), store: undefined as MemoryAdmissionQueueStore | undefined,
  deps: undefined as GovernedExecutionDeps | undefined,
}));
vi.mock('./lsp-daemon-facade.ts', () => ({ lspDaemonFacade: seam.facade }));
vi.mock('../resource-governor/execution', async importOriginal => {
  const original = await importOriginal<typeof import('../resource-governor/execution')>();
  const { MemoryAdmissionQueueStore } = await import('../resource-governor/memory-admission-queue-store');
  const { WorkItemAdmissionQueueDriver } = await import('../resource-governor/queue');
  const { Governor } = await import('../resource-governor/admission');
  seam.store = new MemoryAdmissionQueueStore();
  const driver = new WorkItemAdmissionQueueDriver(seam.store, { namespace: 'lsp-query' });
  seam.deps = { driver, governor: new Governor(driver) };
  return { ...original, governedExecutionRuntime: () => seam.deps! };
});

import { runLspDaemonServer } from './lsp-daemon-server';
import { callLspDaemonRpc } from './lsp-daemon-client';
import { LSP_DAEMON_SOCKET_ENV } from './lsp-daemon-socket';
import { lspAdmissionController } from './lsp-admission';

let server: Server | undefined;
let socketRoot: string | undefined;
const previousSocket = process.env[LSP_DAEMON_SOCKET_ENV];
afterEach(async () => {
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
  server = undefined;
  if (socketRoot) rmSync(socketRoot, { recursive: true, force: true });
  socketRoot = undefined;
  if (previousSocket === undefined) delete process.env[LSP_DAEMON_SOCKET_ENV];
  else process.env[LSP_DAEMON_SOCKET_ENV] = previousSocket;
});

describe('daemon admission integration', () => {
  it('isolates methods under socket pressure and settles the queued durable receipt after execution', async () => {
    socketRoot = mkdtempSync(join(tmpdir(), 'lsp-admission-rpc-'));
    const socketPath = join(socketRoot, 'daemon.sock');
    process.env[LSP_DAEMON_SOCKET_ENV] = socketPath;
    const rootPath = process.cwd();
    // A committed source fixture supplies a real resolvable project/cursor.
    const file = join(rootPath, 'lib/code-intelligence/lsp-admission.test.ts');
    const workspaceId = 'lsp-admission-socket-acceptance';
    let release!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    const calls: string[] = [];
    const answer = (op: string): CodeIntelAnswer => ({
      backend: 'lsp-adapter', intent: op === 'symbol' ? 'definition' : 'references', query: file,
      sites: [{ path: file, line1: 1, kind: op === 'symbol' ? 'definition' : 'reference' }],
      truncation: { truncated: false, totalAvailable: 1, continuation: null },
      freshness: { health: 'healthy', indexedAt: null, staleVsDisk: false, indexedCommit: null }, latencyMs: 1, error: null,
    });
    seam.facade.mockImplementation(async (op: string) => {
      calls.push(op);
      if (op === 'references' && calls.filter(c => c === 'references').length === 1) await hold;
      return answer(op);
    });
    server = runLspDaemonServer();
    await once(server, 'listening');
    const args = { rootPath, file, line1: 1, character: 0 };
    const first = callLspDaemonRpc(socketPath, { workspaceId, op: 'references', args, actorId: 'agent-a' }, 10_000);
    await vi.waitFor(() => expect(calls).toEqual(['references']));
    const queued = callLspDaemonRpc(socketPath, { workspaceId, op: 'references', args, actorId: 'agent-b' }, 10_000);
    const controller = lspAdmissionController(workspaceId);
    await vi.waitFor(() => {
      expect(controller.snapshot()).toMatchObject({ queued: 1, inFlight: 1 });
      expect(controller.snapshot().classes[0].pendingPersistence).toBe(0);
    });
    const admitted = vi.spyOn(seam.deps!.governor, 'admit');
    expect(controller.snapshot().classes[0]).toMatchObject({ queued: 1, inFlight: 1 });
    const definition = await callLspDaemonRpc(socketPath, { workspaceId, op: 'symbol', args, actorId: 'agent-c' }, 10_000);
    expect(definition.sites).toHaveLength(1);
    expect(calls).toEqual(['references', 'symbol']);
    release();
    expect((await first).sites).toHaveLength(1);
    expect((await queued).sites).toHaveLength(1);
    expect(calls).toEqual(['references', 'symbol', 'references']);
    await vi.waitFor(() => expect(controller.snapshot()).toMatchObject({ assessment: 'idle', queued: 0, inFlight: 0, settlementFailures: [] }));
    expect(seam.store).toBeDefined();
    // The real driver persisted one waiting request and released its lease.
    const request = admitted.mock.calls[0][0];
    expect(await seam.store!.find('lsp-query', request.idempotencyKey)).toMatchObject({ record: { state: 'completed' } });
    expect(request.metadata).toMatchObject({ actor: 'agent-b', op: 'references', language: 'typescript' });
  }, 20_000);
});
