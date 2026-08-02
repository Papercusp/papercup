import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
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

function io(overrides: Partial<DesktopPerfScheduledRunIO> = {}): {
  io: DesktopPerfScheduledRunIO;
  child: ReturnType<typeof fakeChild>;
  spawnFn: ReturnType<typeof vi.fn>;
} {
  const child = fakeChild();
  const spawnFn = vi.fn(() => child as never);
  return {
    io: {
      spawnFn: spawnFn as unknown as DesktopPerfScheduledRunIO['spawnFn'],
      readEnabled: overrides.readEnabled ?? (() => Promise.resolve(true)),
    },
    child,
    spawnFn,
  };
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
    await Promise.resolve();
  }

  it('spawns `npm test` in the wdio dir and resolves ran:true on a clean exit', async () => {
    const { io: fakeIo, child, spawnFn } = io();
    const p = runDesktopPerfScheduledRun(fakeIo);
    await flushReadEnabledTick();
    child.emit('close', 0);
    const r = await p;
    expect(r.ran).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(typeof r.durationMs).toBe('number');
    expect(spawnFn).toHaveBeenCalledWith(
      'npm',
      ['test'],
      expect.objectContaining({ cwd: expect.stringContaining('tools/perf-test/wdio') }),
    );
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
});
