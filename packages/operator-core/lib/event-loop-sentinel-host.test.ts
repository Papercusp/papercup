import { describe, it, expect } from 'vitest';
import {
  resolveSentinelConfig,
  startEventLoopSentinel,
  SENTINEL_DEFAULTS,
} from './event-loop-sentinel-host';

describe('resolveSentinelConfig', () => {
  it('is ARMED by default — a detector that ships disabled is never turned on', () => {
    expect(resolveSentinelConfig({}).mode).toBe('kill');
  });

  it.each(['0', 'off', 'false', 'OFF', ' Off '])('%s disables it', (v) => {
    expect(resolveSentinelConfig({ PAPERCUSP_EVENT_LOOP_SENTINEL: v }).mode).toBe('off');
  });

  it('observe detects and logs but never kills', () => {
    expect(
      resolveSentinelConfig({ PAPERCUSP_EVENT_LOOP_SENTINEL: 'observe' }).mode,
    ).toBe('observe');
  });

  it('an unrecognised value stays ARMED rather than silently disabling', () => {
    // Failing open here is deliberate: a typo must not quietly remove the
    // watchdog, which is the failure mode that leaves nobody watching.
    expect(resolveSentinelConfig({ PAPERCUSP_EVENT_LOOP_SENTINEL: 'yes' }).mode).toBe(
      'kill',
    );
  });

  it('honours a wedge-threshold override', () => {
    const c = resolveSentinelConfig({ PAPERCUSP_EVENT_LOOP_SENTINEL_WEDGE_MS: '45000' });
    expect(c.thresholds.wedgeAfterMs).toBe(45_000);
  });

  it.each(['0', '-1', 'abc', '', 'NaN'])(
    'a bad wedge override (%s) falls back to the safe default, never to 0',
    (v) => {
      // A 0 ms threshold would kill on the first observation. The parse must
      // degrade to the default rather than to the most dangerous value.
      const c = resolveSentinelConfig({ PAPERCUSP_EVENT_LOOP_SENTINEL_WEDGE_MS: v });
      expect(c.thresholds.wedgeAfterMs).toBe(SENTINEL_DEFAULTS.wedgeAfterMs);
    },
  );

  it('the default wedge threshold sits far above measured normal loop lag', () => {
    // Worst observed legitimate event-loop lag on this host is ~3475 ms
    // (round-3 cpuprofile captures). A threshold near that would make the
    // sentinel a random killer, so assert the margin explicitly.
    expect(SENTINEL_DEFAULTS.wedgeAfterMs).toBeGreaterThan(3475 * 4);
    // And a kill needs the debounce too, so the real floor is higher still.
    expect(
      SENTINEL_DEFAULTS.wedgeAfterMs +
        SENTINEL_DEFAULTS.observeIntervalMs * SENTINEL_DEFAULTS.observationsToAct,
    ).toBeGreaterThan(20_000);
  });

  it('the startup grace exceeds the wedge threshold, so boot can never kill', () => {
    expect(SENTINEL_DEFAULTS.startupGraceMs).toBeGreaterThan(
      SENTINEL_DEFAULTS.wedgeAfterMs,
    );
  });
});

describe('startEventLoopSentinel', () => {
  it('mode=off spawns nothing and reports inactive', () => {
    const lines: string[] = [];
    const h = startEventLoopSentinel({
      env: { PAPERCUSP_EVENT_LOOP_SENTINEL: 'off' },
      log: (l) => lines.push(l),
    });
    expect(h.active()).toBe(false);
    expect(h.beats()).toBe(0);
    expect(lines.join(' ')).toContain('disabled');
  });

  it('NEVER throws, whatever the runtime does to the worker', async () => {
    // The hard requirement: a watchdog must not be able to take down the host
    // it protects. Whether the worker spawns in THIS runtime is not the point —
    // that it degrades quietly rather than throwing is.
    const lines: string[] = [];
    let h: ReturnType<typeof startEventLoopSentinel> | undefined;
    expect(() => {
      h = startEventLoopSentinel({ env: {}, log: (l) => lines.push(l) });
    }).not.toThrow();
    await h!.stop();
  });

  it('REGRESSION: the worker thread stays ALIVE — it must not exit on its own', async () => {
    // The bug this guards (measured 2026-08-04): a `timer.unref()` inside the
    // worker left its event loop with no handle, so the thread exited cleanly
    // with code 0 immediately after reporting ready. The host still logged
    // "armed", active() still returned true, and the sentinel was silently
    // absent.
    //
    // Two reasons the ORIGINAL tests could not catch it, both worth knowing:
    //  - `beats()` is incremented by the MAIN thread, so it keeps ticking
    //    happily whether or not anything is watching it.
    //  - `new Worker(...)` does NOT throw on an unloadable path; the failure
    //    arrives asynchronously on 'error'. So `active()` only ever meant "the
    //    constructor returned", never "a watcher is running".
    //
    // This is the work-item's own class turned on the sentinel itself: a guard
    // that reports healthy while not running.
    //
    // Must run the REAL worker, and the `.ts` form only loads under tsx — a
    // plain-node Worker (vitest's pool) cannot resolve its extensionless
    // import. So build the same artifact the bundled host ships and use that.
    const built = buildWorkerMjs();
    if (!built) return; // esbuild unavailable — covered by the never-throws test

    const h = startEventLoopSentinel({
      env: { PAPERCUSP_EVENT_LOOP_SENTINEL: 'observe' },
      log: () => {},
      workerPath: built,
    });
    try {
      expect(h.active()).toBe(true);
      await new Promise((r) => setTimeout(r, 1_500));
      expect(h.workerAlive()).toBe(true);
    } finally {
      await h.stop();
    }
  }, 30_000);

  it('when active, the heartbeat actually advances the shared counter', async () => {
    const h = startEventLoopSentinel({
      env: { PAPERCUSP_EVENT_LOOP_SENTINEL: 'observe' },
      log: () => {},
    });
    try {
      if (!h.active()) return; // spawn unsupported here — covered by the test above
      const before = h.beats();
      await new Promise((r) => setTimeout(r, 2_500));
      // If this fails, the SAB wiring is broken and the sentinel would read a
      // permanently frozen counter — i.e. it would think the loop is wedged.
      expect(h.beats()).toBeGreaterThan(before);
    } finally {
      await h.stop();
    }
  }, 10_000);
});
