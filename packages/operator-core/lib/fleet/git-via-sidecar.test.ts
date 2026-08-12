import { describe, it, expect } from 'vitest';
import { gitSidecarEnabled } from './git-via-sidecar';
import { execProcess } from './sidecar-exec-process';

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
    expect(gitSidecarEnabled('PAPERCUSP_POT_GIT_SPAWN_SIDECAR', { PAPERCUSP_POT_GIT_SPAWN_SIDECAR: '1' })).toBe(
      true,
    );
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

describe('spawner-sidecar process progress guard', () => {
  it('refreshes the idle deadline on child output while retaining the absolute hard ceiling', async () => {
    const script =
      "process.stderr.write('progress\\n'); let n=0; const t=setInterval(() => { process.stderr.write('progress\\n'); if (++n === 8) clearInterval(t); }, 100);";
    const started = Date.now();
    const res = await execProcess({
      command: process.execPath,
      args: ['-e', script],
      idleTimeoutMs: 500,
      timeoutMs: 2_000,
    });
    expect(Date.now() - started).toBeGreaterThanOrEqual(700);
    expect(res.code).toBe(0);
    expect(res.stderr).toContain('progress');
  });

  it('kills a silent child at the idle deadline instead of waiting for the hard ceiling', async () => {
    const res = await execProcess({
      command: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 60_000)'],
      idleTimeoutMs: 120,
      timeoutMs: 2_000,
    });
    expect(res.code).toBe(-1);
    expect(res.stderr).toMatch(/made no output progress for 120ms/);
  });
});
