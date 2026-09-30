import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import {
  runDesktopPerfScheduledRun,
  type DesktopPerfScheduledRunIO,
} from './desktop-perf-scheduled-run';

/** A fake ChildProcess whose stdout/stderr/close/error we drive by hand. */
function fakeChild() {
  const ee = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
  ee.stdout = new EventEmitter();
  ee.stderr = new EventEmitter();
  (ee as unknown as { kill: (sig?: string) => void }).kill = vi.fn();
  return ee;
}

function io(
  overrides: Partial<DesktopPerfScheduledRunIO> & { buildExitCode?: number; autoCloseBuild?: boolean } = {},
): {
  io: DesktopPerfScheduledRunIO;
  buildChild: ReturnType<typeof fakeChild>;
  child: ReturnType<typeof fakeChild>;
  spawnFn: ReturnType<typeof vi.fn>;
} {
  const buildChild = fakeChild();
  const child = fakeChild();
  let spawnCount = 0;
  const spawnFn = vi.fn(() => {
    if (spawnCount++ === 0) {
      if (overrides.autoCloseBuild !== false) {
        queueMicrotask(() => buildChild.emit('close', overrides.buildExitCode ?? 0));
      }
      return buildChild as never;
    }
    return child as never;
  });
  return {
    io: {
      spawnFn: spawnFn as unknown as DesktopPerfScheduledRunIO['spawnFn'],
      readEnabled: overrides.readEnabled ?? (() => Promise.resolve(true)),
      // Default: the watermark ADVANCES, i.e. the run persisted a row. Tests
      // that care about the no-row guard override this explicitly.
      readNewestRunTs: overrides.readNewestRunTs ?? advancingWatermark(),
    },
    buildChild,
    child,
    spawnFn,
  };
}

/** A watermark that moves on every read — the healthy "a row landed" case. */
function advancingWatermark(): () => Promise<number | null> {
  let t = 1_000;
  return () => Promise.resolve((t += 1_000));
}

/** A watermark frozen in place — the run persisted NOTHING. */
function frozenWatermark(at: number | null = 1_000): () => Promise<number | null> {
  return () => Promise.resolve(at);
}

