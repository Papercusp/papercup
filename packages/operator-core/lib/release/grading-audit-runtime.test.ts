import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createServer } from 'node:net';
import { runInNewContext } from 'node:vm';
import * as databaseTargets from '@papercusp/db-org/connection';
import { utilityHostEnabled } from '../background-workers';
import type { TaskRow } from '../task-manager/types';
import { readGradingAuditSourcePin, writeGradingAuditSourcePin } from './grading-audit-source-pin';
import { requestOnlyIdentityGuardMarker } from '../harness/env-operator-launcher';
import { ownerPidFromSocketPath, resolveSpawnerSocketPath, SPAWNER_SOCKET_ENV } from '../fleet/spawner-socket-path';
import { SPAWNER_SCOPE_ENV } from '../fleet/sidecar-exec-lifetime';
import { SUBSTRATE_SOCKET_ENV } from '../sync/hyperbee/substrate-socket-path';
import { writeOperatorArtifactManifest } from './operator-artifact';
import { verifierSourceFiles, verifierGitCheckoutSync } from '@papercusp/test-config/verifier-source';
import { ensureGradingAuditRuntime, gradingAuditRuntimeChildEnv, retireUnusedGradingAuditRuntimes, recoverGradingAuditRuntimeSource,
  qualifyRematerializedGradingAuditSource, qualifyPreparedGradingAuditSource, prepareGradingAuditSource,
  GradingAuditSourcePreparationError, gradingAuditRuntimeSupervisorArgs, GradingAuditRuntimeReadinessError,
  type GradingAuditRuntimeDeps, type GradingAuditRuntimeLocator } from './grading-audit-runtime';

const spawnManaged = vi.hoisted(() => vi.fn());
const killManaged = vi.hoisted(() => vi.fn());
vi.mock('../task-manager/managed-spawn', () => ({ managedSpawn: spawnManaged }));
vi.mock('../task-manager/control', () => ({ killTask: killManaged }));

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
afterEach(() => vi.restoreAllMocks());
afterEach(() => vi.unstubAllEnvs());

function fixture(evaluatorBuild = { sha: 'exact123456', version: '1.2.3' }) {
  const root = mkdtempSync(join(tmpdir(), 'audit-runtime-'));
  roots.push(root);
  const sourceRoot = join(root, '.candidate-exact.first', 'checkout');
  const bundlePath = join(sourceRoot, 'apps/operator/dist-host/hono-host.mjs');
  mkdirSync(dirname(bundlePath), { recursive: true });
  writeFileSync(bundlePath, 'exact compiled evaluator bytes');
  const ownerRef = 'grading-audit-runtime:' + createHash('sha256').update(JSON.stringify(['ws', evaluatorBuild.sha, evaluatorBuild.version])).digest('hex');
  const source = { schemaVersion: 1 as const, sourceRoot, bundlePath, evaluatorBuild, ownerRef,
    bundleSha256: createHash('sha256').update('exact compiled evaluator bytes').digest('hex') };
  const rows: TaskRow[] = [];
  let tail = Promise.resolve();
  const stop = vi.fn(async (id: string) => { rows.find(row => row.taskId === id)!.state = 'killed'; });
  const deps: GradingAuditRuntimeDeps = {
    now: () => 1000000, currentSource: () => source, freePort: async () => 45187,
    recoverSource: (workspaceId, build, now) => recoverGradingAuditRuntimeSource(root, workspaceId, build, now),
    list: async (_ws, label) => rows.filter(row => String(row.detail.label).startsWith(label)),
    // A custom spawn stub models a successfully registered running task without
    // necessarily adding a TaskRow; tests that exercise termination mutate a row.
    taskState: async taskId => rows.find(row => row.taskId === taskId)?.state ?? 'running',
    mutex: async (_ws, _key, fn) => {
      const previous = tail;
      let unlock!: () => void;
      tail = new Promise(resolve => { unlock = resolve; });
      await previous;
      try { return await fn(); } finally { unlock(); }
    },
    spawn: vi.fn(async (_ws, locator) => {
      const taskId = `runtime-${rows.length}`;
      rows.unshift({ taskId, workspaceId: 'ws', rootTaskId: taskId, class: 'sidecar',
        title: ownerRef, argv: [process.execPath, bundlePath], launchedBy: 'system:grading-audit-dispatch',
        confined: true, startedAt: new Date(1000000).toISOString(), lastSeenAt: new Date(1000000).toISOString(),
        state: 'running', detail: { label: ownerRef, gradingAuditRuntime: structuredClone(locator) } });
      return taskId;
    }),
    attach: vi.fn(async (id, _ws, ids, acceptanceRefs = []) => {
      (rows.find(row => row.taskId === id)!.detail.gradingAuditRuntime as GradingAuditRuntimeLocator).issueIds = ids;
      (rows.find(row => row.taskId === id)!.detail.gradingAuditRuntime as GradingAuditRuntimeLocator).acceptanceRefs = acceptanceRefs;
    }),
    probe: vi.fn(async () => evaluatorBuild), stop, sleep: vi.fn(async () => {}),
  };
  return { root, rows, source, deps, stop, input: { workspaceId: 'ws', issueId: 'EI-a', evaluatorBuild } };
}

function setReadinessDeadline(f: ReturnType<typeof fixture>, budgetMs = 30_000): number {
  let elapsedMs = 0;
  f.deps.now = () => 1_000_000 + elapsedMs;
  f.deps.sleep = vi.fn(async (ms: number) => { elapsedMs += ms; });
  return 1_000_000 + budgetMs;
}

async function rebuiltFixture(external = false) {
  const root = mkdtempSync(join(tmpdir(), 'audit-rebuilt-'));
  roots.push(root);
  const sourceRoot = external ? join(root, 'source') : join(root, '.candidate-rebuilt', 'checkout');
  const bundlePath = external ? join(root, 'output/hono-host.mjs') : join(sourceRoot, 'apps/operator/dist-host/hono-host.mjs');
  mkdirSync(sourceRoot, { recursive: true });
  mkdirSync(dirname(bundlePath), { recursive: true });
  const git = (...args: string[]) => execFileSync('git', ['-C', sourceRoot, ...args], { encoding: 'utf8' }).trim();
  git('init', '--quiet');
  writeFileSync(join(sourceRoot, 'entry.ts'), 'export const evaluator = true;\n');
  git('add', 'entry.ts');
  git('-c', 'user.name=Runtime test', '-c', 'user.email=runtime@test.invalid', 'commit', '--quiet', '-m', 'exact source');
  const sourceSha = git('rev-parse', 'HEAD');
  if (external) mkdirSync(join(sourceRoot, 'node_modules'));
  writeFileSync(bundlePath, 'rebuilt evaluator ' + requestOnlyIdentityGuardMarker());
  writeFileSync(bundlePath + '.meta.json', JSON.stringify({ inputs: { 'entry.ts': {} } }));
  const artifact = await writeOperatorArtifactManifest({ root: sourceRoot, entry: bundlePath, sourceSha,
    ...(external ? { artifactRoot: dirname(bundlePath) } : {}) });
  return { root, sourceRoot, bundlePath, sourceSha, artifact, git, evaluatorBuild: { sha: sourceSha.slice(0, 10), version: '1.2.3' } };
}

