/**
 * host-recycle.test.ts — the memory-watchdog onTrip drain path (audit P-002).
 *
 * Proves the recycle tears down the P2P substrate before exiting, exits only
 * after BOTH the HTTP drain and the substrate teardown complete, survives a
 * teardown failure, and hard-exits when either side hangs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gracefulHostRecycle, type RecycleServerLike } from './host-recycle';

describe('gracefulHostRecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function makeServer(): { server: RecycleServerLike; drain: () => void } {
    let cb: (() => void) | undefined;
    return {
      server: {
        close: (c?: () => void) => {
          cb = c;
        },
      },
      drain: () => cb?.(),
    };
  }

  it('closes the substrate and exits with the recycle code (non-zero, default 75) after BOTH the drain and teardown complete', async () => {
    const exit = vi.fn();
    let resolveSubstrate!: () => void;
    const closeSubstrate = vi.fn(
      () => new Promise<void>((r) => (resolveSubstrate = r)),
    );
    const { server, drain } = makeServer();

    gracefulHostRecycle({ server, exit, closeSubstrate });
    expect(closeSubstrate).toHaveBeenCalledTimes(1); // teardown starts immediately

    // HTTP drained but substrate still closing → no exit yet.
    drain();
    await vi.advanceTimersByTimeAsync(0);
    expect(exit).not.toHaveBeenCalled();

    // Substrate done → exit 0, exactly once.
    resolveSubstrate();
    await vi.advanceTimersByTimeAsync(0);
    expect(exit).toHaveBeenCalledExactlyOnceWith(75);
  });

  it('a substrate-teardown failure does not block the recycle', async () => {
    const exit = vi.fn();
    const closeSubstrate = vi.fn(() => Promise.reject(new Error('boom')));
    const { server, drain } = makeServer();

    gracefulHostRecycle({ server, exit, closeSubstrate });
    drain();
    await vi.advanceTimersByTimeAsync(0);
    expect(exit).toHaveBeenCalledExactlyOnceWith(75);
  });

  it('hard-exits after hardExitMs when the HTTP drain hangs', async () => {
    const exit = vi.fn();
    const closeSubstrate = vi.fn(() => Promise.resolve());
    const { server } = makeServer(); // drain never called

    gracefulHostRecycle({ server, exit, closeSubstrate, hardExitMs: 1000 });
    await vi.advanceTimersByTimeAsync(999);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(exit).toHaveBeenCalledExactlyOnceWith(75);
  });

  it('hard-exits after hardExitMs when the substrate teardown hangs', async () => {
    const exit = vi.fn();
    const closeSubstrate = vi.fn(() => new Promise<void>(() => {})); // never resolves
    const { server, drain } = makeServer();

    gracefulHostRecycle({ server, exit, closeSubstrate, hardExitMs: 1000 });
    drain();
    await vi.advanceTimersByTimeAsync(1000);
    expect(exit).toHaveBeenCalledExactlyOnceWith(75);
  });

  it('exits via the backstop when the server has no close fn (never double-exits)', async () => {
    const exit = vi.fn();
    const closeSubstrate = vi.fn(() => Promise.resolve());
    gracefulHostRecycle({ server: {}, exit, closeSubstrate, hardExitMs: 500 });
    await vi.advanceTimersByTimeAsync(500);
    expect(exit).toHaveBeenCalledExactlyOnceWith(75);
  });

  it('exits NON-ZERO by default so the recycle restarts under Restart=on-failure too (EI-1613, R4-1)', async () => {
    const exit = vi.fn();
    const closeSubstrate = vi.fn(() => Promise.resolve());
    const { server, drain } = makeServer();
    gracefulHostRecycle({ server, exit, closeSubstrate });
    drain();
    await vi.advanceTimersByTimeAsync(0);
    const code = exit.mock.calls[0]?.[0];
    expect(code).toBe(75);
    expect(code).not.toBe(0);
  });

  it('honors an explicit recycleExitCode', async () => {
    const exit = vi.fn();
    const closeSubstrate = vi.fn(() => Promise.resolve());
    const { server, drain } = makeServer();
    gracefulHostRecycle({ server, exit, closeSubstrate, recycleExitCode: 42 });
    drain();
    await vi.advanceTimersByTimeAsync(0);
    expect(exit).toHaveBeenCalledExactlyOnceWith(42);
  });
});
