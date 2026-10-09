/**
 * stale-routine-executor-watchdog.test.ts — EI-19409061552037718. Pure decider
 * only (no DB, no git, no DBOS) — the sweep's PG/paging orchestration mirrors
 * release-deploy-staleness-watchdog.ts's already-tested shape byte-for-byte and
 * is exercised indirectly via those siblings; this file is the DISCRIMINATION
 * bar for the actual judgment call: healthy-not-enabled, healthy-under-uptime,
 * healthy-unresolvable (fail-safe), healthy-unchanged-commit, and the one true
 * stale case.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  RESTART_SAFETY_NOTE,
  ROUTINE_DRIFT_NAME_CAP,
  STALE_EXECUTOR_GIT_SYNC_DRAIN_SEC,
  STALE_EXECUTOR_RESTART_COOLDOWN_MS,
  STALE_EXECUTOR_RESTART_RETRY_BACKOFF_MS,
  defaultPtoolScriptPath,
  resetStaleExecutorRestartStateForTests,
  restartStaleBgHostExecutor,
  evaluateExecutorStaleness,
  executorAlarmContext,
  executorIdentity,
  refreshedEscalationPayload,
  routineDriftSentence,
  staleRoutineExecutorSweep,
  staleExecutorThresholdSec,
  waitForStaleExecutorRestartGeneration,
  type ExecutorStalenessVerdict,
} from './stale-routine-executor-watchdog';
import {
  captureProcessBootIdentity,
  processBootTimeMs,
  resolveCommitsBehind,
  resolveRoutineCodeDrift,
  type RoutineCodeDrift,
} from '../../dbos/process-boot-identity';

const TWO_H = 2 * 3_600_000;
const BOOT = 1_000_000;

describe('process boot identity — import timing cannot reset executor age', () => {
  it('derives boot time from process.uptime(), not from the lazy watchdog module load', () => {
    const now = Date.now();
    const boot = processBootTimeMs();
    const uptimeMs = process.uptime() * 1000;

    expect(boot).toBeLessThanOrEqual(now);
    // Allow a small scheduling window between the two uptime/clock reads while
    // still rejecting a module-load timestamp on a long-lived test process.
    expect(Math.abs(now - boot - uptimeMs)).toBeLessThan(2_000);
  });

  it('starts the boot-commit sample when the identity is captured', async () => {
    let resolveCalls = 0;
    const identity = captureProcessBootIdentity({
      nowMs: 5_000,
      uptimeSec: 2,
      resolveCommit: async () => {
        resolveCalls += 1;
        return 'a'.repeat(40);
      },
    });

    expect(resolveCalls).toBe(1);
    expect(identity.bootTimeMs).toBe(3_000);
    await expect(identity.bootCommit).resolves.toBe('a'.repeat(40));
  });
});

describe('evaluateExecutorStaleness — the pure decider', () => {
  it('healthy when PAPERCUSP_DBOS_ROUTINES is not enabled on this process', () => {
    const v = evaluateExecutorStaleness({
      routinesEnabled: false,
      bootCommit: 'a'.repeat(40),
      currentCommit: 'b'.repeat(40),
      bootTimeMs: BOOT,
      now: BOOT + TWO_H * 10,
      thresholdMs: TWO_H,
    });
    expect(v.stale).toBe(false);
    expect(v.reason).toContain('not enabled');
  });

  it('healthy on the kill switch (thresholdMs <= 0)', () => {
    const v = evaluateExecutorStaleness({
      routinesEnabled: true,
      bootCommit: 'a'.repeat(40),
      currentCommit: 'b'.repeat(40),
      bootTimeMs: BOOT,
      now: BOOT + TWO_H * 10,
      thresholdMs: 0,
    });
    expect(v.stale).toBe(false);
    expect(v.reason).toContain('kill switch');
  });

  it('healthy under the uptime threshold, even with a commit divergence', () => {
    const v = evaluateExecutorStaleness({
      routinesEnabled: true,
      bootCommit: 'a'.repeat(40),
      currentCommit: 'b'.repeat(40),
      bootTimeMs: BOOT,
      now: BOOT + TWO_H / 2,
      thresholdMs: TWO_H,
    });
    expect(v.stale).toBe(false);
    expect(v.reason).toContain('under the');
  });

  it('fails SAFE (not stale) when either commit is unresolvable — never alert on an unreadable git state', () => {
    const v1 = evaluateExecutorStaleness({
      routinesEnabled: true,
      bootCommit: null,
      currentCommit: 'b'.repeat(40),
      bootTimeMs: BOOT,
      now: BOOT + TWO_H * 10,
      thresholdMs: TWO_H,
    });
    expect(v1.stale).toBe(false);
    expect(v1.reason).toContain('unresolvable');

    const v2 = evaluateExecutorStaleness({
      routinesEnabled: true,
      bootCommit: 'a'.repeat(40),
      currentCommit: null,
      bootTimeMs: BOOT,
      now: BOOT + TWO_H * 10,
      thresholdMs: TWO_H,
    });
    expect(v2.stale).toBe(false);
    expect(v2.reason).toContain('unresolvable');
  });

  it('healthy past the threshold when the boot commit still matches tree HEAD — nothing has moved', () => {
    const sha = 'c'.repeat(40);
    const v = evaluateExecutorStaleness({
      routinesEnabled: true,
      bootCommit: sha,
      currentCommit: sha,
      bootTimeMs: BOOT,
      now: BOOT + TWO_H * 10,
      thresholdMs: TWO_H,
    });
    expect(v.stale).toBe(false);
    expect(v.reason).toContain('nothing has moved');
  });

  it('STALE past the threshold with a genuine boot-commit-vs-HEAD divergence — reports code drift and restart, not a claim race', () => {
    const boot = 'd'.repeat(40);
    const head = 'e'.repeat(40);
    const now = BOOT + 7 * 3_600_000; // 7h uptime, matches the measured incident
    const v = evaluateExecutorStaleness({
      routinesEnabled: true,
      bootCommit: boot,
      currentCommit: head,
      bootTimeMs: BOOT,
      now,
      thresholdMs: TWO_H,
    });
    expect(v.stale).toBe(true);
    expect(v.reason).toContain(boot.slice(0, 10));
    expect(v.reason).toContain(head.slice(0, 10));
    expect(v.reason).toContain('EI-19409061552037718');
    expect(v.reason).toContain('7h');
    expect(v.reason).toContain('not loaded by this process');
    expect(v.reason).toContain('Restart this host');
    expect(v.reason).not.toContain('claim race');
    expect(v.reason).not.toContain('HALF-APPLIED');
    expect(v.ageMs).toBe(now - BOOT);
  });
});

/**
 * The 2026-08-30 recurrence: the page said "has run 2h", which reads as mild,
 * while the executor was 109 commits behind. Uptime measures how LONG it has
 * been wrong; commits measure how WRONG it is — and a reader anchors on the
 * first number. These pin the magnitude into the alarm and, just as important,
 * pin that an unresolvable count stays ABSENT rather than rendering as zero.
 */