describe('pre-start exact evaluator source preparation (EI-29076811994262641)', () => {
  async function preparationFixture() {
    const f = await rebuiltFixture(true);
    // The maintained exporter seals a child checkout over the selected source.
    f.git('-c', 'user.name=Runtime test', '-c', 'user.email=runtime@test.invalid',
      'commit', '--quiet', '--allow-empty', '-m', 'sealed verifier checkout');
    f.sourceSha = f.git('rev-parse', 'HEAD');
    f.evaluatorBuild.sha = f.sourceSha.slice(0, 10);
    const files = verifierSourceFiles(f.sourceRoot, { runtimeArtifacts: true, gitMetadataPaths: ['.git'] });
    const receipt = { schemaVersion: 'verifier-source-v1', sourceCommit: f.sourceSha, files,
      testedInputs: files.map(({ path, sha256 }) => ({ path, sha256 })),
      gitCheckout: verifierGitCheckoutSync(f.sourceRoot, f.sourceSha) };
    const bytes = JSON.stringify(receipt);
    const receiptPath = join(f.root, 'original.json');
    writeFileSync(join(f.sourceRoot, '.verifier-source.json'), bytes);
    writeFileSync(receiptPath, bytes);
    const input = { workspaceId: 'ws', evaluatorBuild: f.evaluatorBuild, sourcePreparation: {
      sourceRoot: f.sourceRoot, receiptPath,
      receiptSha256: createHash('sha256').update(bytes).digest('hex'), outputDir: join(f.root, 'new-output'),
    } };
    let row: TaskRow | null = null;
    const readTask = vi.fn(async () => row);
    const unref = vi.fn();
    const spawn = vi.fn<typeof import('../task-manager/managed-spawn').managedSpawn>(async (_command, _argv, spec, options) => {
      row = { taskId: options!.taskId!, workspaceId: 'ws', state: 'running', detail: spec.detail!,
        exitCode: null, logPath: spec.logPath } as TaskRow;
      return { taskId: row.taskId, row, child: { unref }, confined: true } as never;
    });
    const qualify = vi.fn<typeof qualifyPreparedGradingAuditSource>().mockResolvedValue({
      sourceSha: f.sourceSha, artifactManifestSha256: 'b'.repeat(64), source: {
        schemaVersion: 1, sourceRoot: f.sourceRoot, bundlePath: join(input.sourcePreparation.outputDir, 'hono-host.mjs'),
        evaluatorBuild: f.evaluatorBuild, bundleSha256: 'c'.repeat(64), ownerRef: '',
      },
    });
    const deps = { readTask, spawn, qualify, logDir: join(f.root, 'logs') };
    return { ...f, input, deps, receipt, unref, row: () => row! };
  }

  it('runs only the maintained builder with original receipt, bounded task custody and no inherited build overrides', async () => {
    const f = await preparationFixture();
    const { readVerifierSourceReceipt } = await import('@papercusp/test-config/verifier-source');
    const receipt = await readVerifierSourceReceipt(f.sourceRoot, f.input.sourcePreparation.receiptPath);
    vi.stubEnv('NODE_OPTIONS', '--import=untrusted');
    vi.stubEnv('PAPERCUSP_BUNDLE_ALLOW_STALE_START', '1');
    vi.stubEnv('BUNDLE_HOST_OPERATOR_DIR', '/mutable');
    await expect(prepareGradingAuditSource(f.input, { ...f.deps,
      readReceipt: vi.fn().mockResolvedValue(receipt) })).rejects.toBeInstanceOf(GradingAuditSourcePreparationError);
    const [command, argv, spec, options] = f.deps.spawn.mock.calls[0]!;
    expect(command).toBe('/bin/bash');
    expect(argv).toEqual([join(f.sourceRoot, 'apps/operator/bin/bundle-host.sh'), 'bin/hono-host.ts',
      join(f.input.sourcePreparation.outputDir, 'hono-host.mjs'), 'development']);
    expect(spec).toMatchObject({ class: 'build', runtimeMaxSec: 900, cwd: f.sourceRoot,
      detail: { gradingAuditPreparation: { workspaceId: 'ws', receiptSha256: f.input.sourcePreparation.receiptSha256 } } });
    expect(options).toMatchObject({ workspaceId: 'ws', requireRegistration: true, requireConfinement: true,
      taskId: f.row().taskId, spawnOptions: { env: { VERIFY_TAURI_SOURCE_REF: f.sourceSha,
        VERIFY_TAURI_SOURCE_RECEIPT: f.input.sourcePreparation.receiptPath } } });
    expect(f.row().taskId).toMatch(/^[a-f0-9]{64}$/);
    for (const key of ['NODE_OPTIONS', 'PAPERCUSP_BUNDLE_ALLOW_STALE_START', 'BUNDLE_HOST_OPERATOR_DIR'])
      expect(options!.spawnOptions!.env).not.toHaveProperty(key);
    expect(f.unref).toHaveBeenCalledOnce();
    expect(f.deps.qualify).not.toHaveBeenCalled();
  });

  it('resumes the exact managed task across calls and qualifies only its successful original output', async () => {
    const f = await preparationFixture();
    await expect(prepareGradingAuditSource(f.input, f.deps)).rejects.toMatchObject({ diagnostic: {
      state: 'running', taskId: expect.any(String), logPath: expect.any(String),
      taskRead: { tool: 'processes:list' }, preparedSource: { sourceRoot: f.sourceRoot },
    } });
    // PostgreSQL JSONB can reorder these keys; it must not create another build.
    f.row().detail.gradingAuditPreparation = Object.fromEntries(
      Object.entries(f.row().detail.gradingAuditPreparation as object).reverse());
    await expect(prepareGradingAuditSource(f.input, f.deps)).rejects.toMatchObject({ diagnostic: { state: 'running' } });
    expect(f.deps.spawn).toHaveBeenCalledOnce();
    f.row().state = 'exited'; f.row().exitCode = 0;
    await expect(prepareGradingAuditSource(f.input, f.deps)).resolves.toMatchObject({ sourceSha: f.sourceSha });
    expect(f.deps.qualify).toHaveBeenCalledWith({ sourceRoot: f.sourceRoot,
      bundlePath: join(f.input.sourcePreparation.outputDir, 'hono-host.mjs') }, f.evaluatorBuild);
    f.deps.qualify.mockRejectedValueOnce(new Error('original manifest missing'));
    await expect(prepareGradingAuditSource(f.input, f.deps)).rejects.toThrow('original manifest missing');
    expect(f.deps.spawn).toHaveBeenCalledOnce();
  });

  it.each(['stranded', 'killed', 'unaccounted', 'timed_out'] as const)('retains %s custody without relaunch or qualification', async state => {
    const f = await preparationFixture();
    await expect(prepareGradingAuditSource(f.input, f.deps)).rejects.toBeInstanceOf(GradingAuditSourcePreparationError);
    f.row().state = state;
    await expect(prepareGradingAuditSource(f.input, f.deps)).rejects.toMatchObject({ diagnostic: { state } });
    expect(f.deps.spawn).toHaveBeenCalledOnce(); expect(f.deps.qualify).not.toHaveBeenCalled();
  });

  it('refuses changed source, receipt, evaluator and unowned output before any builder launch', async () => {
    const f = await preparationFixture();
    await expect(prepareGradingAuditSource({ ...f.input, evaluatorBuild: { sha: 'a'.repeat(40), version: 'x' } }, f.deps))
      .rejects.toThrow('exact evaluator');
    await expect(prepareGradingAuditSource({ ...f.input, sourcePreparation: {
      ...f.input.sourcePreparation, receiptSha256: '0'.repeat(64) } }, f.deps)).rejects.toThrow('receipt digest');
    mkdirSync(f.input.sourcePreparation.outputDir);
    await expect(prepareGradingAuditSource(f.input, f.deps)).rejects.toThrow('EEXIST');
    writeFileSync(join(f.sourceRoot, 'entry.ts'), 'tampered');
    await expect(prepareGradingAuditSource(f.input, f.deps)).rejects.toThrow('changed entry.ts');
    expect(f.deps.spawn).not.toHaveBeenCalled(); expect(f.deps.qualify).not.toHaveBeenCalled();
  });

  it('refuses unknown task ownership and cancelled callers instead of retrying a launch', async () => {
    const f = await preparationFixture();
    f.deps.readTask.mockRejectedValueOnce(new Error('ledger unavailable'));
    await expect(prepareGradingAuditSource(f.input, f.deps)).rejects.toThrow('ledger unavailable');
    const controller = new AbortController(); controller.abort();
    await expect(prepareGradingAuditSource({ ...f.input, signal: controller.signal }, f.deps)).rejects.toThrow('budget exhausted');
    await expect(prepareGradingAuditSource({ ...f.input, deadlineAtMs: 0 }, f.deps)).rejects.toThrow('budget exhausted');
    expect(f.deps.spawn).not.toHaveBeenCalled();
  });
});

