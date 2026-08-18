/**
 * batch-watchdog.test.ts — EI-19370814345784324 regression guard.
 *
 * `scripts/lib/batch-watchdog.mjs` backs the per-batch process-level watchdog
 * `scripts/affected-tests.mjs` applies to every workspace's test spawn: a test
 * that blocks its vitest worker's event loop SYNCHRONOUSLY makes vitest's own
 * `testTimeout` structurally unable to fire (it is a timer on the very loop the
 * spin never yields), so a single wedged worker held the green-checkpoint gate
 * for 74 minutes before being found and killed by hand. The async parent keeps
 * its own timer runnable and group-kills the detached task tree on expiry, so
 * descendants cannot keep the captured pipes open beyond the bound.
 *
 * Most tests are pure-function checks. The process-group regression owns one
 * short-lived detached Node tree so the exact descendant-leak class is covered.
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { createTextCollector } from '../child-output';
import {
  resolveBatchTimeoutMs,
  resolveTaskTimeoutMs,
  decideWatchdogExpiry,
  isWatchdogTimeout,
  killSpawnedProcessTree,
  parseBatchProgress,
  classifyBatchProgress,
  formatBatchProgress,
// @ts-expect-error batch-watchdog.mjs is a standalone Node script without declarations.
} from '../../../../scripts/lib/batch-watchdog.mjs';

const AFFECTED_TESTS_SOURCE = readFileSync(
  new URL('../../../../scripts/affected-tests.mjs', import.meta.url),
  'utf8',
);

function processIsRunning(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return !/\) Z /.test(stat);
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid: number, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (processIsRunning(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('resolveBatchTimeoutMs', () => {
  it('defaults when unset', () => {
    expect(resolveBatchTimeoutMs(undefined, 1_200_000)).toBe(1_200_000);
  });

  it('honors a positive explicit override', () => {
    expect(resolveBatchTimeoutMs('300000', 1_200_000)).toBe(300_000);
  });

  it('falls back on a non-numeric override rather than producing NaN (would disable the timeout)', () => {
    expect(resolveBatchTimeoutMs('not-a-number', 1_200_000)).toBe(1_200_000);
  });

  it('falls back on zero or negative — spawnSync treats timeout:0 as "no timeout"', () => {
    expect(resolveBatchTimeoutMs('0', 1_200_000)).toBe(1_200_000);
    expect(resolveBatchTimeoutMs('-5', 1_200_000)).toBe(1_200_000);
  });
});

const TASK_TIMEOUT_POLICY = {
  overrideMs: null,
  floorMs: 45 * 60_000,
  headroomMultiplier: 2,
  quantumMs: 5 * 60_000,
  maxMs: 90 * 60_000,
};

describe('resolveTaskTimeoutMs', () => {
  it('keeps an unknown task at the configured floor', () => {
    expect(resolveTaskTimeoutMs({ ...TASK_TIMEOUT_POLICY, durationMs: null })).toBe(45 * 60_000);
  });

  it('gives a measured long task headroom and rounds the policy to a stable quantum', () => {
    expect(resolveTaskTimeoutMs({ ...TASK_TIMEOUT_POLICY, durationMs: 1_873_919 })).toBe(65 * 60_000);
  });

  it('caps history-derived headroom below the gate-wide 120-minute ceiling', () => {
    expect(resolveTaskTimeoutMs({ ...TASK_TIMEOUT_POLICY, durationMs: 70 * 60_000 })).toBe(90 * 60_000);
  });

  it('keeps an explicit operator override authoritative even when it exceeds the adaptive cap', () => {
    expect(
      resolveTaskTimeoutMs({ ...TASK_TIMEOUT_POLICY, overrideMs: 100 * 60_000, durationMs: 70 * 60_000 }),
    ).toBe(100 * 60_000);
  });
});

/**
 * EI-20803703725014949 — the deadline is a CHECKPOINT, not a verdict.
 *
 * The watchdog exists to kill a SYNCHRONOUS spin, and a spin is silent: output goes
 * flat and stays flat. A merely-slow suite keeps emitting right into the wall. Time
 * alone cannot separate them, so the time-only watchdog SIGKILLed live work under
 * fleet load and red-pinned the gate for a non-code reason.
 *
 * The calibration case below is the real measurement from green-checkpoint RUN 9
 * (2026-08-18): `operator-core :: test:lane-stateful` killed at exactly 2700s with
 * captured output still climbing. If that input ever decides `kill` again, this fix
 * has regressed — which is why it is asserted with the observed numbers rather than
 * with a tidy synthetic pair.
 */
