import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import {
  gitSidecarEnabled,
  isSidecarInfrastructureFault,
  isSpawnOffloadHost,
  markSpawnOffloadHost,
  resetSpawnOffloadHostForTest,
} from './git-via-sidecar';
import { execProcess, type ExecProcessDeps } from './sidecar-exec-process';
import type { GovernedExecution } from '../resource-governor/execution';

function testExecution(): GovernedExecution {
  return {
    receiptId: 'test-receipt',
    context: {
      contractVersion: 1,
      requestId: 'test-request',
      rootRequestId: 'test-request',
      parentRequestId: null,
      idempotencyKey: 'test-sidecar-process',
      admissionClass: 'process',
      priority: 0,
      demand: { cpuWeight: 1 },
      depth: 0,
      createdAtMs: 1,
      decisionGeneration: 1,
    },
    lease: { leaseId: 'test-lease', generation: 1, admissionClass: 'process', expiresAtMs: 2, owner: 'test' },
    finish: async () => true,
    cancel: async () => true,
  };
}

const executionDeps: ExecProcessDeps = { beginExecution: async () => testExecution() };

/**
 * These guard the ENABLE DECISION for routing `git` through the spawner sidecar
 * (EI-18808838427010743). The decision is small but load-bearing in two
 * directions: leaving it off silently restores a ~165ms-per-git-call event-loop
 * stall on the bg-host, and getting the mode-var wrong makes the SIDECAR route
 * to itself — an infinite spawn recursion rather than a quiet perf regression.
 */
describe('gitSidecarEnabled', () => {
  it('is OFF when nothing is set (the sidecar is opt-in)', () => {
    expect(gitSidecarEnabled(undefined, {})).toBe(false);
  });

  it('is ON when the shared enable var is set', () => {
    expect(gitSidecarEnabled(undefined, { PAPERCUSP_SPAWNER_SIDECAR: '1' })).toBe(true);
  });

  it('is OFF INSIDE the sidecar process itself, even with the enable var set', () => {
    // The recursion guard: the sidecar sets the MODE var on itself. Without
    // this, a git call made inside the sidecar would be dispatched to the
    // sidecar, which would dispatch it to the sidecar, ...
    expect(
      gitSidecarEnabled(undefined, {
        PAPERCUSP_SPAWNER_SIDECAR: '1',
        PAPERCUSP_SPAWNER_SIDECAR_MODE: '1',
      }),
    ).toBe(false);
  });

  it("the caller's explicit var can force it ON while the shared var is unset", () => {
    expect(gitSidecarEnabled('PAPERCUSP_POT_GIT_SPAWN_SIDECAR', { PAPERCUSP_POT_GIT_SPAWN_SIDECAR: '1' })).toBe(true);
  });

  it("the caller's explicit var can force it OFF while the shared var is ON (per-subsystem bisect)", () => {
    expect(
      gitSidecarEnabled('PAPERCUSP_POT_GIT_SPAWN_SIDECAR', {
        PAPERCUSP_SPAWNER_SIDECAR: '1',
        PAPERCUSP_POT_GIT_SPAWN_SIDECAR: '0',
      }),
    ).toBe(false);
  });

  it('the MODE recursion guard beats an explicit ON', () => {
    expect(
      gitSidecarEnabled('PAPERCUSP_POT_GIT_SPAWN_SIDECAR', {
        PAPERCUSP_POT_GIT_SPAWN_SIDECAR: '1',
        PAPERCUSP_SPAWNER_SIDECAR_MODE: '1',
      }),
    ).toBe(false);
  });

  it('keeps the two subsystems independent (git-sync vs pot-git)', () => {
    const env = {
      PAPERCUSP_SPAWNER_SIDECAR: '1',
      PAPERCUSP_POT_GIT_SPAWN_SIDECAR: '0',
    };
    expect(gitSidecarEnabled('PAPERCUSP_POT_GIT_SPAWN_SIDECAR', env)).toBe(false);
    expect(gitSidecarEnabled('PAPERCUSP_GIT_SYNC_SPAWN_SIDECAR', env)).toBe(true);
  });
});

