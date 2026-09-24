import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:net';
import type { GovernedExecution } from '../resource-governor/execution';

const h = vi.hoisted(() => ({ begin: vi.fn(), finished: vi.fn(), cancelled: vi.fn() }));
vi.mock('../flag-override-store-boot-effect', () => ({}));
vi.mock('../flag-override-store', () => ({ installFlagOverrideStore: () => {} }));
vi.mock('../flag-change-listener', () => ({ ensureFlagChangeListener: async () => {} }));
vi.mock('../dbos/orchestrator-runner', () => ({ spawnInvokeOnce: vi.fn() }));
vi.mock('./sidecar-exec-process', async (original) => {
  const actual = await original<typeof import('./sidecar-exec-process')>();
  return {
    ...actual,
    execProcess: (params: Parameters<typeof actual.execProcess>[0], deps: Parameters<typeof actual.execProcess>[1]) =>
      actual.execProcess(params, { ...deps, beginExecution: h.begin, killGraceMs: 100 }),
  };
});

import { execProcess } from './sidecar-exec-process';
import { runSpawnerSidecarServer } from './spawner-sidecar-server';
import { SpawnerIpcClient } from './spawner-ipc-client';

function receipt(): GovernedExecution {
  return {
    receiptId: 'test-exec',
    context: { contractVersion: 1, requestId: 'test', rootRequestId: 'test', parentRequestId: null,
      idempotencyKey: 'test', admissionClass: 'process', priority: 0, demand: { cpuWeight: 1 },
      depth: 0, createdAtMs: 1, decisionGeneration: 1 },
    lease: { leaseId: 'test', generation: 1, admissionClass: 'process', expiresAtMs: 2, owner: 'test' },
    finish: h.finished, cancel: h.cancelled,
  };
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw e;
  }
}

let server: Server;
let dir: string;
let clients: SpawnerIpcClient[];
const pids = new Set<number>();
const childScript = "process.on('SIGTERM', () => setTimeout(() => { process.stdout.write('cleanup complete\\n'); process.exit(0); }, 40)); process.stdout.write('ready\\n'); setInterval(() => {}, 1000);";

beforeEach(async () => {
  h.begin.mockReset().mockImplementation(async () => receipt());
  h.finished.mockReset().mockResolvedValue(true);
  h.cancelled.mockReset().mockResolvedValue(true);
  dir = await mkdtemp(join(tmpdir(), 'exec-cancel-'));
  vi.stubEnv('PAPERCUSP_SPAWNER_IPC_SOCKET', join(dir, 'server.sock'));
  clients = [];
  server = runSpawnerSidecarServer();
  await once(server, 'listening');
});