describe('evaluateExecutorStaleness — drift magnitude, not just uptime', () => {
  const boot = 'd'.repeat(40);
  const head = 'e'.repeat(40);
  const stale = (commitsBehind?: number | null) =>
    evaluateExecutorStaleness({
      routinesEnabled: true,
      bootCommit: boot,
      currentCommit: head,
      bootTimeMs: BOOT,
      now: BOOT + TWO_H,
      thresholdMs: TWO_H,
      commitsBehind,
    });

  it('reports the commit drift in the reason when it is resolvable (the measured 109-commit case)', () => {
    const v = stale(109);
    expect(v.stale).toBe(true);
    expect(v.reason).toContain('109 COMMITS BEHIND');
    expect(v.commitsBehind).toBe(109);
  });

  it('singularises a one-commit drift', () => {
    expect(stale(1).reason).toContain('1 COMMIT BEHIND');
    expect(stale(1).reason).not.toContain('1 COMMITS BEHIND');
  });

  it('degrades to the uptime-only wording when the count is unresolvable — never a fabricated magnitude', () => {
    for (const missing of [null, undefined]) {
      const v = stale(missing);
      expect(v.stale).toBe(true); // staleness itself does NOT depend on the count
      expect(v.reason).not.toContain('BEHIND');
      expect(v.reason).toContain('2h');
      expect(v.commitsBehind ?? null).toBeNull();
    }
  });

  it('treats a zero count as absent rather than printing "0 COMMITS BEHIND"', () => {
    // Reachable when HEAD moves back onto the boot commit between the two
    // reads. "0 behind" beside a STALE verdict would read as self-contradictory.
    expect(stale(0).reason).not.toContain('BEHIND');
  });
});

describe('resolveCommitsBehind — fail-safe and argv-safe', () => {
  it('answers 0 for an identical pair without consulting git', async () => {
    const sha = 'a'.repeat(40);
    await expect(resolveCommitsBehind(sha, sha)).resolves.toBe(0);
  });

  it('refuses anything that is not a full 40-hex sha, so a revision range can never become an option', async () => {
    const good = 'a'.repeat(40);
    for (const bad of ['--all', 'HEAD', '', 'z'.repeat(40), 'a'.repeat(39), null]) {
      await expect(resolveCommitsBehind(bad as string | null, good)).resolves.toBeNull();
      await expect(resolveCommitsBehind(good, bad as string | null)).resolves.toBeNull();
    }
  });
});

describe('staleExecutorThresholdSec — env tunable', () => {
  it('defaults to 2h (7200s) with no env override', () => {
    const saved = process.env.PAPERCUSP_STALE_ROUTINE_EXECUTOR_THRESHOLD_SEC;
    delete process.env.PAPERCUSP_STALE_ROUTINE_EXECUTOR_THRESHOLD_SEC;
    try {
      expect(staleExecutorThresholdSec()).toBe(7_200);
    } finally {
      if (saved !== undefined) process.env.PAPERCUSP_STALE_ROUTINE_EXECUTOR_THRESHOLD_SEC = saved;
    }
  });

  it('honors an env override, including a <=0 kill switch', () => {
    const saved = process.env.PAPERCUSP_STALE_ROUTINE_EXECUTOR_THRESHOLD_SEC;
    try {
      process.env.PAPERCUSP_STALE_ROUTINE_EXECUTOR_THRESHOLD_SEC = '0';
      expect(staleExecutorThresholdSec()).toBe(0);
      process.env.PAPERCUSP_STALE_ROUTINE_EXECUTOR_THRESHOLD_SEC = '3600';
      expect(staleExecutorThresholdSec()).toBe(3_600);
    } finally {
      if (saved !== undefined) process.env.PAPERCUSP_STALE_ROUTINE_EXECUTOR_THRESHOLD_SEC = saved;
      else delete process.env.PAPERCUSP_STALE_ROUTINE_EXECUTOR_THRESHOLD_SEC;
    }
  });
});

describe('executorIdentity — a stable per-process key that never conflates two hosts', () => {
  it('prefers PAPERCUSP_HONO_PORT / PORT so the SAME logical service recovers its own alert across restarts', () => {
    const savedHono = process.env.PAPERCUSP_HONO_PORT;
    const savedPort = process.env.PORT;
    try {
      delete process.env.PAPERCUSP_HONO_PORT;
      process.env.PORT = '3270';
      expect(executorIdentity()).toBe('port-3270');

      process.env.PAPERCUSP_HONO_PORT = '3070';
      expect(executorIdentity()).toBe('port-3070'); // PAPERCUSP_HONO_PORT wins over PORT
    } finally {
      if (savedHono !== undefined) process.env.PAPERCUSP_HONO_PORT = savedHono;
      else delete process.env.PAPERCUSP_HONO_PORT;
      if (savedPort !== undefined) process.env.PORT = savedPort;
      else delete process.env.PORT;
    }
  });

  it('falls back to a pid-scoped identity when no port is resolvable, never colliding two distinct processes', () => {
    const savedHono = process.env.PAPERCUSP_HONO_PORT;
    const savedPort = process.env.PORT;
    try {
      delete process.env.PAPERCUSP_HONO_PORT;
      delete process.env.PORT;
      expect(executorIdentity()).toBe(`pid-${process.pid}`);
    } finally {
      if (savedHono !== undefined) process.env.PAPERCUSP_HONO_PORT = savedHono;
      if (savedPort !== undefined) process.env.PORT = savedPort;
    }
  });
});

