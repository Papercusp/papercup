/**
 * host-recycle.test.ts — the memory-watchdog onTrip drain path (audit P-002).
 *
 * Proves the recycle tears down the P2P substrate before exiting, exits only
 * after BOTH the HTTP drain and the substrate teardown complete, survives a
 * teardown failure, and hard-exits when either side hangs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  gracefulHostRecycle,
  installGracefulShutdown,
  installFatalDiagnostics,
  _resetFatalDiagnosticsForTests,
  type RecycleServerLike,
} from './host-recycle';

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

  // WI-3795: a cluster-wide SIGTERM broadcast races the substrate teardown
  // against a native Napi::Error/SIGABRT crash when the loop is already
  // critically saturated — skip attempting the close in that case instead of
  // starting a native op that can crash the process below the JS layer.
  describe('WI-3795 — skip substrate teardown when the loop is critically saturated', () => {
    it('does NOT call closeSubstrate when isSaturated() reads true, and still exits cleanly', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const exit = vi.fn();
      const closeSubstrate = vi.fn(() => Promise.resolve());
      const isSaturated = vi.fn(() => true);
      const { server, drain } = makeServer();

      gracefulHostRecycle({ server, exit, closeSubstrate, isSaturated });
      expect(closeSubstrate).not.toHaveBeenCalled();

      drain();
      await vi.advanceTimersByTimeAsync(0);
      expect(exit).toHaveBeenCalledExactlyOnceWith(75);
      expect(closeSubstrate).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('still calls closeSubstrate as normal when isSaturated() reads false', async () => {
      const exit = vi.fn();
      const closeSubstrate = vi.fn(() => Promise.resolve());
      const isSaturated = vi.fn(() => false);
      const { server, drain } = makeServer();

      gracefulHostRecycle({ server, exit, closeSubstrate, isSaturated });
      expect(closeSubstrate).toHaveBeenCalledTimes(1);

      drain();
      await vi.advanceTimersByTimeAsync(0);
      expect(exit).toHaveBeenCalledExactlyOnceWith(75);
    });

    it('defaults isSaturated to the real event-loop-lag monitor (isLoopElevated), which reads false absent a running monitor (no behavior change when unconfigured)', async () => {
      const exit = vi.fn();
      const closeSubstrate = vi.fn(() => Promise.resolve());
      const { server, drain } = makeServer();

      gracefulHostRecycle({ server, exit, closeSubstrate }); // no isSaturated override
      expect(closeSubstrate).toHaveBeenCalledTimes(1); // no monitor running in this test process → not saturated

      drain();
      await vi.advanceTimersByTimeAsync(0);
      expect(exit).toHaveBeenCalledExactlyOnceWith(75);
    });
  });

  // EI-9649: a MEMORY-watchdog recycle trips when RSS is over the cap — i.e. the
  // substrate is large — and can fire while the event loop is NOT yet elevated,
  // so the WI-3795 isSaturated skip does not catch it and the risky native
  // substrate close runs and throws an uncaught Napi::Error → SIGABRT below the
  // JS layer (a routine recycle becomes a hard crash + webview reconnect flash).
  // skipSubstrateTeardown lets the memory-recycle caller opt out of the native
  // close unconditionally (the process exits anyway; the OS reclaims the handles).
  describe('EI-9649 — skipSubstrateTeardown never starts the native substrate close', () => {
    it('does NOT call closeSubstrate when skipSubstrateTeardown is true, and still exits cleanly', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const exit = vi.fn();
      const closeSubstrate = vi.fn(() => Promise.resolve());
      const { server, drain } = makeServer();

      gracefulHostRecycle({ server, exit, closeSubstrate, skipSubstrateTeardown: true });
      expect(closeSubstrate).not.toHaveBeenCalled(); // the risky native op is never started

      drain();
      await vi.advanceTimersByTimeAsync(0);
      expect(exit).toHaveBeenCalledExactlyOnceWith(75);
      expect(closeSubstrate).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('skips even when the loop is NOT saturated (the EI-9649 gap: a memory recycle in a calm loop)', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const exit = vi.fn();
      const closeSubstrate = vi.fn(() => Promise.resolve());
      const isSaturated = vi.fn(() => false); // calm loop → WI-3795 skip would NOT fire
      const { server, drain } = makeServer();

      gracefulHostRecycle({ server, exit, closeSubstrate, isSaturated, skipSubstrateTeardown: true });
      // skipSubstrateTeardown wins regardless of the isSaturated verdict.
      expect(closeSubstrate).not.toHaveBeenCalled();

      drain();
      await vi.advanceTimersByTimeAsync(0);
      expect(exit).toHaveBeenCalledExactlyOnceWith(75);
      warnSpy.mockRestore();
    });

    it('defaults to false — the SIGTERM/lag paths still close the substrate as before', async () => {
      const exit = vi.fn();
      const closeSubstrate = vi.fn(() => Promise.resolve());
      const { server, drain } = makeServer();

      gracefulHostRecycle({ server, exit, closeSubstrate }); // no skipSubstrateTeardown
      expect(closeSubstrate).toHaveBeenCalledTimes(1);

      drain();
      await vi.advanceTimersByTimeAsync(0);
      expect(exit).toHaveBeenCalledExactlyOnceWith(75);
    });
  });
});

describe('installGracefulShutdown (D4/P-017 — SIGTERM connection-drain)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function makeServer(): { server: RecycleServerLike; drain: () => void } {
    let cb: (() => void) | undefined;
    return { server: { close: (c?: () => void) => { cb = c; } }, drain: () => cb?.() };
  }
  /** A fake `process.on` that captures signal handlers so the test can fire them. */
  function fakeSignals() {
    const handlers = new Map<string, Array<() => void>>();
    const on = (sig: NodeJS.Signals, cb: () => void) => {
      const list = handlers.get(sig) ?? [];
      list.push(cb);
      handlers.set(sig, list);
    };
    const fire = (sig: NodeJS.Signals) => (handlers.get(sig) ?? []).forEach((h) => h());
    return { on, fire, handlers };
  }

  it('registers a handler for SIGTERM and SIGINT by default', () => {
    const { on, handlers } = fakeSignals();
    installGracefulShutdown({ server: makeServer().server, on, exit: vi.fn(), closeSubstrate: () => Promise.resolve() });
    expect([...handlers.keys()].sort()).toEqual(['SIGINT', 'SIGTERM']);
  });

  it('on SIGTERM: drains HTTP + substrate, then exits 0 (intentional stop, NOT the non-zero recycle code)', async () => {
    const exit = vi.fn();
    const closeSubstrate = vi.fn(() => Promise.resolve());
    const { server, drain } = makeServer();
    const { on, fire } = fakeSignals();

    installGracefulShutdown({ server, on, exit, closeSubstrate });
    expect(exit).not.toHaveBeenCalled(); // nothing happens until a signal arrives

    fire('SIGTERM');
    expect(closeSubstrate).toHaveBeenCalledTimes(1); // teardown started
    drain(); // in-flight HTTP finished
    await vi.advanceTimersByTimeAsync(0);
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it('is idempotent: a second signal while draining does not start a second drain', async () => {
    const exit = vi.fn();
    const closeSubstrate = vi.fn(() => Promise.resolve());
    const { server, drain } = makeServer();
    const { on, fire } = fakeSignals();

    installGracefulShutdown({ server, on, exit, closeSubstrate });
    fire('SIGTERM');
    fire('SIGINT'); // second signal mid-drain → ignored
    fire('SIGTERM');
    expect(closeSubstrate).toHaveBeenCalledTimes(1); // only the first drain ran
    drain();
    await vi.advanceTimersByTimeAsync(0);
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it('honors a custom signal list', () => {
    const { on, handlers } = fakeSignals();
    installGracefulShutdown({ server: makeServer().server, on, signals: ['SIGTERM'], exit: vi.fn(), closeSubstrate: () => Promise.resolve() });
    expect([...handlers.keys()]).toEqual(['SIGTERM']);
  });

  // WI-3795: installGracefulShutdown forwards isSaturated through to
  // gracefulHostRecycle so the SIGTERM path (the one a cluster-wide restart
  // actually broadcasts to every worker) gets the same saturated-skip.
  it('forwards isSaturated to gracefulHostRecycle — skips the substrate close on SIGTERM when saturated', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const exit = vi.fn();
    const closeSubstrate = vi.fn(() => Promise.resolve());
    const isSaturated = vi.fn(() => true);
    const { server, drain } = makeServer();
    const { on, fire } = fakeSignals();

    installGracefulShutdown({ server, on, exit, closeSubstrate, isSaturated });
    fire('SIGTERM');
    expect(closeSubstrate).not.toHaveBeenCalled();
    drain();
    await vi.advanceTimersByTimeAsync(0);
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
    warnSpy.mockRestore();
  });
});

// WI-3849: arms Node's diagnostic-report-on-SIGABRT so the next native
// Napi::Error/SIGABRT crash captures a symbolized stack automatically.
describe('installFatalDiagnostics (WI-3849 — diagnostic report on native SIGABRT)', () => {
  beforeEach(() => _resetFatalDiagnosticsForTests());
  afterEach(() => _resetFatalDiagnosticsForTests());

  function fakeReport() {
    return {} as { directory?: string; signal?: string; reportOnSignal?: boolean; reportOnFatalError?: boolean };
  }

  it('arms reportOnSignal for SIGABRT with reportOnFatalError, and writes a directory', () => {
    const report = fakeReport();
    const mkdir = vi.fn();
    const log = vi.fn();
    installFatalDiagnostics({ report, directory: '/tmp/fake-crash-reports', mkdir, log });

    expect(report.reportOnSignal).toBe(true);
    expect(report.signal).toBe('SIGABRT');
    expect(report.reportOnFatalError).toBe(true);
    expect(report.directory).toBe('/tmp/fake-crash-reports');
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('does NOT call mkdir when a report object is injected (test seam skips real fs)', () => {
    const report = fakeReport();
    const mkdir = vi.fn();
    installFatalDiagnostics({ report, directory: '/tmp/fake-crash-reports', mkdir });
    expect(mkdir).not.toHaveBeenCalled();
  });

  it('is idempotent — a second call is a no-op (does not re-touch the report or re-log)', () => {
    const report = fakeReport();
    const log = vi.fn();
    installFatalDiagnostics({ report, directory: '/tmp/a', mkdir: vi.fn(), log });
    report.signal = 'SIGUSR2'; // simulate something else mutating it after install
    installFatalDiagnostics({ report, directory: '/tmp/b', mkdir: vi.fn(), log });

    expect(log).toHaveBeenCalledTimes(1); // only the first call logged
    expect(report.directory).toBe('/tmp/a'); // second call's directory was never applied
    expect(report.signal).toBe('SIGUSR2'); // second call didn't overwrite it either
  });

  it('never throws when process.report is unavailable (best-effort on non-standard Node builds)', () => {
    expect(() => installFatalDiagnostics({ report: undefined })).not.toThrow();
  });

  it('never throws even if the report object itself throws on assignment', () => {
    const throwing = {
      set directory(_v: string) {
        throw new Error('boom');
      },
    } as unknown as { directory?: string; signal?: string; reportOnSignal?: boolean; reportOnFatalError?: boolean };
    expect(() => installFatalDiagnostics({ report: throwing, directory: '/tmp/x', mkdir: vi.fn() })).not.toThrow();
  });
});
