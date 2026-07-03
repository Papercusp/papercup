/**
 * WI-1886 (fleet-scheduler-hardening-2026-07-03 P-003): desktop terminals must
 * never ghost — `capability:terminal` / `fleet:launch-on-plan` used to report
 * `ok + pid` while every window died off-screen, because the operator ran
 * headless (systemd user service, no DISPLAY) and `spawn('gnome-terminal', …)`
 * succeeds at the fork/exec layer regardless (the 2026-07-03 backlog-clearance
 * launch lost all 10 member windows this way, silently).
 *
 * These tests pin the two pure halves of the fix:
 *   (a) resolveLinuxDesktopEnv — inject the interactive session's env when the
 *       operator lacks it; UNRESOLVED (→ callers fail loud, 412) when no X
 *       socket exists at all;
 *   (b) classifyEarlyExit — a client death inside the probe window is a
 *       failure (nonzero always; zero only under gnome-terminal --wait, whose
 *       client lives as long as the window).
 */
import { describe, expect, it } from 'vitest';
import {
  classifyEarlyExit,
  resolveLinuxDesktopEnv,
  type DesktopEnvProbes,
} from './console-spawn';

function probes(overrides: Partial<DesktopEnvProbes> = {}): DesktopEnvProbes {
  return {
    existsSync: () => false,
    readdirSync: () => [],
    uid: 1000,
    home: '/home/user',
    ...overrides,
  };
}

describe('resolveLinuxDesktopEnv (WI-1886a)', () => {
  it('operator already has DISPLAY ⇒ resolved, nothing injected for it', () => {
    const r = resolveLinuxDesktopEnv({ DISPLAY: ':0' }, probes());
    expect(r.resolved).toBe(true);
    expect(r.env.DISPLAY).toBeUndefined();
  });

  it('no DISPLAY + an X socket ⇒ injects DISPLAY from the lowest socket', () => {
    const r = resolveLinuxDesktopEnv(
      {},
      probes({ readdirSync: () => ['X1', 'X10'] }),
    );
    expect(r.resolved).toBe(true);
    expect(r.env.DISPLAY).toBe(':1');
  });

  it('no DISPLAY + NO X socket ⇒ UNRESOLVED with an actionable WI-1886 error', () => {
    const r = resolveLinuxDesktopEnv({}, probes());
    expect(r.resolved).toBe(false);
    expect(r.error).toMatch(/no X display/i);
    expect(r.error).toMatch(/WI-1886/);
  });

  it('a readdir throw (no /tmp/.X11-unix at all) is the same UNRESOLVED, not a crash', () => {
    const r = resolveLinuxDesktopEnv(
      {},
      probes({
        readdirSync: () => {
          throw new Error('ENOENT');
        },
      }),
    );
    expect(r.resolved).toBe(false);
  });

  it('injects DBUS/XDG_RUNTIME_DIR/XAUTHORITY when missing and their paths exist', () => {
    const existing = new Set([
      '/run/user/1000/bus',
      '/run/user/1000',
      '/run/user/1000/gdm/Xauthority',
    ]);
    const r = resolveLinuxDesktopEnv(
      {},
      probes({
        readdirSync: () => ['X1'],
        existsSync: (p) => existing.has(p),
      }),
    );
    expect(r.env).toEqual({
      DISPLAY: ':1',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
      XDG_RUNTIME_DIR: '/run/user/1000',
      XAUTHORITY: '/run/user/1000/gdm/Xauthority',
    });
  });

  it('falls back to ~/.Xauthority when the gdm one is absent', () => {
    const r = resolveLinuxDesktopEnv(
      { DISPLAY: ':0', DBUS_SESSION_BUS_ADDRESS: 'set', XDG_RUNTIME_DIR: '/run/user/1000' },
      probes({ existsSync: (p) => p === '/home/user/.Xauthority' }),
    );
    expect(r.env.XAUTHORITY).toBe('/home/user/.Xauthority');
  });

  it('never overrides env the operator already carries', () => {
    const r = resolveLinuxDesktopEnv(
      {
        DISPLAY: ':0',
        DBUS_SESSION_BUS_ADDRESS: 'unix:path=/custom',
        XDG_RUNTIME_DIR: '/custom',
        XAUTHORITY: '/custom/xauth',
      },
      probes({ existsSync: () => true, readdirSync: () => ['X1'] }),
    );
    expect(r.env).toEqual({});
  });
});

describe('classifyEarlyExit (WI-1886b)', () => {
  it('nonzero exit is ALWAYS a failure (the "Cannot open display" shape)', () => {
    expect(classifyEarlyExit(['--wait', '--'], 1, null).failed).toBe(true);
    expect(classifyEarlyExit(['-e'], 1, null).failed).toBe(true);
  });

  it('signal death is a failure', () => {
    const v = classifyEarlyExit(['-e'], null, 'SIGSEGV');
    expect(v.failed).toBe(true);
    expect(v.why).toContain('SIGSEGV');
  });

  it('instant zero exit under gnome-terminal --wait ⇒ failure (client lives as long as the window)', () => {
    const v = classifyEarlyExit(['--wait', '--window', '--'], 0, null);
    expect(v.failed).toBe(true);
    expect(v.why).toMatch(/--wait/);
  });

  it('instant zero exit WITHOUT --wait is NOT a failure (konsole reusing an app instance exits 0 fast)', () => {
    expect(classifyEarlyExit(['--new-window', '-e'], 0, null).failed).toBe(false);
  });
});