const EXPIRY_POLICY = {
  maxMs: 90 * 60_000,
  stallWindowMs: 5 * 60_000,
  extensionMs: 5 * 60_000,
};

describe('decideWatchdogExpiry', () => {
  it('extends a task whose output is still advancing at the deadline (the RUN 9 case)', () => {
    // Killed at 2700s while capturedBytes went 762,401 -> 797,873 over the last 360s,
    // i.e. output had advanced ~1s before the deadline fired.
    expect(
      decideWatchdogExpiry({ ...EXPIRY_POLICY, elapsedMs: 2_700_000, lastProgressAgeMs: 1_000 }),
    ).toEqual({ action: 'extend', reason: 'progress-advancing', extendByMs: 5 * 60_000 });
  });

  it('still kills the silent wedge the watchdog exists for', () => {
    expect(
      decideWatchdogExpiry({
        ...EXPIRY_POLICY,
        elapsedMs: 2_700_000,
        lastProgressAgeMs: 6 * 60_000,
      }),
    ).toEqual({ action: 'kill', reason: 'progress-stalled', extendByMs: 0 });
  });

  it('fails SAFE to today’s time-only kill when no progress reading is available', () => {
    for (const lastProgressAgeMs of [undefined, null, Number.NaN, -1]) {
      expect(
        decideWatchdogExpiry({ ...EXPIRY_POLICY, elapsedMs: 2_700_000, lastProgressAgeMs }),
      ).toEqual({ action: 'kill', reason: 'progress-unknown', extendByMs: 0 });
    }
  });

  it('kills at the absolute ceiling even while output is still advancing', () => {
    // A wedge that CHATTERS while wedged cannot extend forever: the ceiling still binds.
    expect(
      decideWatchdogExpiry({ ...EXPIRY_POLICY, elapsedMs: 90 * 60_000, lastProgressAgeMs: 0 }),
    ).toEqual({ action: 'kill', reason: 'absolute-ceiling', extendByMs: 0 });
  });

  it('clamps the last extension to the remaining ceiling instead of overshooting it', () => {
    expect(
      decideWatchdogExpiry({ ...EXPIRY_POLICY, elapsedMs: 88 * 60_000, lastProgressAgeMs: 0 }),
    ).toEqual({ action: 'extend', reason: 'progress-advancing', extendByMs: 2 * 60_000 });
  });

  it('fails toward the kill rather than silently disabling the bound on a bad policy constant', () => {
    for (const bad of [{ stallWindowMs: 0 }, { extensionMs: Number.NaN }, { stallWindowMs: -1 }]) {
      expect(
        decideWatchdogExpiry({
          ...EXPIRY_POLICY,
          ...bad,
          elapsedMs: 2_700_000,
          lastProgressAgeMs: 0,
        }).action,
      ).toBe('kill');
    }
  });

  it('is MONOTONE and BOUNDED across the input space: never kills earlier, never past the ceiling', () => {
    // The two properties that make this safe in front of the gate's only hard bound.
    // Every decision is taken AT an expiry, so "never earlier" reduces to: an extension
    // is always strictly positive (never a zero-delay re-arm that kills on the same tick),
    // and it never carries the task past maxMs.
    for (let elapsedMs = 5 * 60_000; elapsedMs <= 90 * 60_000; elapsedMs += 5 * 60_000) {
      for (const lastProgressAgeMs of [0, 1_000, 60_000, 5 * 60_000, 5 * 60_000 + 1, 3_600_000]) {
        const d = decideWatchdogExpiry({ ...EXPIRY_POLICY, elapsedMs, lastProgressAgeMs });
        if (d.action === 'extend') {
          expect(d.extendByMs).toBeGreaterThan(0);
          expect(elapsedMs + d.extendByMs).toBeLessThanOrEqual(EXPIRY_POLICY.maxMs);
        } else {
          expect(d.extendByMs).toBe(0);
        }
      }
    }
  });
});