describe('stale bg-host remediation — guarded, injectable, and generation-verified', () => {
  // The in-flight latch and cooldown are module state; a refused attempt now arms a
  // retry backoff (WI-10007644), so each case starts from a clean actuator.
  beforeEach(() => resetStaleExecutorRestartStateForTests());

  const staleVerdict = (): ExecutorStalenessVerdict => ({
    stale: true,
    reason: 'test stale bg-host executor',
    ageMs: 7 * 3_600_000,
    commitsBehind: 3,
    routineDrift: null,
  });

  it('verifies that the sanctioned restart replaced the bg-host generation', async () => {
    const verification = await waitForStaleExecutorRestartGeneration(101, {
      run: async () => ({ stdout: '202\n' }),
      now: () => 1_000,
      sleep: async () => undefined,
      waitMs: 0,
      pollMs: 0,
    });

    expect(verification).toEqual({
      verified: true,
      beforePid: 101,
      observedPid: 202,
      code: 'generation_changed',
    });
  });

  it('keeps a refused restart\'s reason when ptool exits non-zero on ok:false (EI-24654733539966460)', async () => {
    const result = await restartStaleBgHostExecutor('port-3271', staleVerdict(), {
      // Far past any cooldown an earlier test in this file may have armed.
      now: () => 9_000_000_000_000,
      run: async (command) =>
        command === 'systemctl'
          ? { stdout: '101\n' }
          : { stdout: JSON.stringify({ ok: false, reason: 'gate_collision' }), error: 'Command failed: exit 5' },
      ptoolScript: '/tmp/ptool.mjs',
    });

    expect(result).toMatchObject({ attempted: true, restarted: false, code: 'gate_collision' });
  });

  it('only remediates the stale bg-host identity and keeps the safety rails on the ptool call', async () => {
    let nowMs = 1_000_000_000;
    const calls: Array<{ command: string; args: string[]; stdin: string; timeout: number }> = [];
    const run = async (command: string, args: string[], options: { stdin: string; timeout: number }) => {
      calls.push({ command, args, stdin: options.stdin, timeout: options.timeout });
      if (command === 'systemctl') return { stdout: '101\n' };
      return { stdout: JSON.stringify({ ok: true, restarted: true, restartedFromPid: 101 }) };
    };

    const result = await restartStaleBgHostExecutor('port-3271', staleVerdict(), {
      now: () => nowMs,
      run,
      ptoolScript: '/tmp/ptool.mjs',
      verifyGeneration: async (beforePid) => ({
        verified: true,
        beforePid: Number(beforePid),
        observedPid: 202,
        code: 'generation_changed',
      }),
    });

    expect(result).toMatchObject({
      attempted: true,
      restarted: true,
      coalesced: false,
      verified: true,
      code: 'restarted',
    });
    const ptool = calls.find((call) => call.command === process.execPath);
    expect(ptool).toBeDefined();
    expect(ptool?.args).toEqual(['/tmp/ptool.mjs', 'dev:restart', '--json', '-']);
    const payload = JSON.parse(ptool?.stdin ?? '{}') as Record<string, unknown>;
    expect(payload).toMatchObject({
      target: 'bg-host',
      confirm: true,
      authorize: true,
      max_drain_sec: 0,
      git_sync_drain_sec: STALE_EXECUTOR_GIT_SYNC_DRAIN_SEC,
    });
    expect(String(payload.reason)).toContain('port-3271');
    expect(payload).not.toHaveProperty('override_git_sync_collision');
    expect(payload).not.toHaveProperty('force');
    expect(ptool?.timeout).toBeGreaterThan(STALE_EXECUTOR_GIT_SYNC_DRAIN_SEC * 1_000);

    const cooldown = await restartStaleBgHostExecutor('port-3271', staleVerdict(), { now: () => nowMs, run });
    expect(cooldown).toMatchObject({ attempted: false, code: 'restart_cooldown' });
    expect(calls).toHaveLength(2); // baseline PID read + the one ptool invocation
    nowMs += STALE_EXECUTOR_RESTART_COOLDOWN_MS + 1;
  });

  it('does not invoke the restart command for another identity or a healthy verdict', async () => {
    let calls = 0;
    const run = async () => {
      calls += 1;
      return { stdout: '' };
    };

    await expect(restartStaleBgHostExecutor('port-3170', staleVerdict(), { run })).resolves.toMatchObject({
      attempted: false,
      code: 'identity_not_bg_host',
    });
    await expect(
      restartStaleBgHostExecutor('port-3271', { ...staleVerdict(), stale: false }, { run }),
    ).resolves.toMatchObject({ attempted: false, code: 'not_stale' });
    expect(calls).toBe(0);
  });

  it('fails loudly as ptool_script_missing, naming the path, when the resolved ptool script does not exist (WI-10007644)', async () => {
    const saved = process.env.PAPERCUSP_PTOOL_SCRIPT;
    process.env.PAPERCUSP_PTOOL_SCRIPT = '/nonexistent/wi-10007644/ptool.mjs';
    let ptoolCalls = 0;
    try {
      const result = await restartStaleBgHostExecutor('port-3271', staleVerdict(), {
        now: () => 5_000_000_000_000,
        run: async (command) => {
          if (command !== 'systemctl') ptoolCalls += 1;
          return { stdout: '101\n' };
        },
      });
      expect(result).toMatchObject({ attempted: true, restarted: false, code: 'ptool_script_missing' });
      expect(result.error).toContain('/nonexistent/wi-10007644/ptool.mjs');
      expect(ptoolCalls).toBe(0);
    } finally {
      if (saved === undefined) delete process.env.PAPERCUSP_PTOOL_SCRIPT;
      else process.env.PAPERCUSP_PTOOL_SCRIPT = saved;
    }
  });

  it('backs off after a refused attempt instead of re-running the drain on every tick (WI-10007644)', async () => {
    let nowMs = 7_000_000_000_000;
    let ptoolCalls = 0;
    const run = async (command: string) => {
      if (command === 'systemctl') return { stdout: '101\n' };
      ptoolCalls += 1;
      return {
        stdout: JSON.stringify({ ok: false, reason: 'git_sync_barrier_drain_timeout' }),
        error: 'Command failed: exit 5',
      };
    };
    const deps = { now: () => nowMs, run, ptoolScript: '/tmp/ptool.mjs' };

    await expect(restartStaleBgHostExecutor('port-3271', staleVerdict(), deps)).resolves.toMatchObject({
      attempted: true,
      restarted: false,
      code: 'git_sync_barrier_drain_timeout',
    });
    nowMs += 30_000; // the next routinesTick
    await expect(restartStaleBgHostExecutor('port-3271', staleVerdict(), deps)).resolves.toMatchObject({
      attempted: false,
      code: 'restart_cooldown',
    });
    expect(ptoolCalls).toBe(1);

    nowMs += STALE_EXECUTOR_RESTART_RETRY_BACKOFF_MS;
    await expect(restartStaleBgHostExecutor('port-3271', staleVerdict(), deps)).resolves.toMatchObject({
      attempted: true,
      code: 'git_sync_barrier_drain_timeout',
    });
    expect(ptoolCalls).toBe(2);
    // The backoff is a short retry window, never the post-success cooldown.
    expect(STALE_EXECUTOR_RESTART_RETRY_BACKOFF_MS).toBeLessThan(STALE_EXECUTOR_RESTART_COOLDOWN_MS);
  });
});

