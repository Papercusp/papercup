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
  it('operator already has a LIVE DISPLAY (socket exists) ⇒ resolved, nothing injected for it', () => {
    const r = resolveLinuxDesktopEnv(
      { DISPLAY: ':0' },
      probes({ existsSync: (p) => p === '/tmp/.X11-unix/X0' }),
    );
    expect(r.resolved).toBe(true);
    expect(r.env.DISPLAY).toBeUndefined();
    expect(r.warnings).toEqual([]);
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
      probes({
        existsSync: (p) => p === '/home/user/.Xauthority' || p === '/tmp/.X11-unix/X0',
      }),
    );
    expect(r.env.XAUTHORITY).toBe('/home/user/.Xauthority');
  });

  it('WI-2840: a set-but-STALE DISPLAY (socket gone) is healed by re-resolving, with a named warning', () => {
    const r = resolveLinuxDesktopEnv(
      { DISPLAY: ':0' },
      probes({ readdirSync: () => ['X1'], existsSync: () => false }),
    );
    expect(r.resolved).toBe(true);
    expect(r.env.DISPLAY).toBe(':1');
    // EI-8289: no activeSeatDisplays probe supplied ⇒ no real seat found ⇒ the
    // socket-scan fallback also carries its own disclosure warning now.
    expect(r.resolvedVia).toBe('socket-scan');
    expect(r.warnings).toEqual([
      expect.stringMatching(/stale DISPLAY=:0.*no X socket.*WI-2840\/EI-8289/),
      expect.stringMatching(/no active login seat detected.*socket scan.*EI-8289/),
    ]);
  });

  it('WI-2840: a stale DISPLAY with no live socket anywhere ⇒ UNRESOLVED, error names both the stale value and no-display', () => {
    const r = resolveLinuxDesktopEnv({ DISPLAY: ':0' }, probes());
    expect(r.resolved).toBe(false);
    expect(r.error).toMatch(/stale DISPLAY=:0/);
    expect(r.error).toMatch(/no X display/i);
    expect(r.warnings.length).toBe(1);
  });

  it('WI-2840: a set-but-STALE XAUTHORITY (file gone) is healed by re-resolving, with a named warning', () => {
    const r = resolveLinuxDesktopEnv(
      { DISPLAY: ':0', XAUTHORITY: '/stale/xauth' },
      probes({
        existsSync: (p) => p === '/tmp/.X11-unix/X0' || p === '/home/user/.Xauthority',
      }),
    );
    expect(r.env.XAUTHORITY).toBe('/home/user/.Xauthority');
    expect(r.warnings).toEqual([
      expect.stringMatching(/stale XAUTHORITY=\/stale\/xauth.*WI-2840/),
    ]);
  });

  it('EI-8289: a real seat DISPLAY with NO socket file (GNOME/XWayland) is trusted, not discarded as stale', () => {
    // Reproduces the 2026-07-06 incident exactly: operator process env carries
    // the owner's real DISPLAY=:1, but :1 has no /tmp/.X11-unix socket file
    // (XWayland `-nolisten local`) while a sandbox/frame Xvfb pool (:93, :115)
    // DOES have one. `who` still reports :1 as the logged-in seat.
    const r = resolveLinuxDesktopEnv(
      { DISPLAY: ':1' },
      probes({
        readdirSync: () => ['X93', 'X115'],
        existsSync: () => false, // no /tmp/.X11-unix/X1
        activeSeatDisplays: () => [':1'],
      }),
    );
    expect(r.resolved).toBe(true);
    expect(r.env.DISPLAY).toBeUndefined(); // trusted as-is, nothing injected
    expect(r.resolvedVia).toBe('operator-env');
    expect(r.warnings).toEqual([]);
  });

  it('EI-8289: no operator DISPLAY at all ⇒ prefers the real active seat (who) over a virtual/sandbox socket', () => {
    const r = resolveLinuxDesktopEnv(
      {},
      probes({
        readdirSync: () => ['X93', 'X115'], // a sandbox/frame Xvfb pool — NOT the real seat
        existsSync: () => false,
        activeSeatDisplays: () => [':1'],
      }),
    );
    expect(r.resolved).toBe(true);
    expect(r.env.DISPLAY).toBe(':1');
    expect(r.resolvedVia).toBe('active-seat');
    expect(r.warnings).toEqual([]);
  });

  it('EI-8289: a stale operator DISPLAY that is NOT the real seat still heals via active-seat (not socket-scan)', () => {
    const r = resolveLinuxDesktopEnv(
      { DISPLAY: ':0' }, // some other, genuinely dead value
      probes({
        readdirSync: () => ['X93'],
        existsSync: () => false,
        activeSeatDisplays: () => [':1'],
      }),
    );
    expect(r.resolved).toBe(true);
    expect(r.env.DISPLAY).toBe(':1');
    expect(r.resolvedVia).toBe('active-seat');
    // healed via the real seat, so no "falling back to a raw X11 socket scan" note —
    // only the original stale-DISPLAY warning.
    expect(r.warnings).toEqual([
      expect.stringMatching(/stale DISPLAY=:0.*not a currently logged-in seat.*WI-2840\/EI-8289/),
    ]);
  });

  it('EI-8289: no real seat detected at all ⇒ still falls back to the socket scan, with a disclosure warning', () => {
    const r = resolveLinuxDesktopEnv(
      {},
      probes({ readdirSync: () => ['X93'], existsSync: () => false, activeSeatDisplays: () => [] }),
    );
    expect(r.resolved).toBe(true);
    expect(r.env.DISPLAY).toBe(':93');
    expect(r.resolvedVia).toBe('socket-scan');
    expect(r.warnings).toEqual([
      expect.stringMatching(/no active login seat detected.*DISPLAY=:93.*virtual\/sandbox.*EI-8289/),
    ]);
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