describe('retained evaluator self-recycle supervision (EI-26950964476692806)', () => {
  async function launch(body: string, lifetimeSec = 60) {
    const f = fixture();
    writeFileSync(f.source.bundlePath, body);
    const port = await new Promise<number>((resolve, reject) => {
      const server = createServer();
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address() as { port: number };
        server.close(error => error ? reject(error) : resolve(address.port));
      });
    });
    const locator: GradingAuditRuntimeLocator = { ...f.source,
      bundleSha256: createHash('sha256').update(body).digest('hex'),
      baseUrl: `http://127.0.0.1:${port}`, issueIds: ['EI-a'],
      expiresAtSec: Math.floor(Date.now() / 1000) + lifetimeSec };
    const child = spawn(process.execPath, gradingAuditRuntimeSupervisorArgs(locator), {
      cwd: f.source.sourceRoot, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PORT: String(port), PAPERCUSP_BUILD_SHA: f.input.evaluatorBuild.sha,
        PAPERCUSP_ENV_OPERATOR_ID: f.source.ownerRef },
    });
    let output = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { output += data; });
    const closed = new Promise<{ code: number | null; signal: string | null }>(resolve => {
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    const stop = async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 7000);
      try { return await closed; } finally { clearTimeout(timer); }
    };
    return { ...f, locator, child, closed, stop, output: () => output };
  }

  it('recovers a real self-SIGKILL on the same exact endpoint and stops without respawning on retirement', async () => {
    const run = await launch(`import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
let attempt = 1;
try { attempt += Number(readFileSync('attempt', 'utf8')); } catch {}
writeFileSync('attempt', String(attempt));
createServer((_req, res) => res.end(JSON.stringify({ sha: process.env.PAPERCUSP_BUILD_SHA,
  identity: process.env.PAPERCUSP_ENV_OPERATOR_ID, pid: process.pid, attempt })))
  .listen(Number(process.env.PORT), '127.0.0.1', () => {
    console.log('READY ' + attempt);
    if (attempt === 1) setTimeout(() => process.kill(process.pid, 'SIGKILL'), 20);
  });`);
    let servingPid = 0;
    try {
      await vi.waitFor(() => expect(run.output()).toContain('READY 2'), { timeout: 6000 });
      const response = await fetch(run.locator.baseUrl, { signal: AbortSignal.timeout(2000) });
      const health = await response.json();
      expect(health).toMatchObject({ sha: run.input.evaluatorBuild.sha, identity: run.source.ownerRef, attempt: 2 });
      servingPid = health.pid;
      expect(await run.stop()).toEqual({ code: 0, signal: null });
      expect(readFileSync(join(run.source.sourceRoot, 'attempt'), 'utf8')).toBe('2');
      expect(() => process.kill(servingPid, 0)).toThrow();
    } finally { await run.stop(); }
  }, 12000);

  it('enforces its absolute deadline and never starts an already expired evaluator', async () => {
    const expired = await launch("console.log('CHILD_STARTED'); setInterval(() => {}, 1000);", -1);
    try {
      expect(await expired.closed).toEqual({ code: 0, signal: null });
      expect(expired.output()).not.toContain('CHILD_STARTED');
    } finally { await expired.stop(); }
    const run = await launch("console.log('CHILD_STARTED'); setInterval(() => {}, 1000);", 5);
    try {
      expect(await run.closed).toEqual({ code: 0, signal: null });
      expect(run.output()).toContain('CHILD_STARTED');
      expect(run.output()).toContain('deadline');
    } finally { await run.stop(); }
  }, 15000);

  it('acquires the same retained endpoint while a real recycled child is waiting to listen', async () => {
    const run = await launch(`import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
let attempt = 1;
try { attempt += Number(readFileSync('attempt', 'utf8')); } catch {}
writeFileSync('attempt', String(attempt));
const listen = () => {
  if (attempt > 1 && !existsSync('resume')) return setTimeout(listen, 10);
  createServer((_req, res) => res.end(JSON.stringify({ sha: process.env.PAPERCUSP_BUILD_SHA,
    version: '1.2.3', attempt }))).listen(Number(process.env.PORT), '127.0.0.1', () => {
      if (attempt === 1) setTimeout(() => process.kill(process.pid, 'SIGKILL'), 20);
    });
};
listen();`, 120);
    try {
      await vi.waitFor(() => expect(run.output()).toContain('signal=SIGKILL'), { timeout: 6000 });
      run.deps.now = () => Date.now();
      writeGradingAuditSourcePin(run.locator, Math.floor(Date.now() / 1000));
      const taskId = await run.deps.spawn!('ws', run.locator);
      delete run.deps.probe;
      run.deps.sleep = vi.fn(async () => {
        writeFileSync(join(run.source.sourceRoot, 'resume'), 'ready');
        await new Promise(resolve => setTimeout(resolve, 100));
      });
      const recovered = await ensureGradingAuditRuntime({ ...run.input, issueId: 'EI-b' }, run.deps);
      expect(recovered.taskId).toBe(taskId);
      expect(recovered.baseUrl).toBe(run.locator.baseUrl);
      expect(run.deps.sleep).toHaveBeenCalled();
      expect(run.deps.spawn).toHaveBeenCalledTimes(1);
      expect(run.deps.stop).not.toHaveBeenCalled();
      const health = await fetch(run.locator.baseUrl).then(response => response.json());
      expect(health).toMatchObject({ sha: run.input.evaluatorBuild.sha, version: '1.2.3', attempt: 2 });
      expect(readFileSync(join(run.source.sourceRoot, 'attempt'), 'utf8')).toBe('2');
    } finally { await run.stop(); }
  }, 12000);

  it('halts repeated short crashes instead of spinning until its lifetime expires', async () => {
    const f = fixture();
    const locator: GradingAuditRuntimeLocator = { ...f.source,
      baseUrl: 'http://127.0.0.1:45187', issueIds: ['EI-a'],
      expiresAtSec: Math.floor(Date.now() / 1000) + 60 };
    const args = gradingAuditRuntimeSupervisorArgs(locator);
    const children: EventEmitter[] = [];
    const spawnChild = vi.fn(() => {
      const child = Object.assign(new EventEmitter(), { pid: children.length + 1 });
      children.push(child);
      return child;
    });
    const exit = vi.fn();
    const error = vi.fn();
    const supervisorProcess = Object.assign(new EventEmitter(), {
      argv: [process.execPath, args[2]], execPath: process.execPath, exit,
    });
    // Execute the exact production script. Real recycle/retirement coverage above
    // remains separate from this policy check's controlled exits and clock.
    vi.useFakeTimers();
    try {
      runInNewContext(args[1], {
        require: (id: string) => {
          if (id === 'node:child_process') return { spawn: spawnChild };
          if (id === 'node:fs') return { readFileSync };
          if (id === 'node:crypto') return { createHash };
          throw new Error(`Unexpected supervisor import: ${id}`);
        },
        process: supervisorProcess, console: { error }, Date, setTimeout, clearTimeout,
      });
      expect(spawnChild).toHaveBeenCalledTimes(1);
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        children[attempt - 1].emit('exit', 42, null);
        if (attempt === 5) break;
        expect(exit).not.toHaveBeenCalled();
        const delay = 100 * 2 ** attempt;
        await vi.advanceTimersByTimeAsync(delay - 1);
        expect(spawnChild).toHaveBeenCalledTimes(attempt);
        await vi.advanceTimersByTimeAsync(1);
        expect(spawnChild).toHaveBeenCalledTimes(attempt + 1);
      }
      expect(exit).toHaveBeenCalledExactlyOnceWith(1);
      expect(error).toHaveBeenCalledWith('[grading-audit-supervisor] restart budget exhausted');
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('refuses changed bundle bytes before restarting a recycled child', async () => {
    const run = await launch(`import { writeFileSync } from 'node:fs';
console.log('ORIGINAL');
writeFileSync(process.argv[1], "console.log('CHANGED_EXECUTED')");
process.kill(process.pid, 'SIGKILL');`);
    try {
      expect(await run.closed).toEqual({ code: 1, signal: null });
      expect(run.output()).toContain('bundle digest changed');
      expect(run.output()).not.toContain('CHANGED_EXECUTED');
    } finally { await run.stop(); }
  }, 10000);
});