describe('defaultPtoolScriptPath — the same ptool.mjs from source AND from the host bundle (WI-10007644)', () => {
  // This test file sits beside the watchdog: routines → harness → lib → operator-core → packages → repo.
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
  const expected = path.join(repoRoot, 'apps', 'operator', 'scripts', 'ptool.mjs');

  it('from the source module it names the real, existing ptool.mjs', () => {
    expect(defaultPtoolScriptPath()).toBe(expected);
    expect(existsSync(defaultPtoolScriptPath())).toBe(true);
  });

  it('from the esbuild host bundle bg-host runs it names the SAME file — the old fixed-hop URL left the repo', () => {
    const bundleUrl = pathToFileURL(path.join(repoRoot, 'apps', 'operator', 'dist-host', 'hono-host.mjs')).href;
    expect(defaultPtoolScriptPath(bundleUrl)).toBe(expected);

    // Control: the pre-fix expression, evaluated from that same bundle location,
    // resolves outside the checkout — the production failure this pins.
    const legacy = fileURLToPath(new URL('../../../../../apps/operator/scripts/ptool.mjs', bundleUrl));
    expect(legacy).not.toBe(expected);
    expect(legacy.startsWith(repoRoot + path.sep)).toBe(false);
  });
});

describe('staleRoutineExecutorSweep — remediation runs before alert debounce', () => {
  it('invokes stale remediation even when the alert episode is already debounced', async () => {
    const savedPort = process.env.PAPERCUSP_HONO_PORT;
    const savedRoutines = process.env.PAPERCUSP_DBOS_ROUTINES;
    const savedThreshold = process.env.PAPERCUSP_STALE_ROUTINE_EXECUTOR_THRESHOLD_SEC;
    process.env.PAPERCUSP_HONO_PORT = '3271';
    process.env.PAPERCUSP_DBOS_ROUTINES = '1';
    process.env.PAPERCUSP_STALE_ROUTINE_EXECUTOR_THRESHOLD_SEC = '1';
    const order: string[] = [];
    // A coalesced restart IS an attempt, so the sweep logs its outcome (WI-10007644).
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const result = await staleRoutineExecutorSweep(
        { now: 100_000, workspaceId: 'test-workspace', installSlug: 'test-harness' },
        {
          bootCommit: 'a'.repeat(40),
          currentCommit: 'b'.repeat(40),
          bootTimeMs: 0,
          commitsBehind: 3,
          routineDrift: { changed: [], addedSinceBoot: [] },
          restart: async () => {
            order.push('restart');
            return { attempted: true, restarted: false, coalesced: true, verified: true, code: 'coalesced' };
          },
          recentWatchdogFires: async () => {
            order.push('debounce');
            return 1;
          },
        },
      );

      expect(result.outcome).toBe('skipped');
      expect(result.reason).toBe('debounced');
      expect(result.restart).toMatchObject({ attempted: true, coalesced: true, code: 'coalesced' });
      expect(order).toEqual(['restart', 'debounce']);
      expect(warn.mock.calls.map((call) => String(call[0]))).toContain(
        '[stale-routine-executor] auto-restart (port-3271): coalesced',
      );
    } finally {
      warn.mockRestore();
      if (savedPort === undefined) delete process.env.PAPERCUSP_HONO_PORT;
      else process.env.PAPERCUSP_HONO_PORT = savedPort;
      if (savedRoutines === undefined) delete process.env.PAPERCUSP_DBOS_ROUTINES;
      else process.env.PAPERCUSP_DBOS_ROUTINES = savedRoutines;
      if (savedThreshold === undefined) delete process.env.PAPERCUSP_STALE_ROUTINE_EXECUTOR_THRESHOLD_SEC;
      else process.env.PAPERCUSP_STALE_ROUTINE_EXECUTOR_THRESHOLD_SEC = savedThreshold;
    }
  });

  it('logs every attempted restart outcome, and stays quiet when nothing was attempted (WI-10007644)', async () => {
    const savedPort = process.env.PAPERCUSP_HONO_PORT;
    const savedRoutines = process.env.PAPERCUSP_DBOS_ROUTINES;
    const savedThreshold = process.env.PAPERCUSP_STALE_ROUTINE_EXECUTOR_THRESHOLD_SEC;
    process.env.PAPERCUSP_HONO_PORT = '3271';
    process.env.PAPERCUSP_DBOS_ROUTINES = '1';
    process.env.PAPERCUSP_STALE_ROUTINE_EXECUTOR_THRESHOLD_SEC = '1';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const sweep = (restartResult: Awaited<ReturnType<typeof restartStaleBgHostExecutor>>) =>
      staleRoutineExecutorSweep(
        { now: 100_000, workspaceId: 'test-workspace', installSlug: 'test-harness' },
        {
          bootCommit: 'a'.repeat(40),
          currentCommit: 'b'.repeat(40),
          bootTimeMs: 0,
          commitsBehind: 3,
          routineDrift: { changed: [], addedSinceBoot: [] },
          restart: async () => restartResult,
          recentWatchdogFires: async () => 1,
        },
      );
    const restartLines = () =>
      warn.mock.calls.map((call) => String(call[0])).filter((line) => line.includes('auto-restart'));
    try {
      await sweep({
        attempted: true,
        restarted: false,
        coalesced: false,
        verified: false,
        code: 'ptool_script_missing',
        error: 'ptool script not found at /x/ptool.mjs',
      });
      expect(restartLines()).toEqual([
        '[stale-routine-executor] auto-restart (port-3271): ptool_script_missing — ptool script not found at /x/ptool.mjs',
      ]);

      warn.mockClear();
      await sweep({ attempted: false, restarted: false, coalesced: false, verified: false, code: 'restart_cooldown' });
      expect(restartLines()).toEqual([]);
    } finally {
      warn.mockRestore();
      if (savedPort === undefined) delete process.env.PAPERCUSP_HONO_PORT;
      else process.env.PAPERCUSP_HONO_PORT = savedPort;
      if (savedRoutines === undefined) delete process.env.PAPERCUSP_DBOS_ROUTINES;
      else process.env.PAPERCUSP_DBOS_ROUTINES = savedRoutines;
      if (savedThreshold === undefined) delete process.env.PAPERCUSP_STALE_ROUTINE_EXECUTOR_THRESHOLD_SEC;
      else process.env.PAPERCUSP_STALE_ROUTINE_EXECUTOR_THRESHOLD_SEC = savedThreshold;
    }
  });
});

