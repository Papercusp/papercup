import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import {
  startMemoryWatchdog,
  resolveMemoryWatchdogLimitMb,
  resolveMemoryWatchdogProactiveGcMb,
  MEMORY_WATCHDOG_LIMIT_MB_BACKGROUND,
  MEMORY_WATCHDOG_LIMIT_MB_DESKTOP,
  MEMORY_WATCHDOG_LIMIT_MB_REQUEST,
  MEMORY_WATCHDOG_LIMIT_MB_STAGING,
  MEMORY_WATCHDOG_PROACTIVE_GC_MB_BACKGROUND,
  MEMORY_WATCHDOG_PROACTIVE_GC_MB_DESKTOP,
  MEMORY_WATCHDOG_PROACTIVE_GC_MB_REQUEST,
  MEMORY_WATCHDOG_PROACTIVE_GC_MB_STAGING,
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

  it('recycles only after the high-water mark is held for tripsToRecycle samples (a process that GREW into the limit)', () => {
    withRss(800); // healthy first — a grow-into-limit process, not born over budget
    const onTrip = vi.fn();
    const log = vi.fn();
    const h = startMemoryWatchdog({ intervalMs: 1000, tripsToRecycle: 2, warnMb: 2400, onTrip, log });

    vi.advanceTimersByTime(1000); // sample 1 — healthy (marks sawHealthySample)
    withRss(4000); // over the 3200 default
    vi.advanceTimersByTime(1000); // sample 2 — over, but debounce not met
    expect(onTrip).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000); // sample 3 — over, debounce met → trips
    expect(onTrip).toHaveBeenCalledTimes(1);
    expect(onTrip.mock.calls[0][0]).toMatchObject({ rssLimitMb: 3200 });

    // Idempotent: no further trips after recycle latches.
    vi.advanceTimersByTime(3000);
    expect(onTrip).toHaveBeenCalledTimes(1);
    h.stop();
  });

  // EI-11522 — born-over-budget recycle guard: a process that boots straight into
  // an over-budget working set (the desktop sidecar warm-boots ~23 plugins to
  // ~3.1 GB immediately) must NOT SIGKILL-recycle in a loop — the fresh restart
  // boots into the same footprint, reclaims ~nothing, and severs in-flight
  // converse SSE turns each cycle. It escalates loudly and keeps serving instead.
  it('a process BORN over budget (over the limit from boot, never healthy) SUPPRESSES the recycle instead of hot-looping (EI-11522)', () => {
    withRss(3300); // over the 3200 limit from the very first sample
    const onTrip = vi.fn();
    const log = vi.fn();
    const h = startMemoryWatchdog({
      intervalMs: 1000,
      tripsToRecycle: 2,
      warnMb: 2400,
      rssLimitMb: 3200,
      onTrip,
      log,
    });

    vi.advanceTimersByTime(1000); // over (count=1)
    vi.advanceTimersByTime(1000); // over (count=2) — would trip, but born over budget
    vi.advanceTimersByTime(5000); // keep sampling — still no recycle
    expect(onTrip).not.toHaveBeenCalled();

    // Escalates loudly exactly once — not per-tick spam.
    const suppressLines = log.mock.calls.filter((c) =>
      String(c[0]).includes('SUPPRESSING the recycle'),
    );
    expect(suppressLines).toHaveLength(1);
    h.stop();
  });

  it('the DEFAULT (no onTrip) recycle is also suppressed — a born-over-budget process never exits (EI-11522)', () => {
    withRss(3300);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const h = startMemoryWatchdog({
      intervalMs: 1000,
      tripsToRecycle: 1,
      warnMb: 2400,
      rssLimitMb: 3200,
      log: vi.fn(),
    });
    vi.advanceTimersByTime(1000); // would trip → suppressed (never healthy)
    vi.advanceTimersByTime(250); // no flush-then-exit was ever scheduled
    expect(exitSpy).not.toHaveBeenCalled();
    h.stop();
  });

  it('the desktop :3270 tier gives its observed born RSS headroom, then recycles growth past the tier', () => {
    // The live desktop dev host measured ~10.6–11.6 GiB at boot. With the
    // dedicated 16 GiB tier, its default 12 GiB warn line sees healthy headroom
    // first, so the born-over-budget guard cannot permanently disarm recycling.
    withRss(10_600);
    const onTrip = vi.fn();
    const h = startMemoryWatchdog({
      intervalMs: 1000,
      tripsToRecycle: 1,
      rssLimitMb: MEMORY_WATCHDOG_LIMIT_MB_DESKTOP,
      proactiveGcMb: 0,
      onTrip,
      log: vi.fn(),
    });
    vi.advanceTimersByTime(1000); // 10.6 GiB < 12 GiB warn line → healthy sample
    withRss(17_000);
    vi.advanceTimersByTime(1000); // growth past 16 GiB → recycle
    expect(onTrip).toHaveBeenCalledTimes(1);
    expect(onTrip.mock.calls[0][0]).toMatchObject({ rssLimitMb: MEMORY_WATCHDOG_LIMIT_MB_DESKTOP });
    h.stop();
  });

  it('a born-over-budget process that later recovers below warn then climbs again DOES recycle (the guard releases) (EI-11522)', () => {
    withRss(3300); // born over budget
    const onTrip = vi.fn();
    const h = startMemoryWatchdog({
      intervalMs: 1000,
      tripsToRecycle: 1,
      warnMb: 2400,
      rssLimitMb: 3200,
      onTrip,
      log: vi.fn(),
    });
    vi.advanceTimersByTime(1000); // over → suppressed (never healthy yet)
    expect(onTrip).not.toHaveBeenCalled();
    withRss(800);
    vi.advanceTimersByTime(1000); // healthy → sawHealthySample=true, overCount reset
    withRss(4000);
    vi.advanceTimersByTime(1000); // over again — now it demonstrably had headroom → recycles
    expect(onTrip).toHaveBeenCalledTimes(1);
    h.stop();
  });

  it('suppressBornOverBudgetRecycle:false restores the always-recycle behavior for a born-over-budget process', () => {
    withRss(3300);
    const onTrip = vi.fn();
    const h = startMemoryWatchdog({
      intervalMs: 1000,
      tripsToRecycle: 1,
      warnMb: 2400,
      rssLimitMb: 3200,
      suppressBornOverBudgetRecycle: false,
      onTrip,
      log: vi.fn(),
    });
    vi.advanceTimersByTime(1000); // over → recycles (guard disabled)
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
    withRss(800); // healthy first — a grow-into-limit process (born-over-budget is suppressed)
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    // no onTrip injected → exercise the default recycle path
    const h = startMemoryWatchdog({ intervalMs: 1000, tripsToRecycle: 1, warnMb: 2400, log: vi.fn() });
    vi.advanceTimersByTime(1000); // sample 1 — healthy (marks sawHealthySample)
    withRss(4000);
    vi.advanceTimersByTime(1000); // trips → schedules the 250ms flush-then-exit
    vi.advanceTimersByTime(250); // fire the flush delay → process.exit(recycleExitCode)
    expect(exitSpy).toHaveBeenCalledWith(75);
    expect(exitSpy).not.toHaveBeenCalledWith(0);
    h.stop();
  });

  it('honors an explicit recycleExitCode in the default recycle', () => {
    withRss(800); // healthy first — a grow-into-limit process
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const h = startMemoryWatchdog({ intervalMs: 1000, tripsToRecycle: 1, warnMb: 2400, recycleExitCode: 42, log: vi.fn() });
    vi.advanceTimersByTime(1000); // sample 1 — healthy
    withRss(4000);
    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(250);
    expect(exitSpy).toHaveBeenCalledWith(42);
    h.stop();
  });

  it('runs proactive GC at its independent threshold while the recycle backstop remains higher', () => {
    withRss(2500);
    const forceGc = vi.fn();
    const onTrip = vi.fn();
    const log = vi.fn();
    const h = startMemoryWatchdog({
      intervalMs: 1000,
      rssLimitMb: 12288,
      proactiveGcMb: 1920,
      gcCooldownMs: 0,
      forceGc,
      onTrip,
      log,
    });

    vi.advanceTimersByTime(1000);
    expect(forceGc).toHaveBeenCalledTimes(1);
    expect(onTrip).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      '[memory-watchdog] proactive GC (heap kept out of the stall zone)',
      expect.objectContaining({ proactiveGcMb: 1920, rssLimitMb: 12288 }),
    );
    h.stop();
  });

  // WI-38221: RSS alone says HOW MUCH a worker holds and never WHAT, which is the
  // gap that left the :3070 ~2GB/worker growth un-diagnosable for weeks.
  function withMemory(rssMb: number, heapUsedMb: number) {
    return vi.spyOn(process, 'memoryUsage').mockReturnValue({
      rss: rssMb * 1024 * 1024,
      heapTotal: heapUsedMb * 1024 * 1024,
      heapUsed: heapUsedMb * 1024 * 1024,
      external: 0,
      arrayBuffers: 0,
    } as NodeJS.MemoryUsage);
  }

  it('the soft-threshold gauge carries the V8 heap decomposition, not just the RSS scalar', () => {
    withMemory(2500, 1800);
    const log = vi.fn();
    const h = startMemoryWatchdog({
      intervalMs: 1000,
      rssLimitMb: 12288,
      warnMb: 2400,
      proactiveGcMb: 0,
      log,
    });

    vi.advanceTimersByTime(1000);
    expect(log).toHaveBeenCalledWith(
      '[memory-watchdog] RSS above soft threshold',
      expect.objectContaining({
        rssMb: 2500,
        heapUsedMb: 1800,
        externalMb: expect.any(Number),
        arrayBuffersMb: expect.any(Number),
        // Sourced from real V8 in-process; assert shape, not a fixed value.
        detachedContexts: expect.any(Number),
        nativeContexts: expect.any(Number),
      }),
    );
    h.stop();
  });

  it('the proactive-GC line decomposes POST-GC SURVIVORS, not the pre-GC heap (the retention-vs-garbage distinction)', () => {
    // Pre-GC the process holds 2000 MB of heap; the forced GC collects most of it,
    // leaving 400 MB of genuinely-live survivors. The logged decomposition must
    // describe the SURVIVORS — that is the whole diagnostic value of the line, and
    // sampling it before forceGc() would silently report collectable garbage as
    // retained memory.
    const spy = withMemory(2500, 2000);
    const log = vi.fn();
    const forceGc = vi.fn(() => {
      spy.mockReturnValue({
        rss: 2100 * 1024 * 1024,
        heapTotal: 400 * 1024 * 1024,
        heapUsed: 400 * 1024 * 1024,
        external: 0,
        arrayBuffers: 0,
      } as NodeJS.MemoryUsage);
    });

    const h = startMemoryWatchdog({
      intervalMs: 1000,
      rssLimitMb: 12288,
      proactiveGcMb: 1920,
      gcCooldownMs: 0,
      forceGc,
      log,
    });

    vi.advanceTimersByTime(1000);
    const call = log.mock.calls.find((c) => String(c[0]).includes('proactive GC'));
    expect(call).toBeDefined();
    expect(call?.[1]).toMatchObject({ rssMbBefore: 2500, rssMbAfter: 2100, reclaimedMb: 400 });
    // The load-bearing assertion: 400 (survivors), never 2000 (pre-GC heap).
    expect((call?.[1] as { heapUsedMb: number }).heapUsedMb).toBe(400);
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

  it('the desktop dev operator (:3270, BG=0) gets the measured working-set tier', () => {
    expect(resolveMemoryWatchdogLimitMb(req({ PAPERCUSP_HONO_PORT: '3270' }))).toBe(MEMORY_WATCHDOG_LIMIT_MB_DESKTOP);
    expect(MEMORY_WATCHDOG_LIMIT_MB_DESKTOP).toBe(16384);
  });

  it('a default operator host (no BG flag, not :3170) is a background primary → 12288', () => {
    expect(resolveMemoryWatchdogLimitMb({} as unknown as NodeJS.ProcessEnv)).toBe(12288);
  });

  // EI-19484864948547581: :3170 is request-only (BG=0) but its real born
  // working set (~5.5 GB, measured) is far heavier than a plain request
  // worker's 3200 default — that mismatch let the born-over-budget guard
  // suppress the recycle on every boot (10 of 10 observed). :3170 gets its
  // own STAGING tier instead of inheriting REQUEST.
  it('the :3170 staging operator is request-only but heavier than a plain request worker → its own STAGING tier', () => {
    expect(
      resolveMemoryWatchdogLimitMb({ PAPERCUSP_HONO_PORT: '3170' } as unknown as NodeJS.ProcessEnv),
    ).toBe(MEMORY_WATCHDOG_LIMIT_MB_STAGING);
    expect(MEMORY_WATCHDOG_LIMIT_MB_STAGING).toBe(10240);
  });

  it(':3170 STAGING tier only applies when BG is not otherwise forced on', () => {
    // An explicit PAPERCUSP_BACKGROUND_WORKERS=1 on :3170 (unusual, but
    // possible) still wins the substrate-sized 12288 — BACKGROUND is checked
    // before the port-based STAGING fallback.
    expect(
      resolveMemoryWatchdogLimitMb(
        bg({ PAPERCUSP_HONO_PORT: '3170' }) as unknown as NodeJS.ProcessEnv,
      ),
    ).toBe(MEMORY_WATCHDOG_LIMIT_MB_BACKGROUND);
  });

  it('BACKGROUND wins over the desktop port tier when :3270 explicitly enables background workers', () => {
    expect(
      resolveMemoryWatchdogLimitMb(bg({ PAPERCUSP_HONO_PORT: '3270' }) as unknown as NodeJS.ProcessEnv),
    ).toBe(MEMORY_WATCHDOG_LIMIT_MB_BACKGROUND);
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

describe('resolveMemoryWatchdogProactiveGcMb (EI-20237116358190923)', () => {
  const bg = (over: Record<string, string> = {}) =>
    ({ PAPERCUSP_BACKGROUND_WORKERS: '1', ...over }) as unknown as NodeJS.ProcessEnv;
  const req = (over: Record<string, string> = {}) =>
    ({ PAPERCUSP_BACKGROUND_WORKERS: '0', ...over }) as unknown as NodeJS.ProcessEnv;

  it('keeps the background proactive-GC trigger at its role tier when the recycle backstop is raised', () => {
    expect(
      resolveMemoryWatchdogProactiveGcMb(bg({ PAPERCUSP_MEMORY_WATCHDOG_LIMIT_MB: '32768' })),
    ).toBe(MEMORY_WATCHDOG_PROACTIVE_GC_MB_BACKGROUND);
  });

  it('keeps request-worker proactive GC at its role tier when the recycle backstop is raised', () => {
    expect(
      resolveMemoryWatchdogProactiveGcMb(req({ PAPERCUSP_MEMORY_WATCHDOG_LIMIT_MB: '12288' })),
    ).toBe(MEMORY_WATCHDOG_PROACTIVE_GC_MB_REQUEST);
  });

  it('selects desktop and staging proactive-GC tiers by port', () => {
    expect(resolveMemoryWatchdogProactiveGcMb(req({ PAPERCUSP_HONO_PORT: '3270' }))).toBe(
      MEMORY_WATCHDOG_PROACTIVE_GC_MB_DESKTOP,
    );
    expect(resolveMemoryWatchdogProactiveGcMb(req({ PAPERCUSP_HONO_PORT: '3170' }))).toBe(
      MEMORY_WATCHDOG_PROACTIVE_GC_MB_STAGING,
    );
  });

  it('honors an explicit proactive-GC threshold override without coupling it to the recycle limit', () => {
    expect(
      resolveMemoryWatchdogProactiveGcMb(
        bg({ PAPERCUSP_MEMORY_WATCHDOG_LIMIT_MB: '32768', PAPERCUSP_MEMORY_PROACTIVE_GC_MB: '6000' }),
      ),
    ).toBe(6000);
  });

  it('falls back to the role tier for a non-positive or invalid proactive-GC override', () => {
    expect(resolveMemoryWatchdogProactiveGcMb(bg({ PAPERCUSP_MEMORY_PROACTIVE_GC_MB: '0' }))).toBe(
      MEMORY_WATCHDOG_PROACTIVE_GC_MB_BACKGROUND,
    );
    expect(resolveMemoryWatchdogProactiveGcMb(bg({ PAPERCUSP_MEMORY_PROACTIVE_GC_MB: 'nope' }))).toBe(
      MEMORY_WATCHDOG_PROACTIVE_GC_MB_BACKGROUND,
    );
  });
});