describe('exact grading audit runtime lifecycle (EI-25971079852455067)', () => {
  it('retains a settled audit evaluator for claimed source acceptance and releases it when acceptance settles', async () => {
    const f = fixture();
    const runtime = await ensureGradingAuditRuntime({ ...f.input, acceptanceRef: 'WI-source' }, f.deps);
    f.deps.pendingAcceptanceRefs = async (_ws, ids) => ids.filter(id => id === 'WI-source');
    await retireUnusedGradingAuditRuntimes('ws', async () => [], f.deps);
    expect(f.stop).not.toHaveBeenCalled();
    expect((f.rows[0].detail.gradingAuditRuntime as GradingAuditRuntimeLocator)).toMatchObject({
      issueIds: [], acceptanceRefs: ['WI-source'] });
    f.deps.pendingAcceptanceRefs = async () => [];
    await retireUnusedGradingAuditRuntimes('ws', async () => [], f.deps);
    expect(f.stop).toHaveBeenCalledWith(runtime.taskId);
    expect(readGradingAuditSourcePin(f.source.sourceRoot, f.source.ownerRef, 1000)).toBeNull();
  });

  it('recovers an expired, physically deleted source from an attested exact-ref rebuild with new artifact provenance', async () => {
    const rebuilt = await rebuiltFixture();
    const f = fixture(rebuilt.evaluatorBuild);
    const old = await ensureGradingAuditRuntime(f.input, f.deps);
    f.deps.now = () => 22600000;
    await retireUnusedGradingAuditRuntimes('ws', async ids => ids, f.deps);
    rmSync(dirname(f.source.sourceRoot), { recursive: true, force: true });
    f.deps.currentSource = () => { throw new Error('mutable host cannot seed the old build'); };
    const recovered = await ensureGradingAuditRuntime({ ...f.input, issueId: 'P001-acceptance',
      allowSeed: false, recoverySourceRoot: rebuilt.sourceRoot }, f.deps);
    expect(recovered.taskId).not.toBe(old.taskId);
    expect(recovered.bundleSha256).not.toBe(old.bundleSha256);
    expect(recovered.sourceRecovery).toMatchObject({ sourceSha: rebuilt.sourceSha, previousTaskId: old.taskId,
      previousSourceRoot: f.source.sourceRoot, previousBundleSha256: old.bundleSha256 });
    expect(recovered.expiresAtSec).toBe(22600 + 21600);
    expect((f.rows[0].detail.gradingAuditRuntime as GradingAuditRuntimeLocator).issueIds).toEqual(['EI-a', 'P001-acceptance']);
    expect(readGradingAuditSourcePin(rebuilt.sourceRoot, f.source.ownerRef, 22600)?.bundleSha256).toBe(recovered.bundleSha256);
    // Repeated acquisition returns the same receipt under the same build mutex.
    expect((await ensureGradingAuditRuntime({ ...f.input, allowSeed: false }, f.deps)).sourceRecovery).toEqual(recovered.sourceRecovery);
  });

  it('refuses a rebuild without ledger provenance and never replaces a live task with a missing pin', async () => {
    const rebuilt = await rebuiltFixture();
    const f = fixture(rebuilt.evaluatorBuild);
    await expect(ensureGradingAuditRuntime({ ...f.input, recoverySourceRoot: rebuilt.sourceRoot }, f.deps))
      .rejects.toThrow('registered prior');
    await ensureGradingAuditRuntime(f.input, f.deps);
    rmSync(dirname(f.source.sourceRoot), { recursive: true, force: true });
    await expect(ensureGradingAuditRuntime({ ...f.input, recoverySourceRoot: rebuilt.sourceRoot }, f.deps))
      .rejects.toThrow('no valid recovery locator');
    expect(f.deps.spawn).toHaveBeenCalledTimes(1);
  });

  it('retires a live row past its absolute deadline instead of refusing (EI-28734517302278942)', async () => {
    const f = fixture();
    const first = await ensureGradingAuditRuntime(f.input, f.deps);
    // Before expiry, a live exact-label row is reused, never stopped.
    expect((await ensureGradingAuditRuntime(f.input, f.deps)).taskId).toBe(first.taskId);
    expect(f.stop).not.toHaveBeenCalled();
    // The task outlived its deadline: the ledger still reads running after expiry.
    f.deps.now = () => (first.expiresAtSec + 1) * 1000;
    expect(f.rows.find(row => row.taskId === first.taskId)?.state).toBe('running');
    const next = await ensureGradingAuditRuntime(f.input, f.deps);
    expect(f.stop).toHaveBeenCalledWith(first.taskId);
    expect(f.rows.find(row => row.taskId === first.taskId)?.state).toBe('killed');
    expect(next.taskId).not.toBe(first.taskId);
    expect(next.expiresAtSec).toBeGreaterThan(first.expiresAtSec);
    expect(f.deps.spawn).toHaveBeenCalledTimes(2);
  });

  it('refuses wrong commits, dirty source, missing artifact proof and replaced bundle bytes', async () => {
    const rebuilt = await rebuiltFixture();
    expect((await qualifyRematerializedGradingAuditSource(rebuilt.sourceRoot, rebuilt.evaluatorBuild)).sourceSha).toBe(rebuilt.sourceSha);
    await expect(qualifyRematerializedGradingAuditSource(rebuilt.sourceRoot, { ...rebuilt.evaluatorBuild, sha: 'f'.repeat(10) }))
      .rejects.toThrow('differs');
    writeFileSync(join(rebuilt.sourceRoot, 'entry.ts'), 'dirty source');
    await expect(qualifyRematerializedGradingAuditSource(rebuilt.sourceRoot, rebuilt.evaluatorBuild)).rejects.toThrow('source-unqualified');
    writeFileSync(join(rebuilt.sourceRoot, 'entry.ts'), 'export const evaluator = true;\n');
    writeFileSync(rebuilt.bundlePath, 'replacement ' + requestOnlyIdentityGuardMarker());
    await expect(qualifyRematerializedGradingAuditSource(rebuilt.sourceRoot, rebuilt.evaluatorBuild)).rejects.toThrow('artifact proof');
  });

  it('adopts prepared external bytes, reuses the endpoint, and retires only after its last reference', async () => {
    const built = await rebuiltFixture(true);
    const f = fixture(built.evaluatorBuild);
    f.deps.currentSource = () => { throw new Error('dispatcher is not the target evaluator'); };
    f.deps.recoverSource = (ws, build, now) => recoverGradingAuditRuntimeSource(built.root, ws, build, now);
    const preparedSource = { sourceRoot: built.sourceRoot, bundlePath: built.bundlePath };
    const first = await ensureGradingAuditRuntime({ ...f.input, allowSeed: false, preparedSource }, f.deps);
    const locator = f.rows[0].detail.gradingAuditRuntime as GradingAuditRuntimeLocator;
    expect(locator).toMatchObject({ sourceRoot: built.sourceRoot, bundlePath: built.bundlePath,
      externalArtifact: { sourceSha: built.sourceSha, artifactRoot: dirname(built.bundlePath) } });
    expect(recoverGradingAuditRuntimeSource(built.root, 'ws', built.evaluatorBuild, 1000)).toEqual(locator);
    expect((await ensureGradingAuditRuntime({ ...f.input, issueId: 'EI-b', allowSeed: false }, f.deps)).taskId).toBe(first.taskId);
    expect(f.deps.spawn).toHaveBeenCalledOnce();
    await retireUnusedGradingAuditRuntimes('ws', async ids => ids.filter(id => id === 'EI-b'), f.deps);
    expect(f.stop).not.toHaveBeenCalled();
    await retireUnusedGradingAuditRuntimes('ws', async () => [], f.deps);
    expect(f.stop).toHaveBeenCalledWith(first.taskId);
    expect(readGradingAuditSourcePin(built.sourceRoot, locator.ownerRef, 1000)).toBeNull();
    expect(built.git('status', '--porcelain', '--untracked-files=no')).toBe('');
  });

  it('recovers JSONB-reordered external provenance and then reuses the recovered task (EI-28073575906742648)', async () => {
    const built = await rebuiltFixture(true);
    const f = fixture(built.evaluatorBuild);
    const first = await ensureGradingAuditRuntime({ ...f.input, preparedSource: built }, f.deps);
    const locator = f.rows[0].detail.gradingAuditRuntime as GradingAuditRuntimeLocator;
    const artifact = locator.externalArtifact!;
    const reordered = JSON.parse(JSON.stringify({ sourceSha: artifact.sourceSha, bundlePath: artifact.bundlePath,
      artifactRoot: artifact.artifactRoot, manifestSha256: artifact.manifestSha256 }));
    const pin = readGradingAuditSourcePin(built.sourceRoot, locator.ownerRef, 1000)!;
    expect(reordered).toEqual(pin.externalArtifact);
    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(pin.externalArtifact));
    locator.externalArtifact = reordered;
    f.rows[0].state = 'exited';
    const recovered = await ensureGradingAuditRuntime({ ...f.input, issueId: 'EI-b', allowSeed: false }, f.deps);
    expect(recovered.taskId).not.toBe(first.taskId);
    expect(recovered.baseUrl).toBe(first.baseUrl);
    (f.rows[0].detail.gradingAuditRuntime as GradingAuditRuntimeLocator).externalArtifact = reordered;
    expect((await ensureGradingAuditRuntime({ ...f.input, issueId: 'EI-c', allowSeed: false }, f.deps)).taskId)
      .toBe(recovered.taskId);
    expect(f.deps.spawn).toHaveBeenCalledTimes(2);
  });

  it.each(['bundlePath', 'artifactRoot', 'sourceSha', 'manifestSha256'] as const)(
    'refuses changed external %s before spawning (EI-28073575906742648)', async field => {
      const built = await rebuiltFixture(true);
      const f = fixture(built.evaluatorBuild);
      await ensureGradingAuditRuntime({ ...f.input, preparedSource: built }, f.deps);
      const locator = structuredClone(f.rows[0].detail.gradingAuditRuntime as GradingAuditRuntimeLocator);
      locator.externalArtifact![field] += '-changed';
      f.deps.list = async () => [];
      f.deps.recoverSource = () => locator;
      vi.mocked(f.deps.spawn!).mockClear();
      await expect(ensureGradingAuditRuntime({ ...f.input, allowSeed: false }, f.deps))
        .rejects.toThrow('recovery pin does not match its task locator');
      expect(f.deps.spawn).not.toHaveBeenCalled();
    });

  it.each([false, true])('refuses external provenance presence mismatch (external pin: %s)', async external => {
    const built = external ? await rebuiltFixture(true) : null;
    const f = built ? fixture(built.evaluatorBuild) : fixture();
    await ensureGradingAuditRuntime({ ...f.input, ...(built ? { preparedSource: built } : {}) }, f.deps);
    const locator = structuredClone(f.rows[0].detail.gradingAuditRuntime as GradingAuditRuntimeLocator);
    if (external) delete locator.externalArtifact;
    else locator.externalArtifact = { bundlePath: locator.bundlePath, artifactRoot: dirname(locator.bundlePath),
      sourceSha: 'a'.repeat(40), manifestSha256: 'b'.repeat(64) };
    f.deps.list = async () => [];
    f.deps.recoverSource = () => locator;
    vi.mocked(f.deps.spawn!).mockClear();
    await expect(ensureGradingAuditRuntime({ ...f.input, allowSeed: false }, f.deps))
      .rejects.toThrow('recovery pin does not match its task locator');
    expect(f.deps.spawn).not.toHaveBeenCalled();
  });

  it('prepares external ESM dependency resolution from retained source before spawning', async () => {
    const built = await rebuiltFixture(true);
    const dependency = join(built.sourceRoot, 'node_modules/runtime-fixture-dep');
    mkdirSync(dependency);
    writeFileSync(join(dependency, 'package.json'), JSON.stringify({ type: 'module', exports: './index.mjs' }));
    writeFileSync(join(dependency, 'index.mjs'), 'export default 42;');
    const output = dirname(built.bundlePath);
    const probe = () => execFileSync(process.execPath, ['--input-type=module', '--eval',
      "console.log((await import('runtime-fixture-dep')).default)"], { cwd: output, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    expect(probe).toThrow();
    await qualifyPreparedGradingAuditSource(built, built.evaluatorBuild);
    expect(realpathSync(join(output, 'node_modules'))).toBe(join(built.sourceRoot, 'node_modules'));
    expect(probe().trim()).toBe('42');
    await qualifyPreparedGradingAuditSource(built, built.evaluatorBuild);
    const f = fixture(built.evaluatorBuild);
    rmSync(join(output, 'node_modules'));
    const foreign = join(built.root, 'foreign-modules');
    mkdirSync(foreign);
    symlinkSync(foreign, join(output, 'node_modules'), 'dir');
    await expect(ensureGradingAuditRuntime({ ...f.input, preparedSource: built }, f.deps))
      .rejects.toThrow('dependencies differ');
    expect(f.deps.spawn).not.toHaveBeenCalled();
  });

  it('recovers the external pin before task registration and refuses expiry or replaced output', async () => {
    const built = await rebuiltFixture(true);
    const f = fixture(built.evaluatorBuild);
    f.deps.recoverSource = (ws, build, now) => recoverGradingAuditRuntimeSource(built.root, ws, build, now);
    f.deps.spawn = vi.fn(async () => { throw new Error('registration unavailable'); });
    await expect(ensureGradingAuditRuntime({ ...f.input, preparedSource: built }, f.deps)).rejects.toThrow('registration unavailable');
    const pin = recoverGradingAuditRuntimeSource(built.root, 'ws', built.evaluatorBuild, 1000)!;
    expect(pin?.externalArtifact?.sourceSha).toBe(built.sourceSha);
    expect(recoverGradingAuditRuntimeSource(built.root, 'ws', built.evaluatorBuild, pin.expiresAtSec)).toBeNull();
    f.deps.spawn = vi.fn(async () => 'recovered-task');
    f.deps.currentSource = () => { throw new Error('must recover the pin'); };
    expect((await ensureGradingAuditRuntime({ ...f.input, allowSeed: false }, f.deps)).taskId).toBe('recovered-task');
    writeFileSync(built.bundlePath, 'replacement ' + requestOnlyIdentityGuardMarker());
    expect(recoverGradingAuditRuntimeSource(built.root, 'ws', built.evaluatorBuild, 1000)).toBeNull();
    await expect(ensureGradingAuditRuntime({ ...f.input, allowSeed: false }, f.deps)).rejects.toThrow('No retained');
  });

  it('refuses external wrong source, dirty compiler inputs, missing manifests and replaced bytes before spawn', async () => {
    const built = await rebuiltFixture(true);
    const f = fixture(built.evaluatorBuild);
    await expect(qualifyPreparedGradingAuditSource(built, { ...built.evaluatorBuild, sha: 'f'.repeat(10) })).rejects.toThrow('differs');
    writeFileSync(join(built.sourceRoot, 'entry.ts'), 'dirty input');
    await expect(ensureGradingAuditRuntime({ ...f.input, preparedSource: built }, f.deps)).rejects.toThrow('source-unqualified');
    writeFileSync(join(built.sourceRoot, 'entry.ts'), 'export const evaluator = true;\n');
    if (built.artifact.status !== 'measured') throw new Error('fixture artifact missing');
    const manifest = readFileSync(built.artifact.evidenceRef);
    rmSync(built.artifact.evidenceRef);
    await expect(ensureGradingAuditRuntime({ ...f.input, preparedSource: built }, f.deps)).rejects.toThrow('artifact proof');
    writeFileSync(built.artifact.evidenceRef, manifest);
    writeFileSync(built.bundlePath, 'replaced ' + requestOnlyIdentityGuardMarker());
    await expect(ensureGradingAuditRuntime({ ...f.input, preparedSource: built }, f.deps)).rejects.toThrow('artifact proof');
    expect(f.deps.spawn).not.toHaveBeenCalled();
  });

  it('shares one ledger-owned endpoint across concurrent audits of the same build', async () => {
    const f = fixture();
    const [a, b] = await Promise.all([ensureGradingAuditRuntime(f.input, f.deps),
      ensureGradingAuditRuntime({ ...f.input, issueId: 'EI-b', evaluatorBuild: {
        version: f.input.evaluatorBuild.version, sha: f.input.evaluatorBuild.sha,
      } }, f.deps)]);
    expect(a.taskId).toBe(b.taskId);
    expect(f.deps.spawn).toHaveBeenCalledTimes(1);
    expect((f.rows[0].detail.gradingAuditRuntime as GradingAuditRuntimeLocator).issueIds).toEqual(['EI-a', 'EI-b']);
    expect(readGradingAuditSourcePin(f.source.sourceRoot, f.source.ownerRef, 1000)?.bundleSha256).toBe(f.source.bundleSha256);
  });

  it('rehydrates after process loss from the saved physical generation after staging advances', async () => {
    const f = fixture();
    const old = await ensureGradingAuditRuntime(f.input, f.deps);
    f.rows[0].state = 'ended_unobserved';
    f.deps.currentSource = () => { throw new Error('staging alias now serves a different build'); };
    const recovered = await ensureGradingAuditRuntime({ ...f.input, issueId: 'EI-b', allowSeed: false }, f.deps);
    expect(recovered.taskId).not.toBe(old.taskId);
    expect(f.deps.spawn).toHaveBeenLastCalledWith('ws', expect.objectContaining({
      sourceRoot: f.source.sourceRoot, evaluatorBuild: f.input.evaluatorBuild, issueIds: ['EI-a', 'EI-b'],
    }));
  });

  it('preserves the enrolled runtime and references when live endpoint readiness is unknown', async () => {
    const f = fixture();
    const old = await ensureGradingAuditRuntime(f.input, f.deps);
    f.deps.probe = vi.fn().mockResolvedValueOnce(null).mockResolvedValue(f.input.evaluatorBuild);
    await expect(ensureGradingAuditRuntime({ ...f.input, issueId: 'EI-b' }, f.deps)).rejects.toThrow('readiness is unknown');
    expect(f.stop).not.toHaveBeenCalled();
    expect(f.deps.spawn).toHaveBeenCalledTimes(1);
    expect((f.rows[0].detail.gradingAuditRuntime as GradingAuditRuntimeLocator).issueIds).toEqual(['EI-a', 'EI-b']);
    const recovered = await ensureGradingAuditRuntime({ ...f.input, issueId: 'EI-c' }, f.deps);
    expect(recovered.taskId).toBe(old.taskId);
    expect(f.deps.spawn).toHaveBeenCalledTimes(1);
    expect((f.rows[0].detail.gradingAuditRuntime as GradingAuditRuntimeLocator).issueIds).toEqual(['EI-a', 'EI-b', 'EI-c']);
  });

  it('waits for a retained supervisor to restore readiness without replacing its task or references', async () => {
    const f = fixture();
    const old = await ensureGradingAuditRuntime(f.input, f.deps);
    f.deps.sleep = vi.fn(async () => {});
    f.deps.probe = vi.fn()
      .mockResolvedValueOnce({ status: 'unready', reason: 'connection-error', errorCode: 'ECONNREFUSED' })
      .mockResolvedValueOnce({ status: 'unready', reason: 'timeout' })
      .mockResolvedValue({ status: 'ready', build: f.input.evaluatorBuild });
    const recovered = await ensureGradingAuditRuntime({ ...f.input, issueId: 'EI-b', acceptanceRef: 'WI-source' }, f.deps);
    expect(recovered).toEqual(old);
    expect(f.deps.probe).toHaveBeenCalledTimes(3);
    expect(f.deps.sleep).toHaveBeenCalledTimes(2);
    expect(f.stop).not.toHaveBeenCalled();
    expect(f.deps.spawn).toHaveBeenCalledTimes(1);
    expect(f.rows[0].detail.gradingAuditRuntime).toMatchObject({
      issueIds: ['EI-a', 'EI-b'], acceptanceRefs: ['WI-source'], baseUrl: old.baseUrl,
    });
  });

  it('does not accept another evaluator reached while a retained supervisor is recovering', async () => {
    const f = fixture();
    await ensureGradingAuditRuntime(f.input, f.deps);
    f.deps.probe = vi.fn()
      .mockResolvedValueOnce({ status: 'unready', reason: 'connection-error', errorCode: 'ECONNREFUSED' })
      .mockResolvedValue({ status: 'ready', build: { ...f.input.evaluatorBuild, sha: 'wrong' } });
    await expect(ensureGradingAuditRuntime(f.input, f.deps)).rejects.toThrow('identity mismatch');
    expect(f.deps.spawn).toHaveBeenCalledTimes(1);
    expect(f.stop).not.toHaveBeenCalled();
  });

  it('stops recovery probing when the retained runtime absolute lifetime expires', async () => {
    const f = fixture();
    const old = await ensureGradingAuditRuntime(f.input, f.deps);
    f.deps.probe = vi.fn().mockResolvedValue({ status: 'unready', reason: 'connection-error', errorCode: 'ECONNREFUSED' });
    f.deps.sleep = vi.fn(async () => { f.deps.now = () => old.expiresAtSec * 1000; });
    const error = await ensureGradingAuditRuntime(f.input, f.deps).catch(error => error);
    expect(error).toBeInstanceOf(GradingAuditRuntimeReadinessError);
    expect(f.deps.sleep).toHaveBeenCalledTimes(1);
    expect(f.deps.probe).toHaveBeenCalledTimes(1);
    expect(f.stop).not.toHaveBeenCalled();
    expect(f.deps.spawn).toHaveBeenCalledTimes(1);
  });

  it.each<{
    label: string;
    response: () => Promise<Response>;
    failure: Record<string, unknown>;
  }>([
    { label: 'HTTP failure', response: async () => new Response('warming', { status: 503 }),
      failure: { reason: 'http-error', httpStatus: 503 } },
    { label: 'invalid JSON', response: async () => new Response('not JSON'),
      failure: { reason: 'invalid-json' } },
    { label: 'malformed health', response: async () => Response.json({ healthy: true }),
      failure: { reason: 'invalid-health' } },
    { label: 'null health', response: async () => Response.json(null),
      failure: { reason: 'invalid-health' } },
    { label: 'connection refusal', response: async () => {
      throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
    }, failure: { reason: 'connection-error', errorCode: 'ECONNREFUSED' } },
    { label: 'timeout', response: async () => { throw new DOMException('deadline', 'TimeoutError'); },
      failure: { reason: 'timeout' } },
    { label: 'unclassified fetch error', response: async () => { throw new Error('transport failed'); },
      failure: { reason: 'fetch-error' } },
  ])('retains exact task diagnostics for $label and reuses the task once ready', async ({ response, failure }) => {
    const f = fixture();
    const deadlineAtMs = setReadinessDeadline(f);
    const runtime = await ensureGradingAuditRuntime(f.input, f.deps);
    f.rows[0].logPath = join(f.root, 'recorded-runtime.log');
    delete f.deps.probe;
    const fetchHealth = vi.spyOn(globalThis, 'fetch').mockImplementation(response);
    const error = await ensureGradingAuditRuntime({ ...f.input, issueId: 'EI-b', acceptanceRef: 'WI-source', deadlineAtMs }, f.deps)
      .catch(error => error);
    const recoverable = ['connection-error', 'timeout'].includes(String(failure.reason)) || failure.httpStatus === 503;
    expect(error).toBeInstanceOf(GradingAuditRuntimeReadinessError);
    expect(error.diagnostic).toEqual({
      taskId: runtime.taskId, locator: { ...f.source, baseUrl: runtime.baseUrl, expiresAtSec: runtime.expiresAtSec,
        issueIds: ['EI-a', 'EI-b'], acceptanceRefs: ['WI-source'] },
      logPath: f.rows[0].logPath, lastProbe: { status: 'unready', ...failure },
      attempts: ['connection-error', 'timeout'].includes(String(failure.reason)) || failure.httpStatus === 503 ? 30 : 1,
      readiness: { method: 'GET', url: runtime.baseUrl + '/api/health', timeoutMs: 2000 },
      taskRead: { tool: 'processes:list', args: { taskId: runtime.taskId } },
      recovery: { tool: 'scorecards:repair', args: { targetIds: ['EI-b'] } },
      stopReason: recoverable ? 'caller-deadline' : 'probe-not-recoverable',
    });
    expect(f.stop).not.toHaveBeenCalled();
    expect(f.deps.spawn).toHaveBeenCalledTimes(1);
    expect(readGradingAuditSourcePin(f.source.sourceRoot, f.source.ownerRef, 1000)?.bundleSha256).toBe(runtime.bundleSha256);
    fetchHealth.mockImplementation(async () => Response.json(f.input.evaluatorBuild));
    expect((await ensureGradingAuditRuntime(f.input, f.deps)).taskId).toBe(runtime.taskId);
    expect(f.deps.spawn).toHaveBeenCalledTimes(1);
  });

  it('retains a newly enrolled warming runtime after the readiness window and reuses it once ready', async () => {
    const f = fixture();
    const deadlineAtMs = setReadinessDeadline(f);
    f.deps.probe = vi.fn().mockResolvedValue(null);
    const error = await ensureGradingAuditRuntime({ ...f.input, deadlineAtMs }, f.deps).catch(error => error);
    expect(error).toBeInstanceOf(GradingAuditRuntimeReadinessError);
    expect(error.diagnostic).toMatchObject({ taskId: 'runtime-0', logPath: null, attempts: 30, stopReason: 'caller-deadline',
      lastProbe: { status: 'unready', reason: 'unknown' },
      locator: { ...f.source, baseUrl: 'http://127.0.0.1:45187', issueIds: ['EI-a'] } });
    expect(f.stop).not.toHaveBeenCalled();
    expect(f.rows[0].state).toBe('running');
    expect(f.deps.spawn).toHaveBeenCalledTimes(1);
    expect(readGradingAuditSourcePin(f.source.sourceRoot, f.source.ownerRef, 1000)).not.toBeNull();
    f.deps.probe = vi.fn().mockResolvedValue(f.input.evaluatorBuild);
    expect((await ensureGradingAuditRuntime({ ...f.input, issueId: 'EI-b' }, f.deps)).taskId).toBe('runtime-0');
    expect(f.deps.spawn).toHaveBeenCalledTimes(1);
    expect((f.rows[0].detail.gradingAuditRuntime as GradingAuditRuntimeLocator).issueIds).toEqual(['EI-a', 'EI-b']);
  });

  it('continues exact readiness probing after more than 30 refusals while the task remains live', async () => {
    const f = fixture();
    const deadlineAtMs = setReadinessDeadline(f, 60_000);
    let probes = 0;
    f.deps.probe = vi.fn(async () => ++probes <= 35
      ? { status: 'unready' as const, reason: 'connection-error' as const, errorCode: 'ECONNREFUSED' }
      : { status: 'ready' as const, build: f.input.evaluatorBuild });

    const runtime = await ensureGradingAuditRuntime({ ...f.input, deadlineAtMs }, f.deps);

    expect(runtime.taskId).toBe('runtime-0');
    expect(probes).toBe(36);
    expect(f.deps.sleep).toHaveBeenCalledTimes(35);
    expect(f.rows[0]?.state).toBe('running');
    expect(f.deps.spawn).toHaveBeenCalledTimes(1);
  });

  it('stops readiness retries when the task ledger reports the runtime ended', async () => {
    const f = fixture();
    let probes = 0;
    f.deps.probe = vi.fn(async () => {
      probes += 1;
      if (probes === 2) f.rows[0]!.state = 'exited';
      return { status: 'unready' as const, reason: 'connection-error' as const, errorCode: 'ECONNREFUSED' };
    });

    const error = await ensureGradingAuditRuntime(f.input, f.deps).catch(error => error);

    expect(error).toBeInstanceOf(GradingAuditRuntimeReadinessError);
    expect(error.diagnostic).toMatchObject({ attempts: 2, stopReason: 'task-not-live', taskState: 'exited' });
    expect(probes).toBe(2);
    expect(f.deps.sleep).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['unknown', null],
    ['recoverable', { status: 'unready' as const, reason: 'connection-error' as const, errorCode: 'ECONNREFUSED' }],
  ])('stops readiness retries when the caller aborts a %s probe', async (_reason, result) => {
    const f = fixture();
    const controller = new AbortController();
    f.deps.probe = vi.fn(async () => {
      controller.abort();
      return result;
    });

    const error = await ensureGradingAuditRuntime({ ...f.input, signal: controller.signal }, f.deps).catch(error => error);

    expect(error).toBeInstanceOf(GradingAuditRuntimeReadinessError);
    expect(error.diagnostic).toMatchObject({ attempts: 1, stopReason: 'caller-aborted' });
    expect(f.deps.probe).toHaveBeenCalledTimes(1);
    expect(f.deps.sleep).not.toHaveBeenCalled();
    expect(f.deps.stop).not.toHaveBeenCalled();
    expect(f.rows[0]?.state).toBe('running');
  });

  it('retains the last measured probe reason after the bounded startup window', async () => {
    const f = fixture();
    const deadlineAtMs = setReadinessDeadline(f);
    f.deps.probe = vi.fn().mockResolvedValueOnce({ status: 'unready', reason: 'connection-error', errorCode: 'ECONNREFUSED' })
      .mockResolvedValue({ status: 'unready', reason: 'http-error', httpStatus: 503 });
    const error = await ensureGradingAuditRuntime({ ...f.input, deadlineAtMs }, f.deps).catch(error => error);
    expect(error.diagnostic).toMatchObject({ attempts: 30, stopReason: 'caller-deadline',
      lastProbe: { status: 'unready', reason: 'http-error', httpStatus: 503 } });
    expect(f.stop).not.toHaveBeenCalled();
    expect(f.deps.probe).toHaveBeenCalledTimes(30);
    f.deps.probe = async () => ({ status: 'ready', build: f.input.evaluatorBuild });
    expect((await ensureGradingAuditRuntime(f.input, f.deps)).taskId).toBe('runtime-0');
    expect(f.deps.spawn).toHaveBeenCalledTimes(1);
  });

  it('recovers a crash between atomic pin publication and task registration', async () => {
    const f = fixture();
    f.deps.spawn = vi.fn(async () => { throw new Error('registration interrupted'); });
    await expect(ensureGradingAuditRuntime(f.input, f.deps)).rejects.toThrow('registration interrupted');
    expect(f.rows).toEqual([]);
    const source = recoverGradingAuditRuntimeSource(f.root, 'ws', f.input.evaluatorBuild, 1000);
    expect(source?.issueIds).toEqual(['EI-a']);
    f.deps.currentSource = () => { throw new Error('staging advanced'); };
    f.deps.spawn = async (_ws, locator) => {
      expect(locator.sourceRoot).toBe(f.source.sourceRoot);
      return 'recovered-after-pin';
    };
    const recovered = await ensureGradingAuditRuntime({ ...f.input, allowSeed: false }, f.deps);
    expect(recovered.taskId).toBe('recovered-after-pin');
    expect(recoverGradingAuditRuntimeSource(f.root, 'foreign-ws', f.input.evaluatorBuild, 1000)).toBeNull();
  });

  it('prefers the surviving owned task over a newer terminal row and refuses unknown ownership', async () => {
    const f = fixture();
    const live = await ensureGradingAuditRuntime(f.input, f.deps);
    f.rows.unshift({ ...structuredClone(f.rows[0]), taskId: 'newer-terminal', state: 'ended_unobserved' });
    expect((await ensureGradingAuditRuntime(f.input, f.deps)).taskId).toBe(live.taskId);
    expect(f.deps.spawn).toHaveBeenCalledTimes(1);
    f.rows[1].state = 'unaccounted';
    await expect(ensureGradingAuditRuntime(f.input, f.deps)).rejects.toThrow('unaccounted');
    expect(f.deps.spawn).toHaveBeenCalledTimes(1);
  });

  it('enrolls the production child with its recovery locator, hard deadline and request-only environment', async () => {
    const f = fixture();
    f.deps.now = () => Date.now();
    delete f.deps.spawn;
    const logDir = join(f.root, 'persistent-task-logs');
    f.deps.logDir = logDir;
    const unref = vi.fn();
    spawnManaged.mockResolvedValue({ taskId: 'managed-runtime', confined: true, child: { unref } });
    const runtime = await ensureGradingAuditRuntime(f.input, f.deps);
    expect(runtime.taskId).toBe('managed-runtime');
    expect(spawnManaged).toHaveBeenLastCalledWith(process.execPath,
      gradingAuditRuntimeSupervisorArgs(spawnManaged.mock.calls.at(-1)![2].detail.gradingAuditRuntime),
      expect.objectContaining({ class: 'sidecar', runtimeMaxSec: expect.any(Number),
        detail: { label: f.source.ownerRef, gradingAuditRuntime: expect.objectContaining({
          sourceRoot: f.source.sourceRoot, issueIds: ['EI-a'], bundleSha256: f.source.bundleSha256,
        }) } }), expect.objectContaining({ workspaceId: 'ws', requireRegistration: true,
        spawnOptions: expect.objectContaining({ detached: true, env: expect.objectContaining({ PAPERCUSP_BACKGROUND_WORKERS: '0' }) }) }));
    expect(spawnManaged.mock.calls.at(-1)?.[2].runtimeMaxSec).toBeLessThanOrEqual(21600);
    expect(unref).toHaveBeenCalledOnce();
    const logPath = spawnManaged.mock.calls.at(-1)?.[2].logPath as string | undefined;
    expect(logPath).toContain(logDir);
    expect(logPath).not.toContain(f.source.sourceRoot);
    writeFileSync(logPath!, 'runtime output survives candidate pruning\n');
    rmSync(join(f.root, '.candidate-exact.first'), { recursive: true, force: true });
    expect(readFileSync(logPath!, 'utf8')).toBe('runtime output survives candidate pruning\n');
  });

  it('refuses an unconfined production child and terminates it before dispatch can use it', async () => {
    const f = fixture();
    f.deps.now = () => Date.now();
    delete f.deps.spawn;
    spawnManaged.mockResolvedValue({ taskId: 'unconfined', confined: false, child: { unref: vi.fn() } });
    killManaged.mockResolvedValue({ ok: true });
    await expect(ensureGradingAuditRuntime(f.input, f.deps)).rejects.toThrow('confined');
    expect(killManaged).toHaveBeenCalledWith('unconfined', expect.objectContaining({ includeSubtree: true }));
    expect(f.deps.probe).not.toHaveBeenCalled();
  });

  it.each(['sha', 'version'] as const)('refuses %s readiness and retires the mismatched child', async mode => {
    const f = fixture();
    f.deps.probe = async () => ({ ...f.input.evaluatorBuild, [mode]: 'wrong' });
    await expect(ensureGradingAuditRuntime(f.input, f.deps)).rejects.toThrow('mismatch');
    expect(f.stop).toHaveBeenCalledWith('runtime-0');
  });

  it('fails closed when retained bundle bytes or recovery pins are damaged', async () => {
    const f = fixture();
    await ensureGradingAuditRuntime(f.input, f.deps);
    f.rows[0].state = 'ended_unobserved';
    writeFileSync(f.source.bundlePath, 'different evaluator');
    await expect(ensureGradingAuditRuntime({ ...f.input, allowSeed: false }, f.deps)).rejects.toThrow('digest');
    expect(f.deps.spawn).toHaveBeenCalledTimes(1);
  });

  it('cannot seed an old evaluator from a newer staging host or from unknown identity', async () => {
    const f = fixture();
    await expect(ensureGradingAuditRuntime({ ...f.input, allowSeed: false }, f.deps)).rejects.toThrow('No retained');
    await expect(ensureGradingAuditRuntime({ ...f.input, evaluatorBuild: { sha: null, version: '1' } }, f.deps)).rejects.toThrow('unknown');
    expect(f.deps.spawn).not.toHaveBeenCalled();
  });

  it('keeps a shared runtime until its final pending audit settles, then stops it and releases the pin', async () => {
    const f = fixture();
    const runtime = await ensureGradingAuditRuntime(f.input, f.deps);
    await ensureGradingAuditRuntime({ ...f.input, issueId: 'EI-b' }, f.deps);
    await retireUnusedGradingAuditRuntimes('ws', async ids => ids.filter(id => id === 'EI-b'), f.deps);
    expect(f.stop).not.toHaveBeenCalled();
    expect((f.rows[0].detail.gradingAuditRuntime as GradingAuditRuntimeLocator).issueIds).toEqual(['EI-b']);
    await retireUnusedGradingAuditRuntimes('ws', async () => [], f.deps);
    expect(f.stop).toHaveBeenCalledWith(runtime.taskId);
    expect(readGradingAuditSourcePin(f.source.sourceRoot, f.source.ownerRef, 1000)).toBeNull();
  });

  it('enforces bounded expiry even if a card stays pending', async () => {
    const f = fixture();
    await ensureGradingAuditRuntime(f.input, f.deps);
    f.deps.now = () => 22600000;
    await retireUnusedGradingAuditRuntimes('ws', async ids => ids, f.deps);
    expect(f.stop).toHaveBeenCalledWith('runtime-0');
    expect(readGradingAuditSourcePin(f.source.sourceRoot, f.source.ownerRef, 1000)).toBeNull();
  });

  it('supplies each exact locator to the consumer check before stopping or releasing its source', async () => {
    const f = fixture();
    const runtime = await ensureGradingAuditRuntime(f.input, f.deps);
    const pending = vi.fn(async (_ids: string[], locator?: GradingAuditRuntimeLocator) =>
      locator?.baseUrl === runtime.baseUrl ? [] : ['EI-a']);

    await retireUnusedGradingAuditRuntimes('ws', pending, f.deps);

    expect(pending).toHaveBeenCalledWith(['EI-a'], expect.objectContaining({
      baseUrl: runtime.baseUrl, evaluatorBuild: f.input.evaluatorBuild,
    }));
    expect(f.stop).toHaveBeenCalledWith(runtime.taskId);
    expect(readGradingAuditSourcePin(f.source.sourceRoot, f.source.ownerRef, 1000)).toBeNull();
  });

  it('targeted cleanup bypasses an unrelated runtime mutex and preserves pending siblings', async () => {
    const f = fixture();
    await ensureGradingAuditRuntime(f.input, f.deps);
    await ensureGradingAuditRuntime({ ...f.input, issueId: 'EI-b' }, f.deps);
    const live = f.rows[0];
    const locator = live.detail.gradingAuditRuntime as GradingAuditRuntimeLocator;
    f.rows.push({ ...live, taskId: 'prior-runtime', state: 'ended_unobserved',
      detail: { ...live.detail, gradingAuditRuntime: { ...locator, issueIds: ['EI-a'] } } });
    const unrelatedLabel = 'grading-audit-runtime:unrelated';
    f.rows.push({ ...live, taskId: 'unrelated-runtime',
      detail: { label: unrelatedLabel,
        gradingAuditRuntime: { ...locator, ownerRef: unrelatedLabel, issueIds: ['EI-other'] } } });
    f.deps.mutex = async (_workspace, key, fn) => {
      if (key === unrelatedLabel) throw new Error('unrelated runtime mutex is held');
      return fn();
    };

    await retireUnusedGradingAuditRuntimes('ws', async ids => ids.filter(id => id === 'EI-b'), f.deps, ['EI-a']);

    expect(f.stop).not.toHaveBeenCalled();
    expect((live.detail.gradingAuditRuntime as GradingAuditRuntimeLocator).issueIds).toEqual(['EI-b']);
    expect(readGradingAuditSourcePin(f.source.sourceRoot, f.source.ownerRef, 1000)).not.toBeNull();
  });

  it('reuses the request-only identity and single-writer fences for the child', async () => {
    const f = fixture();
    await ensureGradingAuditRuntime(f.input, f.deps);
    const env = gradingAuditRuntimeChildEnv(f.rows[0].detail.gradingAuditRuntime as GradingAuditRuntimeLocator);
    expect(env).toMatchObject({ PAPERCUSP_BACKGROUND_WORKERS: '0', PAPERCUSP_USE_EMBEDDED_PG: '0',
      PAPERCUSP_DBOS_ENABLE: '0', PAPERCUSP_DBOS_ROUTINES: '0', PAPERCUSP_DBOS_ORCHESTRATOR: '0',
      PAPERCUSP_PROVISION_ENV_OPERATORS: '0', PAPERCUSP_IDENTITY_MODE: 'load-only',
      PAPERCUSP_BIND_HOST: '127.0.0.1', PAPERCUSP_BUILD_SHA: f.input.evaluatorBuild.sha,
      PAPERCUSP_INTEGRATION_ROOT: f.source.sourceRoot, PAPERCUSP_HONO_PORT: '45187' });
  });

  it('pins resolved parent database targets when the immutable child has no operator env file', async () => {
    const f = fixture();
    await ensureGradingAuditRuntime(f.input, f.deps);
    const admin = 'postgresql://parent_admin:private@127.0.0.1:15432/parent';
    const app = 'postgresql://parent_app:private@127.0.0.1:15432/parent';
    vi.spyOn(databaseTargets, 'adminUrl').mockReturnValue(admin);
    vi.spyOn(databaseTargets, 'appUrl').mockReturnValue(app);
    const env = gradingAuditRuntimeChildEnv(f.rows[0].detail.gradingAuditRuntime as GradingAuditRuntimeLocator);
    expect(env).toMatchObject({ DATABASE_URL: admin, HARNESS_ADMIN_DATABASE_URL: admin,
      HARNESS_DATABASE_URL: app, PAPERCUSP_DATABASE_URL: admin,
      PAPERCUSP_INTEGRATION_ROOT: f.source.sourceRoot });
  });

  it.each([undefined, '0'])('selects the utility role independently of parent role %s', async parentRole => {
    vi.stubEnv('PAPERCUSP_UTILITY_HOST', parentRole);
    const f = fixture();
    await ensureGradingAuditRuntime(f.input, f.deps);

    const env = gradingAuditRuntimeChildEnv(f.rows[0].detail.gradingAuditRuntime as GradingAuditRuntimeLocator);

    expect(utilityHostEnabled(env)).toBe(true);
    expect(env.PAPERCUSP_BACKGROUND_WORKERS).toBe('0');
    expect(process.env.PAPERCUSP_UTILITY_HOST).toBe(parentRole);
  });

  it('does not inherit a retired parent sidecar owner when launching an exact evaluator', async () => {
    const f = fixture();
    await ensureGradingAuditRuntime(f.input, f.deps);
    const parentSocket = '/tmp/papercusp-spawner-2147483647.sock';
    vi.stubEnv(SPAWNER_SOCKET_ENV, parentSocket);
    vi.stubEnv(SPAWNER_SCOPE_ENV, 'pc-retired-parent.scope');
    vi.stubEnv(SUBSTRATE_SOCKET_ENV, '/tmp/papercusp-substrate-2147483647.sock');

    const env = gradingAuditRuntimeChildEnv(f.rows[0].detail.gradingAuditRuntime as GradingAuditRuntimeLocator);

    expect(env[SPAWNER_SOCKET_ENV]).toBeUndefined();
    expect(env[SPAWNER_SCOPE_ENV]).toBeUndefined();
    expect(env[SUBSTRATE_SOCKET_ENV]).toBeUndefined();
    expect(process.env[SPAWNER_SOCKET_ENV]).toBe(parentSocket);
    expect(process.env[SPAWNER_SCOPE_ENV]).toBe('pc-retired-parent.scope');
    expect(env).toMatchObject({ PAPERCUSP_BUILD_SHA: f.input.evaluatorBuild.sha,
      PAPERCUSP_INTEGRATION_ROOT: f.source.sourceRoot, PAPERCUSP_HONO_PORT: '45187' });

    vi.stubEnv(SPAWNER_SOCKET_ENV, env[SPAWNER_SOCKET_ENV]);
    const socket = resolveSpawnerSocketPath();
    expect(socket).not.toBe(parentSocket);
    expect(ownerPidFromSocketPath(socket)).toBe(process.pid);
  });
});
