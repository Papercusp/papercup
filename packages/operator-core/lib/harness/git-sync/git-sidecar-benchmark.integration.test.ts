/** Controlled P-003 transport benchmark. Real caller, IPC server, Git and Linux
 * containment; fixture admission excludes production DB/queue latency. This is
 * not a complete scheduled git-sync action or a production performance SLO. */
import { execFile, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { expect, it, vi } from 'vitest';
import { runGitBounded } from './run-git-sync';
import { getSidecarFallbackStats, resetSidecarFallbackStatsForTest } from '../../fleet/git-via-sidecar';
import { closeSpawnerIpcClient, SpawnerIpcClient } from '../../fleet/spawner-ipc-client';
import { sidecarContainmentCurrent, observeSidecarExit, type SidecarContainment } from '../../fleet/sidecar-exec-lifetime';
import { newTaskId, scopeUnitForTask } from '../../task-manager/types';
import { createTextCollector } from '../../child-output';

vi.mock('../../task-manager/enabled', () => ({ isTaskManagerEnabled: async () => true }));
vi.mock('../../fleet/spawner-sidecar-spawn', () => ({ spawnSpawnerSidecar: async () => {} }));
vi.mock('../../task-manager/store', () => ({
  registerTask: async (_spec: unknown, opts: { taskId: string }) => ({ taskId: opts.taskId, state: 'pending' }),
  markSpawned: async () => {}, closeTask: async () => {},
}));
import { managedSpawn, markManagedSpawnTeardown, probeScopeSupport } from '../../task-manager/managed-spawn';

const exec = promisify(execFile);
const quantile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))];
const distribution = (values: number[]) => ({ p50: quantile(values, 0.5), p95: quantile(values, 0.95), max: Math.max(...values) });