describe('executorAlarmContext — identify the owning service before suggesting remediation', () => {
  it('names bg-host service and the sanctioned restart lever instead of presenting a bare worker identity', () => {
    const context = executorAlarmContext('port-3271');

    expect(context.unit).toBe('papercusp-bg-host.service');
    expect(context.identityLabel).toContain('papercusp-bg-host.service');
    expect(context.identityLabel).toContain('executor identity port-3271');
    expect(context.restartLever).toBe("dev:restart { target: 'bg-host', confirm: true, authorize: true, reason: 'reload the owning executor with updated code' }");
    expect(context.identityLabel).not.toMatch(/^pid-/);
  });

  it('keeps an unresolvable PID identity explicit rather than turning it into a kill instruction', () => {
    const savedUnit = process.env.PAPERCUSP_SYSTEMD_UNIT;
    delete process.env.PAPERCUSP_SYSTEMD_UNIT;
    try {
      const context = executorAlarmContext('pid-1690541');

      expect(context.unit).toBe('systemd unit unresolved');
      expect(context.identityLabel).toContain('systemd unit unresolved');
      expect(context.restartLever).toContain('resolve the owning service');
    } finally {
      if (savedUnit !== undefined) process.env.PAPERCUSP_SYSTEMD_UNIT = savedUnit;
    }
  });
});

/**
 * The page names a lever; these pin that it also answers "is pulling it safe RIGHT NOW".
 *
 * Two agents on 2026-08-30 each hand-derived that precondition from process scans and
 * each reached the same REFUTED conclusion, then declined to remediate an open page for
 * an hour on it. The presence/absence pair below is the falsifiability structure: deleting
 * the note fails the first test, and weakening it to fire for an UNIDENTIFIED service —
 * which would be unfounded reassurance rather than a measurement — fails the second.
 * Neither can be made to pass by removing the feature.
 */