afterEach(async () => {
  for (const client of clients) client.close();
  for (const pid of pids) if (alive(pid)) process.kill(pid, 'SIGKILL');
  pids.clear();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

function runChild(releasePath?: string) {
  const client = new SpawnerIpcClient(join(dir, 'server.sock'));
  clients.push(client);
  let requestId = 0;
  let pid = 0;
  let ready!: () => void;
  const started = new Promise<void>((resolve) => { ready = resolve; });
  const script = releasePath
    ? `process.on('SIGTERM', () => { const timer = setInterval(() => { if (require('node:fs').existsSync(${JSON.stringify(releasePath)})) { clearInterval(timer); process.stdout.write('cleanup complete\\n'); process.exit(0); } }, 5); }); process.stdout.write('ready\\n'); setInterval(() => {}, 1000);`
    : childScript;
  const result = client.call<{ code: number; stdout: string; stderr: string }>('process:exec', {
    command: process.execPath, args: ['-e', script], timeoutMs: 5000,
  }, {
    onRequestId: (id) => { requestId = id; },
    onPid: (value) => { pid = value; pids.add(pid); },
    onOutputActivity: () => ready(),
  });
  return { client, started, result, id: () => requestId, pid: () => pid };
}

describe('process:exec cancellation over the real spawner IPC protocol', () => {
  it('keeps the original request pending until graceful cleanup and actual child exit', async () => {
    const releasePath = join(dir, 'release-child');
    const child = runChild(releasePath);
    await child.started;
    expect(alive(child.pid())).toBe(true);
    let settled = false;
    void child.result.then(() => { settled = true; });
    const ack = await child.client.call('spawn:cancel', { requestId: child.id() });
    expect(ack).toMatchObject({ cancelled: true, processExecCancellation: true });
    expect(settled).toBe(false);
    await writeFile(releasePath, 'release');
    const result = await child.result;
    expect(result.code).toBe(-1);
    expect(result.stdout).toContain('cleanup complete');
    expect(result.stderr).toContain('aborted by caller');
    expect(alive(child.pid())).toBe(false);
    expect(h.finished).toHaveBeenCalledOnce();
  });

  it('does not cancel another connection whose request has the same numeric id', async () => {
    const a = runChild();
    const b = runChild();
    await Promise.all([a.started, b.started]);
    expect(a.id()).toBe(b.id());
    await a.client.call('spawn:cancel', { requestId: a.id() });
    await a.result;
    expect(alive(a.pid())).toBe(false);
    expect(alive(b.pid())).toBe(true);
    await b.client.call('spawn:cancel', { requestId: b.id() });
    await b.result;
    expect(alive(b.pid())).toBe(false);
  });

  it('rejects a disconnected caller and cancels its orphaned child on the server', async () => {
    const child = runChild();
    await child.started;
    const rejection = expect(child.result).rejects.toThrow('Connection closed by caller');
    child.client.close();
    await rejection;
    await vi.waitFor(() => expect(alive(child.pid())).toBe(false));
  });

  it('does not spawn after cancellation while admission was pending', async () => {
    const controller = new AbortController();
    let admit!: (value: GovernedExecution) => void;
    h.begin.mockImplementation(() => new Promise<GovernedExecution>((resolve) => { admit = resolve; }));
    const onPid = vi.fn();
    const result = execProcess({ command: process.execPath, args: ['-e', 'process.exit(0)'] }, {
      signal: controller.signal, onPid,
    });
    controller.abort();
    admit(receipt());
    expect(await result).toMatchObject({ code: -1, stderr: 'process aborted before spawn' });
    expect(onPid).not.toHaveBeenCalled();
    expect(h.cancelled).toHaveBeenCalledOnce();
    expect(h.finished).not.toHaveBeenCalled();
  });

  it.each(['inherit', 'ignore'] as const)('terminates a descendant with %s pipes before settling cancellation', async (stdio) => {
    const readyPath = join(dir, 'descendant-ready');
    const descendant = `process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(${JSON.stringify(readyPath)}, String(process.pid)); setInterval(() => {}, 1000);`;
    const parent = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: ${JSON.stringify(stdio)} }); setInterval(() => {}, 1000);`;
    const controller = new AbortController();
    const result = execProcess({
      command: process.execPath, args: ['-e', parent], timeoutMs: 5000,
    }, { signal: controller.signal, onPid: (pid) => pids.add(pid) });
    let descendantPid = 0;
    await vi.waitFor(async () => {
      descendantPid = Number(await readFile(readyPath, 'utf8'));
      expect(descendantPid).toBeGreaterThan(0);
    });
    pids.add(descendantPid);
    expect(alive(descendantPid)).toBe(true);
    let descendantAliveAtSettlement: boolean | undefined;
    h.finished.mockImplementationOnce(async () => {
      descendantAliveAtSettlement = alive(descendantPid);
      return true;
    });
    controller.abort();
    expect(await result).toMatchObject({ code: -1 });
    expect(alive(descendantPid)).toBe(false);
    expect(descendantAliveAtSettlement).toBe(false);
    expect(h.finished).toHaveBeenCalledOnce();
  }, 5000);

  it('escalates an ignored abort and reports completion only after the child is dead', async () => {
    const controller = new AbortController();
    let pid = 0;
    const result = await execProcess({
      command: process.execPath,
      args: ['-e', "process.on('SIGTERM', () => {}); process.stdout.write('ready'); setInterval(() => {}, 1000);"],
      timeoutMs: 5000,
    }, {
      signal: controller.signal,
      onPid: (value) => { pid = value; pids.add(pid); },
      onOutputActivity: () => controller.abort(),
    });
    expect(pid).toBeGreaterThan(0);
    expect(result.code).toBe(-1);
    expect(alive(pid)).toBe(false);
    expect(h.finished).toHaveBeenCalledOnce();
  });

  it('keeps observer failures separate from child execution and settlement', async () => {
    const fail = () => { throw new Error('observer unavailable'); };
    const result = await execProcess({
      command: process.execPath, args: ['-e', "process.stdout.write('ok')"], timeoutMs: 5000,
    }, { onPid: fail, onOutputActivity: fail });
    expect(result).toMatchObject({ code: 0, stdout: 'ok' });
    expect(h.finished).toHaveBeenCalledOnce();
  });

  it('returns after child exit even when admission settlement fails', async () => {
    h.finished.mockRejectedValueOnce(new Error('settlement unavailable'));
    const result = await execProcess({
      command: process.execPath, args: ['-e', "process.stdout.write('done')"], timeoutMs: 5000,
    });
    expect(result).toMatchObject({ code: -1, stdout: 'done' });
    expect(result.stderr).toContain('admission settlement failed: Error: settlement unavailable');
    expect(h.finished).toHaveBeenCalledOnce();
  });

  it('settles failed admission cancellation before spawn without running the child', async () => {
    const handoffPath = join(dir, 'handoff-output');
    const controller = new AbortController();
    let admit!: (value: GovernedExecution) => void;
    h.begin.mockImplementation(() => new Promise<GovernedExecution>((resolve) => { admit = resolve; }));
    h.cancelled.mockRejectedValueOnce(new Error('cancellation unavailable'));
    const result = execProcess({
      command: process.execPath, args: ['-e', "process.stdout.write('must not run')"],
      stdoutPath: handoffPath,
    }, { signal: controller.signal });
    await vi.waitFor(() => expect(h.begin).toHaveBeenCalledOnce());
    controller.abort();
    admit(receipt());
    expect(await result).toMatchObject({ code: -1 });
    expect(h.cancelled).toHaveBeenCalledOnce();
    expect(await readFile(handoffPath, 'utf8')).toBe('');
    await rm(handoffPath);
  });

  it('settles a synchronous spawn failure even when admission cancellation fails', async () => {
    h.cancelled.mockRejectedValueOnce(new Error('cancellation unavailable'));
    const result = await execProcess({
      command: process.execPath, args: ['\0'], timeoutMs: 5000,
    });
    expect(result.code).toBe(-1);
    expect(result.stderr).toContain('could not spawn process');
    expect(result.stderr).toContain('admission cancellation failed');
    expect(h.cancelled).toHaveBeenCalledOnce();
  });
});