const OPTS = { killSignal: 'SIGKILL', timeoutMs: 1_200_000 };

describe('isWatchdogTimeout', () => {
  it('is true for a kill at (or past) the configured deadline with the configured signal', () => {
    expect(isWatchdogTimeout({ signal: 'SIGKILL', status: null, elapsedMs: 1_200_000 }, OPTS)).toBe(true);
    expect(isWatchdogTimeout({ signal: 'SIGKILL', status: null, elapsedMs: 1_205_000 }, OPTS)).toBe(true);
  });

  it('is true within the slack window just under the exact deadline (scheduling jitter)', () => {
    expect(isWatchdogTimeout({ signal: 'SIGKILL', status: null, elapsedMs: 1_199_000 }, OPTS)).toBe(true);
  });

  it('is false for a normal, non-killed exit (the overwhelmingly common case)', () => {
    expect(isWatchdogTimeout({ signal: null, status: 0 }, OPTS)).toBe(false);
    expect(isWatchdogTimeout({ signal: null, status: 1 }, OPTS)).toBe(false);
  });

  it('is false for a SIGKILL that landed WAY before the deadline — not our watchdog (e.g. OOM killer, an operator kill)', () => {
    expect(isWatchdogTimeout({ signal: 'SIGKILL', status: null, elapsedMs: 5_000 }, OPTS)).toBe(false);
  });

  it('is false for a different signal even at the deadline (SIGTERM from somewhere else)', () => {
    expect(isWatchdogTimeout({ signal: 'SIGTERM', status: null, elapsedMs: 1_200_000 }, OPTS)).toBe(false);
  });

  it('treats a missing elapsedMs as 0 rather than throwing (never crash the caller mid-gate-run)', () => {
    expect(isWatchdogTimeout({ signal: 'SIGKILL', status: null }, OPTS)).toBe(false);
  });

  it('respects a caller-supplied slackMs', () => {
    const tight = { ...OPTS, slackMs: 0 };
    expect(isWatchdogTimeout({ signal: 'SIGKILL', status: null, elapsedMs: 1_199_999 }, tight)).toBe(false);
    expect(isWatchdogTimeout({ signal: 'SIGKILL', status: null, elapsedMs: 1_200_000 }, tight)).toBe(true);
  });
});

describe('killSpawnedProcessTree', () => {
  it('wires affected-test tasks through a detached group kill and explicit watchdog terminal state', () => {
    expect(AFFECTED_TESTS_SOURCE).toContain('detached: true');
    expect(AFFECTED_TESTS_SOURCE).toContain('killSpawnedProcessTree(child, BATCH_KILL_SIGNAL)');
    expect(AFFECTED_TESTS_SOURCE).toContain('__watchdogTimedOut: watchdogTimedOut');
    expect(AFFECTED_TESTS_SOURCE).toContain('? "watchdog-killed"');
  });

  it('kills a grandchild that inherited the detached task group', { timeout: 10_000 }, async () => {
    if (process.platform !== 'linux') return;

    const child = spawn(
      process.execPath,
      [
        '-e',
        [
          'const { spawn } = require("node:child_process");',
          'const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
          'process.stdout.write(String(grandchild.pid) + "\\n");',
          'setInterval(() => {}, 1000);',
        ].join(''),
      ],
      { detached: true, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const closePromise = new Promise<void>((resolve) => child.once('close', () => resolve()));
    const stdout = createTextCollector(child.stdout);
    let grandchildPid = 0;
    try {
      grandchildPid = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('grandchild pid was not emitted')), 2_000);
        child.stdout!.on('data', () => {
          const buffered = stdout.peek();
          const lineEnd = buffered.indexOf('\n');
          if (lineEnd < 0) return;
          clearTimeout(timer);
          resolve(Number(buffered.slice(0, lineEnd)));
        });
        child.once('error', reject);
      });
      expect(Number.isInteger(grandchildPid) && grandchildPid > 0).toBe(true);
      expect(processIsRunning(grandchildPid)).toBe(true);

      expect(killSpawnedProcessTree(child, 'SIGKILL')).toBe('group');
      await closePromise;
      await waitForProcessExit(grandchildPid);
      expect(processIsRunning(grandchildPid)).toBe(false);
    } finally {
      if (child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
      }
      if (grandchildPid > 0) {
        try { process.kill(grandchildPid, 'SIGKILL'); } catch { /* already gone */ }
      }
    }
  });
});

