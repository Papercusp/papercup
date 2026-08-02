/**
 * Green-checkpoint orchestration — the advance-only-when-green + FF-only rules
 * are what keep `ready` a trustworthy deployable pin. Real temp repo for the ref
 * logic; stub deps for the (heavy) suite run.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runGreenCheckpoint,
  quietCutSecFromEnv,
  extractFailingTests,
  extractFailingTestNames,
  extractFailingCasesByFile,
  describeFailingCases,
  ISOLATION_MAX_NAMED_CASES,
  stripAnsi,
  classifyRedAgainstTip,
  nonTestGateIdsFrom,
  NON_TEST_GATE_SCRIPTS,
  autoRefireCapFromEnv,
  evaluateDeployStaleness,
  buildGreenCheckpointEnv,
  sanitizeForkNodeOptions,
  GREEN_CHECKPOINT_FORK_HEAP_MB,
  checkpointFailureSignature,
  historicalFlakeAnnotations,
  summarizeSuiteOutput,
  parseTestQuarantine,
  applyTestQuarantine,
  isQuarantinedTestFile,
  parseFailingFilesByWorkspace,
  decideFlakeAbsorption,
  attemptFlakeAbsorption,
  ISOLATION_MAX_FILES,
  ISOLATION_RETRY_MAX,
  ISOLATION_LOAD_STARVATION_MIN_MS,
  acquireCheckpointRunLock,
  checkpointRunLockDir,
  createTerminationSignalHandler,
  armSelfWatchdog,
  isWorkerPoolCrash,
  parseCrashedWorkspaces,
  attemptWorkerCrashAbsorption,
  WORKER_CRASH_MAX_WORKSPACES,
  GREEN_CHECKPOINT_MAX_FORKS,
  SELF_WATCHDOG_MS,
  isNothingToGate,
  realCheckpointDeps,
  pipelineName,
  formatGateLineageLine,
  computeGateLineage,
  type GateLineage,
  type CheckpointDeps,
  type CheckpointExec,
  type FailingFile,
  type IsolationResult,
  type WorkspaceRerunResult,
} from './green-checkpoint';
import { git, revParse, advanceReady } from './git-ops';
import { releaseConfig } from './release-config';

let repo: string;
async function commit(file: string, content: string, msg: string): Promise<string> {
  const full = join(repo, file);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
  await git(repo, ['add', '-A']);
  await git(repo, ['commit', '--no-verify', '-q', '-m', msg]);
  return revParse(repo, 'HEAD');
}

function stubDeps(
  green: boolean,
  failingTests?: string[],
  flakeSuspects?: string[],
): { deps: CheckpointDeps; calls: string[] } {
  const calls: string[] = [];
  const deps: CheckpointDeps = {
    setupTree: async (ref) => {
      calls.push(`setup:${ref.slice(0, 7)}`);
    },
    runGreen: async () => {
      calls.push('runGreen');
      return { green, summary: green ? 'all pass' : '3 failed', failingTests, flakeSuspects };
    },
    advance: (candidate) => {
      calls.push('advance');
      return advanceReady(repo, candidate, 'ready');
    },
    push: async () => {
      calls.push('push');
    },
    broadcast: async () => {
      calls.push('broadcast');
    },
    escalate: async () => {
      calls.push('escalate');
    },
    clearEscalation: async () => {
      calls.push('clearEscalation');
    },
    emitEvent: async ({ key }) => {
      // EI-10800 regression guard: hop a microtask before recording. If a call site does NOT
      // await the emit (the original fire-and-forget `void import(...)` bug), this push lands
      // AFTER runGreenCheckpoint has already resolved — so the `calls`-contains assertion below
      // fails, catching exactly the "green advance never woke its awaiter" regression.
      await Promise.resolve();
      calls.push(`emit:${key}`);
    },
    log: () => {},
  };
  return { deps, calls };
}

// EI-1762: pin the checkpoint log dir INSIDE the per-test temp repo (auto-cleaned by
// afterEach) so the suite never writes fixture logs into the REAL ~/.papercusp/checkpoint-logs/
// — those fixtures ('FAIL lib/foo.test.ts', 'SPA BUILD FAILED') masquerade as real
// checkpoint failures and mislead anyone diagnosing a deploy freeze.
const cfg = () => releaseConfig({ integrationRoot: repo, releaseRoot: repo, checkpointRoot: repo, releaseRef: 'ready', integrationBranch: 'main', checkpointLogDir: join(repo, '.checkpoint-logs') });

beforeEach(async () => {
  // File-scoped console.warn spy: runGreenCheckpoint's execution emits deliberate,
  // env-dependent warns (best-effort probes that differ between a dev tree and the
  // gate's CHECKPOINT tree), and under the full forks-pool run the fail-on-console
  // tracker repeatedly attributed one to a ROVING test in this file — green locally
  // (82/82) but red on the gate ONLY (2026-07-05: 'docs-audit #2' one verdict, 'F2
  // perf BLOCK' the next; two ~50-min verdicts burned on the same phantom). Every
  // assertion in this suite goes through the injected `deps` stubs — nothing asserts
  // via console — so spying warn loses no coverage. console.error stays guarded.
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  repo = mkdtempSync(join(tmpdir(), 'green-'));
  await git(repo, ['init', '-q', '-b', 'main']);
  await git(repo, ['config', 'user.email', 't@e.com']);
  await git(repo, ['config', 'user.name', 'T']);
  await git(repo, ['config', 'commit.gpgsign', 'false']);
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(repo, { recursive: true, force: true });
});

describe('acquireCheckpointRunLock', () => {
  it('blocks a second live checkpoint process from mutating the same checkpoint tree', () => {
    const lockDir = join(repo, '.checkpoint-logs', '.green-checkpoint-run.lock');
    const first = acquireCheckpointRunLock(lockDir, {
      pid: 123,
      isPidAlive: (pid) => pid === 123,
    });
    const second = acquireCheckpointRunLock(lockDir, {
      pid: 456,
      isPidAlive: (pid) => pid === 123,
    });
    expect(first.acquired).toBe(true);
    expect(second).toMatchObject({ acquired: false, owner: { pid: 123 } });
    first.release();
    const third = acquireCheckpointRunLock(lockDir, {
      pid: 456,
      isPidAlive: () => false,
    });
    expect(third.acquired).toBe(true);
    third.release();
  });

  it('clears a stale checkpoint lock whose owner pid is no longer alive', () => {
    const lockDir = join(repo, '.checkpoint-logs', '.green-checkpoint-run.lock');
    const stale = acquireCheckpointRunLock(lockDir, {
      pid: 123,
      isPidAlive: () => true,
    });
    expect(stale.acquired).toBe(true);
    const next = acquireCheckpointRunLock(lockDir, {
      pid: 456,
      isPidAlive: () => false,
    });
    expect(next.acquired).toBe(true);
    stale.release();
    next.release();
  });

  it('reclaims a lock that OUTLIVED the max run age even if its pid still looks alive (recycled-pid / hung-run freeze)', () => {
    // The green-checkpoint-stale-lock-2026-06-26 freeze: a crashed/hung run left a lock
    // whose recorded pid got recycled to an unrelated LIVE process, so the dead-pid check
    // never reclaimed it and `main` froze for 21h. An over-age lock must reclaim regardless.
    const lockDir = join(repo, '.checkpoint-logs', '.green-checkpoint-run.lock');
    const t0 = Date.parse('2026-06-26T00:00:00Z');
    const first = acquireCheckpointRunLock(lockDir, { pid: 123, isPidAlive: () => true, now: () => t0 });
    expect(first.acquired).toBe(true);
    // 46 min later, pid 123 STILL "alive" — but the lock is past the 45-min run window.
    const next = acquireCheckpointRunLock(lockDir, {
      pid: 456,
      isPidAlive: () => true,
      staleAfterMs: 45 * 60_000,
      now: () => t0 + 46 * 60_000,
    });
    expect(next.acquired).toBe(true);
    next.release();
  });

  it('does NOT reclaim a fresh lock with a live pid (genuine concurrent run still blocks)', () => {
    const lockDir = join(repo, '.checkpoint-logs', '.green-checkpoint-run.lock');
    const t0 = Date.parse('2026-06-26T00:00:00Z');
    const first = acquireCheckpointRunLock(lockDir, { pid: 123, isPidAlive: () => true, now: () => t0 });
    expect(first.acquired).toBe(true);
    // 10 min later (within the run window) a live owner → the second acquire is BLOCKED.
    const second = acquireCheckpointRunLock(lockDir, {
      pid: 456,
      isPidAlive: () => true,
      staleAfterMs: 45 * 60_000,
      now: () => t0 + 10 * 60_000,
    });
    expect(second).toMatchObject({ acquired: false, owner: { pid: 123 } });
    first.release();
  });

  describe('checkpointRunLockDir (per-root lock — cross-lineage starvation fix, 2026-07-02)', () => {
    it('the same root always maps to the same lock dir (cron-vs-manual still single-flights)', () => {
      const a = checkpointRunLockDir('/home/x/.papercusp/checkpoint-logs', '/home/x/ws/papercusp');
      const b = checkpointRunLockDir('/home/x/.papercusp/checkpoint-logs', '/home/x/ws/papercusp');
      expect(a).toBe(b);
      expect(a.startsWith('/home/x/.papercusp/checkpoint-logs/')).toBe(true);
      expect(a).toMatch(/\.green-checkpoint-run-[0-9a-z]+\.lock$/);
    });

    it('different roots sharing one log dir get DIFFERENT locks (the papercup-root lineage cannot starve the papercusp gate)', () => {
      const logDir = '/home/x/.papercusp/checkpoint-logs';
      const cusp = checkpointRunLockDir(logDir, '/home/x/ws/papercusp');
      const cup = checkpointRunLockDir(logDir, '/home/x/ws/papercup');
      expect(cusp).not.toBe(cup);
      // Neither collides with the legacy unsuffixed name old-lineage code still writes.
      expect(cusp).not.toBe(join(logDir, '.green-checkpoint-run.lock'));
      expect(cup).not.toBe(join(logDir, '.green-checkpoint-run.lock'));
    });

    it('two roots contend only on their own lock end-to-end (acquire under root A never blocks root B)', () => {
      const logDir = join(repo, '.checkpoint-logs');
      const lockA = acquireCheckpointRunLock(checkpointRunLockDir(logDir, '/ws/rootA'), { pid: 123, isPidAlive: () => true });
      const lockB = acquireCheckpointRunLock(checkpointRunLockDir(logDir, '/ws/rootB'), { pid: 456, isPidAlive: () => true });
      expect(lockA.acquired).toBe(true);
      expect(lockB.acquired).toBe(true); // pre-fix this was the hourly 'skipped-locked'
      lockA.release();
      lockB.release();
    });
  });
});

describe('createTerminationSignalHandler (EI-10680: replaceStale relaunched into skipped-locked against the run it just stopped)', () => {
  it('releases (via releaseAndExit) on SIGTERM, so an external "stop this run" deterministically frees the lock', () => {
    const releaseAndExit = vi.fn();
    const log = vi.fn();
    const handler = createTerminationSignalHandler(releaseAndExit, log);
    handler('SIGTERM');
    expect(releaseAndExit).toHaveBeenCalledTimes(1);
    expect(releaseAndExit).toHaveBeenCalledWith(143);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toContain('SIGTERM');
  });

  it('releases on SIGINT too (the same handler is installed for both)', () => {
    const releaseAndExit = vi.fn();
    const handler = createTerminationSignalHandler(releaseAndExit, () => {});
    handler('SIGINT');
    expect(releaseAndExit).toHaveBeenCalledWith(143);
  });

  it('defaults to console.error when no log fn is injected (does not throw)', () => {
    const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const releaseAndExit = vi.fn();
      const handler = createTerminationSignalHandler(releaseAndExit);
      expect(() => handler('SIGTERM')).not.toThrow();
      expect(releaseAndExit).toHaveBeenCalledWith(143);
      expect(consoleErr).toHaveBeenCalledTimes(1);
    } finally {
      consoleErr.mockRestore();
    }
  });
});

describe('armSelfWatchdog (WI-1319 root fix (c) — orphaned OS process past DBOS cancellation)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('keeps the self-watchdog at the 3h long-run floor', () => {
    expect(SELF_WATCHDOG_MS).toBeGreaterThanOrEqual(3 * 60 * 60_000);
  });

  it('does nothing before the deadline', () => {
    const release = vi.fn();
    const kill = vi.fn();
    armSelfWatchdog({ release }, { ms: 1000, kill, pid: 999, log: () => {} });
    vi.advanceTimersByTime(999);
    expect(release).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
  });

  it('releases the lock and SIGKILLs its own process GROUP (negative pid) once the deadline elapses', () => {
    const release = vi.fn();
    const kill = vi.fn();
    armSelfWatchdog({ release }, { ms: 1000, kill, pid: 999, log: () => {} });
    vi.advanceTimersByTime(1000);
    expect(release).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledWith(-999, 'SIGKILL');
  });

  it('runs a SYNC onFire hook before the process-group kill so the watchdog can emit a loud red verdict', () => {
    const release = vi.fn();
    const kill = vi.fn();
    const onFire = vi.fn();
    armSelfWatchdog({ release }, { ms: 1000, kill, pid: 999, log: () => {}, onFire });
    vi.advanceTimersByTime(1000);
    expect(release).toHaveBeenCalledTimes(1);
    expect(onFire).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledWith(-999, 'SIGKILL');
    expect(onFire.mock.invocationCallOrder[0]).toBeLessThan(kill.mock.invocationCallOrder[0]);
  });

  /** WI-4528 (EI-10800 class). The REAL onFire is async — it awaits emitAwaitedEvent for the
   *  `green-checkpoint:red[:<pipeline>]` verdict that agents park on via checkpoint:await. The old
   *  test above (sync vi.fn + invocationCallOrder) only proved onFire was *invoked* before the kill,
   *  which is TRUE of the broken code too: it fire-and-forgot the emit and then SIGKILLed its own
   *  process group on the very next sync line, so the emit never got an event-loop turn and the wake
   *  was lost with certainty. The contract that actually matters is COMPLETION-before-kill. */
  it('WI-4528: AWAITS an async onFire to COMPLETION before the process-group kill (a fire-and-forget red emit is a lost wake)', async () => {
    const order: string[] = [];
    const release = vi.fn();
    const kill = vi.fn((p: number, sig: NodeJS.Signals) => order.push(`kill:${p}:${sig}`));
    armSelfWatchdog(
      { release },
      {
        ms: 1000,
        kill,
        pid: 999,
        log: () => {},
        onFireGraceMs: 5000,
        onFire: async () => {
          order.push('emit:start');
          // a real emitAwaitedEvent is several awaited DB round-trips — the broken code killed
          // the process group long before anything like this could land.
          await Promise.resolve();
          await Promise.resolve();
          order.push('emit:done');
        },
      },
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(order).toEqual(['emit:start', 'emit:done', 'kill:-999:SIGKILL']);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('WI-4528: a WEDGED onFire can never block the guaranteed kill — the grace bounds it', async () => {
    const order: string[] = [];
    const release = vi.fn();
    const kill = vi.fn((p: number, sig: NodeJS.Signals) => order.push(`kill:${p}:${sig}`));
    const log = vi.fn();
    armSelfWatchdog(
      { release },
      {
        ms: 1000,
        kill,
        pid: 999,
        log,
        onFireGraceMs: 5000,
        onFire: () => new Promise<void>(() => order.push('emit:start')), // never settles
      },
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(order).toEqual(['emit:start']); // still hanging — no kill yet
    await vi.advanceTimersByTimeAsync(5000); // grace elapses
    expect(kill).toHaveBeenCalledWith(-999, 'SIGKILL');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('did not settle within 5000ms'));
  });

  it('logs a process-group snapshot before killing a wedged checkpoint run (WI-2957)', () => {
    const release = vi.fn();
    const kill = vi.fn();
    const log = vi.fn();
    const snapshotProcessGroup = vi.fn(() => ' 999 1 999 Sl 58:00 0.0 1.2 vitest run');
    armSelfWatchdog({ release }, { ms: 1000, kill, pid: 999, log, snapshotProcessGroup });
    vi.advanceTimersByTime(1000);
    expect(snapshotProcessGroup).toHaveBeenCalledWith(999);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('self-watchdog process-group snapshot'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('vitest run'));
    expect(kill).toHaveBeenCalledWith(-999, 'SIGKILL');
  });

  it('snapshot failure is diagnostic-only and still kills the process group', () => {
    const release = vi.fn();
    const kill = vi.fn();
    const snapshotProcessGroup = vi.fn(() => {
      throw new Error('ps failed');
    });
    armSelfWatchdog({ release }, { ms: 1000, kill, pid: 999, log: () => {}, snapshotProcessGroup });
    expect(() => vi.advanceTimersByTime(1000)).not.toThrow();
    expect(release).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledWith(-999, 'SIGKILL');
  });

  it('cancel() prevents the watchdog from ever firing (the normal-exit path)', () => {
    const release = vi.fn();
    const kill = vi.fn();
    const watchdog = armSelfWatchdog({ release }, { ms: 1000, kill, pid: 999, log: () => {} });
    watchdog.cancel();
    vi.advanceTimersByTime(10_000);
    expect(release).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
  });

  it('a kill failure (group already gone) does not throw', () => {
    const release = vi.fn();
    const kill = vi.fn(() => {
      throw new Error('ESRCH');
    });
    armSelfWatchdog({ release }, { ms: 1000, kill, pid: 999, log: () => {} });
    expect(() => vi.advanceTimersByTime(1000)).not.toThrow();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('a lock-release failure does not stop the kill from firing', () => {
    const release = vi.fn(() => {
      throw new Error('lock already gone');
    });
    const kill = vi.fn();
    armSelfWatchdog({ release }, { ms: 1000, kill, pid: 999, log: () => {} });
    expect(() => vi.advanceTimersByTime(1000)).not.toThrow();
    expect(kill).toHaveBeenCalledWith(-999, 'SIGKILL');
  });
});

describe('runGreenCheckpoint', () => {
  it('advances ready when the candidate is green', async () => {
    const c1 = await commit('a', '1', 'c1');
    await git(repo, ['branch', 'ready', c1]);
    const c2 = await commit('a', '2', 'c2');
    const { deps, calls } = stubDeps(true);
    const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });
    expect(r).toMatchObject({ advanced: true, candidate: c2, green: true, reason: 'advanced' });
    expect(await revParse(repo, 'ready')).toBe(c2);
    // P-002: a green advance clears any open release-not-green escalation.
    // EI-10800: the `release:green` verdict emit is AWAITED (both keys land in `calls` before
    // runGreenCheckpoint resolves — the stub hops a microtask, so a fire-and-forget emit would
    // record AFTER return and break this exact-order assertion).
    expect(calls).toEqual([
      'setup:' + c2.slice(0, 7),
      'runGreen',
      'advance',
      'broadcast',
      'clearEscalation',
      'emit:release:green',
      `emit:release:green:${pipelineName(repo)}`,
    ]);
  });

  it('EI-13992: an absent ensureMigrationsCurrent (existing stub) never blocks the run — unaffected call order', async () => {
    const c1 = await commit('a', '1', 'c1');
    await git(repo, ['branch', 'ready', c1]);
    const c2 = await commit('a', '2', 'c2');
    const { deps, calls } = stubDeps(true);
    expect(deps.ensureMigrationsCurrent).toBeUndefined();
    const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });
    expect(r).toMatchObject({ advanced: true, green: true });
    expect(calls).not.toContain('ensureMigrationsCurrent');
  });

  it('EI-13992: ensureMigrationsCurrent runs AFTER setupTree and BEFORE runGreen when provided', async () => {
    const c1 = await commit('a', '1', 'c1');
    await git(repo, ['branch', 'ready', c1]);
    const c2 = await commit('a', '2', 'c2');
    const { deps, calls } = stubDeps(true);
    deps.ensureMigrationsCurrent = async () => {
      calls.push('ensureMigrationsCurrent');
      return { applied: 2, failed: [] };
    };
    const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });
    expect(r).toMatchObject({ advanced: true, green: true });
    const setupIdx = calls.indexOf('setup:' + c2.slice(0, 7));
    const migrateIdx = calls.indexOf('ensureMigrationsCurrent');
    const runGreenIdx = calls.indexOf('runGreen');
    expect(setupIdx).toBeGreaterThanOrEqual(0);
    expect(migrateIdx).toBeGreaterThan(setupIdx);
    expect(runGreenIdx).toBeGreaterThan(migrateIdx);
  });

  it('EI-18757975681519069: a preflight that leaves migrations PENDING aborts the run as inconclusive — it never judges against a schema known to be behind', async () => {
    const c1 = await commit('a', '1', 'c1');
    await git(repo, ['branch', 'ready', c1]);
    const c2 = await commit('a', '2', 'c2');
    const { deps, calls } = stubDeps(true); // stub would otherwise report GREEN
    deps.ensureMigrationsCurrent = async () => {
      calls.push('ensureMigrationsCurrent');
      return { applied: 0, failed: [{ file: '680-carry-note-declared-deps.sql', error: 'canceling statement due to lock timeout' }] };
    };
    const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });
    expect(r).toMatchObject({ advanced: false, candidate: c2, green: null, reason: 'migrations-pending' });
    // The load-bearing assertion: the suite is never RUN, so no verdict about the
    // code can be manufactured from a stale schema, and `main` is never advanced
    // on one either. Judging here is what produced the false red + the phantom
    // "ambient host load" diagnosis this fix exists to prevent.
    expect(calls).not.toContain('runGreen');
    expect(calls).not.toContain('advance');
  });

  it('EI-18757975681519069: the abort names the offending migration + its error, so the reason is diagnosable from the log alone', async () => {
    const c1 = await commit('a', '1', 'c1');
    await git(repo, ['branch', 'ready', c1]);
    await commit('a', '2', 'c2');
    const logs: string[] = [];
    const { deps } = stubDeps(true);
    const priorLog = deps.log;
    deps.log = (s: string) => {
      logs.push(s);
      priorLog?.(s);
    };
    deps.ensureMigrationsCurrent = async () => ({
      applied: 0,
      failed: [{ file: '680-carry-note-declared-deps.sql', error: 'canceling statement due to lock timeout' }],
    });
    await runGreenCheckpoint(cfg(), deps, { noPush: true });
    const line = logs.find((l) => l.includes('migration preflight')) ?? '';
    expect(line).toContain('680-carry-note-declared-deps.sql');
    expect(line).toContain('canceling statement due to lock timeout');
    expect(line).toContain('INCONCLUSIVE');
  });

  it('EI-18757975681519069: a preflight reporting applied>0 with NO failures judges normally — the abort is scoped to a known-behind schema', async () => {
    const c1 = await commit('a', '1', 'c1');
    await git(repo, ['branch', 'ready', c1]);
    const c2 = await commit('a', '2', 'c2');
    const { deps, calls } = stubDeps(true);
    deps.ensureMigrationsCurrent = async () => ({ applied: 3, failed: [] });
    const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });
    expect(r).toMatchObject({ advanced: true, candidate: c2, green: true, reason: 'advanced' });
    expect(calls).toContain('runGreen');
  });

  it('EI-13992: a THROWING ensureMigrationsCurrent is swallowed — the gate still runs + judges normally (never blocks on the preflight)', async () => {
    const c1 = await commit('a', '1', 'c1');
    await git(repo, ['branch', 'ready', c1]);
    const c2 = await commit('a', '2', 'c2');
    const { deps, calls } = stubDeps(true);
    deps.ensureMigrationsCurrent = async () => {
      throw new Error('dev PG unreachable');
    };
    const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });
    expect(r).toMatchObject({ advanced: true, candidate: c2, green: true, reason: 'advanced' });
    expect(calls).toContain('runGreen');
    expect(calls).toContain('advance');
  });

  it('EI-18666996942859193: an absent checkTreeDrift (existing stub) never blocks the run — unaffected call order', async () => {
    const c1 = await commit('a', '1', 'c1');
    await git(repo, ['branch', 'ready', c1]);
    const c2 = await commit('a', '2', 'c2');
    const { deps, calls } = stubDeps(true);
    expect(deps.checkTreeDrift).toBeUndefined();
    const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });
    expect(r).toMatchObject({ advanced: true, green: true });
    expect(calls).not.toContain('checkTreeDrift');
  });

  it('EI-18666996942859193: checkTreeDrift runs AFTER setupTree and BEFORE runGreen when provided', async () => {
    const c1 = await commit('a', '1', 'c1');
    await git(repo, ['branch', 'ready', c1]);
    const c2 = await commit('a', '2', 'c2');
    const { deps, calls } = stubDeps(true);
    deps.checkTreeDrift = async () => {
      calls.push('checkTreeDrift');
      return { ok: true, missing: [], extraneous: [], skipped: false };
    };
    const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });
    expect(r).toMatchObject({ advanced: true, green: true });
    const setupIdx = calls.indexOf('setup:' + c2.slice(0, 7));
    const driftIdx = calls.indexOf('checkTreeDrift');
    const runGreenIdx = calls.indexOf('runGreen');
    expect(setupIdx).toBeGreaterThanOrEqual(0);
    expect(driftIdx).toBeGreaterThan(setupIdx);
    expect(runGreenIdx).toBeGreaterThan(driftIdx);
  });

  it('EI-18666996942859193: drift-reported MISSING packages are named in their own log line — diagnostic only, never blocks the advance', async () => {
    const c1 = await commit('a', '1', 'c1');
    await git(repo, ['branch', 'ready', c1]);
    const c2 = await commit('a', '2', 'c2');
    const { deps, calls } = stubDeps(true);
    const lines: string[] = [];
    deps.log = (s) => lines.push(s);
    deps.checkTreeDrift = async () => ({ ok: false, missing: ['ollama', 'groq-sdk'], extraneous: [], skipped: false });
    const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });
    // Diagnostic-only: the run still judges + advances normally on a green suite.
    expect(r).toMatchObject({ advanced: true, green: true });
    expect(calls).toContain('runGreen');
    const driftLine = lines.find((l) => l.includes('tree-drift preflight') && l.includes('MISSING'));
    expect(driftLine).toBeDefined();
    expect(driftLine).toContain('ollama');
    expect(driftLine).toContain('groq-sdk');
  });

  it('EI-18666996942859193: a THROWING checkTreeDrift is swallowed — the gate still runs + judges normally (never blocks on the preflight)', async () => {
    const c1 = await commit('a', '1', 'c1');
    await git(repo, ['branch', 'ready', c1]);
    const c2 = await commit('a', '2', 'c2');
    const { deps, calls } = stubDeps(true);
    deps.checkTreeDrift = async () => {
      throw new Error('lockfile unreadable');
    };
    const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });
    expect(r).toMatchObject({ advanced: true, candidate: c2, green: true, reason: 'advanced' });
    expect(calls).toContain('runGreen');
    expect(calls).toContain('advance');
  });

  it('EI-10800: AWAITS the release:green verdict emit on a green advance (global + pipeline-scoped)', async () => {
    // The bug: the green full-advance emit was a fire-and-forget `void import(...).then(emit)`
    // followed by an immediate return, so the short-lived checkpoint process tore down before
    // the emit ran — `release:green:<pipeline>` fired via `event` 0 times / 87 timeouts in its
    // whole history, while the longer-lived red path fired normally. This asserts the fix: the
    // emit flows through the injectable deps.emitEvent seam AND is awaited before return.
    const c1 = await commit('a', '1', 'c1');
    await git(repo, ['branch', 'ready', c1]);
    await commit('a', '2', 'c2');
    const { deps, calls } = stubDeps(true);
    await runGreenCheckpoint(cfg(), deps, { noPush: true });
    // Recorded by the time the promise resolves ⇒ it was awaited, not fire-and-forget.
    expect(calls).toContain('emit:release:green'); // global key (back-compat)
    expect(calls).toContain(`emit:release:green:${pipelineName(repo)}`); // pipeline-scoped (EI-7646)
  });

  it('WI-4957: green-path verdict (result + event payloads) carries this run\'s runId', async () => {
    const c1 = await commit('a', '1', 'c1');
    await git(repo, ['branch', 'ready', c1]);
    await commit('a', '2', 'c2');
    const payloads: Record<string, { runId?: string | null }> = {};
    const deps: CheckpointDeps = {
      setupTree: async () => {},
      runGreen: async () => ({ green: true, summary: 'all pass' }),
      advance: (candidate) => advanceReady(repo, candidate, 'ready'),
      push: async () => {},
      broadcast: async () => {},
      escalate: async () => {},
      clearEscalation: async () => {},
      emitEvent: async ({ key, payload }) => {
        payloads[key] = payload as { runId?: string | null };
      },
      log: () => {},
      runId: 'run-green-1',
    };
    const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });
    expect(r.runId).toBe('run-green-1');
    expect(payloads['release:green']?.runId).toBe('run-green-1');
    expect(payloads[`release:green:${pipelineName(repo)}`]?.runId).toBe('run-green-1');
  });

  it('WI-4957: red-path verdict (result + event payloads) carries runId, the FULL failingTests array, and logPath', async () => {
    const c1 = await commit('a', '1', 'c1');
    await git(repo, ['branch', 'ready', c1]);
    await commit('a', '2', 'c2');
    const payloads: Record<string, { runId?: string | null; failingTests?: string[]; logPath?: string | null }> = {};
    const deps: CheckpointDeps = {
      setupTree: async () => {},
      runGreen: async () => ({
        green: false,
        summary: '3 failed',
        failingTests: ['a.test.ts', 'b.test.ts', 'c.test.ts'],
        logPath: '/tmp/fake-checkpoint-run.log',
      }),
      advance: (candidate) => advanceReady(repo, candidate, 'ready'),
      push: async () => {},
      broadcast: async () => {},
      escalate: async () => {},
      clearEscalation: async () => {},
      emitEvent: async ({ key, payload }) => {
        payloads[key] = payload as { runId?: string | null; failingTests?: string[]; logPath?: string | null };
      },
      log: () => {},
      runId: 'run-red-1',
    };
    const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });
    expect(r.runId).toBe('run-red-1');
    expect(r.logPath).toBe('/tmp/fake-checkpoint-run.log');
    const p = payloads['green-checkpoint:red'];
    expect(p?.runId).toBe('run-red-1');
    expect(p?.logPath).toBe('/tmp/fake-checkpoint-run.log');
    expect(p?.failingTests).toEqual(['a.test.ts', 'b.test.ts', 'c.test.ts']);
  });

  it('holds ready when the candidate is NOT green', async () => {
    const c1 = await commit('a', '1', 'c1');
    await git(repo, ['branch', 'ready', c1]);
    const c2 = await commit('a', '2', 'c2');
    const { deps, calls } = stubDeps(false);
    const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });
    expect(r).toMatchObject({ advanced: false, green: false, reason: 'not-green' });
    expect(await revParse(repo, 'ready')).toBe(c1); // unchanged
    expect(calls).not.toContain('advance');
    // P-002: a held gate opens a durable human-facing escalation.
    expect(calls).toContain('escalate');
  });

  it('EI-6542: flags a failing test file that already changed since the candidate was cut', async () => {
    const c1 = await commit('a', '1', 'c1');
    await git(repo, ['branch', 'ready', c1]);
    const c2 = await commit('a', '2', 'c2'); // the (stale-by-the-time-the-suite-finishes) candidate
    await commit('src/failing.test.ts', 'fixed', 'c3 — fixes the failing test, landed after the candidate was cut');
    const { deps } = stubDeps(false, ['src/failing.test.ts']);
    const messages: string[] = [];
    deps.broadcast = async (_s: string, body?: string) => { messages.push(body ?? ''); };
    const r = await runGreenCheckpoint(cfg(), deps, { candidate: c2, noPush: true });
    expect(r.reason).toBe('not-green');
    expect(messages.some((m) => m.includes('already changed since candidate') && m.includes('src/failing.test.ts'))).toBe(true);
  });

  it('EI-6542: no already-fixed-since note when the failing file was NOT touched after the candidate', async () => {
    const c1 = await commit('a', '1', 'c1');
    await git(repo, ['branch', 'ready', c1]);
    const c2 = await commit('a', '2', 'c2');
    await commit('other-file.ts', 'unrelated', 'c3 — unrelated change, does not touch the failing file');
    const { deps } = stubDeps(false, ['src/failing.test.ts']);
    const messages: string[] = [];
    deps.broadcast = async (_s: string, body?: string) => { messages.push(body ?? ''); };
    const r = await runGreenCheckpoint(cfg(), deps, { candidate: c2, noPush: true });
    expect(r.reason).toBe('not-green');
    expect(messages.some((m) => m.includes('already changed since candidate'))).toBe(false);
  });

  // EI-18685041726970077 — owner-flagged highest-leverage fix: every not-green verdict
  // carries an inline one-line LINEAGE (candidate sha, commits behind tip, whether the
  // failing files were touched in that range) so a stale-candidate red is distinguishable
  // from a real break without manual git archaeology.
  describe('EI-18685041726970077: gate verdict lineage', () => {
    it('formatGateLineageLine: candidate IS the tip — nothing newer to blame', () => {
      const lineage: GateLineage = { candidate: 'a'.repeat(40), tip: 'a'.repeat(40), commitsBehind: 0, failingFilesChangedInRange: [] };
      const line = formatGateLineageLine(lineage);
      expect(line).toContain('📍 lineage:');
      expect(line).toContain('IS the current tip');
      expect(line).toContain('real red');
    });

    it('formatGateLineageLine: commits behind, no failing files touched in range — presumptively real', () => {
      const lineage: GateLineage = {
        candidate: 'c'.repeat(40),
        tip: 't'.repeat(40),
        commitsBehind: 4,
        failingFilesChangedInRange: [],
      };
      const line = formatGateLineageLine(lineage);
      expect(line).toContain('4 commit(s) behind tip');
      expect(line).toContain('none of the failing files were modified');
      expect(line).toContain('presumptively a real red');
    });

    it('formatGateLineageLine: commits behind, failing files touched in range — presumptively stale', () => {
      const lineage: GateLineage = {
        candidate: 'c'.repeat(40),
        tip: 't'.repeat(40),
        commitsBehind: 7,
        failingFilesChangedInRange: ['src/a.test.ts', 'src/b.test.ts'],
      };
      const line = formatGateLineageLine(lineage);
      expect(line).toContain('7 commit(s) behind tip');
      expect(line).toContain('2 of the failing file(s) were MODIFIED in that range');
      expect(line).toContain('presumptively STALE');
      expect(line).toContain('src/a.test.ts');
      expect(line).toContain('src/b.test.ts');
    });

    it('computeGateLineage: counts commits behind tip and names failing files touched in range', async () => {
      const c1 = await commit('a', '1', 'c1');
      await git(repo, ['branch', 'ready', c1]);
      const candidate = await commit('a', '2', 'c2 — the candidate');
      await commit('src/failing.test.ts', 'fixed', 'c3');
      await commit('other.ts', 'x', 'c4');
      const tip = await commit('other.ts', 'y', 'c5');
      const lineage = await computeGateLineage(repo, 'main', candidate, ['src/failing.test.ts']);
      expect(lineage).not.toBeNull();
      expect(lineage!.tip).toBe(tip);
      expect(lineage!.commitsBehind).toBe(3); // c3, c4, c5
      expect(lineage!.failingFilesChangedInRange).toEqual(['src/failing.test.ts']);
    });

    it('computeGateLineage: candidate IS the tip', async () => {
      const c1 = await commit('a', '1', 'c1');
      await git(repo, ['branch', 'ready', c1]);
      const candidate = await commit('a', '2', 'c2');
      const lineage = await computeGateLineage(repo, 'main', candidate, ['src/failing.test.ts']);
      expect(lineage).toEqual({ candidate, tip: candidate, commitsBehind: 0, failingFilesChangedInRange: [] });
    });

    it('runGreenCheckpoint: not-green verdict carries the lineage line in the broadcast body + the structured result', async () => {
      const c1 = await commit('a', '1', 'c1');
      await git(repo, ['branch', 'ready', c1]);
      const candidate = await commit('a', '2', 'c2 — the (stale-by-verdict-time) candidate');
      await commit('src/failing.test.ts', 'fixed', 'c3 — fixes it, landed after the candidate was cut');
      const { deps } = stubDeps(false, ['src/failing.test.ts']);
      const messages: string[] = [];
      deps.broadcast = async (_s: string, body?: string) => { messages.push(body ?? ''); };
      const r = await runGreenCheckpoint(cfg(), deps, { candidate, noPush: true });
      expect(r.reason).toBe('not-green');
      expect(r.lineage).toMatchObject({ candidate, commitsBehind: 1, failingFilesChangedInRange: ['src/failing.test.ts'] });
      expect(messages.some((m) => m.includes('📍 lineage:') && m.includes('1 commit(s) behind tip') && m.includes('presumptively STALE'))).toBe(true);
    });
  });

  // EI-10615 — the stale-red rescue must run BEFORE the partial-green prefix salvage.
  //
  // The bug these pin: the two ran in the OPPOSITE order, which made the rescue dead code
  // on a fast-moving fleet. The gate went red, entered the prefix salvage's CONFIRM run (a
  // SECOND full suite, tens of minutes), and was superseded/killed before execution ever
  // reached the re-triage. Seven consecutive gate runs ended their log on the partial-green
  // "confirming longest clean prefix …" line with nothing after it; every one of those reds
  // PASSED at tip (the last was disproved in 559ms). `main` sat 143 commits behind for ~9h
  // with nothing actually broken, so nothing the fleet fixed that day ever reached :3070.
  //
  // These assert ORDER + SKIP, not just the pure classifier — a pure-classifier test passes
  // happily while the caller never invokes it, which is exactly what happened.
  describe('EI-10615: stale-red re-triage precedes the partial-green prefix salvage', () => {
    /** Wires BOTH paths as eligible, so ordering is the only thing under test. */
    function bothPathsWired(opts: { passesAtTip: boolean }) {
      const calls: string[] = [];
      const { deps } = stubDeps(false, ['@papercusp/web']);
      let greenRuns = 0;
      deps.runGreen = async () => {
        calls.push('runGreen');
        greenRuns += 1;
        return {
          green: false,
          summary: '1 failed',
          failingTests: ['@papercusp/web'],
          failingFiles: [{ file: 'src/failing.test.ts', workspace: '@papercusp/web' }],
        };
      };
      // The re-triage is gated on a tip NEWER than the candidate — without resolveTip it
      // never runs at all (tip=null), which is precisely how it stayed silently dead.
      deps.resolveTip = async () => revParse(repo, 'HEAD');
      deps.runTestsAtRef = async () => {
        calls.push('runTestsAtRef');
        return { pass: opts.passesAtTip, summary: opts.passesAtTip ? 'pass at tip' : 'still red at tip' };
      };
      // The prefix salvage's inputs — present and eligible. If it is ever ATTEMPTED,
      // commitsInRange is the first thing it calls, so it cannot run without leaving a mark.
      deps.commitsInRange = async () => {
        calls.push('commitsInRange');
        return [];
      };
      deps.affectedWorkspacesForRange = async () => {
        calls.push('affectedWorkspacesForRange');
        return ['@papercusp/web'];
      };
      return { deps, calls, greenRuns: () => greenRuns };
    }

    it('a STALE red with the refire cap spent still does not salvage from its phantom signature', async () => {
      // Cap 0 ⇒ no refire, so the run walks PAST the re-triage — the exact path where the
      // old code would hand a phantom failure signature to the prefix salvage and spend a
      // second full suite under-advancing `main` around a failure that does not exist.
      vi.stubEnv('PAPERCUSP_GATE_AUTO_REFIRE_CAP', '0');
      const c1 = await commit('a', '1', 'c1');
      await git(repo, ['branch', 'ready', c1]);
      const c2 = await commit('a', '2', 'c2'); // the candidate the quiet-cut judges
      await commit('src/failing.test.ts', 'fixed', 'c3 — the fix, landed after the cut');
      const { deps, calls } = bothPathsWired({ passesAtTip: true });

      await runGreenCheckpoint(cfg(), deps, { candidate: c2, noPush: true });

      expect(calls).toContain('runTestsAtRef'); // the rescue ran (cheap)...
      expect(calls).not.toContain('commitsInRange'); // ...and the salvage was never ATTEMPTED
      vi.unstubAllEnvs();
    });

    it('a tip re-run that fails to EXECUTE is unknown — never a false "REPRODUCE at tip"', async () => {
      // A tree-setup/exec failure is ABSENCE of evidence, not evidence the failures
      // reproduce. realCheckpointDeps.runTestsAtRef used to swallow a setupTree throw
      // and return {pass:false}, which classifyRedAgainstTip reads as tipRetest.ran ⇒
      // "failures REPRODUCE at tip <sha> — genuine red, holding the gate" — a confident
      // claim about a tip that was never run. It must reach the 'unknown' branch instead:
      // same held gate, honest reason. (WI-5110.)
      const c1 = await commit('a', '1', 'c1');
      await git(repo, ['branch', 'ready', c1]);
      const c2 = await commit('a', '2', 'c2');
      await commit('src/failing.test.ts', 'fixed', 'c3 — the fix, landed after the cut');
      const { deps } = bothPathsWired({ passesAtTip: true });
      deps.runTestsAtRef = async () => {
        throw new Error('tip tree setup failed');
      };

      const r = await runGreenCheckpoint(cfg(), deps, { candidate: c2, noPush: true });

      expect(r.retriage).toMatchObject({ classification: 'unknown', autoRefire: false });
      expect(r.retriage?.detail ?? '').not.toMatch(/REPRODUCE/i);
      expect(r.advanced).toBe(false); // still holds the gate — only the REASON changes
    });

    it('a STALE red REFIRES on the tip and can advance — the rescue that seven gate runs never reached', async () => {
      const c1 = await commit('a', '1', 'c1');
      await git(repo, ['branch', 'ready', c1]);
      const c2 = await commit('a', '2', 'c2');
      const c3 = await commit('src/failing.test.ts', 'fixed', 'c3 — the fix');
      const { deps, calls } = bothPathsWired({ passesAtTip: true });
      // The candidate is red; the TIP is green (the peer fix landed after the cut).
      let run = 0;
      deps.runGreen = async () => {
        calls.push('runGreen');
        run += 1;
        return run === 1
          ? {
              green: false,
              summary: '1 failed',
              failingTests: ['@papercusp/web'],
              failingFiles: [{ file: 'src/failing.test.ts', workspace: '@papercusp/web' }],
            }
          : { green: true, summary: 'all pass' };
      };

      const r = await runGreenCheckpoint(cfg(), deps, { candidate: c2, noPush: true });

      expect(calls).toContain('runTestsAtRef');
      expect(r.green).toBe(true);
      expect(r.advanced).toBe(true);
      expect(r.candidate).toBe(c3); // advanced to the TIP, not held on the stale red
    });

    it('the cheap tip re-triage runs BEFORE any prefix-salvage work', async () => {
      const c1 = await commit('a', '1', 'c1');
      await git(repo, ['branch', 'ready', c1]);
      const c2 = await commit('a', '2', 'c2');
      await commit('src/failing.test.ts', 'fixed', 'c3');
      const { deps, calls } = bothPathsWired({ passesAtTip: true });

      await runGreenCheckpoint(cfg(), deps, { candidate: c2, noPush: true });

      const triaged = calls.indexOf('runTestsAtRef');
      const salvaged = calls.indexOf('commitsInRange');
      expect(triaged).toBeGreaterThanOrEqual(0);
      // -1 (never) is the correct outcome here; the point is it must NEVER precede triage.
      if (salvaged >= 0) expect(triaged).toBeLessThan(salvaged);
    });

    it('a REAL red (reproduces at tip) still gets the prefix salvage — P-016 is not regressed', async () => {
      const c1 = await commit('a', '1', 'c1');
      await git(repo, ['branch', 'ready', c1]);
      const c2 = await commit('a', '2', 'c2');
      await commit('unrelated.ts', 'x', 'c3');
      const { deps, calls } = bothPathsWired({ passesAtTip: false });

      await runGreenCheckpoint(cfg(), deps, { candidate: c2, noPush: true });

      expect(calls).toContain('runTestsAtRef'); // triaged first...
      expect(calls).toContain('commitsInRange'); // ...then genuinely salvaged
      expect(calls.indexOf('runTestsAtRef')).toBeLessThan(calls.indexOf('commitsInRange'));
    });
  });

  // EI-18759362119598634: a LINT/TYPECHECK red never populates `failingFiles` (that list
  // is test-FILE-only), so it used to fall straight past the whole re-triage above with
  // nothing to re-run — a lint fixed 90s after the quiet-cut still held the gate red
  // forever. These pin the sibling rescue: `runGateAtRef` re-verifies the named gate
  // script(s) directly, the same stale-vs-real classification + auto-refire the
  // file-based rescue already gets.
  describe('EI-18759362119598634: gate-only (lint/typecheck) stale-red re-triage', () => {
    function gatePathWired(opts: { passesAtTip: boolean }) {
      const calls: string[] = [];
      const { deps } = stubDeps(false, ['lint:identity-leak']); // no failingFiles ⇒ gate-only red
      deps.resolveTip = async () => revParse(repo, 'HEAD');
      deps.runGateAtRef = async (_ref, gateIds) => {
        calls.push('runGateAtRef');
        return { pass: opts.passesAtTip, summary: opts.passesAtTip ? `${gateIds.join(',')}: pass at tip` : `${gateIds.join(',')}: FAIL at tip` };
      };
      deps.commitsInRange = async () => {
        calls.push('commitsInRange');
        return [];
      };
      deps.affectedWorkspacesForRange = async () => {
        calls.push('affectedWorkspacesForRange');
        return ['@papercusp/web'];
      };
      return { deps, calls };
    }

    it('a STALE gate red (the lint fix already landed at tip) REFIRES and can advance', async () => {
      const c1 = await commit('a', '1', 'c1');
      await git(repo, ['branch', 'ready', c1]);
      const c2 = await commit('a', '2', 'c2'); // the candidate the quiet-cut judges — still has the leak
      const c3 = await commit('b', '2', 'c3 — fixes the identity-leak lint'); // tip: already fixed
      const { deps, calls } = gatePathWired({ passesAtTip: true });
      let run = 0;
      deps.runGreen = async () => {
        calls.push('runGreen');
        run += 1;
        return run === 1
          ? { green: false, summary: '1 failed', failingTests: ['lint:identity-leak'] } // no failingFiles
          : { green: true, summary: 'all pass' };
      };

      const r = await runGreenCheckpoint(cfg(), deps, { candidate: c2, noPush: true });

      expect(calls).toContain('runGateAtRef');
      expect(r.green).toBe(true);
      expect(r.advanced).toBe(true);
      expect(r.candidate).toBe(c3); // advanced to the TIP, not held on the stale lint red
    });

    it('a REAL gate red (still fails at tip) holds the gate and still gets the prefix salvage', async () => {
      const c1 = await commit('a', '1', 'c1');
      await git(repo, ['branch', 'ready', c1]);
      const c2 = await commit('a', '2', 'c2');
      await commit('unrelated.ts', 'x', 'c3');
      const { deps, calls } = gatePathWired({ passesAtTip: false });

      const r = await runGreenCheckpoint(cfg(), deps, { candidate: c2, noPush: true });

      expect(calls).toContain('runGateAtRef'); // triaged...
      expect(r.retriage).toMatchObject({ classification: 'real-red', autoRefire: false });
      expect(r.advanced).toBe(false);
      expect(calls).toContain('commitsInRange'); // ...then genuinely salvaged, same as a real test red
    });

    it('a mixed red (a failing test file ALONGSIDE a gate id) goes through the FILE-based rescue, not the gate one', async () => {
      // failingFiles is non-empty here, so the existing file rescue applies unchanged;
      // the gate path must not also fire (it would double-rescue the same red).
      const c1 = await commit('a', '1', 'c1');
      await git(repo, ['branch', 'ready', c1]);
      const c2 = await commit('a', '2', 'c2');
      await commit('unrelated.ts', 'x', 'c3'); // tip strictly newer than the judged candidate
      const calls: string[] = [];
      const { deps } = stubDeps(false, ['@papercusp/web', 'lint:identity-leak']);
      deps.runGreen = async () => ({
        green: false,
        summary: '1 failed + 1 lint',
        failingTests: ['@papercusp/web', 'lint:identity-leak'],
        failingFiles: [{ file: 'src/failing.test.ts', workspace: '@papercusp/web' }],
      });
      deps.resolveTip = async () => revParse(repo, 'HEAD');
      deps.runTestsAtRef = async () => {
        calls.push('runTestsAtRef');
        return { pass: false, summary: 'still red at tip' };
      };
      deps.runGateAtRef = async () => {
        calls.push('runGateAtRef');
        return { pass: true, summary: 'pass at tip' };
      };

      await runGreenCheckpoint(cfg(), deps, { candidate: c2, noPush: true });

      expect(calls).toContain('runTestsAtRef');
      expect(calls).not.toContain('runGateAtRef');
    });

    it('absent runGateAtRef (existing stub) never rescues a gate-only red — today\'s plain-red behaviour preserved', async () => {
      const c1 = await commit('a', '1', 'c1');
      await git(repo, ['branch', 'ready', c1]);
      const c2 = await commit('a', '2', 'c2');
      await commit('unrelated.ts', 'x', 'c3'); // tip strictly newer — the rescue WOULD be eligible
      const { deps } = stubDeps(false, ['lint:identity-leak']);
      deps.resolveTip = async () => revParse(repo, 'HEAD');
      expect(deps.runGateAtRef).toBeUndefined();

      const r = await runGreenCheckpoint(cfg(), deps, { candidate: c2, noPush: true });

      expect(r.advanced).toBe(false);
      expect(r.retriage).toBeUndefined();
    });

    it('an unmapped/unknown signature (not in NON_TEST_GATE_SCRIPTS) is never guessed at — no gate rescue attempted', async () => {
      const c1 = await commit('a', '1', 'c1');
      await git(repo, ['branch', 'ready', c1]);
      const c2 = await commit('a', '2', 'c2');
      await commit('unrelated.ts', 'x', 'c3'); // tip strictly newer — the rescue WOULD be eligible
      const calls: string[] = [];
      // '@papercusp/operator-vite' (a build break) is deliberately NOT in NON_TEST_GATE_SCRIPTS.
      const { deps } = stubDeps(false, ['@papercusp/operator-vite']);
      deps.resolveTip = async () => revParse(repo, 'HEAD');
      deps.runGateAtRef = async () => {
        calls.push('runGateAtRef');
        return { pass: true, summary: 'pass at tip' };
      };

      await runGreenCheckpoint(cfg(), deps, { candidate: c2, noPush: true });

      expect(calls).not.toContain('runGateAtRef');
    });
  });

  describe('nonTestGateIdsFrom (EI-18759362119598634, pure)', () => {
    it('returns the ids when every failingTests entry is a known non-test gate signature', () => {
      expect(nonTestGateIdsFrom(['lint:identity-leak'])).toEqual(['lint:identity-leak']);
      expect(nonTestGateIdsFrom(['lint:tsc', 'lint:design-primitives'])).toEqual(['lint:tsc', 'lint:design-primitives']);
    });

    it('returns [] for an empty/undefined list — nothing to do', () => {
      expect(nonTestGateIdsFrom(undefined)).toEqual([]);
      expect(nonTestGateIdsFrom([])).toEqual([]);
    });

    it('returns [] when ANY entry is not a known gate id (a test file/workspace, or an unmapped signature)', () => {
      expect(nonTestGateIdsFrom(['@papercusp/web'])).toEqual([]);
      expect(nonTestGateIdsFrom(['lint:identity-leak', '@papercusp/web'])).toEqual([]);
      expect(nonTestGateIdsFrom(['@papercusp/operator-vite'])).toEqual([]);
      expect(nonTestGateIdsFrom(['package.json-unreadable'])).toEqual([]);
    });
  });

  describe('agent-state-plane standing probes are GATED (P-020)', () => {
    /* The predecessor plane shipped 8 defects past a green unit gate. This plan built four
     * probes for that class and every one was an ORPHANED npm script — a repo-wide grep
     * found zero references outside comments. These tests exist so that cannot recur
     * silently: the wiring itself is now asserted, including its own vacuous pass. */

    it('lint:plane-integrity is a recognised gate signature, so a plane red auto-refires like any other lint red', () => {
      expect(nonTestGateIdsFrom(['lint:plane-integrity'])).toEqual(['lint:plane-integrity']);
      expect(nonTestGateIdsFrom(['lint:tsc', 'lint:plane-integrity'])).toEqual(['lint:tsc', 'lint:plane-integrity']);
    });

    it('maps to exactly the five plane probes — 4 lints plus the Phase 3 guard mutation tests', () => {
      expect(NON_TEST_GATE_SCRIPTS['lint:plane-integrity']).toEqual([
        'lint:plane-producers',
        'lint:declared-consumed',
        'lint:no-bespoke-state-read',
        'lint:plane-ratchet',
        'lint:plane-guards',
      ]);
    });

    /* ⛔ THE FLEET-SAFETY ASSERTION. check-cell-live-matrix.ts's own header says "THIS MUST
     * NOT BE ADDED TO THE CI LINT JOB": it drives reads against RUNNING operators on :3170
     * and :3070, which the isolated checkpoint tree does not have. Adding it would fail every
     * read and red-pin `main` for the entire fleet. It is the natural fifth member of this
     * group, so the mistake is an easy one — pin it shut. */
    it('NEVER gates lint:cell-matrix — it needs running operators the checkpoint tree does not have', () => {
      for (const [signature, scripts] of Object.entries(NON_TEST_GATE_SCRIPTS)) {
        expect(scripts, `${signature} must not gate the live cell matrix`).not.toContain('lint:cell-matrix');
      }
    });

    /* THE VACUOUS PASS this wiring can have: the leg resolves each script with checkNpmScript
     * and SKIPS an 'absent' one (the documented subject-hive opt-out). So if a script is
     * renamed or dropped, the leg keeps reporting green while silently checking nothing —
     * which is precisely the "goes quiet instead of redding the gate" failure P-020 exists to
     * stop, reintroduced one level up. Assert every gated script really exists at the root. */
    it('every gated script exists in the root package.json — a rename must break HERE, not go quiet', async () => {
      const { readFileSync } = await import('node:fs');
      const { fileURLToPath } = await import('node:url');
      // Resolve from THIS file (apps/operator/lib/release/…), not process.cwd() — the router
      // runs each file from its owning workspace, but a root-level invocation must not make
      // this assertion silently read the wrong package.json.
      const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..');
      const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
        scripts?: Record<string, string>;
      };
      const declared = pkg.scripts ?? {};
      for (const script of NON_TEST_GATE_SCRIPTS['lint:plane-integrity']) {
        expect(declared[script], `root package.json must declare "${script}"`).toBeTruthy();
      }
    });
  });

  describe('historicalFlakeAnnotations (WI-2997, pure)', () => {
    it('renders a line per failing file that has historical stats, flagging known suspects', () => {
      const note = historicalFlakeAnnotations(
        {
          'src/a.test.ts': { fails: 12, passes: 3, bothStatusShas: 4, isSuspect: true },
          'src/b.test.ts': { fails: 1, passes: 0, bothStatusShas: 0, isSuspect: false },
        },
        ['src/a.test.ts', 'src/b.test.ts'],
      );
      expect(note).toContain('7d historical flake stats');
      expect(note).toContain('src/a.test.ts: 12 fail(s) / 3 pass(es) over 7d — ⚠️ known flake-suspect');
      expect(note).toContain('src/b.test.ts: 1 fail(s) / 0 pass(es) over 7d');
      expect(note.split('src/b.test.ts')[1]).not.toContain('known flake-suspect');
    });

    it('omits files with no historical record — never invents a zero-stat line', () => {
      const note = historicalFlakeAnnotations(
        { 'src/a.test.ts': { fails: 5, passes: 2, bothStatusShas: 2, isSuspect: true } },
        ['src/a.test.ts', 'src/never-seen-before.test.ts'],
      );
      expect(note).toContain('src/a.test.ts');
      expect(note).not.toContain('never-seen-before');
    });

    it('returns empty string when nothing in `files` has a historical record', () => {
      expect(historicalFlakeAnnotations({}, ['src/a.test.ts'])).toBe('');
    });
  });

  it('WI-2997: threads the historical-flake annotation into the not-green broadcast + escalate', async () => {
    const c1 = await commit('a', '1', 'c1');
    await git(repo, ['branch', 'ready', c1]);
    await commit('a', '2', 'c2');
    const { deps } = stubDeps(false, ['src/flaky.test.ts']);
    deps.flakeLookup = async (files) => {
      expect(files).toEqual(['src/flaky.test.ts']);
      return { 'src/flaky.test.ts': { fails: 8, passes: 2, bothStatusShas: 3, isSuspect: true } };
    };
    const broadcasts: string[] = [];
    const escalations: string[] = [];
    deps.broadcast = async (_s: string, body?: string) => { broadcasts.push(body ?? ''); };
    deps.escalate = async (_s: string, body: string) => { escalations.push(body); };
    const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });
    expect(r.reason).toBe('not-green');
    expect(broadcasts.some((m) => m.includes('7d historical flake stats') && m.includes('src/flaky.test.ts'))).toBe(true);
    expect(escalations.some((m) => m.includes('7d historical flake stats') && m.includes('src/flaky.test.ts'))).toBe(true);
  });

  it('WI-2997: no flakeLookup wired (existing stubs) → no annotation, no throw', async () => {
    const c1 = await commit('a', '1', 'c1');
    await git(repo, ['branch', 'ready', c1]);
    await commit('a', '2', 'c2');
    const { deps } = stubDeps(false, ['src/flaky.test.ts']); // stubDeps never sets flakeLookup
    const broadcasts: string[] = [];
    deps.broadcast = async (_s: string, body?: string) => { broadcasts.push(body ?? ''); };
    const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });
    expect(r.reason).toBe('not-green');
    expect(broadcasts.some((m) => m.includes('historical flake'))).toBe(false);
  });

  it('WI-2997: a throwing flakeLookup is swallowed — the red path still completes, no annotation', async () => {
    const c1 = await commit('a', '1', 'c1');
    await git(repo, ['branch', 'ready', c1]);
    await commit('a', '2', 'c2');
    const { deps } = stubDeps(false, ['src/flaky.test.ts']);
    deps.flakeLookup = async () => { throw new Error('pg unreachable'); };
    const broadcasts: string[] = [];
    deps.broadcast = async (_s: string, body?: string) => { broadcasts.push(body ?? ''); };
    const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });
    expect(r.reason).toBe('not-green');
    expect(broadcasts.some((m) => m.includes('historical flake'))).toBe(false);
  });

  it('docs-audit #2: re-broadcasts a rising-urgency alert when the gate has been held >2h', async () => {
    const c1 = await commit('a', '1', 'c1');
    await git(repo, ['branch', 'ready', c1]);
    await commit('a', '2', 'c2');
    const { deps } = stubDeps(false);
    const messages: string[] = [];
    deps.broadcast = async (s: string) => { messages.push(s); };
    deps.heldGateMs = async () => 4 * 60 * 60 * 1000; // held 4h (the 2026-06-23 incident)
    const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });
    expect(r.reason).toBe('not-green');
    // The standard red broadcast PLUS a louder URGENT alert naming the held duration.
    expect(messages.some((m) => m.includes('URGENT') && m.includes('held 4h'))).toBe(true);
  });

  it('docs-audit #2: no louder alert within the first 2h (fresh hold ⇒ heldGateMs null/small)', async () => {
    const c1 = await commit('a', '1', 'c1');
    await git(repo, ['branch', 'ready', c1]);
    await commit('a', '2', 'c2');
    const { deps } = stubDeps(false);
    const messages: string[] = [];
    deps.broadcast = async (s: string) => { messages.push(s); };
    deps.heldGateMs = async () => null; // first red — escalation just opened, no age yet
    await runGreenCheckpoint(cfg(), deps, { noPush: true });
    expect(messages.some((m) => /HELD|URGENT|CRITICAL/.test(m))).toBe(false);
  });

  it('is a no-op when ready already at integration HEAD', async () => {
    const c1 = await commit('a', '1', 'c1');
    await git(repo, ['branch', 'ready', c1]);
    const { deps, calls } = stubDeps(true);
    const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });
    expect(r.reason).toBe('up-to-date');
    expect(calls).toEqual([]); // didn't even build the tree
  });

  it('refuses a non-fast-forward candidate', async () => {
    const c1 = await commit('a', '1', 'c1');
    const cFeat = await commit('a', 'feat', 'feat');
    await git(repo, ['branch', 'ready', cFeat]); // ready ahead on a feature line
    await git(repo, ['reset', '--hard', c1]);
    const cDiv = await commit('b', 'div', 'div'); // main diverged
    const { deps } = stubDeps(true);
    const r = await runGreenCheckpoint(cfg(), deps, { candidate: cDiv, noPush: true });
    expect(r.reason).toBe('not-fast-forward');
    expect(await revParse(repo, 'ready')).toBe(cFeat); // unchanged
  });

  it('P-012: threads the failure signature (failingTests) into the not-green result', async () => {
    const c1 = await commit('a', '1', 'c1');
    await git(repo, ['branch', 'ready', c1]);
    await commit('a', '2', 'c2');
    const { deps } = stubDeps(false, ['@papercusp/operator-core', 'lib/fleet/operator-spawn.test.ts']);
    const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });
    expect(r.reason).toBe('not-green');
    // the signature flows out so the release-fixer can dedup by FAILURE, not candidate sha
    expect(r.failingTests).toEqual(['@papercusp/operator-core', 'lib/fleet/operator-spawn.test.ts']);
  });

  // load-flake-isolation-2026-06-23: when runGreen reports green=true with flakeSuspects
  // (the suite went red under load but every file passed in isolation), the gate ADVANCES
  // and surfaces the absorbed files in the green broadcast — the whole fleet's gate isn't
  // held by box-weather, but the flake is on record (drives the P-009 quarantine nudge).
  it('load-flake: a flake-absorbed green advances and surfaces flakeSuspects', async () => {
    const c1 = await commit('a', '1', 'c1');
    await git(repo, ['branch', 'ready', c1]);
    const c2 = await commit('a', '2', 'c2');
    const suspects = ['@papercusp/operator-core::lib/llm-testing/__tests__/runner-aggregate.test.ts'];
    const { deps, calls } = stubDeps(true, undefined, suspects);
    const bodies: string[] = [];
    deps.broadcast = async (_s: string, body?: string) => {
      calls.push('broadcast');
      if (body) bodies.push(body);
    };
    const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });
    expect(r).toMatchObject({ advanced: true, green: true, reason: 'advanced' });
    expect(r.flakeSuspects).toEqual(suspects);
    expect(await revParse(repo, 'ready')).toBe(c2); // advanced despite the initial (absorbed) red
    expect(calls).toContain('advance');
    // the green broadcast names the absorbed flake so the advance is auditable
    expect(bodies.some((b) => b.includes('Load-flake absorbed') && b.includes('runner-aggregate.test.ts'))).toBe(true);
  });

  // F2 (round-4 P-031): the perf-regression gate runs post-runGreen / pre-advance.
  it('F2: a perf BLOCK holds the green pin even when the candidate is green', async () => {
    const c1 = await commit('a', '1', 'c1');
    await git(repo, ['branch', 'ready', c1]);
    await commit('a', '2', 'c2');
    const { deps, calls } = stubDeps(true);
    deps.perfGate = async (candidate) => {
      calls.push('perfGate');
      return { action: 'block', summary: `perf BLOCK ${candidate.slice(0, 7)}` };
    };
    const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });
    expect(r).toMatchObject({ advanced: false, green: true, reason: 'perf-held' });
    expect(await revParse(repo, 'ready')).toBe(c1); // pin NOT advanced
    expect(calls).toContain('perfGate');
    expect(calls).not.toContain('advance'); // blocked before advance
    expect(calls).toContain('escalate'); // a perf block opens a durable escalation
  });

  it('F2: a perf WARN surfaces (broadcast) but still advances — default-warn', async () => {
    const c1 = await commit('a', '1', 'c1');
    await git(repo, ['branch', 'ready', c1]);
    const c2 = await commit('a', '2', 'c2');
    const { deps, calls } = stubDeps(true);
    deps.perfGate = async () => ({ action: 'warn', summary: 'perf WARN — hot but advancing' });
    const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });
    expect(r).toMatchObject({ advanced: true, green: true, reason: 'advanced' });
    expect(await revParse(repo, 'ready')).toBe(c2); // advanced despite the warn
    expect(calls).toContain('advance');
  });

  it('F2: a perf PASS (and the no-gate default) advances normally — back-compat', async () => {
    const c1 = await commit('a', '1', 'c1');
    await git(repo, ['branch', 'ready', c1]);
    const c2 = await commit('a', '2', 'c2');
    const { deps } = stubDeps(true);
    deps.perfGate = async () => ({ action: 'pass', summary: 'perf ok' });
    const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });
    expect(r).toMatchObject({ advanced: true, reason: 'advanced' });
    expect(await revParse(repo, 'ready')).toBe(c2);
  });

  // P-011 (desktop-performance-suite): the desktop-perf gate runs post-runGreen /
  // pre-advance, same call-site shape as perf/delta-gate.
  it('P-011: a desktop-perf BLOCK holds the green pin even when the candidate is green', async () => {
    const c1 = await commit('a', '1', 'c1');
    await git(repo, ['branch', 'ready', c1]);
    await commit('a', '2', 'c2');
    const { deps, calls } = stubDeps(true);
    deps.desktopPerfGate = async (candidate) => {
      calls.push('desktopPerfGate');
      return { action: 'block', summary: `desktop-perf BLOCK ${candidate.slice(0, 7)}` };
    };
    const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });
    expect(r).toMatchObject({ advanced: false, green: true, reason: 'desktop-perf-held' });
    expect(await revParse(repo, 'ready')).toBe(c1); // pin NOT advanced
    expect(calls).toContain('desktopPerfGate');
    expect(calls).not.toContain('advance');
    expect(calls).toContain('escalate');
  });

  it('P-011: a desktop-perf WARN surfaces (broadcast) but still advances — default-warn', async () => {
    const c1 = await commit('a', '1', 'c1');
    await git(repo, ['branch', 'ready', c1]);
    const c2 = await commit('a', '2', 'c2');
    const { deps } = stubDeps(true);
    deps.desktopPerfGate = async () => ({ action: 'warn', summary: 'desktop-perf WARN — regressed but advancing' });
    const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });
    expect(r).toMatchObject({ advanced: true, green: true, reason: 'advanced' });
    expect(await revParse(repo, 'ready')).toBe(c2); // advanced despite the warn
  });

  // EI-11118 (cupboard-public-release P-009 durable fix): the Cupboard prod-hygiene
  // gate runs post-runGreen / pre-advance, same call-site shape as perf/delta-gate.
  it('EI-11118: a cupboard-hygiene BLOCK holds the green pin even when the candidate is green', async () => {
    const c1 = await commit('a', '1', 'c1');
    await git(repo, ['branch', 'ready', c1]);
    await commit('a', '2', 'c2');
    const { deps, calls } = stubDeps(true);
    deps.cupboardHygieneGate = async (candidate) => {
      calls.push('cupboardHygieneGate');
      return { action: 'block', summary: `cupboard-hygiene BLOCK ${candidate.slice(0, 7)}` };
    };
    const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });
    expect(r).toMatchObject({ advanced: false, green: true, reason: 'cupboard-hygiene-held' });
    expect(await revParse(repo, 'ready')).toBe(c1); // pin NOT advanced
    expect(calls).toContain('cupboardHygieneGate');
    expect(calls).not.toContain('advance'); // blocked before advance
    expect(calls).toContain('escalate'); // a cupboard-hygiene block opens a durable escalation
  });

  it('EI-11118: a cupboard-hygiene WARN surfaces (broadcast) but still advances — default-warn', async () => {
    const c1 = await commit('a', '1', 'c1');
    await git(repo, ['branch', 'ready', c1]);
    const c2 = await commit('a', '2', 'c2');
    const { deps, calls } = stubDeps(true);
    deps.cupboardHygieneGate = async () => ({ action: 'warn', summary: 'cupboard-hygiene WARN — junk found but advancing' });
    const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });
    expect(r).toMatchObject({ advanced: true, green: true, reason: 'advanced' });
    expect(await revParse(repo, 'ready')).toBe(c2); // advanced despite the warn
    expect(calls).toContain('advance');
  });

  it('EI-11118: a cupboard-hygiene PASS (and the no-gate default) advances normally — back-compat', async () => {
    const c1 = await commit('a', '1', 'c1');
    await git(repo, ['branch', 'ready', c1]);
    const c2 = await commit('a', '2', 'c2');
    const { deps } = stubDeps(true);
    deps.cupboardHygieneGate = async () => ({ action: 'pass', summary: 'cupboard clean' });
    const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });
    expect(r).toMatchObject({ advanced: true, reason: 'advanced' });
    expect(await revParse(repo, 'ready')).toBe(c2);
  });
});