// WI-10002709: a MARKED spawn-offload host (the request operator, hono-host.ts)
// defaults every seam to the sidecar once its socket exists — so a site nobody
// opted in by name (git-pipeline-position on :3070) stops forking from a ~2 GB
// worker. The marker is in-memory, never inherited through env.
describe('gitSidecarEnabled on a marked spawn-offload host (WI-10002709)', () => {
  const SOCKET = { PAPERCUSP_SPAWNER_IPC_SOCKET: '/tmp/papercusp-spawner-1.sock' };
  beforeEach(() => resetSpawnOffloadHostForTest());
  afterEach(() => resetSpawnOffloadHostForTest());

  it('control: an UNMARKED process with a socket in env stays OFF (inherited env alone never enables it)', () => {
    expect(isSpawnOffloadHost()).toBe(false);
    expect(gitSidecarEnabled('PAPERCUSP_GIT_PIPELINE_SPAWN_SIDECAR', SOCKET)).toBe(false);
  });

  it('a marked host with an established socket defaults an un-opted-in site ON', () => {
    markSpawnOffloadHost();
    expect(gitSidecarEnabled('PAPERCUSP_GIT_PIPELINE_SPAWN_SIDECAR', SOCKET)).toBe(true);
    expect(gitSidecarEnabled(undefined, SOCKET)).toBe(true);
  });

  it('a marked host with NO socket yet stays OFF (never spawns a sidecar just for git)', () => {
    markSpawnOffloadHost();
    expect(gitSidecarEnabled('PAPERCUSP_GIT_PIPELINE_SPAWN_SIDECAR', {})).toBe(false);
    expect(gitSidecarEnabled('PAPERCUSP_GIT_PIPELINE_SPAWN_SIDECAR', { PAPERCUSP_SPAWNER_IPC_SOCKET: '  ' })).toBe(false);
  });

  it("the site's explicit var still wins on a marked host (per-site kill-switch)", () => {
    markSpawnOffloadHost();
    expect(
      gitSidecarEnabled('PAPERCUSP_GIT_PIPELINE_SPAWN_SIDECAR', { ...SOCKET, PAPERCUSP_GIT_PIPELINE_SPAWN_SIDECAR: '0' }),
    ).toBe(false);
  });

  it('the MODE recursion guard beats the host marker (the sidecar never routes through itself)', () => {
    markSpawnOffloadHost();
    expect(gitSidecarEnabled(undefined, { ...SOCKET, PAPERCUSP_SPAWNER_SIDECAR_MODE: '1' })).toBe(false);
  });
});

describe('isSidecarInfrastructureFault (WI-10002709)', () => {
  it("names the sidecar's own faults, so callers fall back instead of reporting them as the child's exit", () => {
    expect(isSidecarInfrastructureFault({ code: -1, stderr: 'spawner sidecar admission failed: x' })).toBe(true);
    expect(isSidecarInfrastructureFault({ code: -1, stderr: 'spawner sidecar could not spawn process: x' })).toBe(true);
  });

  it("does not claim a real child failure (a timeout kill or a non-zero exit is the child's answer)", () => {
    expect(isSidecarInfrastructureFault({ code: -1, stderr: 'systemctl --user show timed out after 3000ms' })).toBe(false);
    expect(isSidecarInfrastructureFault({ code: 1, stderr: 'spawner sidecar admission failed' })).toBe(false);
    expect(isSidecarInfrastructureFault({ code: 0, stderr: '' })).toBe(false);
  });
});

