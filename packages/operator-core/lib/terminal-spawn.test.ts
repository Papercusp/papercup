/**
 * Unit tests for the shared terminal-spawn helper — the shell-injection
 * guard (`shellEscape`) and terminal discovery (`findTerminal`: honour
 * $TERMINAL, fall back through the list in order, null when none found).
 * `node:fs` existsSync is mocked to simulate which binaries are on PATH.
 *
 * Plan: desktop-pui-launch-button-2026-06-05 (Brief 26).
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const existsSyncMock = vi.fn((_p: string): boolean => false);
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...actual, existsSync: (...a: unknown[]) => existsSyncMock(...(a as [string])) };
});

import { findTerminal, shellEscape } from './terminal-spawn';

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