describe('extractFailingTests (P-012 failure signature)', () => {
  it('pulls vitest FAIL files and affected-runner workspace markers, sorted + unique', () => {
    const out = [
      'some passing noise',
      ' FAIL  lib/fleet/operator-spawn.test.ts > mints NO session id',
      '>>> @papercusp/operator-core FAILED — retrying once (AFFECTED_RETRY_FAILED)',
      ' FAIL  lib/fleet/operator-spawn.test.ts > another case', // dup file
      '1 non-quarantined task(s) failed.',
    ].join('\n');
    expect(extractFailingTests(out)).toEqual([
      '@papercusp/operator-core',
      'lib/fleet/operator-spawn.test.ts',
    ]);
  });

  it('returns [] when nothing failed', () => {
    expect(extractFailingTests('All affected tests passed.\nTests 1200 passed')).toEqual([]);
  });

  // Regression: the 2026-07-10 red carried `failingTests: []` because vitest colourizes
  // ` FAIL ` — the SGR prefix defeated the `^\s*FAIL` anchor. Fixture is the real byte
  // shape from /tmp checkpoint logs: `\x1b[41m FAIL \x1b[0m\x1b[31m file > case\x1b[0m`.
  it('sees FAIL lines through ANSI colour codes', () => {
    const out = '\x1b[41m\x1b[1m FAIL \x1b[0m\x1b[31m src/left-sidebar/MugTab.test.tsx > MugTab > renders Pause\x1b[0m';
    expect(extractFailingTests(out)).toEqual(['src/left-sidebar/MugTab.test.tsx']);
  });

  // vitest prints only the first few FAIL lines but one `❯ file (N tests | M failed)`
  // rollup per failing FILE — the rollup is what makes a 17-failure run fully nameable,
  // and naming it is what lets the stale-candidate re-triage re-run it at tip.
  it('pulls every failing file from the per-file rollup lines', () => {
    const out = [
      ' ❯ src/components/left-sidebar/MugTab.test.tsx (9 tests | 8 failed) 4435ms',
      '     × renders Pause (topmost), directive, eligible hives + plans 188ms',
      ' ❯ src/components/left-sidebar/MugTab.tree.test.tsx (9 tests | 9 failed) 8646ms',
      ' ❯ src/components/left-sidebar/Healthy.test.tsx (4 tests) 12ms', // passing ⇒ ignored
    ].join('\n');
    expect(extractFailingTests(out)).toEqual([
      'src/components/left-sidebar/MugTab.test.tsx',
      'src/components/left-sidebar/MugTab.tree.test.tsx',
    ]);
  });
});