describe('the stale-executor page carries the restart-safety precondition, not just the lever', () => {
  it('tells a reader of a RESOLVED unit to let the lever decide, via its side-effect-free dry run', () => {
    const context = executorAlarmContext('port-3271');

    expect(context.restartSafety).toBe(RESTART_SAFETY_NOTE);
    // The actionable half: which call answers it, and how to read the answer.
    expect(context.restartSafety).toContain('WITHOUT');
    expect(context.restartSafety).toContain('gate_collision');
    expect(context.restartSafety).toContain('would_block:true');
  });

  it('states the isolated-scope FACT, so an in-flight gate run stops reading as a reason to wait', () => {
    const note = executorAlarmContext('port-3271').restartSafety ?? '';

    expect(note).toContain('cgroup-isolated');
    expect(note).toContain('SURVIVES');
    // Cites the measurements rather than asserting it bare — a reader who distrusts the
    // claim (correctly, since the false version circulated for weeks) can go check them.
    expect(note).toContain('EI-20286473216066539');
  });

  it('pre-empts the refusal a reader ACTUALLY hits, so one git_sync_collision does not end the remediation', () => {
    // 2026-08-31: the refuted gate caution was cleared and the page STILL sat open,
    // because every attempt to pull the lever was refused on git_sync_collision and a
    // lone refusal reads as "blocked, not mine". Measured: 20 consecutive attempts
    // over 40s, never fewer than 4 git-sync operations in flight.
    const note = executorAlarmContext('port-3271').restartSafety ?? '';

    expect(note).toContain('git_sync_collision');
    expect(note).toContain('EXPECTED');
    // EI-21930094737784126: once dev:restart could actually wait the sweep out, "retry
    // it in a loop" stopped being the honest instruction. A page that names a lever
    // owes the reader the ARGUMENT that makes it fire.
    expect(note).toContain('git_sync_drain_sec');
    expect(note).toMatch(/retry once rather than abandoning/);
    // And the destructive escape hatch is named as the WRONG answer — it is the
    // obvious next reach for someone who has just been refused seven times.
    expect(note).toContain('override_git_sync_collision');
    expect(note).toMatch(/Do NOT reach for `override_git_sync_collision`/);
    expect(note).toMatch(/strands a peer's uncommitted work/);
  });

  it('never asserts the refuted mechanism it exists to replace', () => {
    const note = executorAlarmContext('port-3271').restartSafety ?? '';

    // The exact shape that circulated: "restarting kills / aborts the in-flight run".
    expect(note).not.toMatch(/restart\w*\s+.{0,40}(abort|terminate|kill)\w*\s+.{0,20}run/i);
    expect(note).not.toMatch(/starv\w*\s+(the\s+)?gate/i);
  });

  it('ABSENCE control — an unresolvable identity gets NO safety claim, because none was measured', () => {
    const savedUnit = process.env.PAPERCUSP_SYSTEMD_UNIT;
    delete process.env.PAPERCUSP_SYSTEMD_UNIT;
    try {
      const context = executorAlarmContext('pid-1690541');

      // No lever resolved ⇒ no dry run to point at. Silence beats a confident claim
      // about a service we could not even name.
      expect(context.restartSafety).toBeNull();
    } finally {
      if (savedUnit !== undefined) process.env.PAPERCUSP_SYSTEMD_UNIT = savedUnit;
    }
  });
});

/**
 * An OPEN page must not freeze at its first reading.
 *
 * The alarm is one-shot per episode, which is right for the notification and was wrong
 * for the ROW: on 2026-08-30 an open page kept reporting the uptime and drift it had when
 * it opened, for over an hour, while both grew — a stale value inside the watchdog built
 * to report staleness. These pin the two halves that make a refresh trustworthy: current
 * readings REPLACE, and `emitted_at` does NOT.
 */
describe('refreshedEscalationPayload — an open page ages visibly instead of freezing', () => {
  const T0 = 1_700_000_000_000;
  const prior = {
    kind: 'stale-routine-executor-watchdog:port-3271',
    harness_slug: 'papercusp',
    identity: 'port-3271',
    ageHours: 2,
    commitsBehind: 109,
    detail: 'the reading as it was when the page opened',
    unit: 'papercusp-bg-host.service',
    restartLever: 'dev:restart {...}',
    restartSafety: RESTART_SAFETY_NOTE,
    emitted_at: T0,
  };
  const nowFacts = {
    kind: prior.kind,
    harness_slug: prior.harness_slug,
    identity: prior.identity,
    ageHours: 5,
    commitsBehind: 240,
    // The functional drift is a CURRENT reading like every other field here, so a
    // refresh must carry today's answer rather than whatever the page opened with.
    routineDrift: {
      changed: ['packages/operator-core/lib/harness/routines/register-system-actions.ts'],
      addedSinceBoot: ['packages/operator-core/lib/harness/routines/seed-frozen-candidate-drift-sweep-routine.ts'],
    },
    detail: 'the reading now',
    unit: prior.unit,
    restartLever: prior.restartLever,
    restartSafety: RESTART_SAFETY_NOTE,
  };

  it('replaces every CURRENT reading, so the row stops misreporting the condition', () => {
    const refreshed = refreshedEscalationPayload(prior, nowFacts, T0 + 3 * 3_600_000);

    expect(refreshed.ageHours).toBe(5);
    expect(refreshed.commitsBehind).toBe(240);
    expect(refreshed.detail).toBe('the reading now');
    // Including the functional drift: an open page that kept reporting the routines
    // that were missing THREE HOURS AGO would be the same freeze in a new field.
    expect(refreshed.routineDrift?.addedSinceBoot).toEqual([
      'packages/operator-core/lib/harness/routines/seed-frozen-candidate-drift-sweep-routine.ts',
    ]);
  });

  it('PRESERVES emitted_at and derives openForHours from it — the number that makes an ignored page loud', () => {
    const refreshed = refreshedEscalationPayload(prior, nowFacts, T0 + 3 * 3_600_000);

    // Restamping emitted_at would reset the page's apparent age on every refresh and
    // hide precisely what the refresh exists to reveal.
    expect(refreshed.emitted_at).toBe(T0);
    expect(refreshed.openForHours).toBe(3);
    expect(refreshed.refreshed_at).toBe(T0 + 3 * 3_600_000);
  });

  it('an UNREADABLE prior emitted_at yields openForHours null, never a fabricated 0', () => {
    // 0 would read as "just opened" — the exact opposite of what an unreadable prior row
    // licenses us to claim.
    for (const broken of [{ ...prior, emitted_at: undefined }, { ...prior, emitted_at: 'nope' }]) {
      const refreshed = refreshedEscalationPayload(broken, nowFacts, T0 + 3 * 3_600_000);
      expect(refreshed.openForHours).toBeNull();
    }
  });

  it('reads a JSON STRING prior row — which is what the TEXT escalation column actually returns', () => {
    // The regression this exists for: `harness_escalations.escalation` is TEXT, not jsonb,
    // so the driver hands back a string. An object-only reader would treat EVERY real row
    // as unreadable, restamp emitted_at, and reset the page's apparent age on each refresh
    // — the feature would look implemented and do the opposite of its purpose, silently.
    const refreshed = refreshedEscalationPayload(JSON.stringify(prior), nowFacts, T0 + 3 * 3_600_000);

    expect(refreshed.emitted_at).toBe(T0);
    expect(refreshed.openForHours).toBe(3);
    expect(refreshed.ageHours).toBe(5);
  });

  it('a MALFORMED prior string degrades to null rather than throwing', () => {
    const refreshed = refreshedEscalationPayload('{not json', nowFacts, T0);

    expect(refreshed.openForHours).toBeNull();
    expect(refreshed.ageHours).toBe(5);
  });

  it('FALSIFIABILITY CONTROL — the two assertions above catch the obvious wrong implementations', () => {
    // The subject is an imported module, so the copy-out mutation-probe tier does not
    // apply; the repo's prescribed substitute is a deliberately-wrong implementation kept
    // permanently in the test file. These are the two ways a refresh gets written badly.
    const restamping = (_prev: unknown, next: typeof nowFacts, now: number) => ({
      ...next,
      emitted_at: now, // ← the bug: resets the page's apparent age on every refresh
      refreshed_at: now,
      openForHours: 0,
    });
    const fabricatingZero = (prev: unknown, next: typeof nowFacts, now: number) => {
      const at = (prev as { emitted_at?: unknown })?.emitted_at;
      return {
        ...next,
        emitted_at: typeof at === 'number' ? at : now,
        refreshed_at: now,
        openForHours: typeof at === 'number' ? Math.round((now - at) / 3_600_000) : 0, // ← the bug
      };
    };
    const at = T0 + 3 * 3_600_000;

    // Control 1 fails the preservation assertion...
    expect(restamping(prior, nowFacts, at).emitted_at).not.toBe(T0);
    // ...and control 2 fails the no-fabricated-zero assertion, while PASSING control 1's.
    expect(fabricatingZero(prior, nowFacts, at).emitted_at).toBe(T0);
    expect(fabricatingZero({ ...prior, emitted_at: 'nope' }, nowFacts, at).openForHours).toBe(0);

    // CALIBRATION: the real implementation passes both, so the controls are measuring the
    // implementation and not a broken harness.
    const real = refreshedEscalationPayload(prior, nowFacts, at);
    expect(real.emitted_at).toBe(T0);
    expect(refreshedEscalationPayload({ ...prior, emitted_at: 'nope' }, nowFacts, at).openForHours).toBeNull();
  });

  it('survives a prior row that is not an object at all, rather than throwing inside a watchdog', () => {
    // A watchdog that throws while reporting a fault reports nothing. Every input a
    // jsonb column can actually hold has to land somewhere sane.
    for (const junk of [null, undefined, 'a string', 42]) {
      const refreshed = refreshedEscalationPayload(junk, nowFacts, T0);
      expect(refreshed.emitted_at).toBe(T0);
      expect(refreshed.openForHours).toBeNull();
      expect(refreshed.ageHours).toBe(5);
    }
  });
});

/**
 * The page must say WHAT is stale, not only HOW MUCH.
 *
 * The 2026-08-31 incident is the bar: a page reading "143 COMMITS BEHIND" sat open
 * and unacted for 2h11m while two agents read it, because a commit count cannot
 * distinguish unrelated churn from the actual state — four routine source files
 * absent from the running process, two of them whole routines that had never fired.
 *
 * FALSIFIABILITY. `routineDriftSentence` is a module we import, so per the repo's
 * mutation-probe guidance the controls are two deliberately-WRONG implementations
 * kept permanently beside it, plus a calibration case every implementation must
 * pass (without which the controls could be "failing" for an unrelated reason).
 */
describe('routineDriftSentence — the page names what is stale, not just how much', () => {
  const SEEDS = [
    'packages/operator-core/lib/harness/routines/seed-account-capacity-reprobe-routine.ts',
    'packages/operator-core/lib/harness/routines/seed-frozen-candidate-drift-sweep-routine.ts',
  ];
  const HANDLERS = [
    'packages/operator-core/lib/harness/routines/register-system-actions.ts',
    'packages/operator-core/lib/harness/routines/dead-target-sweep.ts',
  ];

  // ── controls: what this guard must REJECT ──────────────────────────────────
  /** WRONG #1: collapses added files into "changed", losing the severity that makes
   *  the page actionable — the process runs an OLD version vs. runs NO version. */
  const wrongCollapsesSeverity = (d: RoutineCodeDrift | null | undefined): string => {
    if (!d) return '';
    const all = [...(d.addedSinceBoot ?? []), ...(d.changed ?? [])];
    if (all.length === 0) return '';
    return ` — ${all.length} routine files changed since boot`;
  };
  /** WRONG #2: turns a bounded probe that found nothing into a reassuring all-clear —
   *  the false-negative this watchdog exists to prevent. */
  const wrongEmitsAllClear = (d: RoutineCodeDrift | null | undefined): string => {
    if (!d) return '';
    const added = d.addedSinceBoot ?? [];
    const changed = d.changed ?? [];
    if (added.length === 0 && changed.length === 0) return ' — no routine code changed since boot';
    return ` — ${added.length} added, ${changed.length} changed`;
  };

  it('CALIBRATION: every implementation names a lone changed handler (so a failing control is failing for the right reason)', () => {
    const drift: RoutineCodeDrift = { changed: [HANDLERS[1]], addedSinceBoot: [] };
    for (const impl of [routineDriftSentence, wrongCollapsesSeverity, wrongEmitsAllClear]) {
      expect(impl(drift)).not.toBe('');
    }
  });

  it('names files ADDED since boot and says they are NOT RUNNING — the severe case a commit count hides', () => {
    const drift: RoutineCodeDrift = { changed: [], addedSinceBoot: SEEDS };
    const s = routineDriftSentence(drift);
    expect(s).toContain('seed-account-capacity-reprobe-routine.ts');
    expect(s).toContain('seed-frozen-candidate-drift-sweep-routine.ts');
    expect(s).toContain('NOT RUNNING');
    // The control that collapses severity cannot produce this, which is the point.
    expect(wrongCollapsesSeverity(drift)).not.toContain('NOT RUNNING');
  });

  it('distinguishes ADDED from CHANGED rather than reporting one undifferentiated count', () => {
    const drift: RoutineCodeDrift = { changed: HANDLERS, addedSinceBoot: SEEDS };
    const s = routineDriftSentence(drift);
    expect(s).toContain('NOT RUNNING');
    expect(s).toContain('does run');
    expect(s).toContain('2 routine source files');
    expect(s).toContain('2 routine handlers');
    // A single fused count is exactly the failure mode.
    expect(wrongCollapsesSeverity(drift)).toContain('4 routine files');
    expect(s).not.toContain('4 routine files');
  });

  it('says NOTHING when the probe could not run — never a fabricated verdict', () => {
    for (const missing of [null, undefined]) {
      expect(routineDriftSentence(missing)).toBe('');
    }
  });

  it('says NOTHING — not an all-clear — when the bounded probe ran and found nothing', () => {
    // ROUTINE_SOURCE_PREFIX is a LOWER BOUND: handlers reach helpers all over
    // operator-core. "Found nothing in scope" must never be rendered as "fine".
    const empty: RoutineCodeDrift = { changed: [], addedSinceBoot: [] };
    expect(routineDriftSentence(empty)).toBe('');
    expect(routineDriftSentence(empty)).not.toContain('no routine');
    // The control does emit the false all-clear; that is what this guard catches.
    expect(wrongEmitsAllClear(empty)).toContain('no routine code changed');
  });

  it('caps the printed names but STATES the overflow instead of truncating silently', () => {
    const many = Array.from(
      { length: ROUTINE_DRIFT_NAME_CAP + 3 },
      (_, i) => `packages/operator-core/lib/harness/routines/handler-${i}.ts`,
    );
    const s = routineDriftSentence({ changed: many, addedSinceBoot: [] });
    expect(s).toContain('+3 more');
    expect(s).toContain(`${many.length} routine handlers`); // the TOTAL is never capped
    expect(s).toContain('handler-0.ts');
    expect(s).not.toContain(`handler-${ROUTINE_DRIFT_NAME_CAP}.ts`);
  });

  it('agrees in NUMBER in both severities — caught only by reading a real page, not a fixture', () => {
    // The first live run against real commits printed "so any routine they define ARE
    // NOT RUNNING here". Every synthetic assertion still passed, because they all
    // checked for substrings rather than reading the sentence. Page text is read by
    // humans under pressure; broken agreement is a credibility tax on an alarm whose
    // whole problem was already that people did not act on it.
    const many = routineDriftSentence({ changed: [], addedSinceBoot: ['a/x.ts', 'a/y.ts'] });
    expect(many).toContain('the routines they define are NOT RUNNING here');
    expect(many).not.toMatch(/any routine they define are/);

    const one = routineDriftSentence({ changed: [], addedSinceBoot: ['a/x.ts'] });
    expect(one).toContain('the routine it defines is NOT RUNNING here');
    expect(one).not.toMatch(/routines? it defines are/);
  });

  it('singularises a lone file in both severities', () => {
    expect(routineDriftSentence({ changed: [], addedSinceBoot: [SEEDS[0]] })).toContain(
      '1 routine source file',
    );
    expect(routineDriftSentence({ changed: [HANDLERS[0]], addedSinceBoot: [] })).toContain(
      '1 routine handler',
    );
  });
});

describe('evaluateExecutorStaleness — the verdict carries the functional drift', () => {
  const boot = 'a'.repeat(40);
  const head = 'b'.repeat(40);
  const stale = (routineDrift?: RoutineCodeDrift | null) =>
    evaluateExecutorStaleness({
      routinesEnabled: true,
      bootCommit: boot,
      currentCommit: head,
      bootTimeMs: BOOT,
      now: BOOT + TWO_H,
      thresholdMs: TWO_H,
      commitsBehind: 143,
      routineDrift,
    });

  it('reproduces the measured 2026-08-31 page: magnitude AND the routines that are not running', () => {
    const v = stale({
      changed: ['packages/operator-core/lib/harness/routines/register-system-actions.ts'],
      addedSinceBoot: ['packages/operator-core/lib/harness/routines/seed-frozen-candidate-drift-sweep-routine.ts'],
    });
    expect(v.stale).toBe(true);
    expect(v.reason).toContain('143 COMMITS BEHIND'); // the magnitude still leads
    expect(v.reason).toContain('NOT RUNNING'); // ...but no longer alone
    expect(v.reason).toContain('seed-frozen-candidate-drift-sweep-routine.ts');
    expect(v.routineDrift?.addedSinceBoot).toHaveLength(1);
  });

  it('is unchanged from the pre-increment wording when drift is unresolvable', () => {
    const v = stale(null);
    expect(v.stale).toBe(true);
    expect(v.reason).toContain('143 COMMITS BEHIND');
    expect(v.reason).not.toContain('NOT RUNNING');
    expect(v.reason).not.toContain('routine handler');
    expect(v.routineDrift).toBeNull();
  });

  it('staleness itself never depends on the drift probe', () => {
    // A git failure must not be able to silence the alarm — the fail-safe direction
    // for THIS field is the opposite of the one for bootCommit/currentCommit.
    for (const d of [null, undefined, { changed: [], addedSinceBoot: [] }]) {
      expect(stale(d).stale).toBe(true);
    }
  });
});

describe('resolveRoutineCodeDrift — fail-safe and argv-safe', () => {
  it('answers an empty (not null) drift for an identical pair without consulting git', async () => {
    const sha = 'c'.repeat(40);
    await expect(resolveRoutineCodeDrift(sha, sha)).resolves.toEqual({ changed: [], addedSinceBoot: [] });
  });

  it('refuses non-sha input rather than interpolating it into a revision range', async () => {
    for (const bad of ['--output=/tmp/pwned', 'HEAD', '', null]) {
      await expect(resolveRoutineCodeDrift(bad, 'd'.repeat(40))).resolves.toBeNull();
      await expect(resolveRoutineCodeDrift('d'.repeat(40), bad)).resolves.toBeNull();
    }
  });
});