describe('runDesktopPerfScheduledRun', () => {
  it('skips entirely without spawning when the flag is off', async () => {
    const { io: fakeIo, spawnFn } = io({ readEnabled: () => Promise.resolve(false) });
    const r = await runDesktopPerfScheduledRun(fakeIo);
    expect(r.ran).toBe(false);
    expect(r.skippedReason).toMatch(/flag is off/);
    expect(spawnFn).not.toHaveBeenCalled();
  });

  // `runDesktopPerfScheduledRun` awaits `io.readEnabled()` before it calls
  // `io.spawnFn` and wires up the child's event listeners — even a
  // synchronously resolved promise still defers that wiring by one microtask
  // tick. Every test below that drives `child` must flush that tick first, or
  // the emitted event finds no listener yet: an 'error' emit with no listener
  // throws (Node's default), and a 'close'/'data' emit with no listener is
  // just silently dropped, which hangs the test until it times out.
  async function flushReadEnabledTick(): Promise<void> {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
  }

  it('spawns `npm run test:all` in the wdio dir and resolves ran:true on a clean exit', async () => {
    const { io: fakeIo, child, spawnFn } = io();
    const p = runDesktopPerfScheduledRun(fakeIo);
    await flushReadEnabledTick();
    child.emit('close', 0);
    const r = await p;
    expect(r.ran).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(typeof r.durationMs).toBe('number');
    // `test:all` is the script that boots the packaged binary; the package's plain `test`
    // is the headless runner-guard suite the gate runs (WI-10003821) and produces no measures.
    expect(spawnFn).toHaveBeenNthCalledWith(
      1,
      'npm',
      ['run', 'build'],
      expect.objectContaining({ cwd: expect.stringContaining('papercusp-desktop') }),
    );
    expect(spawnFn).toHaveBeenNthCalledWith(
      2,
      'npm',
      ['run', 'test:all'],
      expect.objectContaining({ cwd: expect.stringContaining('tools/perf-test/wdio') }),
    );
  });

  it('skips WDIO when the release build fails so an older package is never measured', async () => {
    const { io: fakeIo, child, spawnFn } = io({ buildExitCode: 23 });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const r = await runDesktopPerfScheduledRun(fakeIo);
      expect(r.ran).toBe(false);
      expect(r.skippedReason).toMatch(/release build exited 23/);
      expect(r.buildExitCode).toBe(23);
      expect(spawnFn).toHaveBeenCalledTimes(1);
      expect(child.listenerCount('close')).toBe(0);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('skipping WDIO'));
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('spawns a wdio script that really runs the WDIO suite, not just the unit guards', async () => {
    // Pins the spawned script to the package it names. Renaming `test:all`, or dropping
    // `test:wdio` from it, would leave this tick "succeeding" while measuring nothing.
    const { io: fakeIo, child, spawnFn } = io();
    const p = runDesktopPerfScheduledRun(fakeIo);
    await flushReadEnabledTick();
    child.emit('close', 0);
    await p;
    const args = spawnFn.mock.calls.at(-1)?.[1] as string[] | undefined;
    expect(args?.slice(0, 1)).toEqual(['run']);
    const script = args?.[1] ?? '';
    const pkg = JSON.parse(
      readFileSync(new URL('../../../../tools/perf-test/wdio/package.json', import.meta.url), 'utf8'),
    ) as { scripts: Record<string, string> };
    expect(pkg.scripts[script], `wdio has no "${script}" script`).toContain('npm run test:wdio');
  });

  it('still resolves ran:true on a NONZERO exit — a test-finding failure is not a tick failure', async () => {
    const { io: fakeIo, child } = io();
    // Expected: a nonzero exit logs a visibility-only warning (the module doc
    // is explicit this is NOT a tick failure) — assert on it rather than
    // leaving it unmocked.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const p = runDesktopPerfScheduledRun(fakeIo);
      await flushReadEnabledTick();
      child.stdout.emit('data', Buffer.from('some suite output'));
      child.emit('close', 1);
      const r = await p;
      expect(r.ran).toBe(true);
      expect(r.exitCode).toBe(1);
      expect(r.timedOut).toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('wdio exited 1'));
    } finally {
      warnSpy.mockRestore();
    }
  });

  // WI-38449. The tick used to assert "measures already posted via onComplete
  // regardless of exit code" without ever checking, and that claim was false for
  // 13 days across three independent causes (spec timeout, a 404'd publish, and
  // absent node_modules → exit 127). The watermark is what makes the claim
  // falsifiable, so these two tests are the guard's own falsifiability proof:
  // the first fires it, the second confirms a healthy run does NOT.
  it('reports producedRow:false and ERRORS when a completed run persisted no row', async () => {
    const { io: fakeIo, child } = io({ readNewestRunTs: frozenWatermark() });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const p = runDesktopPerfScheduledRun(fakeIo);
      await flushReadEnabledTick();
      // exit 127 is the real shape of the absent-node_modules case: the suite
      // "completes" in milliseconds having run nothing at all.
      child.emit('close', 127);
      const r = await p;
      expect(r.ran).toBe(true);
      expect(r.producedRow).toBe(false);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('RAN BUT PRODUCED NO ROW'));
    } finally {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it('reports producedRow:true and stays quiet when the run did persist a row', async () => {
    const { io: fakeIo, child } = io();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const p = runDesktopPerfScheduledRun(fakeIo);
      await flushReadEnabledTick();
      child.emit('close', 0);
      const r = await p;
      expect(r.producedRow).toBe(true);
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('leaves producedRow UNDEFINED when the watermark cannot be read — never true', async () => {
    // "Could not tell" must not read as success: that is the exact failure mode
    // this guard exists to end.
    const { io: fakeIo, child } = io({ readNewestRunTs: () => Promise.resolve(null) });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const p = runDesktopPerfScheduledRun(fakeIo);
      await flushReadEnabledTick();
      child.emit('close', 0);
      const r = await p;
      expect(r.producedRow).toBeUndefined();
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('resolves ran:false with a reason on a spawn error (never throws)', async () => {
    const { io: fakeIo, child } = io();
    // Expected: the spawn-error path deliberately logs the failure via
    // console.error before resolving — assert on it explicitly rather than
    // leaving it unmocked (vitest-fail-on-console fails an unmocked call).
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const p = runDesktopPerfScheduledRun(fakeIo);
      await flushReadEnabledTick();
      child.emit('error', new Error('ENOENT: npm not found'));
      const r = await p;
      expect(r.ran).toBe(false);
      expect(r.skippedReason).toMatch(/spawn error/);
      expect(r.skippedReason).toMatch(/ENOENT/);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('failed to spawn'));
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('kills the child and resolves timedOut:true after the bound (fake timers)', async () => {
    vi.useFakeTimers();
    // Expected: the timeout path deliberately logs a warning (with a log tail)
    // when it kills a hung child — that is the point of the log, not a defect.
    // vitest-fail-on-console treats any unmocked console.warn as a test failure,
    // so assert on it explicitly instead of leaving it unmocked.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { io: fakeIo, child } = io();
      const kill = vi.fn();
      (child as unknown as { kill: typeof kill }).kill = kill;
      const p = runDesktopPerfScheduledRun(fakeIo);
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 1);
      const r = await p;
      expect(r.ran).toBe(true);
      expect(r.timedOut).toBe(true);
      expect(kill).toHaveBeenCalledWith('SIGKILL');
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('timed out after'));
    } finally {
      vi.useRealTimers();
      warnSpy.mockRestore();
    }
  });

  it('kills a hung release build and never starts WDIO against the stale artifact', async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { io: fakeIo, buildChild, child, spawnFn } = io({ autoCloseBuild: false });
      const kill = vi.fn();
      (buildChild as unknown as { kill: typeof kill }).kill = kill;
      const p = runDesktopPerfScheduledRun(fakeIo);
      await flushReadEnabledTick();
      await vi.advanceTimersByTimeAsync(30 * 60 * 1000 + 1);
      const r = await p;
      expect(r.ran).toBe(false);
      expect(r.buildTimedOut).toBe(true);
      expect(kill).toHaveBeenCalledWith('SIGKILL');
      expect(spawnFn).toHaveBeenCalledTimes(1);
      expect(child.listenerCount('close')).toBe(0);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('release build timed out'));
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('skipping WDIO'));
    } finally {
      vi.useRealTimers();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});
