import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  resolveSentinelConfig,
  startEventLoopSentinel,
  SENTINEL_DEFAULTS,
} from './event-loop-sentinel-host';

/**
 * esbuild the real worker to a standalone `.mjs` — the SAME artifact
 * `bundle-host.sh` ships to the bundled host. Returns null (test skips) if the
 * local esbuild binary is absent, so this never fails for an environment
 * reason. ~20ms in practice.
 */
function buildWorkerMjs(footer?: string): string | null {
  const repoRoot = resolve(__dirname, '../../..');
  const esbuild = join(repoRoot, 'node_modules/.bin/esbuild');
  const src = resolve(__dirname, 'event-loop-sentinel.worker.ts');
  if (!existsSync(esbuild) || !existsSync(src)) return null;
  const out = join(mkdtempSync(join(tmpdir(), 'sentinel-worker-')), 'w.mjs');
  try {
    execFileSync(
      esbuild,
      [
        src,
        '--bundle',
        '--platform=node',
        '--format=esm',
        '--target=node22',
        `--outfile=${out}`,
        ...(footer ? [`--footer:js=${footer}`] : []),
      ],
      { stdio: 'pipe', timeout: 120_000, killSignal: 'SIGKILL' },
    );
  } catch {
    return null;
  }
  return existsSync(out) ? out : null;
}

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
  it('wires blocked-directory attribution into the real worker kill diagnostic', () => {
    // EI-22803283447097859: the worker knew the main thread was in
    // `iterate_dir`, but its last log did not name the directory and ptrace was
    // denied after the restart. Pin both halves of the detector: syscall arg0
    // must resolve through the live fd table, and the resulting path must be
    // included in the fields shared by STALLED and WEDGED emissions.
    const source = readFileSync(resolve(__dirname, 'event-loop-sentinel.worker.ts'), 'utf8');
    expect(source).toContain('parseProcDirectoryFd');
    expect(source).toContain('readlinkSync(`/proc/${pid}/fd/${fd}`)');
    expect(source).toContain('mainThreadBlockedDirectory');
    expect(source).toContain('Object.assign(out, readMainThreadDirectoryWait(wchan))');
  });

  it('mode=off spawns nothing and reports inactive', () => {
    const lines: string[] = [];
    const h = startEventLoopSentinel({
      env: { PAPERCUSP_EVENT_LOOP_SENTINEL: 'off' },
      log: (l) => lines.push(l),
    });
    expect(h.active()).toBe(false);
    expect(h.beats()).toBe(0);
    expect(h.sab).toBeNull();
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

  it('CONTROL: re-introducing the unref bug DOES trip the regression test above', async () => {
    // A guard that has never failed is a guard nobody has tested. Rebuild the
    // worker with the exact defect restored — `timer.unref()` at module scope,
    // injected via esbuild's --footer — and assert workerAlive() goes false.
    // Without this, the test above would still pass if workerAlive() were
    // hard-wired to true, or if the worker never spawned at all.
    //
    // The mutation is applied to a BUILT COPY in a temp dir, never to the tree:
    // git-sync sweeps the whole working tree every few minutes, so a source
    // file held mutated for the duration of a test can be committed by a sweep
    // that lands mid-run (CLAUDE.md, "Proving a guard is falsifiable").
    const mutant = buildWorkerMjs('timer.unref?.();');
    if (!mutant) return;

    const h = startEventLoopSentinel({
      env: { PAPERCUSP_EVENT_LOOP_SENTINEL: 'observe' },
      log: () => {},
      workerPath: mutant,
    });
    try {
      await new Promise((r) => setTimeout(r, 1_500));
      expect(h.workerAlive()).toBe(false);
    } finally {
      await h.stop();
    }
  }, 30_000);

  it('when active, the heartbeat actually advances the shared counter', async () => {
    const h = startEventLoopSentinel({
      env: { PAPERCUSP_EVENT_LOOP_SENTINEL: 'observe' },
      log: () => {},
      allowHeartbeatInTest: true,
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

  it('EI-19484853609145439: the SAB is sized for SENTINEL_SAB_IDX (heartbeat + last-known lag), not just the heartbeat', async () => {
    const h = startEventLoopSentinel({
      env: { PAPERCUSP_EVENT_LOOP_SENTINEL: 'observe' },
      log: () => {},
    });
    try {
      if (!h.active()) return; // spawn unsupported here — covered by the test above
      expect(h.sab).not.toBeNull();
      const { SENTINEL_SAB_INT32_LEN } = await import('./event-loop-sentinel');
      expect(h.sab!.byteLength).toBe(SENTINEL_SAB_INT32_LEN * Int32Array.BYTES_PER_ELEMENT);
      // Index 0 (the heartbeat) must still be the same live counter `beats()`
      // reads — extending the SAB must not shift the existing layout.
      const view = new Int32Array(h.sab!);
      expect(Atomics.load(view, 0)).toBe(h.beats());
    } finally {
      await h.stop();
    }
  }, 10_000);
});
