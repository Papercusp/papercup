/**
 * EI-18803497769946984 — the idle-tx warning must fire for a SLOW call, stay silent for a
 * fast one, and never change what the caller observes.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  IDLE_TX_WARN_MS,
  idleTxWarningMessage,
  warnIfHoldingWorkspaceTxTooLong,
  type IdleTxWarnDeps,
} from './idle-tx-warning';

/** A controllable clock: nothing fires until `fire()` is called. */
function fakeClock() {
  const pending = new Map<number, { fn: () => void; ms: number }>();
  let next = 1;
  const warnings: string[] = [];
  const deps: IdleTxWarnDeps = {
    setTimeout: ((fn: () => void, ms: number) => {
      const id = next++;
      pending.set(id, { fn, ms });
      return id as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout,
    clearTimeout: ((id: number) => {
      pending.delete(id);
    }) as unknown as typeof clearTimeout,
    warn: (m) => warnings.push(m),
  };
  return {
    deps,
    warnings,
    scheduledDelays: () => [...pending.values()].map((p) => p.ms),
    /** Run every still-pending timer — i.e. "time passed and nothing cancelled it". */
    fire: () => {
      for (const { fn } of [...pending.values()]) fn();
    },
    pendingCount: () => pending.size,
  };
}

describe('warnIfHoldingWorkspaceTxTooLong (EI-18803497769946984)', () => {
  it('warns, naming the tool, when the handler is still pending at the threshold', async () => {
    const clock = fakeClock();
    let release!: (v: string) => void;
    const slow = new Promise<string>((res) => {
      release = res;
    });

    const wrapped = warnIfHoldingWorkspaceTxTooLong('build:typecheck', slow, clock.deps);

    expect(clock.scheduledDelays()).toEqual([IDLE_TX_WARN_MS]);
    clock.fire(); // the handler has NOT settled yet

    expect(clock.warnings).toHaveLength(1);
    // The tool name is the entire point — a warning that cannot be attributed is the
    // status quo we are replacing.
    expect(clock.warnings[0]).toContain('build:typecheck');
    expect(clock.warnings[0]).toContain('needsWorkspaceTx:true');

    release('done');
    await expect(wrapped).resolves.toBe('done');
  });

  it('stays silent for a call that settles before the threshold', async () => {
    const clock = fakeClock();

    await expect(
      warnIfHoldingWorkspaceTxTooLong('coord:glance', Promise.resolve(42), clock.deps),
    ).resolves.toBe(42);

    // Cleared on settle: firing the clock afterwards must produce nothing. This is the
    // regression that matters for a tool called ~210k times/week — a leaked timer per
    // call would be worse than the bug.
    clock.fire();
    expect(clock.warnings).toEqual([]);
    expect(clock.pendingCount()).toBe(0);
  });

  it('passes a rejection through unchanged and still clears its timer', async () => {
    const clock = fakeClock();
    const boom = new Error('handler exploded');

    await expect(
      warnIfHoldingWorkspaceTxTooLong('release:deploy', Promise.reject(boom), clock.deps),
    ).rejects.toBe(boom);

    clock.fire();
    expect(clock.warnings).toEqual([]);
    expect(clock.pendingCount()).toBe(0);
  });

  it('fires below the 60s idle_in_transaction_session_timeout, not after it', () => {
    // If this ever crept to >=60s the warning would describe a connection Postgres had
    // already killed, which is exactly the useless after-the-fact signal being fixed.
    expect(IDLE_TX_WARN_MS).toBeLessThan(60_000);
  });

  it('the message explains the CONNECTION_CLOSED symptom it is pre-empting', () => {
    const msg = idleTxWarningMessage('testing:run');
    // A reader who greps the mystery error must land on this line.
    expect(msg).toContain('CONNECTION_CLOSED 127.0.0.1:6432');
    expect(msg).toContain('testing:run');
  });

  it('does not hold the process alive (timer is unref\'d when supported)', () => {
    const unref = vi.fn();
    const deps: IdleTxWarnDeps = {
      setTimeout: (() => ({ unref })) as unknown as typeof setTimeout,
      clearTimeout: (() => {}) as unknown as typeof clearTimeout,
      warn: () => {},
    };
    void warnIfHoldingWorkspaceTxTooLong('x:y', Promise.resolve(1), deps);
    expect(unref).toHaveBeenCalledOnce();
  });
});
