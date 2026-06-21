import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import {
  startMemoryWatchdog,
  resolveMemoryWatchdogLimitMb,
  MEMORY_WATCHDOG_LIMIT_MB_BACKGROUND,
  MEMORY_WATCHDOG_LIMIT_MB_REQUEST,
} from './memory-watchdog';

describe('startMemoryWatchdog', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function withRss(mb: number) {
    vi.spyOn(process, 'memoryUsage').mockReturnValue({
      rss: mb * 1024 * 1024,
      heapTotal: 0,
      heapUsed: 0,
      external: 0,
      arrayBuffers: 0,
    } as NodeJS.MemoryUsage);
  }

  it('recycles only after the high-water mark is held for tripsToRecycle samples', () => {
    withRss(4000); // over the 3200 default
    const onTrip = vi.fn();
    const log = vi.fn();
    const h = startMemoryWatchdog({ intervalMs: 1000, tripsToRecycle: 2, onTrip, log });

    vi.advanceTimersByTime(1000); // sample 1 — over, but debounce not met
    expect(onTrip).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000); // sample 2 — trips
    expect(onTrip).toHaveBeenCalledTimes(1);
    expect(onTrip.mock.calls[0][0]).toMatchObject({ rssLimitMb: 3200 });

    // Idempotent: no further trips after recycle latches.
    vi.advanceTimersByTime(3000);
    expect(onTrip).toHaveBeenCalledTimes(1);
    h.stop();
  });

  it('a transient spike that drops back under the limit does NOT recycle (debounce reset)', () => {
    const onTrip = vi.fn();
    const h = startMemoryWatchdog({ intervalMs: 1000, tripsToRecycle: 2, onTrip, log: vi.fn() });

    withRss(4000);
    vi.advanceTimersByTime(1000); // over (count=1)
    withRss(1000); // GC'd back down
    vi.advanceTimersByTime(1000); // under → reset
    withRss(4000);
    vi.advanceTimersByTime(1000); // over again (count=1, not 2)
    expect(onTrip).not.toHaveBeenCalled();
    h.stop();
  });

  it('stays silent and never trips well under the threshold', () => {
    withRss(800);
    const onTrip = vi.fn();
    const log = vi.fn();
    const h = startMemoryWatchdog({ intervalMs: 1000, warnMb: 2400, onTrip, log });
    vi.advanceTimersByTime(10_000);
    expect(onTrip).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled(); // below warn threshold → silent
    h.stop();
  });

  it('logs a soft-threshold gauge line above warnMb without recycling', () => {
    withRss(2600);
    const onTrip = vi.fn();
    const log = vi.fn();
    const h = startMemoryWatchdog({ intervalMs: 1000, warnMb: 2400, rssLimitMb: 3200, onTrip, log });
    vi.advanceTimersByTime(1000);
    expect(log).toHaveBeenCalled();
    expect(onTrip).not.toHaveBeenCalled();
    h.stop();
  });

  it('the DEFAULT recycle exits NON-ZERO (75) so systemd restarts under Restart=on-failure too (EI-1613, R4-1)', () => {
    withRss(4000);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    // no onTrip injected → exercise the default recycle path
    const h = startMemoryWatchdog({ intervalMs: 1000, tripsToRecycle: 1, log: vi.fn() });
    vi.advanceTimersByTime(1000); // trips → schedules the 250ms flush-then-exit
    vi.advanceTimersByTime(250); // fire the flush delay → process.exit(recycleExitCode)
    expect(exitSpy).toHaveBeenCalledWith(75);
    expect(exitSpy).not.toHaveBeenCalledWith(0);
    h.stop();
  });

  it('honors an explicit recycleExitCode in the default recycle', () => {
    withRss(4000);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const h = startMemoryWatchdog({ intervalMs: 1000, tripsToRecycle: 1, recycleExitCode: 42, log: vi.fn() });
    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(250);
    expect(exitSpy).toHaveBeenCalledWith(42);
    h.stop();
  });
});

describe('resolveMemoryWatchdogLimitMb (EI-1613 — role-aware RSS default)', () => {
  // Always pass an explicit env WITHOUT VITEST: backgroundWorkersEnabled reads
  // the PASSED env, and would short-circuit to false (request role) under VITEST.
  const bg = (over: Record<string, string> = {}) =>
    ({ PAPERCUSP_BACKGROUND_WORKERS: '1', ...over }) as unknown as NodeJS.ProcessEnv;
  const req = (over: Record<string, string> = {}) =>
    ({ PAPERCUSP_BACKGROUND_WORKERS: '0', ...over }) as unknown as NodeJS.ProcessEnv;

  it('the background primary (BG=1) defaults to 12288 — the substrate footprint, not the 3200 that froze bg-host', () => {
    expect(resolveMemoryWatchdogLimitMb(bg())).toBe(MEMORY_WATCHDOG_LIMIT_MB_BACKGROUND);
    expect(MEMORY_WATCHDOG_LIMIT_MB_BACKGROUND).toBe(12288);
  });

  it('a request-only worker (BG=0) keeps the lighter 3200 default', () => {
    expect(resolveMemoryWatchdogLimitMb(req())).toBe(MEMORY_WATCHDOG_LIMIT_MB_REQUEST);
    expect(MEMORY_WATCHDOG_LIMIT_MB_REQUEST).toBe(3200);
  });

  it('a default operator host (no BG flag, not :3170) is a background primary → 12288', () => {
    expect(resolveMemoryWatchdogLimitMb({} as unknown as NodeJS.ProcessEnv)).toBe(12288);
  });

  it('the :3170 staging operator is request-only by design → 3200', () => {
    expect(
      resolveMemoryWatchdogLimitMb({ PAPERCUSP_HONO_PORT: '3170' } as unknown as NodeJS.ProcessEnv),
    ).toBe(3200);
  });

  it('an explicit PAPERCUSP_MEMORY_WATCHDOG_LIMIT_MB always wins, in either role', () => {
    expect(resolveMemoryWatchdogLimitMb(bg({ PAPERCUSP_MEMORY_WATCHDOG_LIMIT_MB: '5000' }))).toBe(5000);
    expect(resolveMemoryWatchdogLimitMb(req({ PAPERCUSP_MEMORY_WATCHDOG_LIMIT_MB: '5000' }))).toBe(5000);
  });

  it('falls back to the role default for a non-positive / non-numeric explicit limit', () => {
    expect(resolveMemoryWatchdogLimitMb(bg({ PAPERCUSP_MEMORY_WATCHDOG_LIMIT_MB: '0' }))).toBe(12288);
    expect(resolveMemoryWatchdogLimitMb(bg({ PAPERCUSP_MEMORY_WATCHDOG_LIMIT_MB: '-1' }))).toBe(12288);
    expect(resolveMemoryWatchdogLimitMb(bg({ PAPERCUSP_MEMORY_WATCHDOG_LIMIT_MB: 'nonsense' }))).toBe(12288);
  });
});