describe('extractFailingTestNames (human-facing case names)', () => {
  it('extracts case names from × lines and FAIL … > case lines, ignoring durations', () => {
    const out = [
      '\x1b[31m     × toggling a hive writes eligibleHives + the home hive 1047ms\x1b[0m',
      ' FAIL  src/x.test.tsx > MugTab > summarizes current work flow',
    ].join('\n');
    expect(extractFailingTestNames(out)).toEqual([
      'MugTab > summarizes current work flow',
      'toggling a hive writes eligibleHives + the home hive',
    ]);
  });

  it('stays empty on a green run', () => {
    expect(extractFailingTestNames('Tests 1200 passed')).toEqual([]);
  });
});

describe('extractFailingCasesByFile / describeFailingCases (EI-18673560248447615)', () => {
  // The REAL shape from the 2026-07-26T02-26-57Z full-suite log, whose failing case
  // name was reachable only by opening that separate ~5000-line file.
  const realWorldOut = [
    '\x1b[31m ❯\x1b[39m app/_lints/design-primitives.test.ts \x1b[2m(\x1b[22m\x1b[2m28 tests\x1b[22m\x1b[2m | \x1b[22m\x1b[31m1 failed\x1b[39m\x1b[2m)\x1b[22m\x1b[33m 1996\x1b[2mms\x1b[22m\x1b[39m',
    '     \x1b[33m\x1b[2m✓\x1b[22m\x1b[39m blocks new native <select> controls in app UI \x1b[33m 513\x1b[2mms\x1b[22m\x1b[39m',
    '\x1b[31m     \x1b[31m×\x1b[31m keeps audited active surfaces free of direct cyan literals\x1b[39m\x1b[32m 173\x1b[2mms\x1b[22m\x1b[39m',
  ].join('\n');

  it('attributes the failing case to the file it failed in', () => {
    const byFile = extractFailingCasesByFile(realWorldOut);
    expect(byFile.get('app/_lints/design-primitives.test.ts')).toEqual([
      'keeps audited active surfaces free of direct cyan literals',
    ]);
  });

  it('does NOT let a nested describe row (no "(N tests | M failed)" suffix) re-key the file', () => {
    const out = [
      ' ❯ lib/a.test.ts (5 tests | 2 failed) 100ms',
      '   ❯ someDescribe > nested group',
      '     × first broken case 10ms',
      '     × second broken case 12ms',
      ' ❯ lib/b.test.ts (3 tests | 1 failed) 40ms',
      '     × b case 5ms',
    ].join('\n');
    const byFile = extractFailingCasesByFile(out);
    expect(byFile.get('lib/a.test.ts')).toEqual(['first broken case', 'second broken case']);
    expect(byFile.get('lib/b.test.ts')).toEqual(['b case']);
  });

  it('ignores case rows that appear before any file header', () => {
    expect(extractFailingCasesByFile('     × orphan case 3ms').size).toBe(0);
  });

  it('renders nothing when no cases were parsed, so the caller line still reads correctly', () => {
    expect(describeFailingCases(undefined)).toBe('');
    expect(describeFailingCases([])).toBe('');
  });

  it('quotes the case names and caps a pathological suite with a +N more', () => {
    const many = Array.from({ length: ISOLATION_MAX_NAMED_CASES + 4 }, (_, i) => `case ${i}`);
    const rendered = describeFailingCases(many);
    expect(rendered).toContain('"case 0"');
    expect(rendered).toContain(`(+4 more)`);
    expect(rendered.match(/"/g)!.length).toBe(ISOLATION_MAX_NAMED_CASES * 2);
  });
});

describe('classifyRedAgainstTip (stale-candidate re-triage)', () => {
  const base = { candidate: 'aaaaaaaa1111', tip: 'bbbbbbbb2222', failingTests: ['a.test.ts'], refireAttempts: 0, maxRefires: 2 };

  it('calls a red REAL when the failures reproduce at tip', () => {
    const v = classifyRedAgainstTip({ ...base, tipRetest: { ran: true, pass: false } });
    expect(v).toMatchObject({ classification: 'real-red', autoRefire: false });
  });

  it('calls a red STALE and auto-refires when the failing files pass at tip', () => {
    const v = classifyRedAgainstTip({ ...base, tipRetest: { ran: true, pass: true } });
    expect(v).toMatchObject({ classification: 'stale-candidate', autoRefire: true });
    expect(v.detail).toContain('attempt 1/2');
  });

  it('stops auto-refiring at the cap (a refire storm is worse than a held gate)', () => {
    const v = classifyRedAgainstTip({ ...base, tipRetest: { ran: true, pass: true }, refireAttempts: 2 });
    expect(v).toMatchObject({ classification: 'stale-candidate', autoRefire: false });
    expect(v.detail).toContain('refire cap reached');
  });

  it('never refires when the cap is 0 (opt-out)', () => {
    const v = classifyRedAgainstTip({ ...base, tipRetest: { ran: true, pass: true }, maxRefires: 0 });
    expect(v.autoRefire).toBe(false);
  });

  it('treats the red as real when the candidate IS the tip', () => {
    const v = classifyRedAgainstTip({ ...base, tip: base.candidate, tipRetest: { ran: true, pass: true } });
    expect(v).toMatchObject({ classification: 'real-red', autoRefire: false });
  });

  it('is UNKNOWN (never auto-refires) when failures cannot be named or re-run', () => {
    expect(classifyRedAgainstTip({ ...base, failingTests: [], tipRetest: null })).toMatchObject({
      classification: 'unknown',
      autoRefire: false,
    });
    expect(classifyRedAgainstTip({ ...base, tipRetest: { ran: false, pass: false } })).toMatchObject({
      classification: 'unknown',
      autoRefire: false,
    });
  });
});

describe('autoRefireCapFromEnv', () => {
  it('defaults to 2, honours an explicit value, and treats 0 as disabled', () => {
    expect(autoRefireCapFromEnv({})).toBe(2);
    expect(autoRefireCapFromEnv({ PAPERCUSP_GATE_AUTO_REFIRE_CAP: '5' })).toBe(5);
    expect(autoRefireCapFromEnv({ PAPERCUSP_GATE_AUTO_REFIRE_CAP: '0' })).toBe(0);
    expect(autoRefireCapFromEnv({ PAPERCUSP_GATE_AUTO_REFIRE_CAP: 'nonsense' })).toBe(2);
  });
});

describe('summarizeSuiteOutput leads with the failure, not the tail', () => {
  // The 2026-07-10 verdict's `summary` was 2000 chars of a testing-library DOM dump:
  // the TAIL of a red run is whatever the last assertion happened to print, which is
  // uncorrelated with what broke. Lead with the digest; keep the tail underneath.
  it('surfaces FAIL/rollup lines even when a huge DOM dump trails them', () => {
    const domDump = Array.from({ length: 400 }, (_, i) => `        <div class="pc-qh__dot" data-i="${i}" />`).join('\n');
    const out = [
      '\x1b[41m FAIL \x1b[0m src/left-sidebar/MugTab.test.tsx > MugTab > renders Pause',
      ' ❯ src/left-sidebar/MugTab.test.tsx (9 tests | 8 failed) 4435ms',
      '     × renders Pause 188ms',
      'TestingLibraryElementError: Unable to find an element with the text: Eligible pot',
      domDump,
      ' Test Files  2 failed | 40 passed (42)',
    ].join('\n');

    const summary = summarizeSuiteOutput(out);
    expect(summary).toContain('MugTab.test.tsx');
    expect(summary).toContain('8 failed');
    expect(summary).toContain('× renders Pause');
    expect(summary).toContain('Test Files  2 failed');
    expect(summary).not.toContain('\x1b['); // ANSI stripped
    expect(summary.length).toBeLessThanOrEqual(2000);
  });

  it('falls back to the tail when there are no failure markers (e.g. a build break)', () => {
    const out = ['npm error boilerplate', 'noise', 'ELIFECYCLE: vite build failed'].join('\n');
    const summary = summarizeSuiteOutput(out);
    expect(summary).toContain('ELIFECYCLE');
    expect(summary).not.toContain('npm error');
  });
});

describe('stripAnsi', () => {
  it('removes SGR codes and leaves the text', () => {
    expect(stripAnsi('\x1b[41m\x1b[1m FAIL \x1b[0m\x1b[31m x\x1b[0m')).toBe(' FAIL  x');
  });
});

describe('evaluateDeployStaleness (silent-drought alarm)', () => {
  const th = { maxPinAgeMs: 6 * 3_600_000, maxCommitsBehind: 20 };

  it('stays quiet when only ONE threshold is crossed', () => {
    expect(evaluateDeployStaleness({ pinAgeMs: 12 * 3_600_000, commitsBehind: 3 }, th).alarm).toBe(false);
    expect(evaluateDeployStaleness({ pinAgeMs: 1 * 3_600_000, commitsBehind: 300 }, th).alarm).toBe(false);
  });

  it('fires with the blocking red attached when both cross', () => {
    const v = evaluateDeployStaleness(
      { pinAgeMs: 8 * 3_600_000, commitsBehind: 40, blockingFailures: ['src/x.test.tsx'] },
      th,
    );
    expect(v).toMatchObject({ alarm: true, urgency: 'warn' });
    expect(v.message).toContain('8.0h old');
    expect(v.message).toContain('40 commits behind');
    expect(v.message).toContain('src/x.test.tsx');
  });

  it('escalates to urgent past double the age threshold, and says so when nothing is red', () => {
    const v = evaluateDeployStaleness({ pinAgeMs: 18 * 3_600_000, commitsBehind: 40 }, th);
    expect(v).toMatchObject({ alarm: true, urgency: 'urgent' });
    expect(v.message).toContain('may be wedged rather than red');
  });
});

// HE-02 gap #10 (hive-run-evaluation-2026-06-13, D-017): the realCheckpointDeps
// "real path" — the inline env-strip + output processing in runGreen — twice held
// `main` red for hours via leaked host env (2026-06-06/07). The orchestration is
// already tested above with stub deps; these cover the pure pieces of the heavy
// path that don't need a real suite-run.
describe('buildGreenCheckpointEnv (the gate measures COMMITTED defaults)', () => {
  it('strips ALL PAPERCUSP_* and HOST_ENV_STRIP keys, preserves unrelated env', () => {
    const src = {
      PATH: '/usr/bin',
      HOME: '/home/t',
      PAPERCUSP_FLAG_DEMO: '1', // the 2026-06-06 leaked-flag class
      PAPERCUSP_OPERATOR_URL: 'http://host', // the 2026-06-07 non-flag class
      SPAWN_SU_BEARER: 'tok', // NOT PAPERCUSP_-prefixed and not in HOST_ENV_STRIP — survives
      AGENT_MODELS: '{"worker":"opus"}', // the 2026-06-09 invoke.test class
    };
    const env = buildGreenCheckpointEnv('base123', src);
    expect(env.PAPERCUSP_FLAG_DEMO).toBeUndefined();
    expect(env.PAPERCUSP_OPERATOR_URL).toBeUndefined();
    expect(env.AGENT_MODELS).toBeUndefined();
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/home/t');
    expect(env.SPAWN_SU_BEARER).toBe('tok');
    // pure — never mutates the caller's env object
    expect(src.PAPERCUSP_FLAG_DEMO).toBe('1');
  });

  // EI-19307211919650123: the gate's test rows must be distinguishable from an
  // agent's local run. These stamps are PAPERCUSP_-prefixed, so they only work if
  // they are applied AFTER the strip loop — which is the whole point of the first
  // assertion below (a host value must be overridden, not merely absent).
  it('stamps PAPERCUSP_TEST_RUN_SOURCE=ci AFTER the strip, overriding any host value', () => {
    const env = buildGreenCheckpointEnv('b', { PAPERCUSP_TEST_RUN_SOURCE: 'local' });
    expect(env.PAPERCUSP_TEST_RUN_SOURCE).toBe('ci');
  });

  it('groups the run with PAPERCUSP_TEST_RUN_GROUP only when a runId is given', () => {
    const withId = buildGreenCheckpointEnv('b', {}, 'run-abc');
    expect(withId.PAPERCUSP_TEST_RUN_GROUP).toBe('run-abc');
    // A host-leaked group must not survive when this run has no id of its own —
    // otherwise a gate run would inherit some agent's run-group and mis-attribute.
    const noId = buildGreenCheckpointEnv('b', { PAPERCUSP_TEST_RUN_GROUP: 'leaked' });
    expect(noId.PAPERCUSP_TEST_RUN_GROUP).toBeUndefined();
    expect(noId.PAPERCUSP_TEST_RUN_SOURCE).toBe('ci');
  });

  it('sets GREEN_CHECKPOINT=1 and AFFECTED_BASE only when a base is given', () => {
    const withBase = buildGreenCheckpointEnv('abc', {});
    expect(withBase.GREEN_CHECKPOINT).toBe('1');
    expect(withBase.AFFECTED_BASE).toBe('abc');
    const noBase = buildGreenCheckpointEnv(null, {});
    expect(noBase.GREEN_CHECKPOINT).toBe('1');
    expect(noBase.AFFECTED_BASE).toBeUndefined();
  });

  it('defaults the vitest cap + retry but never clobbers a pre-set value', () => {
    const defaulted = buildGreenCheckpointEnv('b', {});
    // WI-806: the fork cap was lowered 8→4 (GREEN_CHECKPOINT_MAX_FORKS) so the forks
    // can't collectively OOM-kill a worker under fleet load (the worker-pool crash);
    // 2026-06-25 lowered again 4→2 after 4 STILL OOM-/timeout-flaked the gate red for
    // 1h+ on the chronically-swapping box (forced a manual force-deploy).
    expect(defaulted.VITEST_MAX_FORKS).toBe(String(GREEN_CHECKPOINT_MAX_FORKS));
    expect(defaulted.VITEST_MAX_THREADS).toBe(String(GREEN_CHECKPOINT_MAX_FORKS));
    expect(GREEN_CHECKPOINT_MAX_FORKS).toBe(2);
    expect(defaulted.AFFECTED_RETRY_FAILED).toBe('1');
    // 2026-06-22: heavy `await import()` unit tests take 74-97s under the gate's
    // 8-fork transform contention; the gate raises the unit timeout to 180s (dev
    // keeps the 60s libs/test-config default) — see buildGreenCheckpointEnv.
    expect(defaulted.VITEST_UNIT_TIMEOUT_MS).toBe('180000');
    const preset = buildGreenCheckpointEnv('b', { VITEST_MAX_FORKS: '6', AFFECTED_RETRY_FAILED: '0' });
    expect(preset.VITEST_MAX_FORKS).toBe('6'); // honored (distinct from the default to prove precedence)
    expect(preset.VITEST_MAX_THREADS).toBe(String(GREEN_CHECKPOINT_MAX_FORKS)); // still defaulted
    expect(preset.AFFECTED_RETRY_FAILED).toBe('0'); // '0' is a value, not absent — honored
  });

  it('strips the host 128 GiB --max-old-space-size from NODE_OPTIONS, pins a sane per-fork heap', () => {
    // The exact bg-host/staging env that held `main` red ~16h: a 128 GiB heap +
    // --expose-gc inherited straight into the 8 vitest forks.
    const env = buildGreenCheckpointEnv('b', {
      NODE_OPTIONS: '--max-old-space-size=131072 --expose-gc',
    });
    expect(env.NODE_OPTIONS).toBe(`--expose-gc --max-old-space-size=${GREEN_CHECKPOINT_FORK_HEAP_MB}`);
    expect(env.NODE_OPTIONS).not.toContain('131072');
  });
});

describe('sanitizeForkNodeOptions (the gate must not inherit the host 128 GiB heap)', () => {
  const HEAP = `--max-old-space-size=${GREEN_CHECKPOINT_FORK_HEAP_MB}`;

  it('replaces an inherited =value heap flag, preserving other tokens', () => {
    expect(sanitizeForkNodeOptions('--max-old-space-size=131072 --expose-gc')).toBe(`--expose-gc ${HEAP}`);
  });

  it('drops the space-separated `--flag value` form (both tokens)', () => {
    expect(sanitizeForkNodeOptions('--max-old-space-size 131072 --enable-source-maps')).toBe(
      `--enable-source-maps ${HEAP}`,
    );
  });

  it('handles the underscore spelling too', () => {
    expect(sanitizeForkNodeOptions('--max_old_space_size=99999')).toBe(HEAP);
  });

  it('pins the heap deterministically even with empty/undefined input', () => {
    expect(sanitizeForkNodeOptions(undefined)).toBe(HEAP);
    expect(sanitizeForkNodeOptions('')).toBe(HEAP);
  });

  it('honors a caller-chosen cap', () => {
    expect(sanitizeForkNodeOptions('--max-old-space-size=131072', 8192)).toBe('--max-old-space-size=8192');
  });
});

describe('checkpointFailureSignature (P-012 dedup, SPA-build folded in)', () => {
  it('is empty on a green run even if the output contains FAIL-looking text', () => {
    expect(checkpointFailureSignature(' FAIL  lib/x.test.ts > c', true, true)).toEqual([]);
  });

  it('is the suite signature (no vite sentinel) when the suite failed but the build is ok', () => {
    expect(checkpointFailureSignature(' FAIL  lib/x.test.ts > c', false, true)).toEqual(['lib/x.test.ts']);
  });

  it('appends @papercusp/operator-vite when the build (not the suite) is what failed', () => {
    // suite passed (no FAIL markers) but build broke → only the build sentinel
    expect(
      checkpointFailureSignature('\n=== SPA BUILD FAILED (@papercusp/operator-vite) ===\nerror', false, false),
    ).toEqual(['@papercusp/operator-vite']);
  });

  it('does not duplicate the build sentinel when it is already in the extracted set', () => {
    const sig = checkpointFailureSignature('>>> @papercusp/operator-vite FAILED — retry', false, false);
    expect(sig).toEqual(['@papercusp/operator-vite']);
  });
});

describe('summarizeSuiteOutput (de-noised held-gate tail)', () => {
  it('drops npm error boilerplate, keeps FAIL + assertion signal', () => {
    const out = [
      'npm error code 1',
      ' FAIL  lib/x.test.ts > case',
      'npm error A complete log of this run can be found in:',
      'AssertionError: expected 1 to be 2',
    ].join('\n');
    const s = summarizeSuiteOutput(out);
    expect(s).not.toMatch(/npm error/);
    expect(s).toContain('FAIL  lib/x.test.ts');
    expect(s).toContain('AssertionError: expected 1 to be 2');
  });

  it('keeps only the last 2000 chars', () => {
    expect(summarizeSuiteOutput('x'.repeat(3000))).toHaveLength(2000);
  });
});

// EI-8744: a codeless pot (extends coding, only README + .papercusp state, NO package.json)
// can't run the npm green command — `npm run test:affected` dies with `Missing script` (rc=1)
// BEFORE any test, so the gate went hard-RED with an EMPTY failing-test signature and the
// hourly release-fixer churned on a red with nothing to fix. Nothing to gate ⇒ GREEN.
describe('isNothingToGate (EI-8744: codeless pot ⇒ nothing to gate ⇒ green)', () => {
  it('is true for an npm greenCmd when the tree has no package.json', () => {
    expect(isNothingToGate('npm run test:affected', false)).toBe(true);
    expect(isNothingToGate('npm test', false)).toBe(true);
  });

  it('is false when the tree HAS a package.json (the real pipeline — a strict no-op)', () => {
    expect(isNothingToGate('npm run test:affected', true)).toBe(false);
  });

  it('is false for a non-npm greenCmd even with no package.json (it could gate real code)', () => {
    expect(isNothingToGate('cargo test', false)).toBe(false);
    // must NOT prefix-match a command that merely starts with the letters "npm"
    expect(isNothingToGate('npmfoo run x', false)).toBe(false);
  });
});

describe('realCheckpointDeps.runGreen — nothing-to-gate short-circuit (EI-8744)', () => {
  let tree: string;
  let logDir: string;
  beforeEach(() => {
    tree = mkdtempSync(join(tmpdir(), 'gc-codeless-'));
    logDir = mkdtempSync(join(tmpdir(), 'gc-logs-'));
  });
  afterEach(() => {
    rmSync(tree, { recursive: true, force: true });
    rmSync(logDir, { recursive: true, force: true });
  });

  it('reports GREEN with an empty signature and NEVER spawns npm for a repo with no package.json', async () => {
    let execCalls = 0;
    // A fake exec that would fail exactly as the real `npm run test:affected` does on a
    // codeless repo — proving the short-circuit returns green WITHOUT ever invoking it.
    const exec: CheckpointExec = async () => {
      execCalls++;
      return { code: 1, stdout: '', stderr: 'npm error Missing script: "test:affected"' };
    };
    const cfg = releaseConfig({
      checkpointRoot: tree,
      checkpointLogDir: logDir,
      greenCmd: 'npm run test:affected',
      spaBuildWorkspace: '',
    });
    const r = await realCheckpointDeps(cfg, exec).runGreen(tree, 'base');
    expect(r.green).toBe(true);
    expect(r.failingTests).toEqual([]);
    expect(execCalls).toBe(0); // the npm green command is never even spawned
  });

  it('still runs the suite (no short-circuit) when the repo HAS a package.json', async () => {
    writeFileSync(join(tree, 'package.json'), JSON.stringify({ name: 'x', scripts: { 'test:affected': 'true' } }));
    let ran = '';
    const exec: CheckpointExec = async (cmd, args) => {
      ran = `${cmd} ${args.join(' ')}`;
      return { code: 0, stdout: 'No affected workspaces.', stderr: '' };
    };
    const cfg = releaseConfig({
      checkpointRoot: tree,
      checkpointLogDir: logDir,
      greenCmd: 'npm run test:affected',
      spaBuildWorkspace: '',
    });
    const r = await realCheckpointDeps(cfg, exec).runGreen(tree, 'base');
    expect(r.green).toBe(true);
    expect(ran).toBe('npm run test:affected'); // the suite really ran — no false short-circuit
  });
});

// EI-18694489428714850: PAPERCUSP_RETAIN_DIST_CHUNKS had ZERO callers for weeks even though
// the retention mechanism (WI-1484) was fully built — nothing ever set the env var that turns
// it on for a one-shot build, so every gate-triggered SPA rebuild kept emptying dist/ and
// 404ing any open desktop webview's lazy chunks. The bug wasn't a missing FEATURE, it was a
// missing WIRE — exactly the kind of regression a green suite can't catch unless something
// asserts the wire is actually connected. This test IS that assertion: it locks in that the
// checkpoint's SPA build call always passes PAPERCUSP_RETAIN_DIST_CHUNKS=1, so a future
// refactor of this call site (or of buildGreenCheckpointEnv) that silently drops it fails
// loudly here instead of quietly reintroducing the exact same class of bug.
describe('realCheckpointDeps.runGreen — SPA build retains dist chunks (EI-18694489428714850)', () => {
  let tree: string;
  let logDir: string;
  beforeEach(() => {
    tree = mkdtempSync(join(tmpdir(), 'gc-spa-retain-'));
    logDir = mkdtempSync(join(tmpdir(), 'gc-logs-'));
  });
  afterEach(() => {
    rmSync(tree, { recursive: true, force: true });
    rmSync(logDir, { recursive: true, force: true });
  });

  it('passes PAPERCUSP_RETAIN_DIST_CHUNKS=1 to the operator-vite build — the whole point of WI-1484', async () => {
    // No lint:tsc/lint:migrations/identity/design-primitives scripts on this fake tree, so
    // those legs are structurally skipped (hasNpmScript false) and stay at their default-ok
    // — isolating this test to exactly the leg under test: the SPA build call.
    writeFileSync(join(tree, 'package.json'), JSON.stringify({ name: 'x', scripts: { 'test:affected': 'true' } }));
    let buildEnv: NodeJS.ProcessEnv | undefined;
    let buildCalled = false;
    const exec: CheckpointExec = async (cmd, args, opts) => {
      if (cmd === 'git' && args[0] === 'grep') {
        // exit 1 = git grep's "no match" — i.e. no committed conflict markers.
        return { code: 1, stdout: '', stderr: '' };
      }
      if (cmd === 'npm' && args.includes('--workspace') && args.includes('@papercusp/operator-vite') && args.includes('build')) {
        buildCalled = true;
        buildEnv = opts?.env;
        return { code: 0, stdout: '', stderr: '' };
      }
      // the greenCmd itself (`npm run test:affected`) — green, nothing failing.
      return { code: 0, stdout: '', stderr: '' };
    };
    const cfg = releaseConfig({
      checkpointRoot: tree,
      checkpointLogDir: logDir,
      greenCmd: 'npm run test:affected',
      // spaBuildWorkspace deliberately NOT overridden — defaults to
      // '@papercusp/operator-vite', so this test exercises the real SPA-build leg.
    });
    const r = await realCheckpointDeps(cfg, exec).runGreen(tree, 'base');
    expect(r.green).toBe(true);
    expect(buildCalled).toBe(true); // the build leg actually ran — didn't skip/short-circuit
    expect(buildEnv?.PAPERCUSP_RETAIN_DIST_CHUNKS).toBe('1');
  });
});

// load-flake-isolation-2026-06-23: the SAFE load-flake absorber. The 2026-06-23 incident:
// runner-aggregate.test.ts + scheduler-workspace-scope.test.ts (both @papercusp/operator-core)
// failed the gate under the 8-fork checkpoint load but PASS in isolation, and the
// AFFECTED_RETRY_FAILED=1 workspace retry didn't absorb them — holding the whole fleet's
// gate for 4h. These cover the pure parse + decision + orchestration without real vitest.

// A realistic affected-runner output for the actual incident: two files fail under
// @papercusp/operator-core's section (the `>>>` header), shown via both a `FAIL` suite row
// and a `❯ … failed` summary row, the two formats parseFailingFilesByWorkspace handles.
const INCIDENT_OUTPUT = [
  'Affected workspaces (2): @papercusp/operator-core, @papercusp/agent-mcp',
  '',
  '>>> @papercusp/operator-core :: npm run test',
  ' FAIL  lib/llm-testing/__tests__/runner-aggregate.test.ts > aggregates runs',
  ' ❯ lib/scout/scheduler-workspace-scope.test.ts (12 tests | 1 failed) 21034ms',
  '   Test timed out in 20000ms',
  '>>> @papercusp/operator-core FAILED — retrying once (AFFECTED_RETRY_FAILED, flake absorption)',
  '',
  '>>> @papercusp/agent-mcp :: npm run test',
  ' Tests  340 passed (340)',
  '',
  '2 non-quarantined task(s) failed.',
].join('\n');

describe('parseFailingFilesByWorkspace (load-flake isolation)', () => {
  it('groups failing FILES under the workspace section they ran in (both FAIL + ❯ formats)', () => {
    expect(parseFailingFilesByWorkspace(INCIDENT_OUTPUT)).toEqual([
      { workspace: '@papercusp/operator-core', file: 'lib/llm-testing/__tests__/runner-aggregate.test.ts' },
      { workspace: '@papercusp/operator-core', file: 'lib/scout/scheduler-workspace-scope.test.ts' },
    ]);
  });

  it('does NOT return bare workspace markers (only real .test/.spec files)', () => {
    const files = parseFailingFilesByWorkspace(INCIDENT_OUTPUT).map((f) => f.file);
    expect(files.every((f) => /\.(test|spec)\./.test(f))).toBe(true);
    expect(files).not.toContain('@papercusp/operator-core');
  });

  it('skips a FAIL line with no preceding workspace header (no cwd to run it in)', () => {
    const out = ' FAIL  lib/orphan.test.ts > case\nno header above';
    expect(parseFailingFilesByWorkspace(out)).toEqual([]);
  });

  it('dedupes a file that appears in multiple rows of the same workspace', () => {
    const out = [
      '>>> @papercusp/x :: npm run test',
      ' FAIL  lib/a.test.ts > one',
      ' ❯ lib/a.test.ts (3 tests | 2 failed) 5ms',
    ].join('\n');
    expect(parseFailingFilesByWorkspace(out)).toEqual([{ workspace: '@papercusp/x', file: 'lib/a.test.ts' }]);
  });

  it('returns [] on empty / non-vitest output (build break)', () => {
    expect(parseFailingFilesByWorkspace('')).toEqual([]);
    expect(parseFailingFilesByWorkspace('=== SPA BUILD FAILED (@papercusp/operator-vite) ===\nerror TS2304')).toEqual([]);
  });

  // 2026-07-17 phantom-workspace incident: the gate captures each task's stdout/stderr and
  // block-flushes them, so vitest's "Failed Tests" epilogue (` FAIL file > case` rows) can
  // land AFTER later workspaces' headers. The bare FAIL row then re-attributed operator-core's
  // quarantined hyperbee failure to @papercupai/gitnexus-bridge — a phantom un-quarantined
  // entry that kept an all-failures-quarantined run red AND emptied the re-triage's file list.
  it('does NOT re-attribute a rollup-named file via a displaced FAIL epilogue row under a later header', () => {
    const out = [
      '>>> @papercusp/operator-core :: npm run test',
      ' ❯ lib/sync/hyperbee/__tests__/hive-two-peer-federation.test.ts (2 tests | 1 failed) 22943ms',
      '',
      '>>> @papercupai/gitnexus-bridge :: npm run test',
      ' Tests  12 passed (12)',
      ' FAIL  lib/sync/hyperbee/__tests__/hive-two-peer-federation.test.ts > Shared Hive federation > federates a presence announce',
      '>>> @papercusp/operator-core FAILED — retrying once (AFFECTED_RETRY_FAILED, flake absorption)',
    ].join('\n');
    expect(parseFailingFilesByWorkspace(out)).toEqual([
      { workspace: '@papercusp/operator-core', file: 'lib/sync/hyperbee/__tests__/hive-two-peer-federation.test.ts' },
    ]);
  });

  it('still attributes a FAIL-only file (transform/setup error — no rollup row exists for it)', () => {
    const out = [
      '>>> @papercusp/operator-core :: npm run test',
      ' ❯ lib/a.test.ts (3 tests | 1 failed) 10ms',
      '>>> @papercusp/web :: npm run test',
      ' FAIL  app/broken-transform.test.ts > setup',
    ].join('\n');
    expect(parseFailingFilesByWorkspace(out)).toEqual([
      { workspace: '@papercusp/operator-core', file: 'lib/a.test.ts' },
      { workspace: '@papercusp/web', file: 'app/broken-transform.test.ts' },
    ]);
  });
});

describe('test quarantine filtering (v1 gate scope)', () => {
  const quarantine = parseTestQuarantine([
    '# workspace and file-level forms',
    '@papercusp/operator-core::lib/sync/hyperbee/**',
    '@papercusp/operator-core::lib/shared-pot-loop/**',
    '@papercusp/operator-core::lib/*federation*.test.ts',
    '@papercusp/pubsub-substrate',
  ].join('\n'));

  it('matches workspace-scoped glob quarantine entries', () => {
    expect(isQuarantinedTestFile(
      { workspace: '@papercusp/operator-core', file: 'lib/sync/hyperbee/__tests__/two-peer.test.ts' },
      quarantine,
    )).toBe(true);
    expect(isQuarantinedTestFile(
      { workspace: '@papercusp/operator-core', file: 'lib/work-items-view.integration.test.ts' },
      quarantine,
    )).toBe(false);
    expect(isQuarantinedTestFile(
      { workspace: '@papercusp/operator-core', file: 'lib/hive-federation.test.ts' },
      quarantine,
    )).toBe(true);
    expect(isQuarantinedTestFile(
      { workspace: '@papercusp/pubsub-substrate', file: 'src/core/core.test.ts' },
      quarantine,
    )).toBe(true);
  });

  it('turns an all-quarantined p2p/federation failure into a non-gating verdict', () => {
    const out = [
      '>>> @papercusp/operator-core :: npm run test',
      ' FAIL  lib/sync/hyperbee/__tests__/two-peer.test.ts > joins',
      '>>> @papercusp/operator-core FAILED — retrying once (AFFECTED_RETRY_FAILED)',
      '1 non-quarantined task(s) failed.',
    ].join('\n');
    const q = applyTestQuarantine(out, extractFailingTests(out), quarantine);
    expect(q.allFailuresQuarantined).toBe(true);
    expect(q.failingTests).toEqual([]);
    expect(q.quarantined).toEqual(['@papercusp/operator-core::lib/sync/hyperbee/__tests__/two-peer.test.ts']);
  });

  it('keeps unrelated failures gating while removing quarantined file signatures', () => {
    const out = [
      '>>> @papercusp/operator-core :: npm run test',
      ' FAIL  lib/sync/hyperbee/__tests__/two-peer.test.ts > joins',
      ' FAIL  lib/work-items-view.integration.test.ts > renders',
      '>>> @papercusp/operator-core FAILED — retrying once (AFFECTED_RETRY_FAILED)',
      '1 non-quarantined task(s) failed.',
    ].join('\n');
    const q = applyTestQuarantine(out, extractFailingTests(out), quarantine);
    expect(q.allFailuresQuarantined).toBe(false);
    expect(q.failingTests).toEqual(['@papercusp/operator-core', 'lib/work-items-view.integration.test.ts']);
  });
});

describe('decideFlakeAbsorption (pure flake-vs-real decision — NEVER hides a real bug)', () => {
  const ff = (workspace: string, file: string): FailingFile => ({ workspace, file });
  const ir = (workspace: string, file: string, passed: boolean, errored = false): IsolationResult => ({
    workspace,
    file,
    passed,
    errored,
  });

  it('all-flakes: every originally-failing file PASSES in isolation', () => {
    const originalFailing = [ff('@p/core', 'a.test.ts'), ff('@p/core', 'b.test.ts')];
    const isolationResults = [ir('@p/core', 'a.test.ts', true), ir('@p/core', 'b.test.ts', true)];
    const d = decideFlakeAbsorption({ originalFailing, isolationResults });
    expect(d.verdict).toBe('all-flakes');
    expect(d.flakeAbsorbed).toEqual(['@p/core::a.test.ts', '@p/core::b.test.ts']);
    expect(d.stillFailing).toEqual([]);
  });

  it('real-break: ONE file still fails in isolation ⇒ gate stays red (no hiding)', () => {
    const originalFailing = [ff('@p/core', 'a.test.ts'), ff('@p/core', 'b.test.ts')];
    const isolationResults = [ir('@p/core', 'a.test.ts', true), ir('@p/core', 'b.test.ts', false)];
    const d = decideFlakeAbsorption({ originalFailing, isolationResults });
    expect(d.verdict).toBe('real-break');
    expect(d.stillFailing).toEqual(['@p/core::b.test.ts']);
  });

  it('real-break: an ERRORED isolation re-run counts as still-failing (fail-safe)', () => {
    const originalFailing = [ff('@p/core', 'a.test.ts')];
    const isolationResults = [ir('@p/core', 'a.test.ts', false, true)];
    expect(decideFlakeAbsorption({ originalFailing, isolationResults }).verdict).toBe('real-break');
  });

  it('real-break: a MISSING isolation result counts as still-failing (never assume a flake)', () => {
    const originalFailing = [ff('@p/core', 'a.test.ts'), ff('@p/core', 'b.test.ts')];
    const isolationResults = [ir('@p/core', 'a.test.ts', true)]; // no result for b
    const d = decideFlakeAbsorption({ originalFailing, isolationResults });
    expect(d.verdict).toBe('real-break');
    expect(d.stillFailing).toEqual(['@p/core::b.test.ts']);
  });

  it('inconclusive: no originally-failing files (caller keeps the original red verdict)', () => {
    expect(decideFlakeAbsorption({ originalFailing: [], isolationResults: [] }).verdict).toBe('inconclusive');
  });
});

describe('attemptFlakeAbsorption (orchestration — injected isolation runner)', () => {
  it('absorbs the 2026-06-23 incident: both files pass in isolation ⇒ green', async () => {
    const ran: string[] = [];
    const isolationRun = async ({ workspace, file }: { workspace: string; file: string }): Promise<IsolationResult> => {
      ran.push(`${workspace}::${file}`);
      return { workspace, file, passed: true }; // both pass at single concurrency
    };
    const out = await attemptFlakeAbsorption(INCIDENT_OUTPUT, isolationRun);
    expect(out.absorbedToGreen).toBe(true);
    expect(out.flakeSuspects).toEqual([
      '@papercusp/operator-core::lib/llm-testing/__tests__/runner-aggregate.test.ts',
      '@papercusp/operator-core::lib/scout/scheduler-workspace-scope.test.ts',
    ]);
    // it actually re-ran each originally-failing file
    expect(ran).toHaveLength(2);
  });

  it('does NOT absorb when a file still fails in isolation (real break stays red)', async () => {
    const isolationRun = async ({ workspace, file }: { workspace: string; file: string }): Promise<IsolationResult> => ({
      workspace,
      file,
      passed: file.includes('runner-aggregate'), // scheduler-workspace-scope STILL fails
    });
    // EI-18104902318285612: the still-failing file re-fails on every attempt, so this
    // exercises the ISOLATION_RETRY_MAX(=1) retry — inject a no-op sleep so the real
    // ISOLATION_RETRY_DELAY_MS (5s) setTimeout never fires (host-load-correlated flake).
    const out = await attemptFlakeAbsorption(INCIDENT_OUTPUT, isolationRun, undefined, { sleep: async () => {} });
    expect(out.absorbedToGreen).toBe(false);
    expect(out.flakeSuspects).toEqual([]);
  });

  // EI-18673560248447615: the verdict note is what an agent reads to decide whether a red
  // is theirs. Before this, it named the FILE and (post-EI-18669336904251384) ruled out
  // load — but never said WHAT failed, so triage still meant opening a separate ~5000-line
  // full-suite log. Regression-guard both the retry line and the verdict note.
  describe('names the failing CASES so triage never needs the separate full-suite log', () => {
    const outWithCases = [
      'Affected workspaces (1): @papercusp/operator-core',
      '',
      '>>> @papercusp/operator-core :: npm run test',
      ' ❯ lib/scout/scheduler-workspace-scope.test.ts (4 tests | 1 failed) 120ms',
      '     × schedules within the workspace scope 22ms',
      '>>> @papercusp/operator-core FAILED',
      '',
      '1 non-quarantined task(s) failed.',
    ].join('\n');

    it('puts the case name in the red VERDICT note', async () => {
      const isolationRun = async ({ workspace, file }: { workspace: string; file: string }): Promise<IsolationResult> => ({
        workspace,
        file,
        passed: false,
        durationMs: 22,
      });
      const out = await attemptFlakeAbsorption(outWithCases, isolationRun, undefined, { sleep: async () => {} });
      expect(out.absorbedToGreen).toBe(false);
      expect(out.note).toContain('schedules within the workspace scope');
      expect(out.note).toContain('lib/scout/scheduler-workspace-scope.test.ts');
    });

    it('puts the case name on the retry line too, alongside the not-load attribution', async () => {
      const logs: string[] = [];
      const isolationRun = async ({ workspace, file }: { workspace: string; file: string }): Promise<IsolationResult> => ({
        workspace,
        file,
        passed: false,
        durationMs: 22, // < ISOLATION_LOAD_STARVATION_MIN_MS ⇒ "too fast to be load-starved"
      });
      await attemptFlakeAbsorption(outWithCases, isolationRun, (s) => logs.push(s), { sleep: async () => {} });
      const retryLine = logs.find((l) => l.includes('still failing after attempt'));
      expect(retryLine).toBeDefined();
      expect(retryLine).toContain('too fast to be load-starved');
      expect(retryLine).toContain('schedules within the workspace scope');
    });

    it('still reads correctly when no case names are parseable (build break)', async () => {
      const isolationRun = async ({ workspace, file }: { workspace: string; file: string }): Promise<IsolationResult> => ({
        workspace,
        file,
        passed: false,
      });
      // INCIDENT_OUTPUT has failing FILES but no `×` case rows.
      const out = await attemptFlakeAbsorption(INCIDENT_OUTPUT, isolationRun, undefined, { sleep: async () => {} });
      expect(out.note).toContain('STILL FAILED in isolation');
      expect(out.note).not.toContain('failed case(s)');
    });
  });

  it('a THROWING isolation runner defaults to red (uncertainty never flips to green)', async () => {
    const isolationRun = async (): Promise<IsolationResult> => {
      throw new Error('vitest spawn failed');
    };
    // EI-18104902318285612: throws on every attempt too — same retry path, same no-op
    // sleep seam to keep this a fast, deterministic unit test.
    const out = await attemptFlakeAbsorption(INCIDENT_OUTPUT, isolationRun, undefined, { sleep: async () => {} });
    expect(out.absorbedToGreen).toBe(false);
  });

  it('a build break / non-vitest red (no parseable files) stays red — never re-runs', async () => {
    let called = false;
    const isolationRun = async ({ workspace, file }: { workspace: string; file: string }): Promise<IsolationResult> => {
      called = true;
      return { workspace, file, passed: true };
    };
    const out = await attemptFlakeAbsorption('=== SPA BUILD FAILED (@papercusp/operator-vite) ===', isolationRun);
    expect(out.absorbedToGreen).toBe(false);
    expect(called).toBe(false); // nothing to re-run
  });

  it('a BROAD red (> ISOLATION_MAX_FILES files) is a real regression — never absorbed', async () => {
    const lines = ['>>> @papercusp/operator-core :: npm run test'];
    for (let i = 0; i <= ISOLATION_MAX_FILES; i++) lines.push(` FAIL  lib/f${i}.test.ts > case`);
    let called = false;
    const isolationRun = async ({ workspace, file }: { workspace: string; file: string }): Promise<IsolationResult> => {
      called = true;
      return { workspace, file, passed: true };
    };
    const out = await attemptFlakeAbsorption(lines.join('\n'), isolationRun);
    expect(out.absorbedToGreen).toBe(false);
    expect(called).toBe(false); // a broad red is never load-flake absorption
  });

  // isolation-retry-resilience-2026-07-19 (EI-15849): a single isolated re-run can ITSELF
  // be starved by AMBIENT host-wide load (other pots' suites, federation, concurrent SU
  // builds) — not just the checkpoint's own 8-fork contention, which single-concurrency
  // already neutralizes. The reproduced incident: an operator-core/endpoint-route cluster
  // failed the gate AND its first isolation attempt while loadavg sat at 99+/128 cores, but
  // reproduced clean once load had dropped. A bounded per-file retry is the recurrence
  // guard: it must absorb a file that fails once then passes on retry, and it must NEVER
  // absorb a file that keeps failing across every retry (no weakening of the fail-safe).
  describe('isolation retry hardening (ambient-load resilience, never weakens fail-safe)', () => {
    it('a file that FAILS on attempt 1 but PASSES on retry is absorbed to green (transient ambient-load blip)', async () => {
      const attempts: Record<string, number> = {};
      const isolationRun = async ({ workspace, file }: { workspace: string; file: string }): Promise<IsolationResult> => {
        const key = `${workspace}::${file}`;
        attempts[key] = (attempts[key] ?? 0) + 1;
        // fails on the first attempt only, for EVERY originally-failing file
        return { workspace, file, passed: attempts[key] > 1 };
      };
      const sleeps: number[] = [];
      const out = await attemptFlakeAbsorption(INCIDENT_OUTPUT, isolationRun, undefined, {
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      });
      expect(out.absorbedToGreen).toBe(true);
      expect(out.flakeSuspects).toEqual([
        '@papercusp/operator-core::lib/llm-testing/__tests__/runner-aggregate.test.ts',
        '@papercusp/operator-core::lib/scout/scheduler-workspace-scope.test.ts',
      ]);
      // exactly one retry per originally-failing file (2 files ⇒ 2 delays)
      expect(sleeps).toHaveLength(2);
      expect(Object.values(attempts)).toEqual([2, 2]);
    });

    it('a file that STILL fails on every retry stays a real break — retries never manufacture a false green', async () => {
      const attempts: Record<string, number> = {};
      const isolationRun = async ({ workspace, file }: { workspace: string; file: string }): Promise<IsolationResult> => {
        const key = `${workspace}::${file}`;
        attempts[key] = (attempts[key] ?? 0) + 1;
        // 'runner-aggregate' is a genuine, deterministic break — fails on EVERY attempt
        return { workspace, file, passed: !file.includes('runner-aggregate') || attempts[key] > 1 ? !file.includes('runner-aggregate') : false };
      };
      const out = await attemptFlakeAbsorption(INCIDENT_OUTPUT, isolationRun, undefined, {
        sleep: async () => {},
      });
      expect(out.absorbedToGreen).toBe(false);
      // retried up to (1 + ISOLATION_RETRY_MAX) times before giving up
      expect(attempts['@papercusp/operator-core::lib/llm-testing/__tests__/runner-aggregate.test.ts']).toBe(1 + ISOLATION_RETRY_MAX);
    });

    it('respects the overall retry time budget — once exhausted, no further retries are attempted (bounded worst-case)', async () => {
      let calls = 0;
      const isolationRun = async ({ workspace, file }: { workspace: string; file: string }): Promise<IsolationResult> => {
        calls++;
        return { workspace, file, passed: false }; // always fails
      };
      let elapsed = 0;
      const out = await attemptFlakeAbsorption(INCIDENT_OUTPUT, isolationRun, undefined, {
        sleep: async () => {},
        now: () => {
          elapsed += 1000;
          return elapsed;
        },
        retryBudgetMs: 500, // exhausted immediately — the very first budget check fails
      });
      expect(out.absorbedToGreen).toBe(false);
      // exactly one attempt per file — no retry once the budget is already spent
      expect(calls).toBe(2);
    });

    // EI-18669336904251384: the retry-loop log must not assert "ambient host load"
    // unconditionally — a MEASURED green-checkpoint incident (2026-07-25) showed the
    // message firing for failures that completed in 11-32ms on an UNSATURATED host, while
    // the real cause was a stale candidate whose fix had already landed at tip. Gate the
    // wording on the isolation attempt's own measured duration.
    it('a FAST failing attempt (< ISOLATION_LOAD_STARVATION_MIN_MS) is logged as NOT load-starved', async () => {
      const logs: string[] = [];
      const isolationRun = async ({ workspace, file }: { workspace: string; file: string }): Promise<IsolationResult> => ({
        workspace,
        file,
        passed: false,
        durationMs: 23, // measured incident magnitude (11-32ms)
      });
      await attemptFlakeAbsorption(INCIDENT_OUTPUT, isolationRun, (s) => logs.push(s), { sleep: async () => {} });
      const attributionLines = logs.filter((l) => l.includes('still failing after attempt'));
      expect(attributionLines.length).toBeGreaterThan(0);
      for (const line of attributionLines) {
        expect(line).toContain('finished in 23ms');
        expect(line).toContain('too fast to be load-starved');
        expect(line).not.toContain('ambient host load, not just the checkpoint');
      }
    });

    it('a SLOW failing attempt (>= ISOLATION_LOAD_STARVATION_MIN_MS) is logged as consistent with ambient load', async () => {
      const logs: string[] = [];
      const slowMs = ISOLATION_LOAD_STARVATION_MIN_MS + 5_000;
      const isolationRun = async ({ workspace, file }: { workspace: string; file: string }): Promise<IsolationResult> => ({
        workspace,
        file,
        passed: false,
        durationMs: slowMs,
      });
      await attemptFlakeAbsorption(INCIDENT_OUTPUT, isolationRun, (s) => logs.push(s), { sleep: async () => {} });
      const attributionLines = logs.filter((l) => l.includes('still failing after attempt'));
      expect(attributionLines.length).toBeGreaterThan(0);
      for (const line of attributionLines) {
        expect(line).toContain(`took ${slowMs}ms`);
        expect(line).toContain('consistent with ambient host load');
      }
    });

    it('a failing attempt with NO measured duration falls back to the unattributed wording', async () => {
      const logs: string[] = [];
      const isolationRun = async ({ workspace, file }: { workspace: string; file: string }): Promise<IsolationResult> => ({
        workspace,
        file,
        passed: false,
        // durationMs omitted (e.g. a hand-built test double, or a future caller that
        // hasn't wired timing) — must not silently masquerade as load evidence.
      });
      await attemptFlakeAbsorption(INCIDENT_OUTPUT, isolationRun, (s) => logs.push(s), { sleep: async () => {} });
      const attributionLines = logs.filter((l) => l.includes('still failing after attempt'));
      expect(attributionLines.length).toBeGreaterThan(0);
      for (const line of attributionLines) {
        expect(line).toContain('duration not measured');
      }
    });
  });
});

// worker-pool-crash-absorption-2026-06-25 (WI-806): the SAFE worker-pool-crash absorber.
// The incident: @papercusp/operator-core's `vitest run --passWithNoTests` CRASHED a worker
// fork (ENOMEM/OOM-kill under the shared box's fleet load) — `[vitest-pool]: Worker forks
// emitted error` / `Worker exited unexpectedly` — with NO per-file `FAIL` rows. The
// existing per-file isolation absorber parsed ZERO files and fell through to a hard RED
// that wedged the release pipeline 5× in a row. These cover the pure classify + parse +
// orchestration without real vitest. The exact crash signature from the real checkpoint log:
const WORKER_CRASH_OUTPUT = [
  '>>> @papercusp/operator-core :: npm run test',
  'Error: [vitest-pool]: Worker forks emitted error.',
  '    ❯ EventEmitter.<anonymous> ../../node_modules/vitest/dist/chunks/cli-api.js:3446:22',
  'Caused by: Error: Worker exited unexpectedly',
  '    ❯ ChildProcess.emitUnexpectedExit ../../node_modules/vitest/dist/chunks/cli-api.js:3012:33',
  '',
  'npm error Lifecycle script `test` failed with error:',
  'npm error code 1',
  'npm error workspace @papercusp/operator-core@0.1.0',
  'npm error location /home/x/papercup-checkpoint/packages/operator-core',
  'npm error command sh -c vitest run --passWithNoTests',
  '',
  '1 non-quarantined task(s) failed.',
].join('\n');

describe('isWorkerPoolCrash + parseCrashedWorkspaces (WI-806)', () => {
  it('classifies the real worker-pool crash output as a pool crash', () => {
    expect(isWorkerPoolCrash(WORKER_CRASH_OUTPUT)).toBe(true);
    expect(isWorkerPoolCrash('Worker terminated')).toBe(true);
  });

  it('is NOT a pool crash for an ordinary test failure', () => {
    expect(isWorkerPoolCrash(' FAIL  lib/x.test.ts > case\nAssertionError: expected 1 to be 2')).toBe(false);
  });

  it('harvests the crashed workspace from the `npm error workspace` footer (strips @version)', () => {
    expect(parseCrashedWorkspaces(WORKER_CRASH_OUTPUT)).toEqual(['@papercusp/operator-core']);
  });

  it('falls back to the `>>>` section header when no npm-error-workspace footer is present', () => {
    const out = '>>> @papercusp/agent-mcp :: npm run test\nError: [vitest-pool]: Worker forks emitted error.';
    expect(parseCrashedWorkspaces(out)).toEqual(['@papercusp/agent-mcp']);
  });

  it('returns [] when no workspace is localizable', () => {
    expect(parseCrashedWorkspaces('Worker exited unexpectedly')).toEqual([]);
  });
});

describe('attemptWorkerCrashAbsorption (WI-806 — absorb-or-retry the no-signature crash)', () => {
  it('(a) crash + zero parseable files + passing re-run ⇒ green + flakeSuspect', async () => {
    const ran: string[] = [];
    const workspaceRerun = async ({ workspace }: { workspace: string }): Promise<WorkspaceRerunResult> => {
      ran.push(workspace);
      return { workspace, passed: true }; // passes cleanly at reduced concurrency
    };
    const out = await attemptWorkerCrashAbsorption(WORKER_CRASH_OUTPUT, workspaceRerun);
    expect(out.absorbedToGreen).toBe(true);
    expect(out.flakeSuspects).toEqual(['@papercusp/operator-core (worker-pool crash)']);
    expect(ran).toEqual(['@papercusp/operator-core']); // it actually re-ran the crashed ws
  });

  it('(b) crash + re-run STILL crashes ⇒ red (never blanket-green a crash)', async () => {
    const workspaceRerun = async ({ workspace }: { workspace: string }): Promise<WorkspaceRerunResult> => ({
      workspace,
      passed: false,
      crashedAgain: true,
    });
    const out = await attemptWorkerCrashAbsorption(WORKER_CRASH_OUTPUT, workspaceRerun);
    expect(out.absorbedToGreen).toBe(false);
    expect(out.flakeSuspects).toEqual([]);
  });

  it('(b2) crash + re-run reveals a REAL per-file failure ⇒ red', async () => {
    const workspaceRerun = async ({ workspace }: { workspace: string }): Promise<WorkspaceRerunResult> => ({
      workspace,
      passed: false,
      realFailure: true,
    });
    expect((await attemptWorkerCrashAbsorption(WORKER_CRASH_OUTPUT, workspaceRerun)).absorbedToGreen).toBe(false);
  });

  it('(b3) a THROWING re-run defaults to red (uncertainty never flips to green)', async () => {
    const workspaceRerun = async (): Promise<WorkspaceRerunResult> => {
      throw new Error('vitest spawn failed');
    };
    expect((await attemptWorkerCrashAbsorption(WORKER_CRASH_OUTPUT, workspaceRerun)).absorbedToGreen).toBe(false);
  });

  it('(c) a REAL per-file failure is NEVER mistaken for a worker-crash flake (no re-run)', async () => {
    // Ordinary red WITH parseable per-file failures — not a pool crash. Even if it also
    // contained a pool marker, the parseable per-file failures route it to the isolation
    // absorber, never this workspace re-run.
    let called = false;
    const workspaceRerun = async ({ workspace }: { workspace: string }): Promise<WorkspaceRerunResult> => {
      called = true;
      return { workspace, passed: true };
    };
    const out = await attemptWorkerCrashAbsorption(INCIDENT_OUTPUT, workspaceRerun);
    expect(out.absorbedToGreen).toBe(false);
    expect(called).toBe(false); // a genuine test failure is never re-run as a crash flake
  });

  it('(c2) a pool crash that STILL named per-file failures defers to the isolation absorber (no workspace re-run)', async () => {
    const withFiles = WORKER_CRASH_OUTPUT + '\n FAIL  lib/real.test.ts > a case';
    let called = false;
    const workspaceRerun = async ({ workspace }: { workspace: string }): Promise<WorkspaceRerunResult> => {
      called = true;
      return { workspace, passed: true };
    };
    expect((await attemptWorkerCrashAbsorption(withFiles, workspaceRerun)).absorbedToGreen).toBe(false);
    expect(called).toBe(false);
  });

  it('a BROAD multi-workspace crash (> WORKER_CRASH_MAX_WORKSPACES) is a real regression — never absorbed', async () => {
    const lines = ['Error: [vitest-pool]: Worker forks emitted error.'];
    for (let i = 0; i <= WORKER_CRASH_MAX_WORKSPACES; i++) lines.push(`npm error workspace @p/ws${i}@1.0.0`);
    let called = false;
    const workspaceRerun = async ({ workspace }: { workspace: string }): Promise<WorkspaceRerunResult> => {
      called = true;
      return { workspace, passed: true };
    };
    const out = await attemptWorkerCrashAbsorption(lines.join('\n'), workspaceRerun);
    expect(out.absorbedToGreen).toBe(false);
    expect(called).toBe(false);
  });

  it('one of two crashed workspaces still failing ⇒ red (all must pass to absorb)', async () => {
    const out2 = WORKER_CRASH_OUTPUT.replace(
      'npm error workspace @papercusp/operator-core@0.1.0',
      'npm error workspace @papercusp/operator-core@0.1.0\nnpm error workspace @papercusp/agent-mcp@0.1.0',
    );
    const workspaceRerun = async ({ workspace }: { workspace: string }): Promise<WorkspaceRerunResult> => ({
      workspace,
      passed: workspace === '@papercusp/operator-core', // agent-mcp still fails
    });
    expect((await attemptWorkerCrashAbsorption(out2, workspaceRerun)).absorbedToGreen).toBe(false);
  });
});

// P-016 (release-pipeline-resilience-2026-06-09 D-010): longest-green-PREFIX FF — a red
// batch TIP no longer holds the clean prefix hostage. The invariant under test: `main`
// only ever FFs to a commit that ITSELF ran green (the confirm-run), so a wrong prefix
// guess just holds (today's behavior), never deploys untested code. Env-armed (default-OFF).
describe('runGreenCheckpoint — longest-green-prefix (P-016)', () => {
  // Build a real commit chain c1(ready) → c2 → c3 → c4(candidate) so advanceReady /
  // isAncestor work; stub the NEW deps (commitsInRange / affectedWorkspacesForRange) and
  // the two runGreen calls (1 = candidate red, 2 = confirm on the chosen prefix).
  function partialDeps(opts: {
    candidateFailingTests?: string[];
    affected: Record<string, string[]>; // sha → affected workspace names for that prefix's range
    commits: string[]; // lastReady..candidate, OLDEST-FIRST full shas
    confirmGreen: boolean;
  }): { deps: CheckpointDeps; calls: string[] } {
    const calls: string[] = [];
    let runGreenN = 0;
    const deps: CheckpointDeps = {
      setupTree: async (ref) => { calls.push(`setup:${ref.slice(0, 7)}`); },
      runGreen: async () => {
        runGreenN++;
        if (runGreenN === 1) {
          calls.push('runGreen:candidate');
          return { green: false, summary: 'red', failingTests: opts.candidateFailingTests };
        }
        calls.push('runGreen:confirm');
        return { green: opts.confirmGreen, summary: opts.confirmGreen ? 'all pass' : 'still red' };
      },
      advance: (c) => { calls.push(`advance:${c.slice(0, 7)}`); return advanceReady(repo, c, 'ready'); },
      push: async () => { calls.push('push'); },
      broadcast: async () => { calls.push('broadcast'); },
      escalate: async () => { calls.push('escalate'); },
      clearEscalation: async () => { calls.push('clearEscalation'); },
      commitsInRange: async () => { calls.push('commitsInRange'); return opts.commits; },
      affectedWorkspacesForRange: async (_from, to) => { calls.push(`affected:${to.slice(0, 7)}`); return opts.affected[to] ?? []; },
      log: () => {},
    };
    return { deps, calls };
  }

  beforeEach(() => { process.env.PAPERCUSP_PARTIAL_GREEN_GATE = '1'; });
  afterEach(() => { delete process.env.PAPERCUSP_PARTIAL_GREEN_GATE; });

  async function chain() {
    const c1 = await commit('a', '1', 'c1');
    await git(repo, ['branch', 'ready', c1]);
    const c2 = await commit('b', '2', 'c2'); // touches ws "other"
    const c3 = await commit('b', '3', 'c3'); // touches ws "other"
    const c4 = await commit('c', '4', 'c4'); // touches ws "failing" (the red tip)
    return { c1, c2, c3, c4 };
  }

  it('advances `main` to the longest GREEN prefix and holds the red tip', async () => {
    const { c2, c3, c4 } = await chain();
    const { deps, calls } = partialDeps({
      candidateFailingTests: ['@ws/failing'],
      affected: { [c2]: ['@ws/other'], [c3]: ['@ws/other'], [c4]: ['@ws/failing', '@ws/other'] },
      commits: [c2, c3, c4],
      confirmGreen: true,
    });
    const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });
    expect(r).toMatchObject({ advanced: true, reason: 'advanced-prefix', candidate: c4, advancedTo: c3, green: false });
    expect(r.failingTests).toEqual(['@ws/failing']); // red tip's signature preserved for the fixer
    expect(await revParse(repo, 'ready')).toBe(c3); // FF'd to the longest clean prefix, NOT the red tip
    expect(calls).toContain('runGreen:confirm');
    expect(calls).toContain('advance:' + c3.slice(0, 7));
  });

  it('holds (no advance) when the confirm-run on the prefix is RED — never FFs to unconfirmed', async () => {
    const { c1, c3, c4 } = await chain();
    const { deps } = partialDeps({
      candidateFailingTests: ['@ws/failing'],
      affected: { [c4]: ['@ws/failing'] }, // c3 not listed ⇒ clean ⇒ chosen as the prefix to confirm
      commits: [c3, c4],
      confirmGreen: false, // the chosen prefix did NOT confirm green ⇒ must hold
    });
    const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });
    expect(r.reason).toBe('not-green');
    expect(r.advanced).toBe(false);
    expect(await revParse(repo, 'ready')).toBe(c1); // unchanged — no FF to an unconfirmed commit
  });

  it('holds when the FIRST new commit already implicates a failing workspace (no clean prefix)', async () => {
    const { c1, c2, c3, c4 } = await chain();
    const { deps, calls } = partialDeps({
      candidateFailingTests: ['@ws/failing'],
      affected: { [c2]: ['@ws/failing'], [c3]: ['@ws/failing'], [c4]: ['@ws/failing'] },
      commits: [c2, c3, c4],
      confirmGreen: true,
    });
    const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });
    expect(r.reason).toBe('not-green');
    expect(await revParse(repo, 'ready')).toBe(c1); // unchanged
    expect(calls).not.toContain('runGreen:confirm'); // no clean prefix ⇒ never even confirms
  });

  it('holds when the failure is not workspace-localizable (only file-path / build failures)', async () => {
    const { c1, c2, c3, c4 } = await chain();
    const { deps } = partialDeps({
      candidateFailingTests: ['lib/foo.test.ts', '@papercusp/operator-vite'], // file path + build sentinel, no ws-name match
      affected: { [c4]: ['@ws/failing', '@ws/other'] },
      commits: [c2, c3, c4],
      confirmGreen: true,
    });
    const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });
    expect(r.reason).toBe('not-green'); // failingWs ∩ affected = ∅ ⇒ decline, don't guess
    expect(await revParse(repo, 'ready')).toBe(c1);
  });

  it('holds when there is only ONE new commit (the red tip itself — nothing behind it)', async () => {
    const c1 = await commit('a', '1', 'c1');
    await git(repo, ['branch', 'ready', c1]);
    const c2 = await commit('c', '2', 'c2'); // the single red commit
    const { deps, calls } = partialDeps({
      candidateFailingTests: ['@ws/failing'],
      affected: { [c2]: ['@ws/failing'] },
      commits: [c2],
      confirmGreen: true,
    });
    const r = await runGreenCheckpoint(cfg(), deps, { candidate: c2, noPush: true });
    expect(r.reason).toBe('not-green');
    expect(calls).not.toContain('runGreen:confirm');
  });

  it('is ON by default — without PAPERCUSP_PARTIAL_GREEN_GATE set, a red tip still salvages the green prefix', async () => {
    delete process.env.PAPERCUSP_PARTIAL_GREEN_GATE; // no arming needed (default-on, 2026-07-01)
    const { c3, c2, c4 } = await chain();
    const { deps } = partialDeps({
      candidateFailingTests: ['@ws/failing'],
      affected: { [c2]: ['@ws/other'], [c3]: ['@ws/other'], [c4]: ['@ws/failing'] },
      commits: [c2, c3, c4],
      confirmGreen: true,
    });
    const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });
    expect(r).toMatchObject({ advanced: true, reason: 'advanced-prefix', advancedTo: c3 });
  });

  it('opt-out: PAPERCUSP_PARTIAL_GREEN_GATE=0 holds a red candidate exactly as before (strict tip-only gating)', async () => {
    process.env.PAPERCUSP_PARTIAL_GREEN_GATE = '0';
    const { c1, c2, c3, c4 } = await chain();
    const { deps, calls } = partialDeps({
      candidateFailingTests: ['@ws/failing'],
      affected: { [c2]: ['@ws/other'], [c3]: ['@ws/other'], [c4]: ['@ws/failing'] },
      commits: [c2, c3, c4],
      confirmGreen: true,
    });
    const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });
    expect(r.reason).toBe('not-green'); // gate opted out ⇒ no salvage attempt
    expect(await revParse(repo, 'ready')).toBe(c1);
    expect(calls).not.toContain('commitsInRange'); // the salvage path never ran
  });
});

