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

  it('spawns `npm test` in the wdio dir and resolves ran:true on a clean exit', async () => {
    const { io: fakeIo, child, spawnFn } = io();
    const p = runDesktopPerfScheduledRun(fakeIo);
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
    const p = runDesktopPerfScheduledRun(fakeIo);
    child.stdout.emit('data', Buffer.from('some suite output'));
    child.emit('close', 1);
    const r = await p;
    expect(r.ran).toBe(true);
    expect(r.exitCode).toBe(1);
    expect(r.timedOut).toBeUndefined();
  });

  it('resolves ran:false with a reason on a spawn error (never throws)', async () => {
    const { io: fakeIo, child } = io();
    const p = runDesktopPerfScheduledRun(fakeIo);
    child.emit('error', new Error('ENOENT: npm not found'));
    const r = await p;
    expect(r.ran).toBe(false);
    expect(r.skippedReason).toMatch(/spawn error/);
    expect(r.skippedReason).toMatch(/ENOENT/);
  });

  it('kills the child and resolves timedOut:true after the bound (fake timers)', async () => {
    vi.useFakeTimers();
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
    } finally {
      vi.useRealTimers();
    }
  });
});
