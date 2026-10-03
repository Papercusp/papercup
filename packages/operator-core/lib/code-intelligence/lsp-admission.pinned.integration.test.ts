/** Current-source daemon + real pinned TypeScript server; only flags and receipt storage are substituted. */
import { afterAll, describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:net';

vi.mock('@papercusp/flags/server', async importOriginal => {
  const original = await importOriginal<typeof import('@papercusp/flags/server')>();
  return { ...original, getFlag: async (...args: Parameters<typeof original.getFlag>) =>
    args[0] === 'papercusp-code-intel-lsp' ? true : original.getFlag(...args) };
});
vi.mock('../resource-governor/execution', async importOriginal => {
  const original = await importOriginal<typeof import('../resource-governor/execution')>();
  const { MemoryAdmissionQueueStore } = await import('../resource-governor/memory-admission-queue-store');
  const { WorkItemAdmissionQueueDriver } = await import('../resource-governor/queue');
  const { Governor } = await import('../resource-governor/admission');
  const driver = new WorkItemAdmissionQueueDriver(new MemoryAdmissionQueueStore(), { namespace: 'lsp-query' });
  const deps = { driver, governor: new Governor(driver) };
  return { ...original, governedExecutionRuntime: () => deps };
});

import { runLspDaemonServer } from './lsp-daemon-server';
import { callLspDaemonRpc, readLspDaemonAdmission } from './lsp-daemon-client';
import { LSP_DAEMON_SOCKET_ENV } from './lsp-daemon-socket';
import { lspClientInventory, resolveServerBin, shutdownAllLspClients } from './lsp-adapter';
import { corpusCase } from './acceptance-corpus';
import { buildLspAdmissionStatePayload } from '../agent-tools/state/lsp-admission';

const rootPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const workspaceId = `test-lsp-admission-pinned-${process.pid}`;
const previousSocket = process.env[LSP_DAEMON_SOCKET_ENV];
let server: Server | undefined;
let socketRoot: string | undefined;
afterAll(async () => {
  await shutdownAllLspClients();
  if (server) await new Promise<void>(done => server!.close(() => done()));
  if (socketRoot) rmSync(socketRoot, { recursive: true, force: true });
  if (previousSocket === undefined) delete process.env[LSP_DAEMON_SOCKET_ENV];
  else process.env[LSP_DAEMON_SOCKET_ENV] = previousSocket;
});

describe('daemon admission against the pinned TypeScript server', () => {
  it('answers tracked cross-package ground truth through learned cost lanes and live RPC readback', async () => {
    // Absence fails this acceptance check; a skip is not proof of a working backend.
    expect(resolveServerBin('typescript'), 'provision the maintained pinned TypeScript server').not.toBeNull();
    const file = join(rootPath, 'libs/generic/search/src/leg-health.ts');
    const lines = readFileSync(file, 'utf8').split('\n');
    const line0 = lines.findIndex(line => line.includes('import { pinModuleState'));
    expect(line0).toBeGreaterThanOrEqual(0);
    const args = { file, rootPath, line1: line0 + 1, character: lines[line0].indexOf('pinModuleState') };
    const expected = corpusCase('definition-cross-package-bare-specifier')!.expectedSites[0];
    socketRoot = mkdtempSync(join(tmpdir(), 'lsp-pinned-admission-'));
    const socket = join(socketRoot, 'daemon.sock');
    process.env[LSP_DAEMON_SOCKET_ENV] = socket;
    server = runLspDaemonServer();
    await once(server, 'listening');
    const query = (actorId: string) => callLspDaemonRpc(socket, { workspaceId, op: 'symbol', args, actorId,
      deadlineAtMs: Date.now() + 90_000 }, 90_000);
    const warm = await query('warmup');
    expect(warm.error).toBeNull();
    expect(warm.freshness.health).toBe('healthy');
    expect(warm.sites).toContainEqual(expect.objectContaining({ path: expected.path, line1: expected.line1 }));
    const answers = await Promise.all(Array.from({ length: 8 }, (_, index) => query(`agent-${index}`)));
    for (const answer of answers) {
      expect(answer.error).toBeNull();
      expect(answer.freshness.health).toBe('healthy');
      expect(answer.sites).toContainEqual(expect.objectContaining({ path: expected.path, line1: expected.line1 }));
    }
    await vi.waitFor(async () => {
      expect(await readLspDaemonAdmission(workspaceId)).toMatchObject({ assessment: 'idle', queued: 0, inFlight: 0,
        settlementFailures: [], costObservations: 1 });
    });
    expect(await buildLspAdmissionStatePayload(workspaceId)).toMatchObject({ measurement: 'measured', assessment: 'idle', unknown: [] });
    const inventory = lspClientInventory().filter(client => client.language === 'typescript');
    expect(inventory).toHaveLength(1);
    expect(inventory[0].taskId).toBeTruthy();
    expect(inventory[0].health).toBe('healthy');
  }, 120_000);
});