describe('quiet-cut — never judge a tip younger than the quiet window (2026-07-01)', () => {
  afterEach(() => {
    delete process.env.PAPERCUSP_QUIET_CUT;
    delete process.env.PAPERCUSP_QUIET_CUT_SEC;
    delete process.env.GIT_COMMITTER_DATE;
  });

  it('quietCutSecFromEnv: default 240, PAPERCUSP_QUIET_CUT=0 disables, _SEC tunes', () => {
    expect(quietCutSecFromEnv({})).toBe(240);
    expect(quietCutSecFromEnv({ PAPERCUSP_QUIET_CUT: '0' })).toBe(0);
    expect(quietCutSecFromEnv({ PAPERCUSP_QUIET_CUT_SEC: '60' })).toBe(60);
    expect(quietCutSecFromEnv({ PAPERCUSP_QUIET_CUT_SEC: 'junk' })).toBe(240);
  });

  /** Commit with a pinned committer date (rev-list --before + %ct read COMMITTER time). */
  async function datedCommit(file: string, msg: string, ageSec: number): Promise<string> {
    process.env.GIT_COMMITTER_DATE = new Date(Date.now() - ageSec * 1000).toISOString();
    try {
      return await commit(file, `${msg}\n`, msg);
    } finally {
      delete process.env.GIT_COMMITTER_DATE;
    }
  }

  it('fresh tip steps back to the newest quiet-window-old commit; the tip waits for the next run', async () => {
    const c1 = await datedCommit('a.txt', 'c1', 600); // 10 min old — the pin
    await git(repo, ['branch', 'ready', c1]);
    const c2 = await datedCommit('b.txt', 'c2', 300); // 5 min old — the quiet pick
    const c3 = await commit('c.txt', 'now\n', 'c3'); // seconds old — torn-risk tip
    const { deps } = stubDeps(true);
    const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });
    expect(r).toMatchObject({ advanced: true, candidate: c2, green: true });
    expect(await revParse(repo, 'ready')).toBe(c2); // advanced to the QUIET state, not the fresh tip
    expect(r.candidate).not.toBe(c3);
  });

  it('opt-out (PAPERCUSP_QUIET_CUT=0) judges the fresh tip exactly as before', async () => {
    const c1 = await datedCommit('a.txt', 'c1', 600);
    await git(repo, ['branch', 'ready', c1]);
    await datedCommit('b.txt', 'c2', 300);
    const c3 = await commit('c.txt', 'now\n', 'c3');
    process.env.PAPERCUSP_QUIET_CUT = '0';
    const { deps } = stubDeps(true);
    const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });
    expect(r).toMatchObject({ advanced: true, candidate: c3 });
  });

  it('a whole-repo-fresh history has no aged pick — the tip is judged (no stall on young repos)', async () => {
    const c1 = await commit('a.txt', 'x\n', 'c1');
    await git(repo, ['branch', 'ready', c1]);
    const c2 = await commit('b.txt', 'y\n', 'c2');
    const { deps } = stubDeps(true);
    const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });
    expect(r).toMatchObject({ advanced: true, candidate: c2 });
  });

  it('an explicit opts.candidate pin bypasses the quiet cut', async () => {
    const c1 = await datedCommit('a.txt', 'c1', 600);
    await git(repo, ['branch', 'ready', c1]);
    await datedCommit('b.txt', 'c2', 300);
    const c3 = await commit('c.txt', 'now\n', 'c3');
    const { deps } = stubDeps(true);
    const r = await runGreenCheckpoint(cfg(), deps, { noPush: true, candidate: c3 });
    expect(r).toMatchObject({ advanced: true, candidate: c3 });
  });
});