describe('spawner-sidecar process progress guard', () => {
  it('drains already-written progress before judging an idle deadline after a parent-loop stall', async () => {
    // Gate red at repair head c5865549 (and 6bf86578), 2026-09-27: the old
    // version let the child exit on its own and asserted code 0, so under gate
    // load a child that was slow to start or to be reaped hit the 150ms idle
    // window AFTER the drain this test is about. The child now writes forever
    // and the test ends it deterministically, so the verdict depends only on
    // loop-phase ordering, never on how fast a loaded host schedules a child.
    const idleTimeoutMs = 1_000; // generous: a loaded host must still start the child inside it
    const stallMs = 1_500; // > idleTimeoutMs, so the idle deadline expires inside the stall
    const script = [
      "const send = phase => process.stderr.write(JSON.stringify({ phase, at: Date.now() }) + '\\n');",
      "send('ready'); setInterval(() => send('progress'), 40);",
    ].join(' ');
    const abort = new AbortController();
    let queuedBlock = false;
    let blockedFrom = 0;
    let blockedUntil = 0;
    let drainedAfterStall = false;
    const res = await execProcess({
      command: process.execPath,
      args: ['-e', script],
      idleTimeoutMs,
      timeoutMs: 15_000,
    }, {
      ...executionDeps,
      signal: abort.signal,
      onOutputActivity: () => {
        if (blockedUntil > 0) {
          if (drainedAfterStall) return;
          drainedAfterStall = true;
          // This is the POLL-phase drain of output written during the stall.
          // The expired idle deadline queued its verdict (an immediate) in the
          // TIMERS phase BEFORE this drain, so an immediate queued here runs
          // AFTER it in the same CHECK phase: a verdict the drain failed to
          // cancel would kill the child first, as 'no output progress'.
          setImmediate(() => abort.abort());
          return;
        }
        if (queuedBlock) return;
        queuedBlock = true;
        // The child has reported readiness. Occupy the CHECK phase while it
        // keeps writing, so the expired timer races the next POLL phase.
        setImmediate(() => {
          blockedFrom = Date.now();
          while (Date.now() - blockedFrom < stallMs) { /* deliberate parent-loop stall */ }
          blockedUntil = Date.now();
        });
      },
    });
    const writes = res.stderr.split('\n').filter((line) => line.startsWith('{')).map((line) => JSON.parse(line));
    // The stall really outlasted the idle deadline, and the child really wrote
    // during it: distinguish absent child progress from progress in the OS pipe.
    expect(blockedUntil - blockedFrom).toBeGreaterThanOrEqual(stallMs);
    expect(writes.filter((entry) => entry.phase === 'progress' && entry.at > blockedFrom && entry.at < blockedUntil).length).toBeGreaterThanOrEqual(3);
    expect(drainedAfterStall).toBe(true);
    expect(res.stderr).not.toContain('no output progress');
    expect(res.stderr).toContain('aborted by caller');
    expect(res.code).toBe(-1);
  }, 20_000);

  it('does not kill a child that exited while the parent loop stalled past the idle deadline', async () => {
    // Gate red at repair head 6bf86578 (2026-09-27): a lagging host loop resumes
    // with the idle timer expired AND the child's EOF/exit pending. The idle
    // verdict runs in CHECK, but 'close' (and the exit fence) land after it, so
    // an already-finished child was killed and reported as a guard failure.
    // The idle window must still let a loaded host START the child (its
    // 'ready' is the first output), and the stall must outlast both that
    // window and the child's own exit; tighter margins flaked under gate load.
    let queuedBlock = false;
    const res = await execProcess({
      command: process.execPath,
      args: ['-e', "process.stderr.write('ready\\n'); setTimeout(() => process.exit(0), 100);"],
      idleTimeoutMs: 1_000,
      timeoutMs: 15_000,
    }, {
      ...executionDeps,
      onOutputActivity: () => {
        if (queuedBlock) return;
        queuedBlock = true;
        setImmediate(() => {
          const from = Date.now();
          while (Date.now() - from < 2_500) { /* stall until the child has exited */ }
        });
      },
    });
    expect(res.stderr).not.toContain('no output progress');
    expect(res.code, res.stderr).toBe(0);
  }, 20_000);

  it('still idle-kills a child that closed its pipes but stays alive past the exit grace', async () => {
    const res = await execProcess({
      command: process.execPath,
      args: ['-e', "const fs = require('fs'); fs.closeSync(1); fs.closeSync(2); setTimeout(() => {}, 60_000);"],
      // idle-window-ok: this test ASSERTS the idle kill; a slow child boot can only delay it, never prevent it.
      idleTimeoutMs: 120,
      timeoutMs: 5_000,
    }, executionDeps);
    expect(res.code).toBe(-1);
    expect(res.stderr).toMatch(/made no output progress for 120ms/);
  });

  it('retains the absolute deadline when output never stops', async () => {
    // The idle clock is armed at spawn, so the child's node boot is charged to its first
    // window (WI-10004030): the window must outlast a loaded boot, and the hard deadline
    // must still be the bound that fires.
    const IDLE_MS = 1_000;
    const HARD_MS = 2_500;
    expect(IDLE_MS).toBeLessThan(HARD_MS);
    const res = await execProcess({
      command: process.execPath,
      args: ['-e', "process.stderr.write('ready\\n'); setInterval(() => process.stderr.write('progress\\n'), 20);"],
      idleTimeoutMs: IDLE_MS,
      timeoutMs: HARD_MS,
    }, executionDeps);
    expect(res.stderr).toContain('progress');
    expect(res.code).toBe(-1);
    expect(res.stderr).toContain(`timed out after ${HARD_MS}ms`);
    expect(res.stderr).not.toContain('no output progress');
  });

  it('refreshes the idle deadline on child output while retaining the absolute hard ceiling', async () => {
    // The window must outlast a loaded node boot (WI-10004030), and the child must keep
    // producing output for well over one window — otherwise it finishes inside the first
    // window and the test no longer proves the deadline was refreshed.
    const IDLE_MS = 1_000;
    const TICK_MS = 100;
    const TICKS = 25;
    const HARD_MS = 8_000;
    expect(TICK_MS).toBeLessThan(IDLE_MS);
    expect(TICKS * TICK_MS).toBeGreaterThan(2 * IDLE_MS);
    expect(TICKS * TICK_MS + IDLE_MS).toBeLessThan(HARD_MS);
    const script =
      `process.stderr.write('progress\\n'); let n=0; const t=setInterval(() => { process.stderr.write('progress\\n'); if (++n === ${TICKS}) clearInterval(t); }, ${TICK_MS});`;
    const started = Date.now();
    const res = await execProcess(
      {
        command: process.execPath,
        args: ['-e', script],
        idleTimeoutMs: IDLE_MS,
        timeoutMs: HARD_MS,
      },
      executionDeps,
    );
    expect(Date.now() - started).toBeGreaterThanOrEqual(2 * IDLE_MS);
    expect(res.code, res.stderr).toBe(0);
    expect(res.stderr).toContain('progress');
  });

  it('kills a silent child at the idle deadline instead of waiting for the hard ceiling', async () => {
    const res = await execProcess(
      {
        command: process.execPath,
        args: ['-e', 'setTimeout(() => {}, 60_000)'],
        // idle-window-ok: this test ASSERTS the idle kill of a silent child; boot time cannot turn it into a pass.
        idleTimeoutMs: 120,
        timeoutMs: 2_000,
      },
      executionDeps,
    );
    expect(res.code).toBe(-1);
    expect(res.stderr).toMatch(/made no output progress for 120ms/);
  });
});
