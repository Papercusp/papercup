/**
 * Green-checkpoint orchestration — the advance-only-when-green + FF-only rules
 * are what keep `ready` a trustworthy deployable pin. Real temp repo for the ref
 * logic; stub deps for the (heavy) suite run.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runGreenCheckpoint,
  runCmd,
  quietCutSecFromEnv,
  extractFailingTests,
  extractFailingTestNames,
  extractFailingCasesByFile,
  describeFailingCases,
  validateFailingTestPaths,
  ISOLATION_MAX_NAMED_CASES,
  stripAnsi,
  classifyRedAgainstTip,
  describeRealRedAtTip,
  splitTipFailuresPerFile,
  TIP_SPLIT_MAX_FILES,
  nonTestGateIdsFrom,
  parseFailingTaskId,
  isRerunnableGateEntry,
  resolveGateRuns,
  describeSkippedRetriage,
  NON_TEST_GATE_SCRIPTS,
  autoRefireCapFromEnv,
  normaliseFailingKey,
  refireOverlap,
  mergeFailingKeys,
  refireAbsoluteCeiling,
  refireDeadlineExceeded,
  refireRunBudgetMsFromEnv,
  refireBudgetInputs,
  nextRefireOpts,
  DEFAULT_REFIRE_RUN_BUDGET_MS,
  evaluateDeployStaleness,
  buildGreenCheckpointEnv,
  sanitizeForkNodeOptions,
  GREEN_CHECKPOINT_FORK_HEAP_MB,
  GREEN_CHECKPOINT_POST_SUITE_HEAP_MB,
  runPostSuiteLegs,
  checkpointFailureSignature,
  historicalFlakeAnnotations,
  summarizeSuiteOutput,
  parseTestQuarantine,
  applyTestQuarantine,
  isQuarantinedTestFile,
  parseFailingFilesByWorkspace,
  decideFlakeAbsorption,
  decideConcurrencyConfirmation,
  attemptFlakeAbsorption,
  ISOLATION_MAX_FILES,
  ISOLATION_RETRY_MAX,
  ISOLATION_LOAD_STARVATION_MIN_MS,
  ISOLATION_LOAD_STARVATION_MIN_LOAD_PER_CORE,
  isDeterministicFailureShape,
  outputHasTimingSignature,
  outputHasAssertionSignature,
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
  formatGatePromotionTrailer,
  recordOrchestratorLine,
  resetOrchestratorLog,
  renderOrchestratorTranscript,
  pipelineName,
  formatGateLineageLine,
  computeGateLineage,
  matchFailingFilesToChanged,
  unmatchedFailingFiles,
  failingFilesUncommitted,
  type GateLineage,
  type CheckpointDeps,
  type CheckpointExec,
  type FailingFile,
  type IsolationResult,
  type WorkspaceRerunResult,
  // WI-37605: re-exported from green-checkpoint.ts (:961). Used so the persisted-log header
  // assertion resolves the tag instead of hardcoding the production literal.
  orchestratorStdoutTag,
} from './green-checkpoint';
import { git, revParse, advanceReady } from './git-ops';
import { releaseConfig } from './release-config';
import { formatFailingFilesLine } from '../../../../scripts/lib/vitest-summary.mjs';

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

describe('in-flight candidate publication', () => {
  it('awaits marker publication before checkpoint tree setup begins', async () => {
    const ready = await commit('a', '1', 'ready');
    await git(repo, ['branch', 'ready', ready]);
    await commit('b', '2', 'candidate');
    const { deps } = stubDeps(true);
    const order: string[] = [];
    deps.recordInFlightCandidate = async () => {
      await Promise.resolve();
      order.push('published');
    };
    deps.setupTree = async () => {
      order.push('setup');
    };

    await runGreenCheckpoint(cfg(), deps, { noPush: true });

    expect(order.slice(0, 2)).toEqual(['published', 'setup']);
  });
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

  // WI-7013: green-checkpoint's push() carries the pre-FF `ready` sha as its second
  // arg so the dispatched test.yml run can diff against what this promotion actually
  // changed instead of comparing the pushed tip to itself (green by vacuity —
  // AFFECTED_BASE defaulting to origin/main, which on a workflow_dispatch run
  // checked out at main IS the same commit as HEAD).
  it('WI-7013: push is called with the pre-FF sha (AdvanceResult.from) as its baseSha arg', async () => {
    const c1 = await commit('a', '1', 'c1');
    await git(repo, ['branch', 'ready', c1]);
    const c2 = await commit('a', '2', 'c2');
    const { deps } = stubDeps(true);
    const pushCalls: Array<{ ref: string; baseSha?: string | null }> = [];
    deps.push = async (ref, baseSha) => {
      pushCalls.push({ ref, baseSha });
    };
    const r = await runGreenCheckpoint(cfg(), deps, {}); // noPush NOT set — push actually runs
    expect(r).toMatchObject({ advanced: true, candidate: c2, green: true, reason: 'advanced' });
    expect(pushCalls).toEqual([{ ref: 'ready', baseSha: c1 }]);
  });

  // The dual: on the VERY FIRST advance (no prior `ready` branch), AdvanceResult.from
  // is `null` — push must be called with that `null` verbatim (never a stale/guessed
  // sha), so dispatchCiWorkflow correctly omits the `base` input and test.yml falls
  // back to its unchanged origin/main default.
  it('WI-7013: push is called with baseSha=null when `ready` is created fresh (no prior tip to diff from)', async () => {
    const c1 = await commit('a', '1', 'c1'); // candidate; no `ready` branch exists yet
    const { deps } = stubDeps(true);
    const pushCalls: Array<{ ref: string; baseSha?: string | null }> = [];
    deps.push = async (ref, baseSha) => {
      pushCalls.push({ ref, baseSha });
    };
    const r = await runGreenCheckpoint(cfg(), deps, {});
    expect(r).toMatchObject({ advanced: true, candidate: c1, green: true, reason: 'advanced' });
    expect(pushCalls).toEqual([{ ref: 'ready', baseSha: null }]);
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

  /**
   * WI-7069 — the selection→suite gap is MEASURED and REPORTED.
   *
   * The 2026-08-02 12:53Z verdict judged a commit committed 10h51m earlier. Selection was
   * provably CORRECT (the quiet-cut could only have returned that sha for a cutoff inside a
   * 2-minute window), so the age accumulated AFTER selection — during setupTree/preflights —
   * and nothing recorded that interval. With no selected-at stamp, "the candidate was old" and
   * "selection chose badly" are indistinguishable, which is what turned a diagnosis into hours
   * of git archaeology and produced four contradictory conclusions across the fleet.
   *
   * These pin the INSTRUMENT, not a kill bound: the run must still judge in both cases.
   */
  it('WI-7069: reports the selection→suite gap before judging, and stays QUIET on a healthy run', async () => {
    const c1 = await commit('a', '1', 'c1');
    await git(repo, ['branch', 'ready', c1]);
    await commit('a', '2', 'c2');
    const logs: string[] = [];
    const { deps, calls } = stubDeps(true);
    const priorLog = deps.log;
    deps.log = (s: string) => {
      logs.push(s);
      priorLog?.(s);
    };
    await runGreenCheckpoint(cfg(), deps, { noPush: true });
    const line = logs.find((l) => l.includes('candidate-age:')) ?? '';
    expect(line).toContain('judging it now');
    // A fast run must NOT carry the warning — a detector that fires on the healthy case is
    // worse than none (this file's own EI-10609 lesson).
    expect(line).not.toContain('⚠');
    expect(line).not.toContain('STALE tree');
    // Purely diagnostic: the run still judges.
    expect(calls).toContain('runGreen');
  });

  it('⭐ WI-7069: a long stretch between selection and the suite WARNS that the verdict describes a stale tree — and still judges', async () => {
    const c1 = await commit('a', '1', 'c1');
    await git(repo, ['branch', 'ready', c1]);
    await commit('a', '2', 'c2');
    const logs: string[] = [];
    const { deps, calls } = stubDeps(true);
    const priorLog = deps.log;
    deps.log = (s: string) => {
      logs.push(s);
      priorLog?.(s);
    };
    // Reproduce the real failure shape: the candidate is selected, then a step BETWEEN
    // selection and the suite blocks for a long time. Advancing a Date.now offset from inside
    // setupTree exercises the ACTUAL code path (real awaits, real git) rather than stubbing
    // the measurement the test exists to verify.
    const realNow = Date.now.bind(Date);
    let offsetMs = 0;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + offsetMs);
    try {
      const priorSetup = deps.setupTree;
      deps.setupTree = async (ref: string) => {
        offsetMs = 45 * 60_000; // 45m, past the 20m budget
        return priorSetup?.(ref);
      };
      await runGreenCheckpoint(cfg(), deps, { noPush: true });
    } finally {
      nowSpy.mockRestore();
    }
    const line = logs.find((l) => l.includes('candidate-age:')) ?? '';
    expect(line).toContain('⚠');
    expect(line).toContain('45m ago');
    expect(line).toContain('STALE tree');
    // It must point at the RIGHT culprit — the whole purpose is that the next reader stops
    // suspecting candidate selection, which is where the 2026-08-02 investigation went wrong.
    expect(line).toContain('not a bad candidate choice');
    expect(line).toContain('WI-7069');
    // Diagnostic ONLY — never blocks, re-cuts, or changes the advance/hold decision.
    expect(calls).toContain('runGreen');
  });

  /**
   * WI-7069 — `killProcessGroupOnTimeout` must reach a GRANDCHILD process, not just the
   * direct child. setupTree's own shell scripts fork further children (git/cp/npm); a plain
   * `child.kill('SIGKILL')` on timeout reaches only the direct `bash` process and ORPHANS
   * whatever it forked, which is the exact half-written-checkout risk this option closes.
   * These two tests are each other's teeth: same repro shape, opposite expected outcome,
   * driven only by the flag under test.
   */
  it('WI-7069: killProcessGroupOnTimeout reaches a GRANDCHILD process, not just the direct child', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'green-checkpoint-grandchild-'));
    const pidfile = join(dir, 'pid');
    try {
      await expect(
        runCmd('bash', ['-c', `sleep 20 & echo $! > ${pidfile}; sleep 20`], {
          timeoutMs: 500,
          killProcessGroupOnTimeout: true,
        }),
      ).rejects.toThrow(/timed out/);
      await new Promise((r) => setTimeout(r, 200));
      const pid = Number(readFileSync(pidfile, 'utf8').trim());
      let alive = true;
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
      }
      // The backgrounded grandchild must be dead too — the group-kill reached it.
      expect(alive).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('WI-7069: WITHOUT killProcessGroupOnTimeout, a timeout kill orphans the grandchild — documents the bug this option closes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'green-checkpoint-grandchild-'));
    const pidfile = join(dir, 'pid');
    let pid: number | undefined;
    try {
      await expect(
        runCmd('bash', ['-c', `sleep 20 & echo $! > ${pidfile}; sleep 20`], {
          timeoutMs: 500,
        }),
      ).rejects.toThrow(/timed out/);
      await new Promise((r) => setTimeout(r, 200));
      pid = Number(readFileSync(pidfile, 'utf8').trim());
      let alive = true;
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
      }
      // Without the flag, only the direct `bash` child is killed — the backgrounded
      // grandchild survives as an orphan. This is the bug `killProcessGroupOnTimeout` fixes.
      expect(alive).toBe(true);
    } finally {
      // Clean up the orphan so it doesn't linger on the shared box.
      if (pid) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }
      rmSync(dir, { recursive: true, force: true });
    }
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

  it('EI-19370028836452003: a not-green verdict is APPENDED to the candidate log, so the file named for a candidate carries that candidate\'s OWN verdict', async () => {
    // The regression: runGreen WRITES the per-candidate log before the not-green
    // verdict block runs, so `...-cand-<X>.log` never contained X's own lineage /
    // already-fixed-since notes — they landed in the NEXT pass's log, or nowhere.
    // Measured 2026-08-02 on three consecutive real verdict logs: two had no lineage
    // line at all and the third's named the PREVIOUS candidate. A triaging agent reads
    // that absence as "no staleness note, so this is a real red" — the exact false
    // negative the lineage line exists to prevent.
    const c1 = await commit('a', '1', 'c1');
    await git(repo, ['branch', 'ready', c1]);
    await commit('a', '2', 'c2');
    const logDir = mkdtempSync(join(tmpdir(), 'gc-verdict-log-'));
    const logPath = join(logDir, 'stamp-base-deadbeef-cand-cafebabe.log');
    // Stand in for what runGreen already wrote: a header plus the suite body.
    writeFileSync(logPath, '[green-checkpoint] candidate=... green=false\nSUITE BODY MARKER\n');
    const deps: CheckpointDeps = {
      setupTree: async () => {},
      runGreen: async () => ({ green: false, summary: '1 failed', failingTests: ['a.test.ts'], logPath }),
      advance: (candidate) => advanceReady(repo, candidate, 'ready'),
      push: async () => {},
      broadcast: async () => {},
      escalate: async () => {},
      clearEscalation: async () => {},
      emitEvent: async () => {},
      log: () => {},
    };
    const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });
    const body = readFileSync(logPath, 'utf8');
    rmSync(logDir, { recursive: true, force: true });
    // APPENDED, not rewritten — the suite body a triager greps must survive.
    expect(body).toContain('SUITE BODY MARKER');
    // ...and the verdict for THIS candidate is now in THIS file.
    expect(body).toContain(`[green-checkpoint verdict for candidate ${r.candidate.slice(0, 8)}]`);
    expect(body).toContain(`candidate ${r.candidate.slice(0, 8)} is NOT green`);
  });

  // WI-9613: a red whose ONLY cause is a post-suite LEG must name that leg in its own log.
  //
  // Reproduces candidate dca4c291 (real verdict 2026-08-03T17:27:30Z, part of the 6-red
  // streak that held main at 5b898b7b for ~4h): the suite PASSED
  // (`AFFECTED_TESTS_RESULT status=passed tasks=58 failed=0`), there was no
  // AFFECTED_TESTS_FAILING_FILES line at all, and no `FAILED (npm run ...)` line — so both
  // lines the repo's triage guidance names came back empty on a genuine red. The true cause
  // (`lint:no-control-bytes`) occurred twice in 12,562 lines, both inside the leg's own
  // output block, and never in a line that says "this is what held the gate".
  //
  // FALSIFIABILITY (self-contained, no tree mutation — see CLAUDE.md "Proving a guard is
  // falsifiable"): the pre-written body below is fixed and contains NO leg name, and
  // `failingTests` here carries a leg signature and NO test file. So the leg name can appear
  // in the final body ONLY via the verdict block's canonical line. If that emission is
  // removed, this assertion cannot pass by accident.
  it('WI-9613: a lint-leg-only red names the leg in the verdict log (GATE_HELD_BY)', async () => {
    const c1 = await commit('a', '1', 'c1');
    await git(repo, ['branch', 'ready', c1]);
    await commit('a', '2', 'c2');
    const logDir = mkdtempSync(join(tmpdir(), 'gc-heldby-log-'));
    const logPath = join(logDir, 'stamp-base-deadbeef-cand-cafebabe.log');
    // Stands in for what runGreen already wrote. Deliberately contains NEITHER the leg
    // name NOR any AFFECTED_TESTS_FAILING_FILES / "FAILED (npm run" line — i.e. exactly
    // the dca4c291 shape a triager could not resolve.
    writeFileSync(logPath, '[green-checkpoint] candidate=... green=false\nSUITE BODY MARKER\n');
    const deps: CheckpointDeps = {
      setupTree: async () => {},
      // The leg signature with NO failing test file — runGreen folds legs.failingSignatures
      // into failingTests (~L5715), so this is the real shape of a lint-only red.
      runGreen: async () => ({
        green: false,
        summary: 'lint leg failed',
        failingTests: ['lint:no-control-bytes'],
        logPath,
      }),
      advance: (candidate) => advanceReady(repo, candidate, 'ready'),
      push: async () => {},
      broadcast: async () => {},
      escalate: async () => {},
      clearEscalation: async () => {},
      emitEvent: async () => {},
      log: () => {},
    };
    const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });
    const body = readFileSync(logPath, 'utf8');
    rmSync(logDir, { recursive: true, force: true });
    expect(r.green).toBe(false);
    // The suite body a triager greps still survives (append, not rewrite).
    expect(body).toContain('SUITE BODY MARKER');
    // ⭐ The decisive one: the log now states its OWN red cause, greppably.
    expect(body).toContain('GATE_HELD_BY');
    expect(body).toContain('lint:no-control-bytes');
    // The canonical line must be the thing that carries it — not incidental prose.
    const heldByLine = body.split('\n').find((l) => l.includes('GATE_HELD_BY'));
    expect(heldByLine).toBeDefined();
    expect(heldByLine).toContain('lint:no-control-bytes');
    expect(heldByLine).toContain('count=1');
    // Guards the `AFFECTED_TESTS_RESULT failed=N` misread class: the label must say what
    // the entries ARE, so the count is never read as a failing-FILE count.
    expect(body).toMatch(/LEG signatures AND failing TEST files/);
    // Sibling of the unattributed case below: when there ARE entries the line must say so,
    // so `attribution=` can never be read as decorative.
    expect(heldByLine).toContain('attribution=attributed');
  });

  it('EI-19988460746986622: a red with NO attributable failing entries still emits GATE_HELD_BY, as count=0 attribution=unattributed — never silence', async () => {
    const c1 = await commit('a', '1', 'c1');
    await git(repo, ['branch', 'ready', c1]);
    await commit('a', '2', 'c2');
    const logDir = mkdtempSync(join(tmpdir(), 'gc-heldby-unattributed-'));
    const logPath = join(logDir, 'stamp-base-deadbeef-cand-cafebabe.log');
    writeFileSync(logPath, '[green-checkpoint] candidate=... green=false\nSUITE BODY MARKER\n');
    const deps: CheckpointDeps = {
      setupTree: async () => {},
      // The shape this guards: a genuine red whose entries could NOT be attributed. Reached
      // via the SUITE route (r.code !== 0) when extractFailingTests parses nothing out of the
      // output — recorded as having really happened at green-checkpoint.ts ~L1048. Before the
      // fix this emitted NO GateHeldBy line at all, which reads as "nothing held it".
      runGreen: async () => ({
        green: false,
        summary: 'suite failed but nothing could be attributed',
        failingTests: [],
        logPath,
      }),
      advance: (candidate) => advanceReady(repo, candidate, 'ready'),
      push: async () => {},
      broadcast: async () => {},
      escalate: async () => {},
      clearEscalation: async () => {},
      emitEvent: async () => {},
      log: () => {},
    };
    const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });
    const body = readFileSync(logPath, 'utf8');
    rmSync(logDir, { recursive: true, force: true });
    expect(r.green).toBe(false);
    expect(body).toContain('SUITE BODY MARKER');
    // ⭐ The decisive one: the line EXISTS on a red that named nothing. Its whole failure
    // mode was silence, so asserting presence is the point of the test.
    expect(body).toContain('GATE_HELD_BY');
    const heldByLine = body.split('\n').find((l) => l.includes('GATE_HELD_BY'));
    expect(heldByLine).toBeDefined();
    expect(heldByLine).toContain('count=0');
    expect(heldByLine).toContain('entries=[]');
    // The status must be explicit, so count=0 is never read as "the gate held on nothing".
    expect(heldByLine).toContain('attribution=unattributed');
    expect(heldByLine).not.toContain('attribution=attributed');
    // And the reader must be told what count=0 does NOT mean.
    expect(body).toMatch(/NOT "nothing held it"/);
  });

  // WI-7482: the re-triage verdict must reach the persisted log on the NON-refiring paths.
  //
  // Same write-before-compute shape as the lineage regression above, one field over — and it
  // survived that fix. The re-triage's only output was `deps.log`, which runGreen snapshots via
  // renderOrchestratorTranscript() BEFORE the verdict block runs, and the append above composes
  // lineage/already-fixed/historical-flake only. So "the gate re-ran this red at tip and it
  // genuinely reproduced" and "the gate never looked" were byte-identical in the durable record.
  // gate_health couldn't disambiguate them either (retriageDetail is stale-candidate-ONLY), so
  // there was no channel left: three separate agents reconstructed this from raw logs on
  // 2026-08-02/03 and two got it wrong (EI-19388705187359206 blamed the parser and was retracted;
  // EI-19389700122825304).
  //
  // Both non-refiring classifications are covered, because they are the two readings that were
  // conflated and they demand OPPOSITE responses: `unknown` ⇒ the gate could not check, so check
  // it yourself; `real-red` ⇒ the gate DID check at tip and it still fails, so go fix it.
  for (const scenario of [
    {
      name: 'unknown (no tip runner wired — the gate could not check)',
      extraDeps: {} as Partial<CheckpointDeps>,
      failingFiles: undefined as { workspace: string; file: string }[] | undefined,
      expectClassification: 'unknown',
    },
    {
      name: 'real-red (the gate DID re-run at tip and the failures reproduced)',
      extraDeps: {
        resolveTip: async () => 'facefeed00000000000000000000000000000000',
        runTestsAtRef: async () => ({ pass: false, summary: 'ws: FAIL' }),
      } as Partial<CheckpointDeps>,
      failingFiles: [{ workspace: '@papercusp/operator-core', file: 'a.test.ts' }],
      expectClassification: 'real-red',
    },
  ]) {
    it(`WI-7482: the persisted verdict log carries the re-triage verdict — ${scenario.name}`, async () => {
      const c1 = await commit('a', '1', 'c1');
      await git(repo, ['branch', 'ready', c1]);
      await commit('a', '2', 'c2');
      const logDir = mkdtempSync(join(tmpdir(), 'gc-retriage-log-'));
      const logPath = join(logDir, 'stamp-base-deadbeef-cand-cafebabe.log');
      writeFileSync(logPath, '[green-checkpoint] candidate=... green=false\nSUITE BODY MARKER\n');
      const deps: CheckpointDeps = {
        setupTree: async () => {},
        runGreen: async () => ({
          green: false,
          summary: '1 failed',
          failingTests: ['a.test.ts'],
          ...(scenario.failingFiles ? { failingFiles: scenario.failingFiles } : {}),
          logPath,
        }),
        advance: (candidate) => advanceReady(repo, candidate, 'ready'),
        push: async () => {},
        broadcast: async () => {},
        escalate: async () => {},
        clearEscalation: async () => {},
        emitEvent: async () => {},
        log: () => {},
        ...scenario.extraDeps,
      };
      const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });
      const body = readFileSync(logPath, 'utf8');
      rmSync(logDir, { recursive: true, force: true });
      // Appended, never rewritten — the suite tail a triager greps must survive both appends.
      expect(body).toContain('SUITE BODY MARKER');
      expect(body).toContain(`[green-checkpoint verdict for candidate ${r.candidate.slice(0, 8)}]`);
      // The regression guard proper: the classification is IN the file, and machine-greppable.
      expect(body).toContain(`[green-checkpoint re-triage for candidate ${r.candidate.slice(0, 8)}]`);
      expect(body).toContain(`classification=${scenario.expectClassification}`);
      // A reader must be able to tell a held gate from one that simply had no rescue budget.
      expect(body).toContain('autoRefire=false');
    });
  }

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

    // EI-19390159514676981 / EI-19394456914198611. A real-red presumption needs the
    // range to be EMPTY, not merely to exclude the failing test files. This fixture
    // previously asserted the confident wording with the range UNMEASURED, which is
    // precisely the defect: for any test that polices OTHER files (prompt-weight
    // budget, NUL/source-integrity lints, claim-door census, tools-md-sync) the fix
    // lands in the policed SOURCE and the test file is never touched — so an empty
    // `failingFilesChangedInRange` is the expected shape of an ALREADY-FIXED red.
    // Measured 2026-08-03 on candidate 060ea000: the line claimed "presumptively a
    // real red" while all 11 failing files were already green at HEAD.
    it('formatGateLineageLine: only the range being EMPTY licenses a real-red presumption', () => {
      const lineage: GateLineage = {
        candidate: 'c'.repeat(40),
        tip: 't'.repeat(40),
        commitsBehind: 4,
        failingFilesChangedInRange: [],
        failingPathsConsidered: 3,
        rangeFilesChanged: 0, // the range genuinely changed nothing
      };
      const line = formatGateLineageLine(lineage);
      expect(line).toContain('4 commit(s) behind tip');
      expect(line).toContain('nothing at all changed in that range');
      expect(line).toContain('a real red');
    });

    it('formatGateLineageLine: range changed OTHER files — UNDETERMINED, not a real red', () => {
      const lineage: GateLineage = {
        candidate: 'c'.repeat(40),
        tip: 't'.repeat(40),
        commitsBehind: 4,
        failingFilesChangedInRange: [],
        failingPathsConsidered: 3,
        rangeFilesChanged: 12, // the fix may well be in one of these
      };
      const line = formatGateLineageLine(lineage);
      expect(line).toContain('skew UNDETERMINED');
      expect(line).toContain('12 other file(s) did');
      expect(line).toContain('re-run each failing file at tip');
      // The false-confidence phrasing must be GONE, not merely softened.
      expect(line).not.toContain('presumptively a real red');
    });

    // EI-19393306381214544: `extractFailingTests` also emits bare workspace NAMES
    // (`@papercusp/web`), which can never match a changed FILE. With no path-shaped
    // entry there was nothing to intersect, so the empty result compared NOTHING.
    it('formatGateLineageLine: no path-shaped failing entry — the empty match is vacuous', () => {
      const lineage: GateLineage = {
        candidate: 'c'.repeat(40),
        tip: 't'.repeat(40),
        commitsBehind: 4,
        failingFilesChangedInRange: [],
        failingPathsConsidered: 0,
      };
      const line = formatGateLineageLine(lineage);
      expect(line).toContain('no failing entry was path-shaped');
      expect(line).toContain('skew UNDETERMINED');
      expect(line).not.toContain('presumptively a real red');
    });

    // A legacy/unmeasured record must degrade to UNDETERMINED, never be upgraded to
    // confidence — absence of a measurement is not evidence that the range was empty.
    it('formatGateLineageLine: an UNMEASURED range never reads as a real red', () => {
      const lineage: GateLineage = {
        candidate: 'c'.repeat(40),
        tip: 't'.repeat(40),
        commitsBehind: 4,
        failingFilesChangedInRange: [],
        failingPathsConsidered: 2,
        // rangeFilesChanged deliberately absent
      };
      const line = formatGateLineageLine(lineage);
      expect(line).toContain('skew UNDETERMINED');
      expect(line).not.toContain('presumptively a real red');
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

    it('EI-20215068298600724: a mixed match keeps unmatched failing files UNDETERMINED', () => {
      const lineage: GateLineage = {
        candidate: 'c'.repeat(40),
        tip: 't'.repeat(40),
        commitsBehind: 4,
        failingFilesChangedInRange: ['packages/operator-core/lib/a.test.ts'],
        failingFilesUnchangedInRange: ['lib/b.test.ts', 'lib/c.test.ts'],
        failingPathsConsidered: 3,
        rangeFilesChanged: 12,
      };
      const line = formatGateLineageLine(lineage);
      expect(line).toContain('presumptively STALE');
      expect(line).toContain('2 other failing file(s) were NOT MODIFIED');
      expect(line).toContain('their skew is UNDETERMINED');
      expect(line).toContain('lib/b.test.ts');
      expect(line).toContain('lib/c.test.ts');
      expect(line).not.toContain('a real red');
    });

    // EI-19365565179927273. "presumptively a real red" is a claim about the WHOLE range,
    // so it may only be made when the whole range was readable. A moved-but-undiffable
    // submodule makes part of it unknown — and an agent acting on a false "real red" goes
    // and "fixes" already-correct files (6 embedder tests, on the 18:02:15Z verdict).
    it('formatGateLineageLine: an unexpandable submodule downgrades "real red" to UNDETERMINED', () => {
      const lineage: GateLineage = {
        candidate: 'c'.repeat(40),
        tip: 't'.repeat(40),
        commitsBehind: 4,
        failingFilesChangedInRange: [],
        submodulesUnexpanded: ['libs/generic/memory'],
      };
      const line = formatGateLineageLine(lineage);
      expect(line).toContain('skew UNDETERMINED');
      expect(line).toContain('libs/generic/memory');
      // The false-confidence phrasing must be GONE, not merely accompanied by a caveat.
      expect(line).not.toContain('presumptively a real red');
    });

    it('formatGateLineageLine: an empty submodulesUnexpanded does not by itself downgrade the verdict', () => {
      // The submodule leg is only ONE of the ways confidence is withheld; with it empty
      // the verdict falls through to the range check, which here IS empty — so this
      // still reads as a real red, on the range evidence rather than by default.
      const lineage: GateLineage = {
        candidate: 'c'.repeat(40),
        tip: 't'.repeat(40),
        commitsBehind: 4,
        failingFilesChangedInRange: [],
        submodulesUnexpanded: [],
        failingPathsConsidered: 2,
        rangeFilesChanged: 0,
      };
      expect(formatGateLineageLine(lineage)).toContain('a real red');
    });

    it('formatGateLineageLine: a matched file still wins, but an unreadable submodule is disclosed', () => {
      // STALE is the actionable verdict and must not be suppressed — but the reader is
      // still told part of the range was unreadable, so "only one file matched" is not
      // mistaken for a complete accounting.
      const lineage: GateLineage = {
        candidate: 'c'.repeat(40),
        tip: 't'.repeat(40),
        commitsBehind: 4,
        failingFilesChangedInRange: ['src/a.test.ts'],
        submodulesUnexpanded: ['libs/test-config'],
      };
      const line = formatGateLineageLine(lineage);
      expect(line).toContain('presumptively STALE');
      expect(line).toContain('also unreadable: libs/test-config');
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

    // EI-19324432490048782 / EI-19324146335802876. The test ABOVE passes a failing file at
    // the repo ROOT (`src/failing.test.ts`) — the one position where vitest's
    // workspace-relative vocabulary and git's repo-relative vocabulary coincide. Every real
    // failing file lives INSIDE a workspace, where they cannot coincide, so the old
    // exact-equality intersection was empty on every real gate run while this suite stayed
    // green. These cases pin the real shape.
    it('computeGateLineage: matches a workspace-relative failing file against a repo-relative change (the shape that was empty by construction)', async () => {
      const c1 = await commit('a', '1', 'c1');
      await git(repo, ['branch', 'ready', c1]);
      const candidate = await commit('a', '2', 'c2 — the candidate');
      await commit('packages/operator-core/lib/sync-resolver/sync-read-audit.test.ts', 'fixed', 'c3');
      const tip = await commit('other.ts', 'y', 'c4');
      // Exactly what the gate passes: vitest's workspace-relative path, plus the bare
      // workspace NAMES extractFailingTests also emits (never paths, must not match).
      const lineage = await computeGateLineage(repo, 'main', candidate, [
        '@papercusp/operator-core',
        'lib/sync-resolver/sync-read-audit.test.ts',
      ]);
      expect(lineage).not.toBeNull();
      expect(lineage!.tip).toBe(tip);
      // The REPO-relative path is what the reader can act on.
      expect(lineage!.failingFilesChangedInRange).toEqual([
        'packages/operator-core/lib/sync-resolver/sync-read-audit.test.ts',
      ]);
    });

    it('computeGateLineage: records failing files whose fixes may have landed in their subjects', async () => {
      const c1 = await commit('a', '1', 'c1');
      await git(repo, ['branch', 'ready', c1]);
      const candidate = await commit('a', '2', 'c2 — the candidate');
      await commit('src/a.test.ts', 'fixed', 'c3 — changes one failing test file');
      await commit('src/subject.ts', 'fixed', 'c4 — changes a subject, not the other failing test file');
      const tip = await commit('other.ts', 'y', 'c5');
      const lineage = await computeGateLineage(repo, 'main', candidate, ['src/a.test.ts', 'src/b.test.ts']);
      expect(lineage).not.toBeNull();
      expect(lineage!.tip).toBe(tip);
      expect(lineage!.failingFilesChangedInRange).toEqual(['src/a.test.ts']);
      expect(lineage!.failingFilesUnchangedInRange).toEqual(['src/b.test.ts']);
      expect(formatGateLineageLine(lineage!)).toContain('src/b.test.ts');
    });

    it('matchFailingFilesToChanged: skips workspace names, needs a path boundary, dedupes', () => {
      // A workspace name is not a file, even though it contains a slash.
      expect(matchFailingFilesToChanged(['@papercusp/web'], ['apps/web'])).toEqual([]);
      // Suffix must land on a path boundary — `audit.test.ts` must not match `read-audit.test.ts`.
      expect(matchFailingFilesToChanged(['audit.test.ts'], ['packages/x/lib/read-audit.test.ts'])).toEqual([]);
      // Unchanged failing file ⇒ no match (the presumptively-real-red signal must survive).
      expect(matchFailingFilesToChanged(['lib/a.test.ts'], ['packages/x/lib/b.test.ts'])).toEqual([]);
      // Two failing entries resolving to one changed file are reported once.
      expect(
        matchFailingFilesToChanged(
          ['lib/a.test.ts', 'packages/x/lib/a.test.ts'],
          ['packages/x/lib/a.test.ts'],
        ),
      ).toEqual(['packages/x/lib/a.test.ts']);
    });

    it('unmatchedFailingFiles: returns only path-shaped failures absent from the range', () => {
      expect(
        unmatchedFailingFiles(
          ['@papercusp/operator-core', 'lib/a.test.ts', 'lib/b.test.ts'],
          ['packages/operator-core/lib/a.test.ts', 'packages/other/lib/subject.ts'],
        ),
      ).toEqual(['lib/b.test.ts']);
    });

    it('computeGateLineage: candidate IS the tip', async () => {
      const c1 = await commit('a', '1', 'c1');
      await git(repo, ['branch', 'ready', c1]);
      const candidate = await commit('a', '2', 'c2');
      const lineage = await computeGateLineage(repo, 'main', candidate, ['src/failing.test.ts']);
      expect(lineage).toEqual({ candidate, tip: candidate, commitsBehind: 0, failingFilesChangedInRange: [] });
    });

    /* ── EI-20063423357086565: the fix is ON DISK but not committed ─────────────────
     * Every discriminator above compares COMMITS, so none of them can see a fix that
     * exists only in the working tree. The blindness is worst exactly where this record
     * is most confident: `commitsBehind === 0` returns "nothing newer to blame, this is
     * a real red". Measured incident — git-sync stalled ~31min while a complete fix sat
     * in the tree, the gate re-judged the same tip twice more, `main` froze ~1h behind
     * staging, and every red read as "my fix didn't work" instead of "my fix was never
     * committed".
     */

    /** Write a file WITHOUT committing it — the incident's actual shape. */
    function writeUncommitted(file: string, content: string): void {
      const full = join(repo, file);
      mkdirSync(join(full, '..'), { recursive: true });
      writeFileSync(full, content);
    }

    it('formatGateLineageLine: candidate IS the tip but a failing file is dirty — the real-red presumption is WITHHELD', () => {
      const base: GateLineage = {
        candidate: 'a'.repeat(40),
        tip: 'a'.repeat(40),
        commitsBehind: 0,
        failingFilesChangedInRange: [],
      };
      // CONTROL: the SAME record without a dirty file still produces the confident wording.
      // Without this pair, the assertion below would also pass against a formatter that
      // had simply stopped saying "real red" for every input.
      expect(formatGateLineageLine(base)).toContain('this is a real red');

      const line = formatGateLineageLine({
        ...base,
        failingFilesDirtyUncommitted: ['packages/operator-core/lib/a.test.ts'],
      });
      expect(line).not.toContain('this is a real red');
      expect(line).toContain('NOT a confirmed real red');
      expect(line).toContain('ALREADY-ON-DISK, NOT COMMITTED');
      expect(line).toContain('packages/operator-core/lib/a.test.ts');
      // The actionable half — a diagnosis with no next step is what cost the hour.
      expect(line).toContain('dev:pipeline_position');
    });

    it('formatGateLineageLine: the dirty note also lands on the commits-behind verdict, and lands LAST', () => {
      const line = formatGateLineageLine({
        candidate: 'c'.repeat(40),
        tip: 't'.repeat(40),
        commitsBehind: 4,
        failingFilesChangedInRange: [],
        failingPathsConsidered: 2,
        rangeFilesChanged: 0, // the range genuinely changed nothing ⇒ "a real red"
        failingFilesDirtyUncommitted: ['packages/x/lib/b.test.ts'],
      });
      // The commit-based discriminator still speaks for itself...
      expect(line).toContain('nothing at all changed in that range');
      // ...but it must not be the last word, because it was computed over commits only.
      expect(line).toContain('ALREADY-ON-DISK, NOT COMMITTED');
      expect(line.indexOf('ALREADY-ON-DISK')).toBeGreaterThan(line.indexOf('nothing at all changed'));
    });

    it('computeGateLineage: names a failing file whose fix is written but NOT committed (the incident, end to end)', async () => {
      const c1 = await commit('a', '1', 'c1');
      await git(repo, ['branch', 'ready', c1]);
      const candidate = await commit(
        'packages/operator-core/lib/sync-read-audit.test.ts',
        'broken',
        'c2 — the candidate',
      );

      // CONTROL: committed and clean ⇒ nothing reported, confident wording intact. This is
      // what proves the positive below is caused by the DIRTY WRITE and not merely by the
      // file being named as failing.
      const clean = await computeGateLineage(repo, 'main', candidate, ['lib/sync-read-audit.test.ts']);
      expect(clean!.failingFilesDirtyUncommitted).toBeUndefined();
      expect(formatGateLineageLine(clean!)).toContain('this is a real red');

      // Now the fix is written to disk and git-sync has not swept it yet.
      writeUncommitted('packages/operator-core/lib/sync-read-audit.test.ts', 'fixed');
      const dirty = await computeGateLineage(repo, 'main', candidate, ['lib/sync-read-audit.test.ts']);
      // Every commit-based check still agrees this is the tip — that is the whole point.
      expect(dirty!.commitsBehind).toBe(0);
      // Reported REPO-relative, matched from vitest's WORKSPACE-relative entry
      // (the vocabulary skew that made the sibling signal empty-by-construction).
      expect(dirty!.failingFilesDirtyUncommitted).toEqual([
        'packages/operator-core/lib/sync-read-audit.test.ts',
      ]);
      expect(formatGateLineageLine(dirty!)).not.toContain('this is a real red');
    });

    it('computeGateLineage: an UNTRACKED new file counts as dirty (a diff against a commit cannot see it at all)', async () => {
      const c1 = await commit('a', '1', 'c1');
      await git(repo, ['branch', 'ready', c1]);
      const candidate = await commit('a', '2', 'c2 — the candidate');
      // A brand-new test file the candidate provably cannot contain.
      writeUncommitted('packages/operator-core/lib/brand-new.test.ts', 'it("x", () => {})');
      const lineage = await computeGateLineage(repo, 'main', candidate, ['lib/brand-new.test.ts']);
      expect(lineage!.failingFilesDirtyUncommitted).toEqual([
        'packages/operator-core/lib/brand-new.test.ts',
      ]);
    });

    it('computeGateLineage: a dirty file that is NOT among the failing tests is never reported', async () => {
      const c1 = await commit('a', '1', 'c1');
      await git(repo, ['branch', 'ready', c1]);
      const candidate = await commit('a', '2', 'c2 — the candidate');
      // On the shared tree dozens of unrelated files are dirty at any instant. The signal
      // is only worth anything if it stays scoped to the FAILING files.
      writeUncommitted('packages/operator-core/lib/unrelated.ts', 'noise');
      const lineage = await computeGateLineage(repo, 'main', candidate, ['lib/the-failing.test.ts']);
      expect(lineage!.failingFilesDirtyUncommitted).toBeUndefined();
    });

    it('failingFilesUncommitted: all-workspace-name failures are VACUOUS, not a measured "nothing dirty"', async () => {
      await commit('a', '1', 'c1');
      writeUncommitted('packages/operator-core/lib/x.test.ts', 'dirty');
      // Nothing path-shaped ⇒ nothing could be intersected (EI-19393306381214544's shape,
      // one field over). The empty answer must not be read as evidence of a clean tree.
      expect(await failingFilesUncommitted(repo, ['@papercusp/operator-core'])).toEqual([]);
      // CONTROL: the very same dirty file IS found once a path-shaped entry exists —
      // so the empty result above came from the vacuity guard, not from a broken reader.
      expect(await failingFilesUncommitted(repo, ['lib/x.test.ts'])).toEqual([
        'packages/operator-core/lib/x.test.ts',
      ]);
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

    // EI-19326481022404981: a caller may have armed `checkpoint:await { candidateSha: c2 }`
    // right after c2 was committed — before learning the gate's quiet-cut would immediately
    // re-triage it away onto a newer tip. Without cancelling that stale registration, the
    // caller's sha-bound wait has no way to learn THIS run moved on: its eventual verdict
    // fires keyed to c3 (never matching a `startsWith: c2` payload filter), so the caller
    // sleeps to its own multi-hour timeout, indistinguishable the whole time from "still
    // judging". This pins the fix — green-checkpoint.ts calling deps.cancelStaleAwaits /
    // deps.recordInFlightRetriage right before the recursive re-fire onto the new candidate.
    it('a STALE red that REFIRES cancels any checkpoint:await bound to the ABANDONED candidate, and records the transition', async () => {
      const c1 = await commit('a', '1', 'c1');
      await git(repo, ['branch', 'ready', c1]);
      const c2 = await commit('a', '2', 'c2'); // the candidate about to be ABANDONED
      const c3 = await commit('src/failing.test.ts', 'fixed', 'c3 — the fix'); // the newer tip
      const { deps, calls } = bothPathsWired({ passesAtTip: true });
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
      const cancelledFor: string[] = [];
      const retriageMarkers: Array<{ fromCandidate: string; refiringCandidate: string }> = [];
      deps.cancelStaleAwaits = async (fromCandidate) => {
        calls.push('cancelStaleAwaits');
        cancelledFor.push(fromCandidate);
      };
      deps.recordInFlightRetriage = async (info) => {
        calls.push('recordInFlightRetriage');
        retriageMarkers.push({ fromCandidate: info.fromCandidate, refiringCandidate: info.refiringCandidate });
      };

      const r = await runGreenCheckpoint(cfg(), deps, { candidate: c2, noPush: true });

      expect(r.advanced).toBe(true);
      expect(r.candidate).toBe(c3);
      // The abandoned candidate (c2) — NEVER the new tip (c3), which has a real verdict coming
      // and must not be cancelled.
      expect(cancelledFor).toEqual([c2]);
      expect(retriageMarkers).toEqual([{ fromCandidate: c2, refiringCandidate: c3 }]);
      // Both the marker write and the cancellation happen on the FIRST (failing) pass, before
      // the recursive re-run's own runGreen call — never left dangling after the recursion.
      const secondRunGreen = calls.lastIndexOf('runGreen');
      expect(calls.indexOf('recordInFlightRetriage')).toBeGreaterThanOrEqual(0);
      expect(calls.indexOf('recordInFlightRetriage')).toBeLessThan(secondRunGreen);
      expect(calls.indexOf('cancelStaleAwaits')).toBeLessThan(secondRunGreen);
    });

    // WI-37490: a run that auto-refires and then dies mid-refire (process kill, deploy
    // restart, host reboot) used to record NOTHING — recordOwnVerdict only fires on the
    // FINAL resolution of the (possibly-recursive) runGreenCheckpoint call, so the first
    // pass's already-computed verdict was silently discarded. Pins the fix: the superseded
    // pass's own verdict is recorded via deps.recordVerdict BEFORE the recursive re-fire.
    it('a STALE red that REFIRES records the SUPERSEDED pass verdict before recursing (WI-37490)', async () => {
      const c1 = await commit('a', '1', 'c1');
      await git(repo, ['branch', 'ready', c1]);
      const c2 = await commit('a', '2', 'c2'); // the candidate about to be ABANDONED
      const c3 = await commit('src/failing.test.ts', 'fixed', 'c3 — the fix'); // the newer tip
      const { deps, calls } = bothPathsWired({ passesAtTip: true });
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
      const recorded: Array<{ green: boolean | null; candidate: string }> = [];
      deps.recordVerdict = async (r) => {
        calls.push('recordVerdict');
        recorded.push({ green: r.green, candidate: r.candidate });
        return true;
      };

      const r = await runGreenCheckpoint(cfg(), deps, { candidate: c2, noPush: true });

      // The overall run still resolves green, advanced to the tip — recording the
      // superseded pass must not change the final outcome.
      expect(r.green).toBe(true);
      expect(r.advanced).toBe(true);
      expect(r.candidate).toBe(c3);
      // Exactly ONE recorded verdict: the superseded first pass, NOT-green, still pinned
      // to the ABANDONED candidate c2 (never c3 — the final resolution's own recorder,
      // recordOwnVerdict, is a separate call path this test does not stub).
      expect(recorded).toEqual([{ green: false, candidate: c2 }]);
      // Recorded on the FIRST (failing) pass, strictly before the recursive re-run's own
      // runGreen call — a superseded-pass record left dangling after the recursion would
      // mean it ran too late to survive a death during the refire itself.
      const secondRunGreen = calls.lastIndexOf('runGreen');
      expect(calls.indexOf('recordVerdict')).toBeGreaterThanOrEqual(0);
      expect(calls.indexOf('recordVerdict')).toBeLessThan(secondRunGreen);
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

    // WI-37490: the gate-only (lint/typecheck) sibling of the file-based rescue's own
    // superseded-pass recording, above. Same defect, same fix, independent call site
    // (green-checkpoint.ts's second `deps.recordVerdict?.(buildNotGreenResult(...))` before
    // its own recursive re-fire) — this pins THAT site so it can't silently regress alone.
    it('a STALE gate red that REFIRES records the SUPERSEDED pass verdict before recursing (WI-37490)', async () => {
      const c1 = await commit('a', '1', 'c1');
      await git(repo, ['branch', 'ready', c1]);
      const c2 = await commit('a', '2', 'c2'); // the candidate about to be ABANDONED
      const c3 = await commit('b', '2', 'c3 — fixes the identity-leak lint'); // the newer tip
      const { deps, calls } = gatePathWired({ passesAtTip: true });
      let run = 0;
      deps.runGreen = async () => {
        calls.push('runGreen');
        run += 1;
        return run === 1
          ? { green: false, summary: '1 failed', failingTests: ['lint:identity-leak'] } // no failingFiles ⇒ gate-only red
          : { green: true, summary: 'all pass' };
      };
      const recorded: Array<{ green: boolean | null; candidate: string }> = [];
      deps.recordVerdict = async (r) => {
        calls.push('recordVerdict');
        recorded.push({ green: r.green, candidate: r.candidate });
        return true;
      };

      const r = await runGreenCheckpoint(cfg(), deps, { candidate: c2, noPush: true });

      expect(r.green).toBe(true);
      expect(r.advanced).toBe(true);
      expect(r.candidate).toBe(c3);
      // Exactly one recorded verdict: the superseded first pass, not-green, pinned to the
      // abandoned candidate c2 — never c3, which belongs to the final resolution's own
      // (separately-tested) recordOwnVerdict path.
      expect(recorded).toEqual([{ green: false, candidate: c2 }]);
      const secondRunGreen = calls.lastIndexOf('runGreen');
      expect(calls.indexOf('recordVerdict')).toBeGreaterThanOrEqual(0);
      expect(calls.indexOf('recordVerdict')).toBeLessThan(secondRunGreen);
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
      // WI-7290: this test's subject is "no RESCUE happens", and that is unchanged — no refire,
      // gate stays red. It used to assert that via `retriage === undefined`, which was a proxy
      // for the rescue not running, not the property itself. The record is no longer silent
      // about an unmeasured red (silence read identically to "measured, genuinely red"), so
      // assert the real intent — no rescue — plus the reason that replaced the silence.
      expect(r.retriage?.classification).toBe('unknown');
      expect(r.retriage?.autoRefire ?? false).toBe(false);
      expect(r.retriage?.detail).toContain('no tip gate-runner is wired');
      expect(r.retriage?.detail).toContain('lint:identity-leak');
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

  /**
   * EI-20092765275570648. A red held by a workspace-scoped LINT task could never be
   * measured for staleness, so it could never auto-refire, so it froze `main` until a
   * human noticed — while an otherwise-identical red held by a TEST file self-healed.
   *
   * The break was a lossy signature: the affected runner names the failing task exactly
   * (`<ws> :: <script>`), but extractFailingTests could only match the retry marker
   * `>>> <ws> FAILED`, so all that survived was a bare WORKSPACE name — neither a
   * {workspace,file} pair nor a NON_TEST_GATE_SCRIPTS key, hence `classification=unknown
   * autoRefire=false` and an unmeasured red.
   *
   * Fixtures below are verbatim from the 2026-08-10 incident log
   * (…-base-9263da0694d2-cand-c758381fc674.log L12595/L12727-12728).
   */
  describe('EI-20092765275570648: a workspace-scoped lint red is re-runnable at tip (pure)', () => {
    const INCIDENT_TASK = '@papercusp/operator-core :: lint:no-ungated-mug-kettle';
    // Verbatim shape, in the REAL order the runner emits it. The leading PLANNED-task
    // list is load-bearing in this fixture, not scenery: affected-tests.mjs prints the
    // run's schedule (L1210) with the SAME `  - <ws> :: <script>` bullet the failure list
    // uses (L1602). A first cut of this fix matched that bullet log-wide and swept in all
    // 16 planned tasks — which, being mostly `test` scripts, would have defeated the
    // every()-check and left the rescue dead while every hand-built fixture stayed green.
    // Any fixture without a planned-task list cannot catch that, so it stays here.
    const INCIDENT_OUTPUT = [
      'tasks:',
      '  - @papercupai/operator-docs :: test',
      '  - @papercusp/web :: test',
      '  - @papercusp/web :: lint:el-tools',
      '  - @papercusp/operator-core :: test',
      '  - @papercusp/operator-core :: lint:no-retired',
      '  - @papercusp/operator-core :: lint:no-ungated-mug-kettle',
      '',
      '>>> @papercusp/operator-core :: npm run lint:no-ungated-mug-kettle',
      '>>> @papercusp/operator-core FAILED — retrying once (AFFECTED_RETRY_FAILED, flake absorption)',
      '',
      '1 non-quarantined task(s) failed:',
      '  - @papercusp/operator-core :: lint:no-ungated-mug-kettle',
      '',
      '0 failing test file(s) — the per-FILE break set (the failed=1 above counts TASKS, not files):',
      '1 failed task(s) could NOT be attributed to files — their failures are REAL but unnamed here:',
      '  - @papercusp/operator-core :: lint:no-ungated-mug-kettle (no-file-rows)',
    ].join('\n');

    it('extracts the runner-named TASK id, not just the bare workspace from the retry marker', () => {
      const failing = extractFailingTests(INCIDENT_OUTPUT);
      expect(failing).toContain(INCIDENT_TASK);
      // The bare workspace is deliberately RETAINED: tryLongestGreenPrefix localizes a red
      // by matching workspace names against this signature, so removing it as "subsumed"
      // would trade one rescue for another.
      expect(failing).toContain('@papercusp/operator-core');
      // The `(no-file-rows)` prose sibling must not double-count as a second task.
      expect(failing.filter((f) => f.includes('lint:no-ungated-mug-kettle'))).toEqual([INCIDENT_TASK]);
    });

    it('captures ONLY the failed task — never the run\'s PLANNED task list, which shares the bullet shape', () => {
      const failing = extractFailingTests(INCIDENT_OUTPUT);
      const tasks = failing.filter((f) => f.includes(' :: '));
      // Exactly one task id: the one that actually failed. The 5 other scheduled tasks in
      // the fixture (incl. `@papercusp/web :: lint:el-tools`, itself a lint task that WOULD
      // have looked rescue-eligible) must not appear.
      expect(tasks).toEqual([INCIDENT_TASK]);
      expect(failing).not.toContain('@papercusp/web :: lint:el-tools');
      expect(failing).not.toContain('@papercusp/operator-core :: test');
    });

    it('THE REGRESSION: the incident signature now yields a rescue instead of an unmeasured red', () => {
      // Exactly what the gate held on. Before the fix this returned [] — no gate ids, no
      // tip re-run, `main` frozen.
      expect(nonTestGateIdsFrom(extractFailingTests(INCIDENT_OUTPUT))).toEqual([INCIDENT_TASK]);
    });

    it('documents the bug this closes: the signature the gate ACTUALLY had rescues nothing', () => {
      // This is verbatim what the 2026-08-10 gate held on — the bare workspace scraped from
      // the retry marker, with the runner's own task id dropped on the floor. It is still
      // un-rescuable today (correctly: a workspace name names no script to run), which is
      // exactly why capturing the task id is the load-bearing half of the fix and not a
      // cosmetic signature improvement.
      expect(nonTestGateIdsFrom(['@papercusp/operator-core'])).toEqual([]);
    });

    it('drops the workspace entry the task id subsumes, so the every()-check is not defeated by it', () => {
      expect(nonTestGateIdsFrom(['@papercusp/operator-core', INCIDENT_TASK])).toEqual([INCIDENT_TASK]);
      // An UNRELATED workspace is not subsumed and still declines the rescue.
      expect(nonTestGateIdsFrom(['@papercusp/web', INCIDENT_TASK])).toEqual([]);
    });

    it('mixes with registry gate ids', () => {
      expect(nonTestGateIdsFrom(['lint:tsc', INCIDENT_TASK])).toEqual(['lint:tsc', INCIDENT_TASK]);
    });

    it('admits ONLY lint tasks — a test/build task is never guessed at', () => {
      expect(isRerunnableGateEntry(INCIDENT_TASK)).toBe(true);
      expect(isRerunnableGateEntry('lint:tsc')).toBe(true);
      // A `test` task belongs to the FILE-based rescue (runTestsAtRef), not this one.
      expect(isRerunnableGateEntry('@papercusp/web :: test')).toBe(false);
      expect(isRerunnableGateEntry('@papercusp/web :: build')).toBe(false);
      expect(isRerunnableGateEntry('@papercusp/web')).toBe(false);
      expect(nonTestGateIdsFrom(['@papercusp/web :: test'])).toEqual([]);
    });

    it('parses the task id shape, and rejects anything that is not one', () => {
      expect(parseFailingTaskId(INCIDENT_TASK)).toEqual({
        workspace: '@papercusp/operator-core',
        script: 'lint:no-ungated-mug-kettle',
      });
      expect(parseFailingTaskId('lint:tsc')).toBeNull();
      expect(parseFailingTaskId('@papercusp/web')).toBeNull();
      expect(parseFailingTaskId('src/a.test.ts')).toBeNull();
    });

    it('resolves to a WORKSPACE-scoped npm invocation (a root-only run would not re-verify it)', () => {
      expect(resolveGateRuns([INCIDENT_TASK])).toEqual([
        { script: 'lint:no-ungated-mug-kettle', workspace: '@papercusp/operator-core' },
      ]);
      // A registry id keeps running at the repo ROOT, exactly as before.
      expect(resolveGateRuns(['lint:tsc'])).toEqual([{ script: 'lint:tsc', workspace: null }]);
      // A registry id fanning out to several scripts is unchanged.
      expect(resolveGateRuns(['lint:identity-leak'])).toEqual(
        NON_TEST_GATE_SCRIPTS['lint:identity-leak'].map((script) => ({ script, workspace: null })),
      );
    });

    it('against the REAL 1.5MB incident log (when still on disk), extracts the 1 failure and none of the 16 planned tasks', () => {
      // A hand-built fixture cannot prove this — the first cut of the fix passed every
      // fixture and still swept in 16 planned tasks from the genuine article. Skipped
      // rather than failed when the log has aged out, so this never becomes a flake.
      const log = join(
        process.env.HOME ?? '',
        '.papercusp/checkpoint-logs',
        '2026-08-10T18-34-37-011Z-base-9263da0694d2-cand-c758381fc674.log',
      );
      let raw: string;
      try {
        raw = readFileSync(log, 'utf8');
      } catch {
        return; // log rotated away — the fixture tests above still cover the shape
      }
      const failing = extractFailingTests(raw);
      expect(failing.filter((f) => f.includes(' :: '))).toEqual([INCIDENT_TASK]);
      expect(nonTestGateIdsFrom(failing)).toEqual([INCIDENT_TASK]);
    });

    it('de-duplicates entries that resolve to the same invocation', () => {
      expect(resolveGateRuns([INCIDENT_TASK, INCIDENT_TASK])).toHaveLength(1);
      expect(resolveGateRuns(['lint:tsc', 'lint:tsc'])).toEqual([{ script: 'lint:tsc', workspace: null }]);
      // Same script name in two different workspaces is NOT a duplicate.
      expect(resolveGateRuns(['@papercusp/a :: lint:x', '@papercusp/b :: lint:x'])).toHaveLength(2);
    });
  });

  /**
   * WI-7290. The filed hypothesis was that the `📍 lineage` staleness check should TRIGGER a
   * refire. Tracing the control flow REFUTED it: the refire is already gated on strictly
   * stronger evidence — an actual re-run of the failing files at tip (`classifyRedAgainstTip`)
   * — and lineage only reports that a file was MODIFIED in the range, which is not a fix.
   * Triggering on the proxy would fire a ~55min suite in exactly the cases where the direct
   * measurement just said the break reproduces.
   *
   * The real defect the trace exposed: when the tip re-run does not run AT ALL, the record was
   * silent, so "never measured" was indistinguishable from "measured, genuinely red". These
   * assert the reason is always stated and always specific enough to act on.
   */
  describe('WI-7290: describeSkippedRetriage — an unmeasured red says so, in its own words (pure)', () => {
    const base = {
      candidate: 'a'.repeat(40),
      tip: 'b'.repeat(40),
      failingFiles: [] as { workspace: string; file: string }[],
      gateIds: [] as string[],
      failingTests: [] as string[],
      hasTestRunner: true,
      hasGateRunner: true,
    };

    it('names an unresolvable tip — nothing newer existed to re-test against', () => {
      const s = describeSkippedRetriage({ ...base, tip: null });
      expect(s).toContain('could not be resolved');
      expect(s).toContain('never checked for staleness');
    });

    it('names the candidate-IS-tip case as red-by-construction, not as an unmeasured gap', () => {
      const s = describeSkippedRetriage({ ...base, tip: base.candidate });
      expect(s).toContain('IS the tip');
      expect(s).toContain('nothing newer');
    });

    it('distinguishes an UNWIRED test runner from a genuinely un-runnable failure set', () => {
      const s = describeSkippedRetriage({
        ...base,
        failingFiles: [{ workspace: '@papercusp/operator-core', file: 'lib/a.test.ts' }],
        hasTestRunner: false,
      });
      expect(s).toContain('no tip test-runner is wired');
      expect(s).toContain('NOT measured');
    });

    it('names the unwired GATE runner separately (the lint/typecheck sibling path)', () => {
      const s = describeSkippedRetriage({ ...base, gateIds: ['lint:tsc'], hasGateRunner: false });
      expect(s).toContain('no tip gate-runner is wired');
      expect(s).toContain('lint:tsc');
    });

    it('⭐ the residual case — failures existed but none was re-runnable — NAMES them and refuses to imply the red is real', () => {
      // This is the shape that produced WI-7290 itself: a cargo task and a workspace-level
      // failure, neither of which resolves to a {workspace,file} pair nor to a known gate id.
      const s = describeSkippedRetriage({
        ...base,
        failingTests: ['@papercusp/operator-core', '@papercusp/desktop'],
      });
      expect(s).toContain('@papercusp/desktop');
      expect(s).toContain('no failing entry resolved to a {workspace,file} pair');
      expect(s).toContain('may or may not still reproduce');
      // The load-bearing negative: it must never assert the red is current.
      expect(s).not.toMatch(/real red|genuinely broken|reproduces at tip/i);
    });

    it('is TOTAL — every skip path yields a non-empty sentence, never an empty string', () => {
      const variants = [
        { ...base, tip: null },
        { ...base, tip: base.candidate },
        { ...base, failingFiles: [{ workspace: 'w', file: 'f.test.ts' }], hasTestRunner: false },
        { ...base, gateIds: ['lint:tsc'], hasGateRunner: false },
        { ...base },
        { ...base, failingTests: ['x'] },
      ];
      for (const v of variants) {
        const s = describeSkippedRetriage(v);
        expect(s.length).toBeGreaterThan(20);
        expect(s).toContain('SKIPPED');
      }
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

// EI-19340004308033958 recurrence guard: a `failingTests` entry can be a MANGLED
// suffix of a real path (e.g. `lib/y.test.ts`) that resolves to nothing in the
// judged candidate — worse than an absent field, because it looks authoritative.
describe('validateFailingTestPaths (EI-19340004308033958)', () => {
  it('drops a file-shaped entry that does not exist in the tree', () => {
    const exists = (p: string) => p.endsWith('real.test.ts');
    const result = validateFailingTestPaths(
      ['lib/real.test.ts', 'lib/y.test.ts'],
      '/tree',
      exists,
    );
    expect(result.kept).toEqual(['lib/real.test.ts']);
    expect(result.dropped).toEqual(['lib/y.test.ts']);
  });

  it('passes through non-file entries (workspace names, gate ids) untouched, never validated', () => {
    const exists = vi.fn(() => false); // would drop everything if wrongly consulted
    const result = validateFailingTestPaths(
      ['@papercusp/operator-vite', 'lint:tsc'],
      '/tree',
      exists,
    );
    expect(result.kept).toEqual(['@papercusp/operator-vite', 'lint:tsc']);
    expect(result.dropped).toEqual([]);
    expect(exists).not.toHaveBeenCalled();
  });

  it('keeps every entry when all resolve', () => {
    const result = validateFailingTestPaths(['lib/a.test.ts', 'lib/b.spec.tsx'], '/tree', () => true);
    expect(result.kept).toEqual(['lib/a.test.ts', 'lib/b.spec.tsx']);
    expect(result.dropped).toEqual([]);
  });

  it('checks existence against treeDir-joined paths, not the bare entry', () => {
    let seen: string | null = null;
    validateFailingTestPaths(['lib/x.test.ts'], '/candidate-tree', (p) => {
      seen = p;
      return true;
    });
    expect(seen).toBe(join('/candidate-tree', 'lib/x.test.ts'));
  });

  it('real filesystem end-to-end: a real temp file is kept, a mangled sibling is dropped', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gc-validate-'));
    try {
      mkdirSync(join(dir, 'lib'), { recursive: true });
      writeFileSync(join(dir, 'lib', 'real.test.ts'), '// ok');
      const result = validateFailingTestPaths(['lib/real.test.ts', 'lib/y.test.ts'], dir);
      expect(result.kept).toEqual(['lib/real.test.ts']);
      expect(result.dropped).toEqual(['lib/y.test.ts']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

  // EI-19324146335802876: the tip re-run is a GROUP run collapsed to one boolean, so a real-red
  // verdict cannot distinguish "all still fail" from "one still fails". The detail must not
  // claim the stronger reading — four agents re-triaged five files on 2026-08-02 when four of
  // them were already green at tip.
  it('a real-red detail states the group re-run is ALL-OR-NOTHING, not that every file still fails', () => {
    const v = classifyRedAgainstTip({
      ...base,
      failingTests: ['a.test.ts', 'b.test.ts', 'c.test.ts'],
      tipRetest: { ran: true, pass: false },
    });
    expect(v.classification).toBe('real-red');
    expect(v.detail).toMatch(/did not ALL pass|not "they all still fail"/i);
    expect(v.detail).toContain('INDIVIDUALLY');
    expect(v.detail).toContain('3'); // the count is named so the reader knows the group size
  });

  // WI-7217 — the follow-up the EI-19324146335802876 fix left open. Better WORDING still made
  // every reader do the per-file re-run themselves (4 agents on candidate 1a9e8a1f, 1 more on
  // ab4babba). With a split available the verdict must ANSWER instead of assigning homework.
  it('a real-red detail NAMES which files still fail and which are already green, when the split ran', () => {
    const v = classifyRedAgainstTip({
      ...base,
      failingTests: ['a.test.ts', 'b.test.ts', 'c.test.ts'],
      tipRetest: {
        ran: true,
        pass: false,
        perFile: [
          { workspace: '@p/core', file: 'a.test.ts', pass: true },
          { workspace: '@p/core', file: 'b.test.ts', pass: false },
          { workspace: '@p/core', file: 'c.test.ts', pass: true },
        ],
      },
    });
    expect(v.classification).toBe('real-red');
    expect(v.detail).toContain('STILL FAILING');
    expect(v.detail).toContain('b.test.ts');
    expect(v.detail).toMatch(/ALREADY GREEN AT TIP/);
    expect(v.detail).toContain('a.test.ts');
    expect(v.detail).toContain('c.test.ts');
    // The whole point: it must NOT tell the reader to go do the re-run it already did.
    expect(v.detail).not.toContain('INDIVIDUALLY');
  });

  // The safety invariant. `perFile` refines the PROSE only — if it could move the verdict, a
  // split that ran individually (and so cannot see cross-file pollution) would refire the gate
  // onto a genuinely broken tip.
  it('perFile never changes the classification — only the detail', () => {
    const withSplit = classifyRedAgainstTip({
      ...base,
      tipRetest: {
        ran: true,
        pass: false,
        perFile: [{ workspace: '@p/core', file: 'a.test.ts', pass: true }],
      },
    });
    const without = classifyRedAgainstTip({ ...base, tipRetest: { ran: true, pass: false } });
    expect(withSplit.classification).toBe(without.classification);
    expect(withSplit.autoRefire).toBe(false);
    expect(withSplit.detail).not.toBe(without.detail); // ...but it DID say something different
  });

  // Group failed, every file passes alone ⇒ the breakage is the INTERACTION. Saying "0 files
  // still fail" without naming that reads as "nothing is broken" and sends the next reader to
  // re-run them individually, reproducing nothing and looking like a flaky gate.
  it('calls out ORDER-DEPENDENCE when the group failed but every file passes alone', () => {
    const v = classifyRedAgainstTip({
      ...base,
      failingTests: ['a.test.ts', 'b.test.ts'],
      tipRetest: {
        ran: true,
        pass: false,
        perFile: [
          { workspace: '@p/core', file: 'a.test.ts', pass: true },
          { workspace: '@p/core', file: 'b.test.ts', pass: true },
        ],
      },
    });
    expect(v.classification).toBe('real-red'); // still holds the gate
    expect(v.detail).toMatch(/ORDER-DEPENDENT|cross-file pollution/i);
    expect(v.detail).toMatch(/bisect/i);
    expect(v.detail).not.toContain('STILL FAILING');
  });

  it('describeRealRedAtTip falls back to the honest hedge with no split', () => {
    expect(describeRealRedAtTip('bbbbbbbb2222', ['a.test.ts'])).toContain('INDIVIDUALLY');
    expect(describeRealRedAtTip('bbbbbbbb2222', ['a.test.ts'], [])).toContain('INDIVIDUALLY');
  });

  describe('splitTipFailuresPerFile (diagnostic per-file split — WI-7217)', () => {
  const files = [
    { workspace: '@p/core', file: 'a.test.ts' },
    { workspace: '@p/core', file: 'b.test.ts' },
  ];

  it('reports each file\'s solo verdict when every run is decidable', async () => {
    const out = await splitTipFailuresPerFile(files, async (_ws, f) => f === 'a.test.ts');
    expect(out).toEqual([
      { workspace: '@p/core', file: 'a.test.ts', pass: true },
      { workspace: '@p/core', file: 'b.test.ts', pass: false },
    ]);
  });

  // ALL-OR-NOTHING. A partial split reads as the whole answer — this is the same class of bug
  // the split exists to fix, just one level up.
  it('ABANDONS the split (undefined, never partial) when any single run is INDETERMINATE', async () => {
    const out = await splitTipFailuresPerFile(files, async (_ws, f) => (f === 'a.test.ts' ? true : null));
    expect(out).toBeUndefined();
  });

  it('abandons rather than naming a file that could not be run — the crashed run is not a failure', async () => {
    // Guards the specific wrong-direction failure: reporting an indeterminate run as pass:false
    // would list a HEALTHY file under "STILL FAILING (fix these)".
    const out = await splitTipFailuresPerFile(files, async () => null);
    expect(out).toBeUndefined();
    expect(out).not.toEqual(expect.arrayContaining([expect.objectContaining({ pass: false })]));
  });

  it('skips the split entirely above the file cap', async () => {
    const many = Array.from({ length: TIP_SPLIT_MAX_FILES + 1 }, (_, i) => ({
      workspace: '@p/core',
      file: `f${i}.test.ts`,
    }));
    const ran: string[] = [];
    const out = await splitTipFailuresPerFile(many, async (_ws, f) => {
      ran.push(f);
      return true;
    });
    expect(out).toBeUndefined();
    expect(ran).toEqual([]); // and costs nothing — not even one run
  });

  it('abandons when the wall-clock budget lapses mid-split', async () => {
    let t = 0;
    const out = await splitTipFailuresPerFile(files, async () => true, {
      now: () => (t += 1000),
      budgetMs: 1500, // deadline set at 1000+1500=2500; the 2nd file's check reads 3000
    });
    expect(out).toBeUndefined();
  });

  it('returns undefined for an empty file list', async () => {
    expect(await splitTipFailuresPerFile([], async () => true)).toBeUndefined();
  });
  });

  it('calls a red STALE and auto-refires when the failing files pass at tip', () => {
    const v = classifyRedAgainstTip({ ...base, tipRetest: { ran: true, pass: true } });
    expect(v).toMatchObject({ classification: 'stale-candidate', autoRefire: true });
    // EI-19343532231631821 changed what this refire COSTS, not whether it happens. With no
    // `priorFailing` there is no rescued set to have failed, so the refire is UNCHARGED and the
    // detail must not claim "attempt 1/2" — the charged budget is untouched. (This assertion
    // previously read `toContain('attempt 1/2')`, which asserted the old always-charge accounting.)
    expect(v.chargeRefire).toBe(false);
    expect(v.detail).toContain('UNCHARGED');
    expect(v.detail).toContain('0/2');
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

/**
 * EI-19343532231631821 — the refire budget is charged for a FAILED rescue, not for a refire.
 *
 * The bug these guard: on the papercusp gate run of 2026-08-02 the auto-refire spent its whole
 * 2-attempt budget on tree churn. Each ~30-min-later cut rescued the previous red successfully and
 * imported a COMPLETELY DISJOINT new one, so the run ended red having never once failed to rescue
 * anything — then restarted ~55min later against an even later tip. Self-perpetuating.
 */
describe('refire charge accounting (EI-19343532231631821)', () => {
  const base = {
    candidate: 'aaaaaaaa1111',
    tip: 'bbbbbbbb2222',
    failingTests: ['a.test.ts'],
    tipRetest: { ran: true, pass: true } as const,
    refireAttempts: 0,
    maxRefires: 2,
  };

  describe('normaliseFailingKey / refireOverlap — the FAIL-OPEN hazard', () => {
    // THE dangerous direction, and the reason normalisation is a function rather than an inline
    // compare. The rescued set survives as bare workspace-relative strings (the marker persists
    // `failingFiles.map(f => f.file)`) while the current pass carries `{workspace, file}` objects.
    // Compare those two shapes naively and NOTHING ever matches ⇒ nothing is ever charged ⇒ the
    // charged budget silently ceases to exist and the gate can refire until it is killed.
    it('matches a marker-shaped string against a FailingFile for the SAME file', () => {
      const rescued = ['lib/harness/hygiene.test.ts', 'src/components/adv/TasksRosterPanel.test.tsx'];
      const current: FailingFile[] = [
        { workspace: '@papercusp/operator-core', file: 'lib/harness/hygiene.test.ts' },
        { workspace: 'operator', file: 'src/components/adv/SomethingElse.test.tsx' },
      ];
      // The naive compare this guards against — object vs string — finds nothing:
      expect(current.filter((f) => rescued.includes(f as unknown as string))).toEqual([]);
      // The normalised compare finds the real overlap:
      expect(refireOverlap(rescued, current)).toEqual(['lib/harness/hygiene.test.ts']);
    });

    it('normalises ./ and duplicate separators so cosmetic path drift cannot fake a disjoint set', () => {
      expect(normaliseFailingKey('./lib//foo.test.ts')).toBe('lib/foo.test.ts');
      expect(normaliseFailingKey({ workspace: 'ws', file: '  lib/foo.test.ts  ' })).toBe('lib/foo.test.ts');
      expect(refireOverlap(['lib/foo.test.ts'], [{ workspace: 'ws', file: './lib/foo.test.ts' }])).toEqual([
        'lib/foo.test.ts',
      ]);
    });

    it('drops the workspace deliberately — a same-named file in another workspace over-charges (fails CLOSED)', () => {
      // The cost of a key the marker can also produce. Over-charging degrades to today's
      // always-charge behaviour; under-charging would remove the loop guard entirely.
      const overlap = refireOverlap(
        [{ workspace: 'pkg-a', file: 'lib/index.test.ts' }],
        [{ workspace: 'pkg-b', file: 'lib/index.test.ts' }],
      );
      expect(overlap).toEqual(['lib/index.test.ts']);
    });

    it('non-test gate ids compare intact and never collide with a path', () => {
      expect(refireOverlap(['lint:tsc'], ['lint:tsc'])).toEqual(['lint:tsc']);
      expect(refireOverlap(['lint:tsc'], ['lint:migrations'])).toEqual([]);
    });

    it('an empty set on either side overlaps with nothing (the first refire of a run)', () => {
      expect(refireOverlap([], [{ workspace: 'ws', file: 'a.test.ts' }])).toEqual([]);
      expect(refireOverlap(undefined, undefined)).toEqual([]);
    });
  });

  describe('the charge decision', () => {
    it('does NOT charge a refire whose failures are DISJOINT from the rescued set', () => {
      const v = classifyRedAgainstTip({
        ...base,
        priorFailing: ['lib/hyperbee/boot.test.ts', 'src/TasksRosterPanel.test.tsx'],
        currentFailing: [
          { workspace: 'operator', file: 'lib/release/release-actions.test.ts' },
          { workspace: '@papercusp/operator-core', file: 'lib/harness/hygiene.test.ts' },
        ],
        totalRefires: 1,
      });
      expect(v).toMatchObject({ classification: 'stale-candidate', autoRefire: true, chargeRefire: false });
      expect(v.detail).toContain('UNCHARGED');
      expect(v.detail).toMatch(/rescue SUCCEEDED/i);
    });

    it('DOES charge when the same breakage survives the re-cut (the loop guard that must survive)', () => {
      const v = classifyRedAgainstTip({
        ...base,
        priorFailing: ['lib/harness/hygiene.test.ts'],
        currentFailing: [{ workspace: '@papercusp/operator-core', file: 'lib/harness/hygiene.test.ts' }],
      });
      expect(v).toMatchObject({ autoRefire: true, chargeRefire: true });
      expect(v.detail).toContain('CHARGED attempt 1/2');
      expect(v.detail).toContain('lib/harness/hygiene.test.ts');
    });

    it('charges on PARTIAL overlap — one surviving file is a failed rescue', () => {
      const v = classifyRedAgainstTip({
        ...base,
        priorFailing: ['a.test.ts', 'b.test.ts'],
        currentFailing: [
          { workspace: 'ws', file: 'b.test.ts' },
          { workspace: 'ws', file: 'c.test.ts' },
        ],
      });
      expect(v.chargeRefire).toBe(true);
    });

    it('charges an OSCILLATION — {A}→{B}→{A} is no progress, and only the accumulated union sees it', () => {
      // Against the PREVIOUS pass alone ({B}) the returning {A} looks disjoint and would run free.
      const priorUnion = mergeFailingKeys(['a.test.ts'], [{ workspace: 'ws', file: 'b.test.ts' }]);
      expect(priorUnion).toEqual(['a.test.ts', 'b.test.ts']);
      const v = classifyRedAgainstTip({
        ...base,
        priorFailing: priorUnion,
        currentFailing: [{ workspace: 'ws', file: 'a.test.ts' }],
      });
      expect(v.chargeRefire).toBe(true);
    });

    it("the run's FIRST refire is never charged — no rescue has been attempted, so none can have failed", () => {
      const v = classifyRedAgainstTip({ ...base, priorFailing: [], currentFailing: [{ workspace: 'ws', file: 'a.test.ts' }] });
      expect(v).toMatchObject({ autoRefire: true, chargeRefire: false });
    });
  });

  describe('the two required safety bounds', () => {
    it('stops at the ABSOLUTE ceiling even when nothing was ever charged', () => {
      // The failure mode uncharged refires create: a tree where SOMETHING is always freshly red
      // produces an unbroken chain of successful rescues and would otherwise refire forever.
      const v = classifyRedAgainstTip({
        ...base,
        priorFailing: ['old.test.ts'],
        currentFailing: [{ workspace: 'ws', file: 'new.test.ts' }],
        totalRefires: 6,
        absoluteCeiling: 6,
      });
      expect(v).toMatchObject({ autoRefire: false, refireBlockedBy: 'absolute-ceiling' });
      // The operator action differs from a charged-budget stop — say so, don't send them to the files.
      expect(v.detail).toMatch(/never simultaneously green/i);
      expect(v.detail).toContain('NOT to debug the files');
    });

    it('stops at the DEADLINE rather than being killed mid-suite with no verdict at all', () => {
      const v = classifyRedAgainstTip({
        ...base,
        priorFailing: ['old.test.ts'],
        currentFailing: [{ workspace: 'ws', file: 'new.test.ts' }],
        deadlineExceeded: true,
      });
      expect(v).toMatchObject({ autoRefire: false, refireBlockedBy: 'deadline' });
      expect(v.detail).toMatch(/no verdict recorded/i);
    });

    it('the charged budget still stops a genuinely-broken tip, regardless of this pass"s charge', () => {
      const v = classifyRedAgainstTip({
        ...base,
        refireAttempts: 2,
        priorFailing: ['old.test.ts'],
        currentFailing: [{ workspace: 'ws', file: 'brand-new.test.ts' }],
      });
      expect(v).toMatchObject({ autoRefire: false, refireBlockedBy: 'charged-budget' });
      expect(v.detail).toContain('refire cap reached');
    });

    it('reports cap-disabled distinctly from a spent budget', () => {
      const v = classifyRedAgainstTip({ ...base, maxRefires: 0 });
      expect(v).toMatchObject({ autoRefire: false, refireBlockedBy: 'cap-disabled' });
    });

    it('refireAbsoluteCeiling is a multiple of the charged cap, and 0 when refire is disabled', () => {
      expect(refireAbsoluteCeiling(2)).toBe(6);
      expect(refireAbsoluteCeiling(0)).toBe(0);
      expect(refireAbsoluteCeiling(Number.NaN)).toBe(0);
    });

    it('refireDeadlineExceeded predicts the NEXT pass from the last one, and never blocks unmeasured', () => {
      const budgetMs = 110 * 60_000;
      expect(refireDeadlineExceeded({ elapsedMs: 60 * 60_000, lastPassMs: 20 * 60_000, budgetMs })).toBe(false);
      expect(refireDeadlineExceeded({ elapsedMs: 60 * 60_000, lastPassMs: 55 * 60_000, budgetMs })).toBe(true);
      // Unmeasured ⇒ fail OPEN on time alone; refireAbsoluteCeiling is what still bounds the run.
      expect(refireDeadlineExceeded({ elapsedMs: Number.NaN, lastPassMs: 1, budgetMs })).toBe(false);
    });

    it('the run budget stays strictly under the suite timeout that would kill a mid-flight refire', () => {
      expect(refireRunBudgetMsFromEnv({})).toBe(DEFAULT_REFIRE_RUN_BUDGET_MS);
      expect(refireRunBudgetMsFromEnv({ PAPERCUSP_GATE_REFIRE_RUN_BUDGET_MS: '900000' })).toBe(900_000);
      expect(refireRunBudgetMsFromEnv({ PAPERCUSP_GATE_REFIRE_RUN_BUDGET_MS: 'nonsense' })).toBe(
        DEFAULT_REFIRE_RUN_BUDGET_MS,
      );
    });
  });

  describe('nextRefireOpts — the recursion state', () => {
    it('advances the charged counter ONLY on a charged refire, while totalRefires always climbs', () => {
      const uncharged = nextRefireOpts(
        { refireAttempts: 0, totalRefires: 0, priorFailing: ['a.test.ts'] },
        { chargeRefire: false },
        [{ workspace: 'ws', file: 'b.test.ts' }],
        1_000,
      );
      expect(uncharged).toMatchObject({ refireAttempts: 0, totalRefires: 1, runStartedAtMs: 1_000 });
      expect(uncharged.priorFailing).toEqual(['a.test.ts', 'b.test.ts']);

      const charged = nextRefireOpts(
        { refireAttempts: 0, totalRefires: 1, priorFailing: ['a.test.ts'] },
        { chargeRefire: true },
        [{ workspace: 'ws', file: 'a.test.ts' }],
        1_000,
      );
      expect(charged).toMatchObject({ refireAttempts: 1, totalRefires: 2 });
    });

    it('replays the 2026-08-02 run: three passes that would have exhausted the budget now spend NONE', () => {
      // pass 1 {hyperbee, TasksRoster, SessionsRoster} → refire 1 {release-actions, hygiene} → refire 2.
      // Under the old unconditional increment this reached refireAttempts=2 and the final red STUCK.
      let opts: Parameters<typeof nextRefireOpts>[0] = {};
      const pass1 = [
        { workspace: 'ws', file: 'lib/hyperbee/boot.test.ts' },
        { workspace: 'operator', file: 'src/TasksRosterPanel.test.tsx' },
        { workspace: 'operator', file: 'src/SessionsRosterView.test.tsx' },
      ];
      const pass2 = [
        { workspace: 'operator', file: 'lib/release/release-actions.test.ts' },
        { workspace: 'core', file: 'lib/harness/hygiene.test.ts' },
      ];
      for (const failing of [pass1, pass2]) {
        const v = classifyRedAgainstTip({
          ...base,
          refireAttempts: opts.refireAttempts ?? 0,
          ...refireBudgetInputs(opts, failing, 0, 0, () => 0),
        });
        expect(v.autoRefire).toBe(true);
        expect(v.chargeRefire).toBe(false); // every rescue SUCCEEDED — nothing to charge
        opts = nextRefireOpts(opts, v, failing, 0);
      }
      expect(opts.refireAttempts).toBe(0); // the whole charged budget is still available
      expect(opts.totalRefires).toBe(2);
    });
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
      HARNESS_SLUG: 'papercusp', // WI-6583: a non-PAPERCUSP_-prefixed attribution fallback
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

  // WI-6583: HARNESS_SLUG is a non-`PAPERCUSP_`-prefixed test-run-attribution
  // fallback the vitest/playwright reporters now read (admin-test-runs-reporter.ts's
  // resolveTestRunHarnessSlug). If the gate's own host process ever inherited a stray
  // HARNESS_SLUG, leaving it unstripped would silently undo the deliberate
  // "gate rows stay unattributed" design documented on buildGreenCheckpointEnv itself.
  it('strips a host-inherited HARNESS_SLUG so gate rows stay unattributed (WI-6583)', () => {
    const env = buildGreenCheckpointEnv('base123', { HARNESS_SLUG: 'some-other-harness' });
    expect(env.HARNESS_SLUG).toBeUndefined();
  });

  // EI-19307211919650123: the gate's test rows must be distinguishable from an
  // agent's local run. These stamps are PAPERCUSP_-prefixed, so they only work if
  // they are applied AFTER the strip loop — which is the whole point of the first
  // assertion below (a host value must be overridden, not merely absent).
  // A deliberately PARTIAL host env — the builder only ever reads keys, and a fixture
  // that had to spell out the whole environment would obscure what each case is about.
  // The cast is needed because this project's tsconfig pulls in Next's generated
  // `.next/types`, whose ProcessEnv augmentation makes NODE_ENV required; the older
  // inline-literal call sites in this file predate that and still carry the error.
  const partialEnv = (e: Record<string, string>): NodeJS.ProcessEnv => e as NodeJS.ProcessEnv;

  it('stamps PAPERCUSP_TEST_RUN_SOURCE=ci AFTER the strip, overriding any host value', () => {
    const env = buildGreenCheckpointEnv('b', partialEnv({ PAPERCUSP_TEST_RUN_SOURCE: 'local' }));
    expect(env.PAPERCUSP_TEST_RUN_SOURCE).toBe('ci');
  });

  it('groups the run with PAPERCUSP_TEST_RUN_GROUP only when a runId is given', () => {
    const withId = buildGreenCheckpointEnv('b', partialEnv({}), 'run-abc');
    expect(withId.PAPERCUSP_TEST_RUN_GROUP).toBe('run-abc');
    // A host-leaked group must not survive when this run has no id of its own —
    // otherwise a gate run would inherit some agent's run-group and mis-attribute.
    const noId = buildGreenCheckpointEnv('b', partialEnv({ PAPERCUSP_TEST_RUN_GROUP: 'leaked' }));
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

// EI-19346606967082413: the persisted verdict log used to record ONLY the suite's stdout.
// Every ORCHESTRATOR decision — `checkpointing candidate <sha>`, the quiet-cut pick, and each
// in-process `auto-refiring` — went to stdout alone. A MANUAL run redirects that to /tmp; a
// SCHEDULER-fired run redirects it NOWHERE. So a cron run left no artifact whatsoever of which
// candidate(s) it judged, which is why "which sha is this run judging" repeatedly produced
// contradictory answers from agents reading the same files, and why the `inFlightRetriage`
// routines marker had to be invented to recover state this log should have carried.
//
// The first fix attempt is the reason this test exists. It shipped the ring buffer, the
// once-per-run reset seam and the tee — and stopped one hunk short of CALLING
// renderOrchestratorTranscript() at the write site. It compiled, it typechecked, every test
// stayed green, and it was a complete no-op: the buffer filled on every run and was thrown
// away. That is the same class as EI-18694489428714850 above — not a missing FEATURE, a
// missing WIRE — and no test of the helper in isolation can ever catch it, because the helper
// was perfect. So this asserts the WIRE, end to end: a line recorded on the buffer has to come
// out the other end INSIDE THE FILE.
describe('realCheckpointDeps.runGreen — the orchestrator transcript reaches the persisted log (EI-19346606967082413)', () => {
  let tree: string;
  let logDir: string;
  beforeEach(() => {
    tree = mkdtempSync(join(tmpdir(), 'gc-transcript-'));
    logDir = mkdtempSync(join(tmpdir(), 'gc-logs-'));
    // The buffer is module-global, so a neighbouring test's lines would otherwise leak in
    // and make this pass for the wrong reason.
    resetOrchestratorLog();
  });
  afterEach(() => {
    rmSync(tree, { recursive: true, force: true });
    rmSync(logDir, { recursive: true, force: true });
    resetOrchestratorLog();
  });

  const runAndReadLog = async (suiteStdout: string): Promise<string> => {
    const { readdirSync, readFileSync } = await import('node:fs');
    writeFileSync(join(tree, 'package.json'), JSON.stringify({ name: 'x', scripts: { 'test:affected': 'true' } }));
    const exec: CheckpointExec = async (cmd, args) => {
      // git grep's "no match" exit code — no committed conflict markers on this fake tree.
      if (cmd === 'git' && args[0] === 'grep') return { code: 1, stdout: '', stderr: '' };
      return { code: 0, stdout: suiteStdout, stderr: '' };
    };
    const cfg = releaseConfig({
      checkpointRoot: tree,
      checkpointLogDir: logDir,
      greenCmd: 'npm run test:affected',
      spaBuildWorkspace: '', // isolate to the suite leg — no SPA build on a fake tree
    });
    await realCheckpointDeps(cfg, exec).runGreen(tree, 'base');
    const written = readdirSync(logDir).filter((f) => f.endsWith('.log'));
    expect(written).toHaveLength(1); // exactly one log per run, as the write site promises
    return readFileSync(join(logDir, written[0]!), 'utf8');
  };

  it('⭐ carries a recorded orchestrator line into the written file, inside the transcript fence', async () => {
    // Verbatim shape of the line green-checkpoint.ts:2745 emits — the single most-wanted
    // fact about any run, and the one a cron run used to lose entirely.
    recordOrchestratorLine('checkpointing candidate abc12345 (base none)');
    const body = await runAndReadLog('Test Files  3 passed (3)\n');

    expect(body).toContain('checkpointing candidate abc12345');
    // ...and it must be FENCED, not loose in the suite output: the fence is what makes it
    // greppable and keeps it from reading as something the suite itself printed.
    const fenceStart = body.indexOf('--- orchestrator transcript');
    expect(fenceStart).toBeGreaterThanOrEqual(0);
    const fenceEnd = body.indexOf('--- end orchestrator transcript');
    expect(fenceEnd).toBeGreaterThan(fenceStart);
    expect(body.indexOf('checkpointing candidate abc12345')).toBeGreaterThan(fenceStart);
    expect(body.indexOf('checkpointing candidate abc12345')).toBeLessThan(fenceEnd);
  });

  it('does not displace the suite output the log already existed to preserve', async () => {
    // The negative control. A "fix" that wrote the transcript OVER the suite stdout would
    // satisfy the assertion above while destroying the log's original purpose.
    recordOrchestratorLine('quiet-cut: tip deadbeef is 63s old (<240s quiet window)');
    const body = await runAndReadLog('Test Files  571 passed (573)\n      Tests  42576 passed\n');

    expect(body).toContain('Test Files  571 passed (573)');
    expect(body).toContain('Tests  42576 passed');
    // header first, then the transcript, then the suite output it precedes.
    // WI-37605: the header now emits the RESOLVED tag, so this must not hardcode the production
    // literal — under vitest the same write path legitimately produces the FIXTURE tag, which is
    // the whole point (a log written by a test announces itself in its own first line instead of
    // opening byte-identically to a genuine verdict log). Resolving it here keeps the assertion
    // about ORDERING, which is what this test exists to pin.
    expect(body.indexOf(`${orchestratorStdoutTag()} candidate=`)).toBe(0);
    expect(body.indexOf('--- orchestrator transcript')).toBeLessThan(body.indexOf('Test Files  571 passed'));
  });

  it('⭐ the header FORWARDS to the promotion trailer (EI-20014356905761236)', async () => {
    // The seam between the two halves of that fix, which are otherwise tested apart: the
    // header is written HERE, by the suite dep, and cannot know the promotion outcome — the
    // decision is taken later, by runGreenCheckpoint. So this line's only job is to forward
    // the reader. Stop forwarding and `green=true` goes straight back to being read as
    // "this became the pin", which is the whole incident.
    const body = await runAndReadLog('Test Files  3 passed (3)\n');
    const header = body.split('\n')[0]!;

    expect(header).toContain('green=');
    expect(header).toContain('promoted=see-GATE_PROMOTION');
    // ...and it must state what ABSENCE means, or a run killed before its decision (which
    // writes no trailer at all) reads as a missing field rather than a real third state.
    expect(header).toContain('never reached a promotion decision');
  });

  it('adds no fence at all when the run recorded nothing (an empty header is worse than none)', () => {
    // Kept as a direct call rather than a runGreen round-trip: runGreen legitimately logs
    // its own lines before the write, so "empty transcript" is not reachable through it.
    expect(renderOrchestratorTranscript([])).toBe('');
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

  it('uses the affected runner break-set for node --test output that has no Vitest rows', () => {
    const file = 'test/build-desktop-sidecar-lock.test.js';
    const out = [
      '>>> @papercusp/desktop :: npm run test',
      'ℹ fail 1',
      `test at ${file}:11:1`,
      '✖ every cargo build closes the sidecar flock fd before sccache can daemonize (3.4ms)',
      formatFailingFilesLine({
        runToken: '3655179-735cdb19',
        entries: [{ workspace: '@papercusp/desktop', file }],
      }),
      'AFFECTED_TESTS_RESULT status=failed tasks=1 failed=1',
    ].join('\n');
    expect(parseFailingFilesByWorkspace(out)).toEqual([{ workspace: '@papercusp/desktop', file }]);
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

  // WI-7501 — the same displacement, one rung deeper, and the guard above could not reach it.
  //
  // That guard suppresses a displaced bare FAIL row only for a file some ROLLUP already named.
  // A file that fails at COLLECTION emits `❯ …arm.test.ts (0 test)` — zero tests collected, no
  // `failed` token — and `vitestSummaryFailRow` requires that token, so NO rollup names it. Its
  // only rows are bare FAIL rows, and every one of them lands in the epilogue after the last
  // normal section, so it was attributed to whichever workspace happened to run last.
  //
  // Measured live on cand a94547c8 (2026-08-03): two operator-core files came back as
  // `@papercusp/eval-battery` files. That is not a cosmetic mislabel — the pair is the cwd for
  // the re-run, so isolation AND the tip rescue both re-ran them in a workspace that does not
  // contain them, matching zero files and exiting 1 every time. `runTestsAtRef` therefore
  // returned pass:false ⇒ `real-red` ⇒ autoRefire:false, making the red structurally
  // unrescuable however thoroughly the tree was fixed. It fires precisely on import/transform
  // breaks — the class a peer's in-flight commit causes, i.e. the reds MOST likely already
  // fixed at tip and most in need of the rescue.
  //
  // Fixed by recognising the absorption marker as a section header (it names the workspace
  // explicitly) and treating that attribution as authoritative over positional placement.
  it('WI-7501: attributes a COLLECTION-error file (0 tests, no rollup) to its OWN workspace, not the last one to run', () => {
    const out = [
      '>>> @papercusp/operator-core :: npm run test',
      // Zero tests collected ⇒ no `failed` token ⇒ no rollup row for this file, ever.
      ' ❯ lib/agent-tools/loop/arm.test.ts (0 test)',
      '>>> @papercusp/eval-battery :: npm run test',
      ' Tests  4 passed (4)',
      // Displaced epilogue: operator-core's row, flushed under a foreign header.
      ' FAIL  lib/agent-tools/loop/arm.test.ts [ lib/agent-tools/loop/arm.test.ts ]',
      // The absorption re-run names the owning workspace — the authoritative attribution.
      '>>> @papercusp/operator-core FAILED — fresh-process re-run of 1 failed file(s) (HARDEN-GATE flake absorption): lib/agent-tools/loop/arm.test.ts',
      ' FAIL  lib/agent-tools/loop/arm.test.ts [ lib/agent-tools/loop/arm.test.ts ]',
    ].join('\n');
    // Exactly ONE pair, under operator-core. A second eval-battery pair would be the live bug:
    // unrunnable by construction, and enough on its own to pin the gate red forever.
    expect(parseFailingFilesByWorkspace(out)).toEqual([
      { workspace: '@papercusp/operator-core', file: 'lib/agent-tools/loop/arm.test.ts' },
    ]);
  });

  // The `>>> …` chatter the affected-runner emits between sections must never be mistaken for a
  // header now that a second header shape is recognised — otherwise a cargo section would
  // capture every subsequent file under a bogus workspace named "Running".
  it('WI-7501: does not treat non-package `>>>` chatter as a section header', () => {
    const out = [
      '>>> @papercusp/operator-core :: npm run test',
      '>>> Running cargo tests (P-009: papercusp-desktop/src-tauri Rust suite)...',
      ' FAIL  lib/a.test.ts > case',
    ].join('\n');
    expect(parseFailingFilesByWorkspace(out)).toEqual([
      { workspace: '@papercusp/operator-core', file: 'lib/a.test.ts' },
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
    // WI-6956: absorption now also requires the CONFIRMING co-execution pass. The
    // 2026-06-23 incident was genuine box-weather, so the files pass together too.
    const out = await attemptFlakeAbsorption(INCIDENT_OUTPUT, isolationRun, undefined, {
      concurrentRun: async ({ workspace }) => ({ workspace, passed: true }),
    });
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
        // WI-6956: EI-15849 was genuine ambient load — once the box settled the files
        // pass CO-EXECUTED too, so the confirming pass must not block this absorption.
        concurrentRun: async ({ workspace }) => ({ workspace, passed: true }),
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

    it('a SLOW failing attempt on a SATURATED host is logged as consistent with ambient load', async () => {
      const logs: string[] = [];
      const slowMs = ISOLATION_LOAD_STARVATION_MIN_MS + 5_000;
      const isolationRun = async ({ workspace, file }: { workspace: string; file: string }): Promise<IsolationResult> => ({
        workspace,
        file,
        passed: false,
        durationMs: slowMs,
      });
      await attemptFlakeAbsorption(INCIDENT_OUTPUT, isolationRun, (s) => logs.push(s), {
        sleep: async () => {},
        // The box really was oversubscribed — 1.5 runnable tasks per core.
        loadPerCore: () => ISOLATION_LOAD_STARVATION_MIN_LOAD_PER_CORE + 0.5,
      });
      const attributionLines = logs.filter((l) => l.includes('still failing after attempt'));
      expect(attributionLines.length).toBeGreaterThan(0);
      for (const line of attributionLines) {
        expect(line).toContain(`took ${slowMs}ms`);
        expect(line).toContain('consistent with ambient host load');
        expect(line).toContain('loadavg/core 1.50'); // the reader can check the claim
      }
    });

    // EI-19368177649203822 / EI-19367962245538796 — THE RECURRENCE GUARD. A duration-only
    // test blamed ambient load for 7 of 7 isolation failures in the 2026-08-02 18:02:14Z
    // verdict, because `durationMs` wraps the whole vitest spawn (boot + transform + import
    // = 5-25s) and so ALWAYS clears the 1s bound. That boilerplate read as a gate defect:
    // two agents filed contradictory bugs from it, and one proposed promoting the prose to a
    // CLASSIFICATION — which would have absorbed nearly every red into a false green. A slow
    // failure on an IDLE box must therefore never be attributed to load.
    it('a SLOW failing attempt on an UNSATURATED host is NOT blamed on ambient load', async () => {
      const logs: string[] = [];
      const slowMs = 19_137; // the measured adv-agent-detail.test.ts attempt from that verdict
      const isolationRun = async ({ workspace, file }: { workspace: string; file: string }): Promise<IsolationResult> => ({
        workspace,
        file,
        passed: false,
        durationMs: slowMs,
      });
      await attemptFlakeAbsorption(INCIDENT_OUTPUT, isolationRun, (s) => logs.push(s), {
        sleep: async () => {},
        loadPerCore: () => 0.1, // plenty of free cores — nothing was starving this run
      });
      const attributionLines = logs.filter((l) => l.includes('still failing after attempt'));
      expect(attributionLines.length).toBeGreaterThan(0);
      for (const line of attributionLines) {
        expect(line).toContain(`took ${slowMs}ms`);
        expect(line).toContain('NOT a supported explanation');
        expect(line).toContain('loadavg/core 0.10');
        // The precise regression: the old duration-only rule emitted this for exactly this input.
        expect(line).not.toContain('consistent with ambient host load');
      }
    });

    // EI-19369790810564409: a deterministic AssertionError signature must win over the
    // load-based wording UNCONDITIONALLY — even on a genuinely SATURATED host, where the
    // pre-existing load-corroboration guard (EI-19368177649203822) would otherwise still
    // print "consistent with ambient host load" for a failure that is provably not
    // load-shaped (a saturated CPU can only make a comparison slower, never wrong).
    it('a SLOW failing attempt with an assertion signature is NOT blamed on ambient load, even on a saturated host', async () => {
      const logs: string[] = [];
      const slowMs = ISOLATION_LOAD_STARVATION_MIN_MS + 5_000;
      const isolationRun = async ({ workspace, file }: { workspace: string; file: string }): Promise<IsolationResult> => ({
        workspace,
        file,
        passed: false,
        durationMs: slowMs,
        hasAssertionSignature: true,
      });
      await attemptFlakeAbsorption(INCIDENT_OUTPUT, isolationRun, (s) => logs.push(s), {
        sleep: async () => {},
        // The box really is oversubscribed — if load alone drove the wording, this would
        // read "consistent with ambient host load". It must not.
        loadPerCore: () => ISOLATION_LOAD_STARVATION_MIN_LOAD_PER_CORE + 0.5,
      });
      const attributionLines = logs.filter((l) => l.includes('still failing after attempt'));
      expect(attributionLines.length).toBeGreaterThan(0);
      for (const line of attributionLines) {
        expect(line).toContain(`took ${slowMs}ms`);
        expect(line).toContain('deterministic AssertionError, not a timeout');
        expect(line).toContain('NOT load-shaped however busy the host is');
        expect(line).not.toContain('consistent with ambient host load');
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

  // WI-6969: the retry loop's "cheap first cut" — a static/structural assertion (compares
  // two in-process data structures, no I/O, no timing) reproduces byte-identically on
  // every attempt, so retrying it can never change the outcome. The observed incident
  // blamed "ambient host load" for three such assertions and burned a retry cycle on each
  // before giving up. This short-circuits the retry the moment an attempt's own failure
  // shape already proves determinism.
  describe('WI-6969: failure-shape short-circuit (skip a retry that is already proven doomed)', () => {
    const outWithMatchingCase = [
      'Affected workspaces (1): @papercusp/operator-core',
      '',
      '>>> @papercusp/operator-core :: npm run test',
      ' ❯ lib/sync-resolver/resolver-backing-table-coverage.test.ts (1 tests | 1 failed) 14095ms',
      '     × every registry entry either declares backingTables or is in the baseline 14095ms',
      '>>> @papercusp/operator-core FAILED',
      '',
      '1 non-quarantined task(s) failed.',
    ].join('\n');

    const outWithTimeoutCase = [
      'Affected workspaces (1): @papercusp/operator-core',
      '',
      '>>> @papercusp/operator-core :: npm run test',
      ' ❯ lib/scout/scheduler-workspace-scope.test.ts (12 tests | 1 failed) 21034ms',
      '     × schedules within the workspace scope 21034ms',
      '>>> @papercusp/operator-core FAILED',
      '',
      '1 non-quarantined task(s) failed.',
    ].join('\n');

    it('an attempt matching the ORIGINAL failure exactly (same case, no timing signature) skips the retry entirely', async () => {
      let calls = 0;
      const isolationRun = async ({ workspace, file }: { workspace: string; file: string }): Promise<IsolationResult> => {
        calls++;
        return {
          workspace,
          file,
          passed: false,
          durationMs: 14095,
          failingCases: ['every registry entry either declares backingTables or is in the baseline'],
          hasTimingSignature: false,
        };
      };
      const logs: string[] = [];
      const out = await attemptFlakeAbsorption(outWithMatchingCase, isolationRun, (s) => logs.push(s), {
        // If the short-circuit fails to fire, this would sleep for real — fail loudly
        // instead of silently passing a slow test.
        sleep: async () => {
          throw new Error('should not sleep — the retry must be skipped by the shape short-circuit');
        },
      });
      expect(out.absorbedToGreen).toBe(false);
      expect(calls).toBe(1); // no retry — abandoned after the first attempt
      const abandonLine = logs.find((l) => l.includes('abandoning remaining retry budget'));
      expect(abandonLine).toBeDefined();
      expect(abandonLine).toContain('IDENTICAL case list');
      expect(abandonLine).toContain('every registry entry either declares backingTables or is in the baseline');
      // never reached the load-attribution retry line — the short-circuit fires first
      expect(logs.some((l) => l.includes('still failing after attempt'))).toBe(false);
    });

    it('a MATCHING case list but WITH a timing signature does NOT skip the retry (a load-sensitive timeout can reproduce identically)', async () => {
      let calls = 0;
      const isolationRun = async ({ workspace, file }: { workspace: string; file: string }): Promise<IsolationResult> => {
        calls++;
        return {
          workspace,
          file,
          passed: false,
          durationMs: 21034,
          failingCases: ['schedules within the workspace scope'],
          hasTimingSignature: true, // e.g. output containing "Test timed out in 20000ms"
        };
      };
      const out = await attemptFlakeAbsorption(outWithTimeoutCase, isolationRun, undefined, { sleep: async () => {} });
      expect(out.absorbedToGreen).toBe(false);
      expect(calls).toBe(1 + ISOLATION_RETRY_MAX); // retried as before — unchanged behavior
    });

    it('a DIFFERENT case list does not trigger the short-circuit (unchanged retry behavior)', async () => {
      let calls = 0;
      const isolationRun = async ({ workspace, file }: { workspace: string; file: string }): Promise<IsolationResult> => {
        calls++;
        return {
          workspace,
          file,
          passed: false,
          durationMs: 14095,
          failingCases: ['a wholly different case than the original failure'],
          hasTimingSignature: false,
        };
      };
      const out = await attemptFlakeAbsorption(outWithMatchingCase, isolationRun, undefined, { sleep: async () => {} });
      expect(out.absorbedToGreen).toBe(false);
      expect(calls).toBe(1 + ISOLATION_RETRY_MAX); // retried as before — unchanged behavior
    });

    it('an attempt with NO failingCases (a hand-built fixture, or a build-break output) never short-circuits', async () => {
      // Regression guard: every pre-existing test in this file constructs IsolationResult
      // without failingCases/hasTimingSignature. The short-circuit must stay inert for them.
      let calls = 0;
      const isolationRun = async ({ workspace, file }: { workspace: string; file: string }): Promise<IsolationResult> => {
        calls++;
        return { workspace, file, passed: false, durationMs: 14095 };
      };
      await attemptFlakeAbsorption(outWithMatchingCase, isolationRun, undefined, { sleep: async () => {} });
      expect(calls).toBe(1 + ISOLATION_RETRY_MAX);
    });
  });

  describe('isDeterministicFailureShape / outputHasTimingSignature (WI-6969, pure)', () => {
    const attempt = (over: Partial<IsolationResult> = {}): IsolationResult => ({
      workspace: '@p/core',
      file: 'a.test.ts',
      passed: false,
      ...over,
    });

    it('true: identical non-empty case sets (order-independent), no timing signature', () => {
      expect(
        isDeterministicFailureShape({ originalCases: ['a', 'b'], attempt: attempt({ failingCases: ['b', 'a'] }) }),
      ).toBe(true);
    });

    it('false: original cases missing or empty (nothing to compare against)', () => {
      expect(isDeterministicFailureShape({ originalCases: undefined, attempt: attempt({ failingCases: ['a'] }) })).toBe(
        false,
      );
      expect(isDeterministicFailureShape({ originalCases: [], attempt: attempt({ failingCases: ['a'] }) })).toBe(false);
    });

    it('false: the attempt has no failing cases parsed', () => {
      expect(isDeterministicFailureShape({ originalCases: ['a'], attempt: attempt() })).toBe(false);
    });

    it('false: the case sets differ', () => {
      expect(isDeterministicFailureShape({ originalCases: ['a'], attempt: attempt({ failingCases: ['b'] }) })).toBe(
        false,
      );
    });

    it('false: a timing signature is present even when the case list matches exactly (fail-safe)', () => {
      expect(
        isDeterministicFailureShape({
          originalCases: ['a'],
          attempt: attempt({ failingCases: ['a'], hasTimingSignature: true }),
        }),
      ).toBe(false);
    });

    it('outputHasTimingSignature detects waitFor / Timed out / Exceeded timeout, case-insensitively', () => {
      expect(outputHasTimingSignature('something using waitFor(...) internally')).toBe(true);
      expect(outputHasTimingSignature('Test timed out in 5000ms')).toBe(true);
      expect(outputHasTimingSignature('Exceeded timeout of 5000ms for a hook')).toBe(true);
      expect(outputHasTimingSignature('every registry entry is in the baseline')).toBe(false);
    });

    // EI-19369790810564409: outputHasAssertionSignature mirrors outputHasTimingSignature —
    // direct, positive evidence of a deterministic vitest assertion failure, independent of
    // the case-list comparison isDeterministicFailureShape needs.
    it('outputHasAssertionSignature detects AssertionError / "expected ... to ..." diffs, case-insensitively', () => {
      expect(
        outputHasAssertionSignature("AssertionError: expected [ 'a', 'b' ] to deeply equal []"),
      ).toBe(true);
      expect(outputHasAssertionSignature('assertionerror: something failed')).toBe(true);
      expect(outputHasAssertionSignature('expected 3 to equal 4')).toBe(true);
      expect(outputHasAssertionSignature('every registry entry is in the baseline')).toBe(false);
    });
  });

  // WI-6956: the absorber's discriminator ("passes in isolation") IS the defining
  // property of a concurrency-dependent failure class, so for that class it was
  // structurally blind — and the only thing preventing a false green was
  // ISOLATION_MAX_FILES declining to look at a big red. That makes the bug fire on
  // PROGRESS: shrink such a class past the guard and the gate flips green on a broken
  // tree. These pin the confirming co-execution pass that closes it.
  describe('WI-6956 confirming co-execution pass (a concurrency-dependent class is never absorbed)', () => {
    /** Every file passes ALONE — the signature shared by genuine weather AND by the bug. */
    const passesAlone = async ({ workspace, file }: { workspace: string; file: string }): Promise<IsolationResult> => ({
      workspace,
      file,
      passed: true,
    });

    it('THE RECURRENCE GUARD: files that all pass ALONE but REPRODUCE co-executed are NOT absorbed', async () => {
      const out = await attemptFlakeAbsorption(INCIDENT_OUTPUT, passesAlone, undefined, {
        // the no-real-PG rail's exact shape: clean alone, fails the moment they run together
        concurrentRun: async ({ workspace }) => ({ workspace, passed: false }),
      });
      expect(out.absorbedToGreen).toBe(false);
      expect(out.flakeSuspects).toEqual([]);
      expect(out.note).toContain('REPRODUCED');
      expect(out.note).toContain('CONCURRENCY-DEPENDENT DEFECT');
    });

    it('passes the originally-failing files of each workspace to the confirming run, TOGETHER', async () => {
      const batches: { workspace: string; files: string[] }[] = [];
      await attemptFlakeAbsorption(INCIDENT_OUTPUT, passesAlone, undefined, {
        concurrentRun: async ({ workspace, files }) => {
          batches.push({ workspace, files });
          return { workspace, passed: true };
        },
      });
      // one co-executed batch for the single workspace, carrying BOTH failing files
      expect(batches).toHaveLength(1);
      expect(batches[0].workspace).toBe('@papercusp/operator-core');
      expect(batches[0].files).toEqual([
        'lib/llm-testing/__tests__/runner-aggregate.test.ts',
        'lib/scout/scheduler-workspace-scope.test.ts',
      ]);
    });

    it('an ABSENT confirming runner declines to absorb (fail-safe, never the old pass-alone criterion)', async () => {
      const out = await attemptFlakeAbsorption(INCIDENT_OUTPUT, passesAlone);
      expect(out.absorbedToGreen).toBe(false);
      expect(out.note).toContain('NO confirming co-execution re-run');
    });

    it('a THROWING confirming runner is undetermined ⇒ stays red (uncertainty never flips green)', async () => {
      const out = await attemptFlakeAbsorption(INCIDENT_OUTPUT, passesAlone, undefined, {
        concurrentRun: async () => {
          throw new Error('vitest spawn failed');
        },
      });
      expect(out.absorbedToGreen).toBe(false);
      expect(out.note).toContain('UNDETERMINED');
    });

    it('an ERRORED confirming result is undetermined ⇒ stays red', async () => {
      const out = await attemptFlakeAbsorption(INCIDENT_OUTPUT, passesAlone, undefined, {
        concurrentRun: async ({ workspace }) => ({ workspace, passed: false, errored: true }),
      });
      expect(out.absorbedToGreen).toBe(false);
      expect(out.note).toContain('UNDETERMINED');
    });

    it('EI-15849 stays absorbable: genuine weather passes co-executed once the box settles', async () => {
      const out = await attemptFlakeAbsorption(INCIDENT_OUTPUT, passesAlone, undefined, {
        concurrentRun: async ({ workspace }) => ({ workspace, passed: true }),
      });
      expect(out.absorbedToGreen).toBe(true);
      expect(out.note).toContain('CO-EXECUTED');
    });

    it('the confirming pass never runs at all when isolation already found a real break', async () => {
      let confirmCalled = false;
      const out = await attemptFlakeAbsorption(
        INCIDENT_OUTPUT,
        async ({ workspace, file }) => ({ workspace, file, passed: false }),
        undefined,
        {
          sleep: async () => {},
          concurrentRun: async ({ workspace }) => {
            confirmCalled = true;
            return { workspace, passed: true };
          },
        },
      );
      expect(out.absorbedToGreen).toBe(false);
      expect(confirmCalled).toBe(false);
    });
  });

  describe('decideConcurrencyConfirmation (pure)', () => {
    const ff = (workspace: string, file: string) => ({ workspace, file });

    it('weather: every workspace passed co-executed', () => {
      const d = decideConcurrencyConfirmation({
        originalFailing: [ff('@p/core', 'a.test.ts'), ff('@p/core', 'b.test.ts')],
        concurrentResults: [{ workspace: '@p/core', passed: true }],
      });
      expect(d.verdict).toBe('weather');
    });

    it('reproduced: any workspace failing co-executed wins over an undetermined sibling', () => {
      const d = decideConcurrencyConfirmation({
        originalFailing: [ff('@p/core', 'a.test.ts'), ff('@p/web', 'b.test.ts')],
        concurrentResults: [
          { workspace: '@p/core', passed: false },
          { workspace: '@p/web', passed: false, errored: true },
        ],
      });
      expect(d.verdict).toBe('reproduced');
      expect(d.reproducedIn).toEqual(['@p/core']);
      expect(d.undeterminedIn).toEqual(['@p/web']);
    });

    it('undetermined: a workspace with NO confirming result is never assumed to have passed', () => {
      const d = decideConcurrencyConfirmation({
        originalFailing: [ff('@p/core', 'a.test.ts'), ff('@p/web', 'b.test.ts')],
        concurrentResults: [{ workspace: '@p/core', passed: true }], // nothing for @p/web
      });
      expect(d.verdict).toBe('undetermined');
      expect(d.undeterminedIn).toEqual(['@p/web']);
    });

    it('undetermined: no originally-failing files (nothing was confirmed)', () => {
      expect(decideConcurrencyConfirmation({ originalFailing: [], concurrentResults: [] }).verdict).toBe(
        'undetermined',
      );
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
    // EI-19329608646178878: the confirm step (`runGreen:confirm`) checked out `prefixTip`
    // (c3) via setupTree — the checkpoint tree must be restored to the run's TRUE candidate
    // (c4) afterward, so a live probe of that checkout (candidateSource:'run-probe' on the
    // cron path) never reports the stale salvage prefix as "the candidate under judgment".
    const setupCalls = calls.filter((c) => c.startsWith('setup:'));
    expect(setupCalls[setupCalls.length - 1]).toBe(`setup:${c4.slice(0, 7)}`);
  });

  it('holds (no advance) when the confirm-run on the prefix is RED — never FFs to unconfirmed', async () => {
    const { c1, c3, c4 } = await chain();
    const { deps, calls } = partialDeps({
      candidateFailingTests: ['@ws/failing'],
      affected: { [c4]: ['@ws/failing'] }, // c3 not listed ⇒ clean ⇒ chosen as the prefix to confirm
      commits: [c3, c4],
      confirmGreen: false, // the chosen prefix did NOT confirm green ⇒ must hold
    });
    const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });
    expect(r.reason).toBe('not-green');
    expect(r.advanced).toBe(false);
    expect(await revParse(repo, 'ready')).toBe(c1); // unchanged — no FF to an unconfirmed commit
    // EI-19329608646178878: even on a FAILED confirm, the checkout was left at the
    // unconfirmed prefix (c3) mid-function — it must still be restored to the real
    // candidate (c4) before this run's final hold-result is returned.
    const setupCalls = calls.filter((c) => c.startsWith('setup:'));
    expect(setupCalls[setupCalls.length - 1]).toBe(`setup:${c4.slice(0, 7)}`);
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

  // WI-38207: the salvage path must STATE ITS DISPOSITION on every branch. Measured
  // 2026-08-12: `main` sat at one sha for 22h across 16 red runs, and not one log could say
  // whether this mechanism had run, because "never attempted" and "attempted, found nothing"
  // both emitted zero lines. These assert the log, not the promotion decision — an inert
  // safety net that cannot report itself is the failure being guarded against.
  it('WI-38207: logs "no salvageable green prefix" when the salvage RAN and found nothing', async () => {
    const { c1, c2, c3, c4 } = await chain();
    const { deps } = partialDeps({
      candidateFailingTests: ['@ws/failing'],
      affected: { [c2]: ['@ws/other'], [c3]: ['@ws/other'], [c4]: ['@ws/failing'] },
      commits: [c2, c3, c4],
      confirmGreen: false, // the confirm suite fails ⇒ tryLongestGreenPrefix returns null
    });
    const lines: string[] = [];
    deps.log = (s: string) => { lines.push(s); };
    await runGreenCheckpoint(cfg(), deps, { noPush: true });
    expect(await revParse(repo, 'ready')).toBe(c1); // still held — behaviour unchanged
    const dispositions = lines.filter((l) => l.includes('partial-green-gate:'));
    expect(dispositions.length).toBeGreaterThan(0);
    expect(dispositions.some((l) => l.includes('no salvageable green prefix'))).toBe(true);
    // and it must be distinguishable from the never-ran case
    expect(dispositions.some((l) => l.includes('skipped'))).toBe(false);
  });

  it('WI-38207: logs a distinct "skipped — disabled" disposition when opted out', async () => {
    process.env.PAPERCUSP_PARTIAL_GREEN_GATE = '0';
    const { c2, c3, c4 } = await chain();
    const { deps } = partialDeps({
      candidateFailingTests: ['@ws/failing'],
      affected: { [c2]: ['@ws/other'], [c3]: ['@ws/other'], [c4]: ['@ws/failing'] },
      commits: [c2, c3, c4],
      confirmGreen: true,
    });
    const lines: string[] = [];
    deps.log = (s: string) => { lines.push(s); };
    await runGreenCheckpoint(cfg(), deps, { noPush: true });
    const dispositions = lines.filter((l) => l.includes('partial-green-gate:'));
    expect(dispositions.some((l) => l.includes('disabled by PAPERCUSP_PARTIAL_GREEN_GATE=0'))).toBe(true);
    // the opted-out run must NOT claim it looked for a prefix
    expect(dispositions.some((l) => l.includes('no salvageable green prefix'))).toBe(false);
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

  /**
   * EI-19458822909084210 — the anti-drift guard.
   *
   * This rule was defined TWICE: here (the AUTHORITY that drives real candidate selection)
   * and in release-checkpoint-launch.ts (the launch-side PREDICTOR of what this module will
   * pick). The copies had already drifted — only the predictor floored — so they disagreed
   * for a non-integer PAPERCUSP_QUIET_CUT_SEC. A predictor that can disagree with the
   * authority it predicts is the whole bug class.
   *
   * Referential identity is the guard rather than a behavioral re-assertion on purpose:
   * re-testing the VALUES would still pass if someone reintroduced a local copy that merely
   * happened to agree today, which is exactly how the first drift went unnoticed. Comparing
   * function identity fails the instant a second definition exists at all.
   */
  it('is the SINGLE shared definition — not a local copy that merely agrees today', async () => {
    const shared = await import('@papercusp/operator-core/lib/release/quiet-cut');
    expect(quietCutSecFromEnv).toBe(shared.quietCutSecFromEnv);

    // CONTROL (falsifiability): a re-implementation that agrees on every value the old
    // copies agreed on is still a DIFFERENT function. This proves the assertion above
    // discriminates by identity rather than passing trivially — i.e. that it really would
    // catch a reintroduced local copy, which is the only failure mode it exists to catch.
    const reintroducedLocalCopy = (env: NodeJS.ProcessEnv = process.env): number => {
      if (env.PAPERCUSP_QUIET_CUT === '0') return 0;
      const v = Number(env.PAPERCUSP_QUIET_CUT_SEC);
      return Number.isFinite(v) && v >= 0 ? Math.floor(v) : 240;
    };
    // NODE_ENV is spelled out because Next's global augmentation (next-env.d.ts →
    // next/types/global.d.ts) makes it REQUIRED on ProcessEnv, so a bare {} does not
    // satisfy the parameter type. The older call sites in this file omit it and are
    // carried in apps/operator/.tsc-baseline.json; new ones should not add to that debt.
    const env: NodeJS.ProcessEnv = { NODE_ENV: 'test' };
    expect(reintroducedLocalCopy(env)).toBe(quietCutSecFromEnv(env)); // agrees behaviorally…
    expect(reintroducedLocalCopy).not.toBe(shared.quietCutSecFromEnv); // …and is still caught.
  });

  it('floors a non-integer window — the exact value the two copies used to disagree on', () => {
    // NODE_ENV: Next's global augmentation makes it REQUIRED on ProcessEnv (see above).
    const withSec = (sec: string): NodeJS.ProcessEnv => ({
      NODE_ENV: 'test',
      PAPERCUSP_QUIET_CUT_SEC: sec,
    });
    // Pre-fix: the authority returned 90.7 while the predictor returned 90.
    expect(quietCutSecFromEnv(withSec('90.7'))).toBe(90);
    // A negative window is nonsense, not a disable — it must fall back, not return 0.
    expect(quietCutSecFromEnv(withSec('-5'))).toBe(240);
    // '0' via _SEC is a real 0-second window (only PAPERCUSP_QUIET_CUT=0 is the opt-out).
    expect(quietCutSecFromEnv(withSec('0'))).toBe(0);
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

describe('P-004/D-002 — the gate-verdict WAKE BANNER is attributable to its pipeline', () => {
  // EI-15925 (above) fixed this class for `broadcast` and judged the event path already
  // covered because the event PAYLOAD carries `pipeline`. It was not: an await's `summary`
  // is the wake banner an agent actually reads, and it stayed pipeline-blind — so the same
  // confusion recurred 15 days later on the same pipeline. `release:green:*` await 42194
  // woke a papercusp agent on ODDSMITH's advance of 9a8aa848 (papercusp had no
  // green_checkpoint row in that window) and it reported the gate green
  // (EI-19311522275272409). The GLOBAL key is emitted by every co-hosted pipeline, so it —
  // not the glob — is the widest carrier; both keys must carry the label.
  const captureSummaries = (green: boolean): { deps: CheckpointDeps; summaries: Record<string, string> } => {
    const summaries: Record<string, string> = {};
    return {
      summaries,
      deps: {
        setupTree: async () => {},
        runGreen: async () => ({ green, summary: green ? 'all pass' : '3 failed' }),
        advance: (candidate) => advanceReady(repo, candidate, 'ready'),
        push: async () => {},
        broadcast: async () => {},
        escalate: async () => {},
        clearEscalation: async () => {},
        emitEvent: async ({ key, summary }) => {
          summaries[key] = summary;
        },
        log: () => {},
      },
    };
  };

  it('labels the GREEN summary on BOTH the global and the pipeline-scoped key', async () => {
    const c1 = await commit('a', '1', 'c1');
    await git(repo, ['branch', 'ready', c1]);
    const c2 = await commit('a', '2', 'c2');
    const { deps, summaries } = captureSummaries(true);
    await runGreenCheckpoint(cfg(), deps, { noPush: true });

    const pipeline = pipelineName(repo);
    const expected = `[${pipeline}] ready advanced to ${c2.slice(0, 8)} (green, deployable)`;
    expect(summaries['release:green']).toBe(expected);
    expect(summaries[`release:green:${pipeline}`]).toBe(expected);
    // The whole point: the banner alone must identify the pipeline, with no payload read.
    expect(summaries['release:green']).toContain(pipeline);
  });

  it('labels the RED summary on BOTH keys too — a foreign red must not read as your gate', async () => {
    const c1 = await commit('a', '1', 'c1');
    await git(repo, ['branch', 'ready', c1]);
    const c2 = await commit('a', '2', 'c2');
    const { deps, summaries } = captureSummaries(false);
    await runGreenCheckpoint(cfg(), deps, { noPush: true });

    const pipeline = pipelineName(repo);
    const expected = `[${pipeline}] green-checkpoint: ${c2.slice(0, 8)} not green — ready held`;
    expect(summaries['green-checkpoint:red']).toBe(expected);
    expect(summaries[`green-checkpoint:red:${pipeline}`]).toBe(expected);
  });
});

/**
 * RECURRENCE GUARD — the post-suite legs must NOT inherit the per-FORK heap cap.
 *
 * `main` sat frozen ~11h behind an OOM caused by two locally-correct fixes cancelling
 * each other: the gate pins NODE_OPTIONS to GREEN_CHECKPOINT_FORK_HEAP_MB (4 GiB,
 * sized for EIGHT CONCURRENT vitest forks) and hands that same env to the post-suite
 * legs, which run SEQUENTIALLY; `tscChildEnv` (scripts/lib/tsc-baseline-gate.mjs) then
 * DEFERS to any pin the caller already set — deliberately, so a constrained box can pin
 * a smaller one and win — so its TSC_HEAP_MB=8192 could never apply inside the gate.
 * Candidate 28ad34252e5f died at `Scavenge 4069.4 (4092.1) MB`.
 *
 * This asserts the WIRING, not the constant. WI-37503's fix existed and was INERT
 * because nothing checked it reached the path the gate actually runs — precisely the
 * failure this guard must be able to catch.
 */
describe("post-suite legs get their own heap (WI-37510: fork cap OOM'd lint:tsc, froze main ~11h)", () => {
  it('the POST-SUITE ceiling must exceed the per-fork cap, or the whole fix is a no-op', () => {
    expect(GREEN_CHECKPOINT_POST_SUITE_HEAP_MB).toBeGreaterThan(GREEN_CHECKPOINT_FORK_HEAP_MB);
  });

  it('spawns lint:tsc with the POST-SUITE heap, never the 4 GiB fork cap', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'green-postsuite-heap-'));
    try {
      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({ name: 'fixture', scripts: { 'lint:tsc': 'node scripts/lint-tsc.mjs' } }),
      );

      let lintTscNodeOptions: string | undefined;
      const exec = (async (_cmd: string, args: string[], opts?: { env?: NodeJS.ProcessEnv }) => {
        if (args.includes('lint:tsc')) lintTscNodeOptions = opts?.env?.NODE_OPTIONS;
        return { code: 0, stdout: '', stderr: '' };
      }) as unknown as Parameters<typeof runPostSuiteLegs>[2];

      // The env EXACTLY as the gate builds it: the bg-host's 128 GiB stripped and
      // pinned to the per-fork cap. This is the input that caused the outage.
      const suiteEnv: NodeJS.ProcessEnv = {
        NODE_ENV: 'test',
        NODE_OPTIONS: sanitizeForkNodeOptions('--expose-gc --max-old-space-size=131072'),
      };
      // Precondition: prove the fixture reproduces the BAD input, so a passing
      // assertion below cannot come from an env that was never capped in the first place.
      expect(suiteEnv.NODE_OPTIONS).toContain(`--max-old-space-size=${GREEN_CHECKPOINT_FORK_HEAP_MB}`);

      await runPostSuiteLegs(dir, suiteEnv, exec, 'apps/operator');

      expect(lintTscNodeOptions).toBeDefined();
      expect(lintTscNodeOptions).toContain(`--max-old-space-size=${GREEN_CHECKPOINT_POST_SUITE_HEAP_MB}`);
      expect(lintTscNodeOptions).not.toContain(`--max-old-space-size=${GREEN_CHECKPOINT_FORK_HEAP_MB}`);
      // Exactly ONE ceiling: a second occurrence silently takes the LAST, which is how
      // an "append" fix looks correct in review and behaves unpredictably at runtime.
      expect(lintTscNodeOptions?.match(/--max-old-space-size/g)).toHaveLength(1);
      // And it must not eat unrelated flags the gate set.
      expect(lintTscNodeOptions).toContain('--expose-gc');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('WI-37527: the typecheck banner must not out-claim its evidence', () => {
  // typecheckFailureBanner() has its own unit tests in gate-artifact-verdict-tail.
  // These assert the WIRING instead: that the banner the GATE actually emits comes from
  // that helper. WI-37503 is the reason the distinction matters — a correct, committed,
  // fully-tested fix sat INERT because nothing checked it reached the path the gate runs.
  const runLintTsc = async (code: number, stdout: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'green-tsc-banner-'));
    try {
      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({ name: 'fixture', scripts: { 'lint:tsc': 'node scripts/lint-tsc.mjs' } }),
      );
      const exec = (async (_cmd: string, args: string[]) =>
        args.includes('lint:tsc')
          ? { code, stdout, stderr: '' }
          : { code: 0, stdout: '', stderr: '' }) as unknown as Parameters<typeof runPostSuiteLegs>[2];
      return await runPostSuiteLegs(dir, { NODE_ENV: 'test' }, exec, 'apps/operator');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it('a lint:tsc failure carrying NO type diagnostics must not announce type regressions', async () => {
    // The literal WI-37503 shape: non-zero exit, zero `error TS\d+`.
    const oom = 'FATAL ERROR: Ineffective mark-compacts near heap limit — JavaScript heap out of memory\n';
    const res = await runLintTsc(134, oom);

    // Preconditions: the leg really failed and its output really reached the verdict, so
    // the assertions below cannot pass merely because no banner was ever emitted.
    expect(res.typecheck.status).toBe('failed');
    expect(res.output).toContain(oom);

    expect(res.output).not.toContain('type regressions block the release');
    expect(res.output).toContain('NO type diagnostics');
    expect(res.output).toContain('exit=134');
  });

  it('a REAL type regression still gets the regression banner', async () => {
    // Calibration: without this, the assertions above would also pass if the banner were
    // deleted outright, or if the helper were wired to always emit the honest wording.
    const res = await runLintTsc(1, "foo.ts(12,3): error TS2322: Type 'a' is not assignable.\n");

    expect(res.typecheck.status).toBe('failed');
    expect(res.output).toContain('type regressions block the release');
    expect(res.output).not.toContain('NO type diagnostics');
  });

  it('CONTROL — the pre-fix hardcoded banner FAILS the property above (so the guard is falsifiable)', () => {
    // A guard that has never failed is a guard nobody has tested. Proving it here rather
    // than by mutating green-checkpoint.ts: this tree is edited concurrently by the whole
    // fleet and git-sync commits it every few minutes, so an in-tree mutation can be swept
    // into a real candidate mid-probe (that is a measured incident, not a hypothetical).
    //
    // This is the exact string the leg pushed before the wiring landed. It is a CONSTANT,
    // so it announces "type regressions" no matter what the run actually produced.
    const preFixBanner =
      '\n\n=== TYPECHECK FAILED (npm run lint:tsc) — operator-core type regressions block the release ===\n';
    const oom = 'FATAL ERROR: Ineffective mark-compacts near heap limit — JavaScript heap out of memory\n';
    const preFixOutput = preFixBanner + oom;

    // The OOM case: the pre-fix output violates both halves of the property, so a revert
    // of the wiring reds the first test deterministically rather than silently passing.
    expect(preFixOutput).toContain('type regressions block the release');
    expect(preFixOutput).not.toContain('NO type diagnostics');

    // And the reason it is wrong is not the wording but the INDIFFERENCE to evidence:
    // the same constant is emitted for output carrying no tsc diagnostic at all.
    expect(/error TS\d+/.test(oom)).toBe(false);
  });
});

/**
 * EI-20014356905761236 — the verdict log must state whether its verdict COUNTED.
 *
 * The incident (2026-08-09 ~21:53Z): one question about one candidate (33cd2bfebec8) drew
 * three different answers from three authoritative surfaces — the persisted verdict log said
 * `green=true`, `release:deploy` said `skipped-locked`, and gate_health's `observedCandidate`
 * still named an older red. Reconciling them took six tool calls, and `main` had not moved.
 * The missing datum was never the VERDICT; it was whether the verdict PROMOTED.
 *
 * The header physically cannot carry it: it is written by the suite dep at suite-end, while
 * every promotion decision (held gates / fast-forward / prefix salvage / refire) is taken
 * afterwards by runGreenCheckpoint. Hence a trailer, stamped per disposition.
 *
 * These pin the BEHAVIOUR — "the log distinguishes promoted from merely green" — not the
 * wording of any one line. The third case is the falsifiability control.
 */
describe('EI-20014356905761236: the verdict log records whether its verdict promoted', () => {
  const trailer = (logPath: string): string =>
    (readFileSync(logPath, 'utf8').match(/GATE_PROMOTION.*/g) ?? []).at(-1) ?? '';

  /** stubDeps' runGreen reports no logPath; give the run a real file to stamp. */
  const withLog = (deps: CheckpointDeps, green: boolean, logPath: string): CheckpointDeps => {
    writeFileSync(logPath, `[green-checkpoint] candidate=... green=${green} promoted=see-GATE_PROMOTION\n`);
    return {
      ...deps,
      runGreen: async () => ({ green, summary: green ? 'all pass' : '3 failed', logPath }),
    };
  };

  it('⭐ a GREEN candidate that is HELD says promoted=false, with the reason that held it', async () => {
    const c1 = await commit('a', '1', 'c1');
    await git(repo, ['branch', 'ready', c1]);
    await commit('a', '2', 'c2');
    const logPath = join(repo, 'verdict-held.log');
    const deps = withLog(stubDeps(true).deps, true, logPath);
    deps.perfGate = async () => ({ action: 'block', summary: 'perf BLOCK' });

    const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });

    expect(r).toMatchObject({ green: true, advanced: false, reason: 'perf-held' });
    expect(await revParse(repo, 'ready')).toBe(c1); // the pin genuinely did not move
    // THE POINT: the log itself now separates the two, so `green=true` in the header can no
    // longer be read as "this became the pin".
    expect(trailer(logPath)).toContain('green=true');
    expect(trailer(logPath)).toContain('promoted=false');
    expect(trailer(logPath)).toContain('reason=perf-held');
    // ...and a held verdict points AT that log, or the trailer is unreachable from the tool
    // surface that reports the hold (a held result used to carry no logPath at all).
    expect(r.logPath).toBe(logPath);
  });

  it('a candidate that really did become the pin says promoted=true (the positive control)', async () => {
    // Without this, a stamp that never fired on the happy path would be indistinguishable
    // from a working one: every observed log would simply say promoted=false.
    const c1 = await commit('a', '1', 'c1');
    await git(repo, ['branch', 'ready', c1]);
    const c2 = await commit('a', '2', 'c2');
    const logPath = join(repo, 'verdict-advanced.log');
    const deps = withLog(stubDeps(true).deps, true, logPath);

    const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });

    expect(r).toMatchObject({ green: true, advanced: true, reason: 'advanced' });
    expect(await revParse(repo, 'ready')).toBe(c2);
    expect(trailer(logPath)).toContain('promoted=true');
    expect(trailer(logPath)).toContain(`advancedTo=${c2.slice(0, 12)}`);
  });

  it('⭐ promoted reflects the ACTUAL fast-forward — not `green`, and not `reason`', async () => {
    // THE FALSIFIABILITY CONTROL. green===true and reason==='advanced' while the advance
    // itself declined, so deriving `promoted` from either would report true here. That silent
    // "reason=advanced but main never moved" state is the class of confident-wrong reading
    // this trailer exists to kill — a re-derivation from green/reason reds THIS test while
    // still passing the two above.
    const c1 = await commit('a', '1', 'c1');
    await git(repo, ['branch', 'ready', c1]);
    await commit('a', '2', 'c2');
    const logPath = join(repo, 'verdict-declined.log');
    const deps = withLog(stubDeps(true).deps, true, logPath);
    // The real decline: `advance` is FF-only, so a candidate that is not a descendant of
    // the current pin comes back advanced:false / not-fast-forward.
    deps.advance = async (candidate) => ({ advanced: false, from: c1, to: candidate, reason: 'not-fast-forward' });

    const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });

    expect(r).toMatchObject({ green: true, advanced: false, reason: 'advanced' });
    expect(trailer(logPath)).toContain('green=true');
    expect(trailer(logPath)).toContain('reason=advanced');
    expect(trailer(logPath)).toContain('promoted=false');
    expect(trailer(logPath)).not.toContain('advancedTo=');
  });

  it('renders one greppable line, in the house GATE_HELD_BY / AFFECTED_TESTS_RESULT shape', () => {
    const line = formatGatePromotionTrailer({
      candidate: 'a'.repeat(40),
      green: true,
      promoted: true,
      reason: 'advanced',
      advancedTo: 'b'.repeat(40),
    });
    // `grep -o 'GATE_PROMOTION.*'` must return the whole record, so it cannot wrap.
    expect(line.trim().split('\n')).toHaveLength(1);
    expect(line.trim()).toBe(
      'GATE_PROMOTION candidate=aaaaaaaaaaaa green=true promoted=true reason=advanced advancedTo=bbbbbbbbbbbb',
    );
  });
});
