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
  it('refreshes the idle deadline on child output while retaining the absolute hard ceiling', async () => {
    const script =
      "process.stderr.write('progress\\n'); let n=0; const t=setInterval(() => { process.stderr.write('progress\\n'); if (++n === 8) clearInterval(t); }, 100);";
    const started = Date.now();
    const res = await execProcess(
      {
        command: process.execPath,
        args: ['-e', script],
        idleTimeoutMs: 500,
        timeoutMs: 2_000,
      },
      executionDeps,
    );
    expect(Date.now() - started).toBeGreaterThanOrEqual(700);
    expect(res.code, res.stderr).toBe(0);
    expect(res.stderr).toContain('progress');
  });

  it('kills a silent child at the idle deadline instead of waiting for the hard ceiling', async () => {
    const res = await execProcess(
      {
        command: process.execPath,
        args: ['-e', 'setTimeout(() => {}, 60_000)'],
        idleTimeoutMs: 120,
        timeoutMs: 2_000,
      },
      executionDeps,
    );
    expect(res.code).toBe(-1);
    expect(res.stderr).toMatch(/made no output progress for 120ms/);
  });
});
