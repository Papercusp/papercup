import { describe, it, expect } from 'vitest';
import {
  isEnvFailureExit,
  recordImplementWorkerExit,
  ENV_FAILURE_RUNTIME_FLOOR_MS,
  type ImplementWorkerExitDeps,
} from './implement-worker-exit';

describe('isEnvFailureExit (EI-406 classifier)', () => {
  it('a clean exit (0) is never an env failure — it resolved or exited-0-without-resolve', () => {
    expect(isEnvFailureExit({ exitCode: 0, runtimeMs: 2_000, stdout: 'weekly limit' }).env).toBe(false);
  });

  it('the live EI-75 weekly-limit DOA is an env failure', () => {
    const v = isEnvFailureExit({
      exitCode: 1,
      runtimeMs: 3_000,
      stdout: "You've hit your weekly limit · resets Jun 18, 7am (America/New_York)",
    });
    expect(v.env).toBe(true);
    expect(v.reason).toMatch(/env signature/);
  });

  it.each([
    ['401', 'request failed with status 401'],
    ['403 org block', 'Your organization has disabled subscription access — 403'],
    ['unauthorized', 'Error: Unauthorized'],
    ['credential', 'no valid credential found'],
    ['rate limit', 'you are being rate-limited, try again later'],
    ['connectivity', 'connect ECONNREFUSED 127.0.0.1:8788'],
  ])('classifies %s as env failure', (_label, stdout) => {
    expect(isEnvFailureExit({ exitCode: 1, runtimeMs: 5_000, stdout }).env).toBe(true);
  });

  it('a non-zero sub-floor near-empty exit is a dead-on-arrival env failure', () => {
    const v = isEnvFailureExit({ exitCode: 1, runtimeMs: 2_000, stdout: '', stderr: '' });
    expect(v.env).toBe(true);
    expect(v.reason).toMatch(/dead-on-arrival/);
  });

  it('a genuine worker failure (long run, substantive output, no env signature) is NOT env', () => {
    const v = isEnvFailureExit({
      exitCode: 1,
      runtimeMs: ENV_FAILURE_RUNTIME_FLOOR_MS + 600_000,
      stdout: 'Reproduced the bug, wrote a regression test, but the fix attempt still fails 2 assertions. '.repeat(6),
    });
    expect(v.env).toBe(false);
  });

  it('a non-zero exit with substantive output under the floor but no signature is NOT env (it did real work fast)', () => {
    const v = isEnvFailureExit({
      exitCode: 1,
      runtimeMs: 10_000,
      stdout: 'x'.repeat(500), // > 200 chars → not the empty-DOA shape, no signature → genuine
    });
    expect(v.env).toBe(false);
  });
});

function fakeDeps(overrides: Partial<ImplementWorkerExitDeps> = {}): {
  deps: ImplementWorkerExitDeps;
  calls: { markOrphaned: Array<[string, string, string | undefined]>; mergePayload: Array<[string, Record<string, unknown>]> };
} {
  const calls = {
    markOrphaned: [] as Array<[string, string, string | undefined]>,
    mergePayload: [] as Array<[string, Record<string, unknown>]>,
  };
  const deps: ImplementWorkerExitDeps = {
    markOrphaned: async (id, by, detail) => {
      calls.markOrphaned.push([id, by, detail]);
      return true;
    },
    mergePayload: async (id, patch) => {
      calls.mergePayload.push([id, patch]);
      return null;
    },
    ...overrides,
  };
  return { deps, calls };
}

describe('recordImplementWorkerExit (EI-404 back-edge + EI-406 rollback)', () => {
  it('marks the open ledger row orphaned at exit with by=worker-exit-backedge + detail', async () => {
    const { deps, calls } = fakeDeps();
    const res = await recordImplementWorkerExit(
      { dispatchId: 'd1', itemId: 'EI-9', attempt: 1, exitCode: 1, runtimeMs: 4_000, stdout: 'fix failed: 2 assertions red'.repeat(20) },
      deps,
    );
    expect(res.marked).toBe(true);
    expect(calls.markOrphaned).toHaveLength(1);
    expect(calls.markOrphaned[0][0]).toBe('d1');
    expect(calls.markOrphaned[0][1]).toBe('worker-exit-backedge');
    expect(calls.markOrphaned[0][2]).toMatch(/worker exit 1/);
  });

  it('env-failure rolls the attempt counter back (does NOT charge) — EI-406', async () => {
    const { deps, calls } = fakeDeps();
    const res = await recordImplementWorkerExit(
      { dispatchId: 'd2', itemId: 'EI-75', attempt: 2, exitCode: 1, runtimeMs: 3_000, stdout: "You've hit your weekly limit · resets Jun 18, 7am" },
      deps,
    );
    expect(res.charged).toBe(false);
    expect(res.envReason).toBeTruthy();
    expect(calls.mergePayload).toEqual([['EI-75', { implementAttempts: 1 }]]);
    expect(calls.markOrphaned[0][2]).toMatch(/env-failure/);
    // Tagged distinctly so the orphaned-dispatch watchdog excludes it from the "lane broken" signal.
    expect(calls.markOrphaned[0][1]).toBe('worker-exit-backedge-env');
  });

  it('a credential outage on attempt 1 rolls back to 0 (never negative)', async () => {
    const { deps, calls } = fakeDeps();
    await recordImplementWorkerExit(
      { dispatchId: 'd3', itemId: 'EI-1', attempt: 1, exitCode: 1, runtimeMs: 1_500, stdout: '', stderr: '' },
      deps,
    );
    expect(calls.mergePayload).toEqual([['EI-1', { implementAttempts: 0 }]]);
  });

  it('a genuine worker failure stays charged (no rollback)', async () => {
    const { deps, calls } = fakeDeps();
    const res = await recordImplementWorkerExit(
      {
        dispatchId: 'd4',
        itemId: 'EI-2',
        attempt: 2,
        exitCode: 1,
        runtimeMs: ENV_FAILURE_RUNTIME_FLOOR_MS + 300_000,
        stdout: 'Tried the fix, tests still red after 3 iterations. '.repeat(10),
      },
      deps,
    );
    expect(res.charged).toBe(true);
    expect(calls.mergePayload).toHaveLength(0);
  });

  it('is a no-op when the row is already terminal (the worker DID resolve)', async () => {
    const { deps, calls } = fakeDeps({ markOrphaned: async () => false });
    const res = await recordImplementWorkerExit(
      { dispatchId: 'd5', itemId: 'EI-3', attempt: 1, exitCode: 0, runtimeMs: 120_000, stdout: 'resolved' },
      deps,
    );
    expect(res.marked).toBe(false);
    expect(calls.mergePayload).toHaveLength(0);
  });
});
