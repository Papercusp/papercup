import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { startMemoryWatchdog } from './memory-watchdog';

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
});