describe('parseBatchProgress', () => {
  it('counts only Vitest per-file completion rows, deduplicates paths, and ignores path mentions', () => {
    const progress = parseBatchProgress(
      [
        'FAIL lib/not-a-rollup.test.ts',
        '  ✓ lib/first.test.ts (2 tests) 12ms',
        'stack mentions lib/second.test.ts but did not complete it',
        '  ✓ lib/first.test.ts (2 tests) 12ms',
        '  ❯ lib/second.test.ts (3 tests | 1 failed) 20ms',
      ].join('\n'),
    );
    expect(progress.completedFiles).toBe(2);
    expect(progress.completionRows).toBe(3);
    expect(progress.completedFilePaths).toEqual(['lib/first.test.ts', 'lib/second.test.ts']);
    expect(progress.lastCompletedFile).toBe('lib/second.test.ts');
    expect(progress.lastDurationMs).toBe(20);
  });

  it('strips ANSI and reads the Vitest total when a summary exists', () => {
    const progress = parseBatchProgress(
      '\u001b[32m  ✓\u001b[39m lib/one.test.ts (1 test) \u001b[2m3ms\u001b[22m\n' +
        '\u001b[2mTest Files\u001b[22m  1 passed (1)',
    );
    expect(progress.available).toBe(true);
    expect(progress.completedFiles).toBe(1);
    expect(progress.totalFiles).toBe(1);
  });

  it('preserves unavailable output so a streamed TTY run is not mistaken for zero progress', () => {
    const progress = parseBatchProgress(null);
    expect(progress.available).toBe(false);
    expect(progress.completedFiles).toBe(0);
    expect(classifyBatchProgress(progress)).toBe('unknown');
    expect(formatBatchProgress(progress)).toContain('UNKNOWN');
  });
});

describe('classifyBatchProgress', () => {
  it('reports captured completion rows as observed, not as a spin', () => {
    const progress = parseBatchProgress('  ✓ lib/one.test.ts (1 test) 9ms');
    expect(classifyBatchProgress(progress)).toBe('progress-observed');
    expect(formatBatchProgress(progress)).toContain('do not infer a spin');
  });

  it('does not assert a spin when no completed row was captured', () => {
    const progress = parseBatchProgress('RUN v4.1.8 /repo\ncollecting...');
    expect(classifyBatchProgress(progress)).toBe('no-progress-observed');
    expect(formatBatchProgress(progress)).toContain('cannot infer a spin');
  });

  it('supports a live timestamp when the caller has one', () => {
    const progress = parseBatchProgress('  ✓ lib/one.test.ts (1 test) 9ms');
    expect(classifyBatchProgress(progress, { lastProgressAgeMs: 500 })).toBe('advancing');
    expect(classifyBatchProgress(progress, { lastProgressAgeMs: 20_000 })).toBe('stalled');
    expect(formatBatchProgress(progress, 'stalled')).toContain('spin is now a supported hypothesis');
  });
});