it.runIf(process.platform === 'linux')('compares identical multi-repository read/write workloads with cancellation fencing enabled', async (ctx) => {
  const support = await probeScopeSupport();
  if (!support.ok) ctx.skip(`user scopes unavailable: ${support.reason}`);
  const dir = await mkdtemp(join(tmpdir(), 'git-offload-bench-'));
  let child: ChildProcess | undefined;
  let unit: string | undefined;
  let snapshot: SidecarContainment | undefined;
  const padding = Buffer.alloc(256 * 1024 * 1024, 1);
  try {
    const repos: string[] = [];
    for (let i = 0; i < 4; i++) {
      const repo = join(dir, `repo-${i}`);
      await mkdir(repo);
      await exec('git', ['init', '-q', repo]);
      // Each repo has its own content and index. No shared-tree refs/remotes.
      for (let j = 0; j < 8; j++) await writeFile(join(repo, `file-${j}.txt`), `repo ${i} file ${j}\n`.repeat(1000));
      // Every measured block starts from an already-populated identical index;
      // the initial index creation must not appear only in the first local run.
      await exec('git', ['add', '-A'], { cwd: repo });
      repos.push(repo);
    }
    const taskId = newTaskId();
    const socketPath = join(dir, 'sidecar.sock');
    const argv = ['--import', 'tsx', fileURLToPath(new URL('../../fleet/fixtures/sidecar-lifetime-server.ts', import.meta.url))];
    const startAt = performance.now();
    const task = await managedSpawn(process.execPath, argv, {
      class: 'sidecar', title: 'P-003 isolated Git benchmark', launchedBy: 'test:git-sidecar-benchmark', argv: [process.execPath, ...argv],
    }, { taskId, scopeAvailable: true, spawnOptions: {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PAPERCUSP_SPAWNER_IPC_SOCKET: socketPath, PAPERCUSP_SPAWNER_SCOPE_UNIT: scopeUnitForTask(taskId) },
    } });
    child = task.child;
    unit = task.scopeUnit ?? undefined;
    expect(unit).toBeTruthy();
    markManagedSpawnTeardown(child);
    const output = createTextCollector(child.stdout, { maxChars: 4000 });
    output.attach(child.stderr);
    await vi.waitFor(() => {
      if (child!.exitCode !== null || child!.signalCode !== null) throw new Error(`sidecar exited: ${output.peek()}`);
      expect(output.peek()).toContain('PAPERCUSP_SPAWNER_READY');
    }, { timeout: 30_000 });
    const startupMs = performance.now() - startAt;
    const control = new SpawnerIpcClient(socketPath);
    try {
      snapshot = (await control.call<{ processExecContainment: SidecarContainment }>('spawn:cancel', {})).processExecContainment;
      expect(sidecarContainmentCurrent(snapshot)).toBe(true);
    } finally { control.close(); }
    vi.stubEnv('PAPERCUSP_SPAWNER_IPC_SOCKET', socketPath);
    vi.stubEnv('PAPERCUSP_GIT_SYNC_SPAWN_SIDECAR', '1');
    vi.stubEnv('PAPERCUSP_SPAWNER_SIDECAR_MODE', '0');
    const signal = new AbortController().signal;
    resetSidecarFallbackStatsForTest();
    const warmAt = performance.now();
    expect((await runGitBounded(['rev-parse', '--git-dir'], repos[0], 10_000, { signal })).code).toBe(0);
    const firstCallMs = performance.now() - warmAt;
    const commands = [['add', '-A'], ['write-tree'], ['status', '--porcelain=v1'], ['diff', '--cached', '--stat'], ['ls-files', '-z']];
    const expected = new Map<string, string>();
    const blocks: Array<Record<string, unknown>> = [];
    for (const mode of ['local', 'sidecar', 'sidecar', 'local']) {
      vi.stubEnv('PAPERCUSP_GIT_SYNC_SPAWN_SIDECAR', mode === 'sidecar' ? '1' : '0');
      const blocked: number[] = [], wall: number[] = [];
      const histogram = monitorEventLoopDelay({ resolution: 10 });
      histogram.enable();
      const blockAt = performance.now();
      try {
        for (let round = 0; round < 5; round++) for (const [repoIndex, repo] of repos.entries()) for (const args of commands) {
          const at = performance.now();
          const pending = runGitBounded(args, repo, 10_000, { signal });
          blocked.push(performance.now() - at);
          const result = await pending;
          wall.push(performance.now() - at);
          expect(result.code, result.stderr).toBe(0);
          const key = `${repoIndex}:${args[0]}`;
          if (!expected.has(key)) expected.set(key, result.stdout);
          expect(result.stdout).toBe(expected.get(key));
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
        blocks.push({ mode, calls: wall.length, wallMs: performance.now() - blockAt,
          rssBytes: process.memoryUsage().rss, blockedMs: distribution(blocked), completionMs: distribution(wall),
          loopP95Ms: histogram.percentile(95) / 1e6, loopMaxMs: histogram.max / 1e6 });
      } finally { histogram.disable(); }
    }
    const fallback = getSidecarFallbackStats();
    expect(fallback.total).toBe(0);
    expect(padding[padding.length - 1]).toBe(1); // retain touched caller memory through the final block
    expect(expected.size).toBe(20);
    const local = blocks.filter((row) => row.mode === 'local').map((row) => (row.blockedMs as { p50: number }).p50);
    const sidecar = blocks.filter((row) => row.mode === 'sidecar').map((row) => (row.blockedMs as { p50: number }).p50);
    // Broad mechanism guard. Completion/queueing may cost MORE and is reported.
    expect(Math.max(...sidecar)).toBeLessThan(Math.min(...local));
    console.info('P-003 multi-repository controlled benchmark:', JSON.stringify({
      admission: 'fixture; production persistence/queue latency excluded', repoCount: repos.length,
      filesPerRepo: 8, commands, order: 'local-sidecar-sidecar-local', startupMs, firstCallMs, blocks, fallback,
    }));
  } finally {
    closeSpawnerIpcClient();
    if (child) {
      const closed = child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : once(child, 'close');
      if (unit) await exec('systemctl', ['--user', 'kill', '--signal=SIGKILL', unit]).catch(() => {});
      else child.kill('SIGKILL');
      await closed;
      // Cleanup is exact fixture ownership, never a shared sidecar.
      if (snapshot) await vi.waitFor(() => expect(observeSidecarExit(snapshot!)).toBe('exited'));
    }
    await rm(dir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  }
}, 120_000);
