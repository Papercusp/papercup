import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  PURE_PROOF_CAPTURE_HARD_GRACE_MS,
  SELF_WATCHDOG_MS,
  createNormalCheckpointFinalizer,
  runPostVerdictPureProofCapture,
} from './green-checkpoint';

/**
 * gate-test-reuse-yield-2026-10-01 P-006 (D-005 §1): the CLI runs the pure-lane proof capture
 * AFTER the verdict is recorded and before the run lock is released. This wrapper must never cost
 * the run anything: it honours the kill switch without touching the watchdog, cancels the
 * self-watchdog only when capture really runs (its fire path would record a second, emergency
 * verdict), carries the phase's knobs past the gate env allowlist, swallows a capture failure, and
 * stops waiting at a hard deadline.
 */

const cfg = {
  checkpointRoot: '/ck/root',
  checkpointLogDir: '/ck/logs',
  greenCheckpointCapacityMode: 'shared' as const,
};
const KEYS = ['PC_PURE_PROOF_CAPTURE', 'PC_PURE_PROOF_CAPTURE_BUDGET_MS', 'PC_PURE_PROOF_CAPTURE_SLICE'];
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
});

afterEach(() => {
  vi.useRealTimers();
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('CLI normal finalization and pure-proof capture', () => {
  const result = { green: true, candidate: 'a'.repeat(40) } as Parameters<
    ReturnType<typeof createNormalCheckpointFinalizer>
  >[0];

  function finalizer(overrides: Partial<Parameters<typeof createNormalCheckpointFinalizer>[0]> = {}) {
    let claimed = false;
    const deps = {
      claimTerminal: vi.fn(() => {
        if (claimed) return false;
        claimed = true;
        return true;
      }),
      emitResult: vi.fn(async () => {}),
      captureProofs: vi.fn(async () => {}),
      releaseAndExit: vi.fn(),
      ...overrides,
    };
    return { deps, finalize: createNormalCheckpointFinalizer(deps) };
  }

  it('waits for durable verdict recording, then capture, before release', async () => {
    const recorded = deferred<void>();
    const captured = deferred<void>();
    const h = finalizer({ emitResult: vi.fn(() => recorded.promise), captureProofs: vi.fn(() => captured.promise) });
    const done = h.finalize(result);
    expect(h.deps.emitResult).toHaveBeenCalledWith(result);
    expect(h.deps.captureProofs).not.toHaveBeenCalled();
    expect(h.deps.releaseAndExit).not.toHaveBeenCalled();
    recorded.resolve();
    await recorded.promise;
    expect(h.deps.captureProofs).toHaveBeenCalledTimes(1);
    expect(h.deps.releaseAndExit).not.toHaveBeenCalled();
    captured.resolve();
    await done;
    expect(h.deps.releaseAndExit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it('refuses a signal/crash-owned terminal path without emitting or capturing', async () => {
    const h = finalizer({ claimTerminal: vi.fn(() => false) });
    await h.finalize(result);
    expect(h.deps.claimTerminal).toHaveBeenCalledExactlyOnceWith('normal');
    expect(h.deps.emitResult).not.toHaveBeenCalled();
    expect(h.deps.captureProofs).not.toHaveBeenCalled();
    expect(h.deps.releaseAndExit).not.toHaveBeenCalled();
  });

  it('rejects duplicate completion while the first verdict recording is in flight', async () => {
    const recorded = deferred<void>();
    const h = finalizer({ emitResult: vi.fn(() => recorded.promise) });
    const first = h.finalize(result);
    await h.finalize(result);
    expect(h.deps.emitResult).toHaveBeenCalledTimes(1);
    expect(h.deps.captureProofs).not.toHaveBeenCalled();
    recorded.resolve();
    await first;
    await h.finalize(result);
    expect(h.deps.captureProofs).toHaveBeenCalledTimes(1);
    expect(h.deps.releaseAndExit).toHaveBeenCalledTimes(1);
  });

  it('leaves verdict-recording failures to the existing fatal handler without capturing', async () => {
    const error = new Error('verdict write failed');
    const h = finalizer({ emitResult: vi.fn(async () => { throw error; }) });
    await expect(h.finalize(result)).rejects.toBe(error);
    expect(h.deps.captureProofs).not.toHaveBeenCalled();
    expect(h.deps.releaseAndExit).not.toHaveBeenCalled();
  });
});

describe('runPostVerdictPureProofCapture', () => {
  it('honours the kill switch: no capture, and the watchdog stays armed', async () => {
    process.env.PC_PURE_PROOF_CAPTURE = '0';
    const cancel = vi.fn();
    const capture = vi.fn();
    const logs: string[] = [];
    await runPostVerdictPureProofCapture(cfg, 'run-1', cancel, (l) => logs.push(l), capture as never);
    expect(capture).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    expect(logs).toEqual(['PURE_PROOF_CAPTURE state=skipped reason=disabled-by-env']);
  });

  it('cancels the watchdog first, then captures in the checkpoint tree under the gate env', async () => {
    process.env.PC_PURE_PROOF_CAPTURE_BUDGET_MS = '60000';
    process.env.PC_PURE_PROOF_CAPTURE_SLICE = '50';
    const order: string[] = [];
    const cancel = vi.fn(() => order.push('cancel'));
    const capture = vi.fn(async (_o: Record<string, unknown>) => {
      order.push('capture');
      return {} as never;
    });
    const logs: string[] = [];
    await runPostVerdictPureProofCapture(cfg, 'run-1', cancel, (l) => logs.push(l), capture as never);
    expect(order).toEqual(['cancel', 'capture']);
    const arg = capture.mock.calls[0][0] as {
      root: string;
      runGroupId: string;
      logFile: string;
      env: Record<string, string | undefined>;
      deps: { readNextFireAtMs: unknown };
    };
    expect(arg.root).toBe('/ck/root');
    expect(arg.runGroupId).toBe('run-1:pure-proof-capture');
    expect(arg.logFile).toBe('/ck/logs/pure-proof-capture-run-1.log');
    expect(arg.env.GREEN_CHECKPOINT).toBe('1');
    // Carried past canonicalGreenCheckpointSourceEnv's allowlist, which would otherwise drop them.
    expect(arg.env.PC_PURE_PROOF_CAPTURE_BUDGET_MS).toBe('60000');
    expect(arg.env.PC_PURE_PROOF_CAPTURE_SLICE).toBe('50');
    expect(typeof arg.deps.readNextFireAtMs).toBe('function');
    expect(logs).toContain('GATE_RUN_PHASE phase=pure-proof-capture');
  });

  it('swallows a capture failure into one log line', async () => {
    const logs: string[] = [];
    const capture = vi.fn(async () => {
      throw new Error('boom went the capture');
    });
    await expect(
      runPostVerdictPureProofCapture(cfg, 'run-1', () => {}, (l) => logs.push(l), capture as never),
    ).resolves.toBeUndefined();
    expect(logs).toContain('PURE_PROOF_CAPTURE state=error reason=boom_went_the_capture');
  });

  it('never runs past the run ceiling: the slice deadline and the hard deadline both stop at it', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    const startedAt = now - SELF_WATCHDOG_MS + 2_000; // 2s of run left
    const logs: string[] = [];
    let nextFire: number | null = null;
    const capture = vi.fn(async (o: { deps: { readNextFireAtMs: () => Promise<number | null> } }) => {
      nextFire = await o.deps.readNextFireAtMs();
      return new Promise<never>(() => {});
    });
    let settled = false;
    const done = runPostVerdictPureProofCapture(
      cfg,
      'run-1',
      () => {},
      (l) => logs.push(l),
      capture as never,
      startedAt,
      async () => null, // no scheduled fire: the ceiling alone is the stop line
    ).then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(settled).toBe(false);
    // The phase is told the ceiling (or an earlier fire) as its stop line.
    expect(nextFire).not.toBeNull();
    expect(nextFire!).toBeLessThanOrEqual(startedAt + SELF_WATCHDOG_MS);
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(logs).toContain('PURE_PROOF_CAPTURE state=abandoned reason=hard-deadline(2000ms)');
  });

  it('hands capture the earlier of the next fire and the ceiling, and the ceiling when the fire is unreadable', async () => {
    const startedAt = Date.now() - SELF_WATCHDOG_MS + 600_000; // 10 min of run left
    const seen: Array<number | null> = [];
    const capture = vi.fn(async (o: { deps: { readNextFireAtMs: () => Promise<number | null> } }) => {
      seen.push(await o.deps.readNextFireAtMs());
    });
    const before = Date.now();
    // A fire in 60s is earlier than the ceiling: it wins.
    await runPostVerdictPureProofCapture(cfg, 'run-1', () => {}, () => {}, capture as never, startedAt, async () => 60);
    // A fire in 3h is later than the ceiling: the ceiling wins.
    await runPostVerdictPureProofCapture(cfg, 'run-1', () => {}, () => {}, capture as never, startedAt, async () => 10_800);
    // An unreadable fire leaves the ceiling in force.
    await runPostVerdictPureProofCapture(cfg, 'run-1', () => {}, () => {}, capture as never, startedAt, async () => {
      throw new Error('routines row unreadable');
    });
    const after = Date.now();
    const ceiling = startedAt + SELF_WATCHDOG_MS;
    expect(seen[0]).toBeGreaterThanOrEqual(before + 60_000);
    expect(seen[0]).toBeLessThanOrEqual(after + 60_000);
    expect(seen[1]).toBe(ceiling);
    expect(seen[2]).toBe(ceiling);
  });

  it('stops waiting at budget + grace when capture hangs', async () => {
    vi.useFakeTimers();
    process.env.PC_PURE_PROOF_CAPTURE_BUDGET_MS = '1000';
    const logs: string[] = [];
    const capture = vi.fn(() => new Promise<never>(() => {}));
    let settled = false;
    const done = runPostVerdictPureProofCapture(cfg, 'run-1', () => {}, (l) => logs.push(l), capture as never).then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(1000 + PURE_PROOF_CAPTURE_HARD_GRACE_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(settled).toBe(true);
    expect(logs).toContain(
      `PURE_PROOF_CAPTURE state=abandoned reason=hard-deadline(${1000 + PURE_PROOF_CAPTURE_HARD_GRACE_MS}ms)`,
    );
  });
});
