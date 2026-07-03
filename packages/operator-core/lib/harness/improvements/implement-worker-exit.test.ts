import { describe, it, expect, vi } from 'vitest';
import {
  isEnvFailureExit,
  recordImplementWorkerExit,
  ENV_FAILURE_RUNTIME_FLOOR_MS,
  CONTEXT_OVERFLOW_ESCALATE_CAP,
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
    // EI-6876: transient upstream model-API 5xx / overload — NOT the item's fault.
    ['the live EI-6876 server-error-mid-response', 'API Error: Server error mid-response. The response above may be incomplete.'],
    ['overloaded (529)', 'API Error: 529 {"type":"error","error":{"type":"overloaded_error"}}'],
    ['internal server error (500)', 'API Error: 500 Internal server error'],
    ['service unavailable (503)', 'upstream returned 503 Service Unavailable'],
    ['bad gateway (502)', 'API Error: 502 Bad Gateway'],
    ['gateway timeout (504)', 'API Error: 504 Gateway Timeout'],
    // EI-6890: the inference-gateway's own transient-upstream wrapper — NUMERIC status +
    // "upstream error: fetch failed" / "server-side issue", NOT the English 5xx phrasings
    // above. The live EI-6476 death slipped through before this and filed a false EI.
    ['the live EI-6476 inference-gateway 502', 'API Error: 502 inference-gateway upstream error: fetch failed. This is a server-side issue, usually temporary — try again in a moment. If it persists, check your inference gateway (127.0.0.1:8788).'],
    ['a bare numeric 5xx with no English phrasing', 'API Error: 503'],
    ['undici fetch-failed connectivity death', 'TypeError: fetch failed'],
  ])('classifies %s as env failure', (_label, stdout) => {
    // A long substantive run (well past the DOA floor) so the ONLY thing that can
    // class these env is the new upstream-5xx signature, not the sub-floor DOA rule.
    expect(isEnvFailureExit({ exitCode: 1, runtimeMs: ENV_FAILURE_RUNTIME_FLOOR_MS + 500_000, stdout }).env).toBe(true);
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

  it('WI-716: "Prompt is too long" is classed env + tagged context-overflow (not a generic env signature)', () => {
    const v = isEnvFailureExit({
      exitCode: 1,
      runtimeMs: 400_000, // a real long reproduce+fix run, not a DOA
      stdout: 'reproducing the bug...\n'.repeat(200) + 'worker exit 1 ... Prompt is too long',
    });
    expect(v.env).toBe(true);
    expect(v.class).toBe('context-overflow');
    expect(v.reason).toMatch(/context overflow/);
  });

  it('WI-716: an underlying "exceeds the context window" API message also classifies as context-overflow', () => {
    const v = isEnvFailureExit({
      exitCode: 1,
      runtimeMs: 200_000,
      stdout: 'x'.repeat(300) + '\nrequest exceeds the model context window',
    });
    expect(v.class).toBe('context-overflow');
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
    getPayload: async () => null, // no prior contextOverflowDeaths unless a test overrides it
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

  it('EI-6876: a transient upstream "Server error mid-response" rolls the attempt back + tags -env (not a "lane broken" orphan)', async () => {
    const { deps, calls } = fakeDeps();
    const res = await recordImplementWorkerExit(
      {
        dispatchId: 'd-6569',
        itemId: 'EI-6569',
        attempt: 1,
        exitCode: 1,
        runtimeMs: 866_000, // the real EI-6569 death: a long run, not a DOA
        stdout: 'API Error: Server error mid-response. The response above may be incomplete.',
      },
      deps,
    );
    // Transient provider 5xx says nothing about the item → do NOT charge the attempt.
    expect(res.charged).toBe(false);
    expect(res.envReason).toBeTruthy();
    expect(calls.mergePayload).toEqual([['EI-6569', { implementAttempts: 0 }]]);
    // Tagged -env so the orphaned-dispatch watchdog EXCLUDES it from the "lane broken"
    // signal — no self-amplifying EI (the loop that produced EI-6876).
    expect(calls.markOrphaned[0][1]).toBe('worker-exit-backedge-env');
    expect(calls.markOrphaned[0][2]).toMatch(/env-failure/);
  });

  it('EI-6890: the live inference-gateway 502 death rolls the attempt back + tags -env (not a "lane broken" orphan)', async () => {
    const { deps, calls } = fakeDeps();
    const res = await recordImplementWorkerExit(
      {
        dispatchId: 'd-6476',
        itemId: 'EI-6476',
        attempt: 1,
        exitCode: 1,
        runtimeMs: 249_000, // the real EI-6476 death: a 249s run, well past the DOA floor
        stdout:
          'API Error: 502 inference-gateway upstream error: fetch failed. This is a server-side issue, ' +
          'usually temporary — try again in a moment. If it persists, check your inference gateway (127.0.0.1:8788).',
      },
      deps,
    );
    // A transient inference-gateway 502 says nothing about the item → do NOT charge the attempt.
    expect(res.charged).toBe(false);
    expect(res.envReason).toBeTruthy();
    expect(calls.mergePayload).toEqual([['EI-6476', { implementAttempts: 0 }]]);
    // Tagged -env so the orphaned-dispatch watchdog EXCLUDES it from the "lane broken"
    // signal — the fix for the EI-6476 → EI-6890 self-amplifying noise loop.
    expect(calls.markOrphaned[0][1]).toBe('worker-exit-backedge-env');
    expect(calls.markOrphaned[0][2]).toMatch(/env-failure/);
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

describe('recordImplementWorkerExit — WI-716 context-overflow bounded escalation', () => {
  const overflowInput = (over: Partial<Parameters<typeof recordImplementWorkerExit>[0]> = {}) => ({
    dispatchId: 'd-of',
    itemId: 'EI-716',
    attempt: 3,
    exitCode: 1,
    runtimeMs: 600_000,
    stdout: 'reproducing...\n'.repeat(100) + 'worker exit 1 ... Prompt is too long',
    ...over,
  });

  it('a FIRST context-overflow death (no prior) rolls the attempt back and persists deaths=1 — not escalated', async () => {
    const { deps, calls } = fakeDeps({ getPayload: async () => null });
    const res = await recordImplementWorkerExit(overflowInput(), deps);
    expect(res.charged).toBe(false);
    expect(res.contextOverflow).toEqual({ deaths: 1, escalated: false });
    expect(calls.mergePayload).toEqual([['EI-716', { contextOverflowDeaths: 1, implementAttempts: 2 }]]);
    expect(calls.markOrphaned[0][1]).toBe('worker-exit-backedge-context-overflow');
    expect(calls.markOrphaned[0][2]).toMatch(/context-overflow death 1\/2/);
  });

  it(`a ${CONTEXT_OVERFLOW_ESCALATE_CAP}th context-overflow death trips the cap: needsHuman, attempt NOT rolled back`, async () => {
    const { deps, calls } = fakeDeps({ getPayload: async () => ({ contextOverflowDeaths: CONTEXT_OVERFLOW_ESCALATE_CAP - 1 }) });
    const res = await recordImplementWorkerExit(overflowInput({ attempt: 5 }), deps);
    expect(res.contextOverflow).toEqual({ deaths: CONTEXT_OVERFLOW_ESCALATE_CAP, escalated: true });
    expect(calls.mergePayload).toEqual([
      ['EI-716', { contextOverflowDeaths: CONTEXT_OVERFLOW_ESCALATE_CAP, needsHuman: true }],
    ]);
    // NOT an implementAttempts rollback this time — needsHuman removes it from the
    // auto pool regardless of attempts, so no infinite rollback/re-dispatch loop.
    expect(calls.mergePayload[0][1]).not.toHaveProperty('implementAttempts');
    expect(calls.markOrphaned[0][2]).toMatch(/escalation cap tripped/);
  });

  it('a getPayload failure is treated as 0 prior deaths (best-effort — never throws)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { deps, calls } = fakeDeps({ getPayload: async () => { throw new Error('pg down'); } });
    const res = await recordImplementWorkerExit(overflowInput(), deps);
    expect(res.contextOverflow).toEqual({ deaths: 1, escalated: false });
    expect(calls.mergePayload).toEqual([['EI-716', { contextOverflowDeaths: 1, implementAttempts: 2 }]]);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('a generic env failure (weekly limit) never touches getPayload / contextOverflowDeaths', async () => {
    let getPayloadCalls = 0;
    const { deps, calls } = fakeDeps({ getPayload: async () => { getPayloadCalls++; return null; } });
    const res = await recordImplementWorkerExit(
      { dispatchId: 'd-env', itemId: 'EI-9', attempt: 2, exitCode: 1, runtimeMs: 3_000, stdout: "You've hit your weekly limit · resets Jun 18, 7am" },
      deps,
    );
    expect(res.contextOverflow).toBeUndefined();
    expect(getPayloadCalls).toBe(0);
    expect(calls.mergePayload).toEqual([['EI-9', { implementAttempts: 1 }]]);
  });
});
