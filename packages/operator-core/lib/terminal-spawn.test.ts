/**
 * Unit tests for the shared terminal-spawn helper — the shell-injection
 * guard (`shellEscape`) and terminal discovery (`findTerminal`: honour
 * $TERMINAL, fall back through the list in order, null when none found).
 * `node:fs` existsSync is mocked to simulate which binaries are on PATH.
 *
 * Plan: desktop-pui-launch-button-2026-06-05 (Brief 26).
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const existsSyncMock = vi.fn((_p: string): boolean => false);
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...actual, existsSync: (...a: unknown[]) => existsSyncMock(...(a as [string])) };
});

const spawnMock = vi.fn((_bin: string, _args: string[], _opts: unknown) => ({
  pid: 55555,
  unref: vi.fn(),
}));
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return { ...actual, spawn: (...a: Parameters<typeof spawnMock>) => spawnMock(...a) };
});

import { findTerminal, isProcessAlive, shellEscape, spawnInTerminal } from './terminal-spawn';

describe('shellEscape', () => {
  it('wraps a plain string in single quotes', () => {
    expect(shellEscape('/home/x/.cargo/bin/pui')).toBe("'/home/x/.cargo/bin/pui'");
  });

  it('escapes an embedded single quote', () => {
    expect(shellEscape("a'b")).toBe("'a'\\''b'");
  });

  it('neutralises shell metacharacters as one literal token', () => {
    expect(shellEscape('x; rm -rf / $(whoami)')).toBe("'x; rm -rf / $(whoami)'");
  });
});

describe('findTerminal', () => {
  const ORIG_TERMINAL = process.env.TERMINAL;

  beforeEach(() => {
    existsSyncMock.mockReset();
    existsSyncMock.mockReturnValue(false);
    delete process.env.TERMINAL;
  });

  afterAll(() => {
    if (ORIG_TERMINAL === undefined) delete process.env.TERMINAL;
    else process.env.TERMINAL = ORIG_TERMINAL;
  });

  it('honours $TERMINAL when it is on PATH (generic -e args)', () => {
    process.env.TERMINAL = 'kitty';
    existsSyncMock.mockImplementation((p: string) => String(p).endsWith('/kitty'));
    expect(findTerminal()).toEqual({ bin: 'kitty', args: ['-e'] });
  });

  it('uses gnome-terminal special args when $TERMINAL=gnome-terminal', () => {
    process.env.TERMINAL = 'gnome-terminal';
    existsSyncMock.mockImplementation((p: string) => String(p).endsWith('/gnome-terminal'));
    expect(findTerminal()).toEqual({ bin: 'gnome-terminal', args: ['--wait', '--'] });
  });

  it('falls back to the first installed terminal in list order', () => {
    // No $TERMINAL; gnome-terminal absent, konsole present.
    existsSyncMock.mockImplementation((p: string) => String(p).endsWith('/konsole'));
    expect(findTerminal()).toEqual({ bin: 'konsole', args: ['--new-window', '-e'] });
  });

  it('returns null when no terminal emulator is found', () => {
    existsSyncMock.mockReturnValue(false);
    expect(findTerminal()).toBeNull();
  });
});

describe('isProcessAlive', () => {
  const killSpy = vi.spyOn(process, 'kill');

  afterEach(() => {
    killSpy.mockReset();
  });

  it('true when kill(pid, 0) does not throw', () => {
    killSpy.mockReturnValue(true as unknown as boolean);
    expect(isProcessAlive(123)).toBe(true);
    expect(killSpy).toHaveBeenCalledWith(123, 0);
  });

  it('false when kill(pid, 0) throws (dead / no-such-process)', () => {
    killSpy.mockImplementation(() => {
      throw new Error('ESRCH');
    });
    expect(isProcessAlive(123)).toBe(false);
  });
});

// EI-18696184925888288: the shell-write... err, silent-launch-failure guard.
// `spawnInTerminal` must not just check the OS spawn call didn't throw — it
// re-checks the child's liveness a short beat later, since a terminal client
// (gnome-terminal against a headless/offscreen display) can exit almost
// immediately even though no window ever actually opened.
describe('spawnInTerminal liveness check', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    spawnMock.mockClear();
    spawnMock.mockReturnValue({ pid: 55555, unref: vi.fn() });
    existsSyncMock.mockReturnValue(false);
    // Make gnome-terminal resolvable so findTerminal() succeeds.
    existsSyncMock.mockImplementation((p: string) => String(p).endsWith('/gnome-terminal'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('reports likelyOpened:true when the pid is still alive after the delay', async () => {
    vi.spyOn(process, 'kill').mockReturnValue(true as unknown as boolean);
    const resultPromise = spawnInTerminal({ oneliner: 'exec true', livenessCheckDelayMs: 400 });
    await vi.advanceTimersByTimeAsync(400);
    const result = await resultPromise;
    expect(result).toEqual({ ok: true, terminal: 'gnome-terminal', pid: 55555, likelyOpened: true });
  });

  it('reports likelyOpened:false when the process already exited by the time we check', async () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('ESRCH');
    });
    const resultPromise = spawnInTerminal({ oneliner: 'exec true', livenessCheckDelayMs: 400 });
    await vi.advanceTimersByTimeAsync(400);
    const result = await resultPromise;
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.likelyOpened).toBe(false);
  });

  it('livenessCheckDelayMs:0 skips the check entirely (likelyOpened:true, no wait)', async () => {
    const killSpy = vi.spyOn(process, 'kill');
    const result = await spawnInTerminal({ oneliner: 'exec true', livenessCheckDelayMs: 0 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.likelyOpened).toBe(true);
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('defaults to a 400ms check when livenessCheckDelayMs is omitted', async () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('ESRCH');
    });
    const resultPromise = spawnInTerminal({ oneliner: 'exec true' });
    await vi.advanceTimersByTimeAsync(400);
    const result = await resultPromise;
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.likelyOpened).toBe(false);
  });
});