describe('pipelineName (EI-7646 — the pipeline-scoped verdict-key segment)', () => {
  it('is the sanitized basename of the integration root', async () => {
    const { pipelineName } = await import('./green-checkpoint');
    expect(pipelineName('/home/x/papercupai-workspace/papercusp')).toBe('papercusp');
    expect(pipelineName('/home/x/papercupai-workspace/papercup/')).toBe('papercup');
    expect(pipelineName('/weird/dir with spaces!')).toBe('dir-with-spaces-');
  });
});

describe('EI-15925 — the advance broadcast is attributable to its pipeline', () => {
  // Every co-hosted pot broadcasts to the SAME audience `*`. An unlabelled
  // "`main` advanced to <sha>" is indistinguishable between pipelines, and on
  // 2026-07-18 oddsmith's real 439b4037 was read fleet-wide as a papercusp
  // PHANTOM sha mid-release-decision. The label is what makes a release
  // broadcast safe to resolve a cut target from.
  it('prefixes the summary with the pipeline name and labels the sender', async () => {
    const sent: Array<{ summary: string; label: string }> = [];
    vi.doMock('@papercusp/operator-core/lib/agent-tools/coordination/messages', () => ({
      sendMessage: async (identity: { ownerLabel: string }, msg: { summary: string }) => {
        sent.push({ summary: msg.summary, label: identity.ownerLabel });
      },
    }));
    const deps = realCheckpointDeps(cfg());
    await deps.broadcast('🟩 green-checkpoint: `ready` advanced to 439b4037 (green, deployable)');

    // `repo` is the mkdtemp integration root, so the pipeline is its basename.
    const pipeline = pipelineName(repo);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.summary).toBe(
      `[${pipeline}] 🟩 green-checkpoint: \`ready\` advanced to 439b4037 (green, deployable)`,
    );
    expect(sent[0]!.label).toBe(`green-checkpoint[${pipeline}]`);
    vi.doUnmock('@papercusp/operator-core/lib/agent-tools/coordination/messages');
  });
});
