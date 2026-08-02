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

import {
  findTerminal,
  isProcessAlive,
  scrubTerminalContextEnv,
  shellEscape,
  spawnInTerminal,
  TERMINAL_CONTEXT_ENV_KEYS,
} from './terminal-spawn';

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

// EI-19385011811175105: the operator sidecar is started from a gnome-terminal
// tab, so it carries that tab's GNOME_TERMINAL_SCREEN. Inheriting it made
// gnome-terminal ask the factory for a screen that no longer exists, print
// "Failed to get screen from object path …" and EXIT 0 with no window — which the
// HUD then reported to the owner as "its terminal closed before the session came
// online. Try launching it again", advice that could never work.
describe('scrubTerminalContextEnv', () => {
  it('drops the gnome-terminal tab identity that broke the HUD launch', () => {
    const out = scrubTerminalContextEnv({
      PATH: '/usr/bin',
      GNOME_TERMINAL_SCREEN: '/org/gnome/Terminal/screen/f7136bff_f487_4330_8ff5_966041ee694a',
      GNOME_TERMINAL_SERVICE: ':1.123',
    });
    expect(out.GNOME_TERMINAL_SCREEN).toBeUndefined();
    expect(out.GNOME_TERMINAL_SERVICE).toBeUndefined();
    expect(out.PATH).toBe('/usr/bin');
  });

  it('drops every key in the list and keeps everything else', () => {
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin', DISPLAY: ':1', HOME: '/home/x' };
    for (const k of TERMINAL_CONTEXT_ENV_KEYS) env[k] = 'stale';
    const out = scrubTerminalContextEnv(env);
    for (const k of TERMINAL_CONTEXT_ENV_KEYS) expect(out[k]).toBeUndefined();
    expect(out).toEqual({ PATH: '/usr/bin', DISPLAY: ':1', HOME: '/home/x' });
  });

  it('does not mutate the caller’s env', () => {
    const env = { GNOME_TERMINAL_SCREEN: 'x' };
    scrubTerminalContextEnv(env);
    expect(env.GNOME_TERMINAL_SCREEN).toBe('x');
  });

  it('keeps the vars a spawned session actually needs', () => {
    // Guards against over-broad scrubbing: DISPLAY/DBUS/XDG are what make the
    // window openable at all, and PAPERCUSP_* is the launch's own identity.
    for (const k of ['DISPLAY', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR', 'XAUTHORITY', 'TERM', 'PATH', 'HOME']) {
      expect(TERMINAL_CONTEXT_ENV_KEYS).not.toContain(k);
    }
  });
});

describe('isProcessAlive', () => {
  const killSpy = vi.spyOn(process, 'kill');

  afterEach(() => {
    killSpy.mockReset();
  });

  it('true when kill(pid, 0) does not throw', () => {
    killSpy.mockReturnValue(true);
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
    vi.spyOn(process, 'kill').mockReturnValue(true);
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

  // The fix itself: whatever the caller hands us, the child must not receive the
  // terminal identity of the tab the OPERATOR was started in.
  it('scrubs inherited terminal-context vars from the spawned env', async () => {
    vi.spyOn(process, 'kill').mockReturnValue(true);
    const p = spawnInTerminal({
      oneliner: 'exec true',
      livenessCheckDelayMs: 0,
      env: {
        PATH: '/usr/bin',
        DISPLAY: ':1',
        GNOME_TERMINAL_SCREEN: '/org/gnome/Terminal/screen/dead',
        GNOME_TERMINAL_SERVICE: ':1.123',
        TMUX: '/tmp/tmux-1000/default,1,0',
      },
    });
    await p;
    const env = (spawnMock.mock.calls[0]?.[2] as { env: NodeJS.ProcessEnv }).env;
    expect(env.GNOME_TERMINAL_SCREEN).toBeUndefined();
    expect(env.GNOME_TERMINAL_SERVICE).toBeUndefined();
    expect(env.TMUX).toBeUndefined();
    expect(env.DISPLAY).toBe(':1');
    expect(env.PATH).toBe('/usr/bin');
  });

  // Exit code 0 is what a silent gnome-terminal failure looks like, so stderr is
  // the only evidence there is — capture it and hand it back so the caller can
  // say WHY instead of "the terminal closed".
  it('returns the emulator’s stderr when it died without opening a window', async () => {
    const listeners: Record<string, Array<(d: unknown) => void>> = {};
    const stderr = {
      on: (ev: string, fn: (d: unknown) => void) => {
        (listeners[ev] ??= []).push(fn);
      },
      removeAllListeners: vi.fn(),
      resume: vi.fn(),
      destroy: vi.fn(),
      unref: vi.fn(),
    };
    spawnMock.mockReturnValue({ pid: 55555, unref: vi.fn(), stderr } as never);
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('ESRCH');
    });
    const resultPromise = spawnInTerminal({ oneliner: 'exec true', livenessCheckDelayMs: 400 });
    for (const fn of listeners.data ?? []) {
      fn('# Error creating terminal: Failed to get screen from object path /org/gnome/Terminal/screen/dead\n');
    }
    await vi.advanceTimersByTimeAsync(400);
    const result = await resultPromise;
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.likelyOpened).toBe(false);
      expect(result.stderr).toContain('Failed to get screen from object path');
    }
    // Dead child ⇒ safe to close the pipe.
    expect(stderr.destroy).toHaveBeenCalled();
  });

  it('never destroys a LIVE child’s stderr (EPIPE would kill the new window)', async () => {
    const stderr = {
      on: vi.fn(),
      removeAllListeners: vi.fn(),
      resume: vi.fn(),
      destroy: vi.fn(),
      unref: vi.fn(),
    };
    spawnMock.mockReturnValue({ pid: 55555, unref: vi.fn(), stderr } as never);
    vi.spyOn(process, 'kill').mockReturnValue(true);
    const resultPromise = spawnInTerminal({ oneliner: 'exec true', livenessCheckDelayMs: 400 });
    await vi.advanceTimersByTimeAsync(400);
    const result = await resultPromise;
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.stderr).toBeUndefined();
    expect(stderr.destroy).not.toHaveBeenCalled();
    expect(stderr.resume).toHaveBeenCalled();
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
