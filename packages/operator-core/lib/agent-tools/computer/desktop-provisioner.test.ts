/**
 * desktop-provisioner.test.ts — pure-logic coverage: free-display selection
 * (never :0) and the host-display refusal. The live Xvfb path is exercised by
 * the end-to-end proof script, not here.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  assertDesktopPrerequisites,
  findFreeDisplayNumber,
  provisionSandboxDesktop,
  releaseDesktopResources,
  releaseDesktopProcesses,
} from './desktop-provisioner';

describe('findFreeDisplayNumber', () => {
  it('returns the lowest free number ≥ base (skips locked displays)', () => {
    const locked = new Set(['/tmp/.X110-lock', '/tmp/.X111-lock']);
    expect(findFreeDisplayNumber(110, 250, (p) => locked.has(p))).toBe(112);
  });

  it('never returns :0 even if base is 0', () => {
    expect(findFreeDisplayNumber(0, 250, () => false)).toBe(1);
  });

  it('throws when the whole range is taken', () => {
    expect(() => findFreeDisplayNumber(110, 112, () => true)).toThrow(/no free X display/);
  });
});

describe('provisionSandboxDesktop — safety', () => {
  it('refuses an explicit host display :0', async () => {
    await expect(provisionSandboxDesktop({ displayNumber: 0 })).rejects.toThrow(/host :0 \/ invalid|refusing/);
  });
  it('refuses a negative display number', async () => {
    await expect(provisionSandboxDesktop({ displayNumber: -5 })).rejects.toThrow(/refusing/);
  });
  it('names an absent X server before waiting for a display or starting children', async () => {
    await expect(provisionSandboxDesktop({
      displayNumber: 249,
      xServerBinaryPath: '/nonexistent/papercusp-test-X-server',
      readyTimeoutMs: 0,
    })).rejects.toThrow(/missing xvfb prerequisites: .*\/nonexistent\/papercusp-test-X-server/);
  });
});

describe('desktop prerequisites', () => {
  it('reports the absent stack on a headless host, including the readiness probe', () => {
    expect(() => assertDesktopPrerequisites({}, () => false))
      .toThrow(/missing xvfb prerequisites: Xvfb, xdpyinfo, openbox.*optional desktop pack provides KasmVNC/);
  });

  it('accepts a complete KasmVNC stack without requiring Xvfb', () => {
    const installed = new Set(['Xkasmvnc', 'xdpyinfo', 'openbox', 'kasmvncpasswd']);
    expect(() => assertDesktopPrerequisites({ xServer: 'kasmvnc' }, (binary) => installed.has(binary)))
      .not.toThrow();
  });

  it('requires credential tooling before trying to mint KasmVNC credentials', () => {
    expect(() => assertDesktopPrerequisites({ xServer: 'kasmvnc' }, (binary) => binary !== 'kasmvncpasswd'))
      .toThrow(/missing kasmvnc prerequisites: kasmvncpasswd/);
  });

  it('requires xsetroot only when a root colour is requested, and refuses a malformed colour', () => {
    const installed = new Set(['Xkasmvnc', 'xdpyinfo', 'openbox', 'kasmvncpasswd']);
    const has = (binary: string) => installed.has(binary);
    expect(() => assertDesktopPrerequisites({ xServer: 'kasmvnc' }, has)).not.toThrow();
    expect(() => assertDesktopPrerequisites({ xServer: 'kasmvnc', rootColor: '#4b5563' }, has))
      .toThrow(/missing kasmvnc prerequisites: xsetroot/);
    expect(() => assertDesktopPrerequisites({ xServer: 'kasmvnc', rootColor: 'grey; rm -rf /' }, () => true))
      .toThrow(/rootColor must be #rrggbb/);
  });

  it('honors a custom server, existing credentials, and a disabled window manager', () => {
    const installed = new Set(['/opt/kasm/Xkasmvnc', 'xdpyinfo']);
    expect(() => assertDesktopPrerequisites({
      xServer: 'kasmvnc', xServerBinaryPath: '/opt/kasm/Xkasmvnc',
      kasmvncPasswordFile: '/run/desktop/passwd', windowManager: false,
    }, (binary) => installed.has(binary))).not.toThrow();
  });
});

describe('releaseDesktopProcesses — managed teardown', () => {
  const root = {
    taskId: 'task-root',
    scopeUnit: 'pc-task-root.scope',
    confined: true,
    ledgered: true,
  };

  it('kills the managed task before touching systemd-run client handles', async () => {
    const events: string[] = [];
    const clients = [
      { kill: vi.fn((signal: NodeJS.Signals) => { events.push(`client-1:${signal}`); return true; }) },
      { kill: vi.fn((signal: NodeJS.Signals) => { events.push(`client-2:${signal}`); return true; }) },
    ];
    const killTask = vi.fn(async (_taskId: string, options: { includeSubtree?: boolean } = {}) => {
      events.push(`task:${options.includeSubtree === true ? 'subtree' : 'root'}`);
      return { ok: true as const, taskId: 'task-root', action: 'kill' };
    });
    const markManagedTeardown = vi.fn(() => {
      events.push('mark');
      return () => {};
    });

    await releaseDesktopProcesses(clients, root, { killTask, markManagedTeardown, sleep: async () => {} });

    expect(markManagedTeardown).toHaveBeenCalledTimes(2);
    expect(events[2]).toBe('task:subtree');
    expect(events).toEqual([
      'mark',
      'mark',
      'task:subtree',
      'client-2:SIGTERM',
      'client-1:SIGTERM',
      'client-1:SIGKILL',
      'client-2:SIGKILL',
    ]);
  });

  it('uses the validated scope handle when the ledger is unavailable', async () => {
    const events: string[] = [];
    const clients = [{ kill: vi.fn((signal: NodeJS.Signals) => { events.push(`client:${signal}`); return true; }) }];
    const killTask = vi.fn();
    const killScopeUnit = vi.fn(async (scopeUnit: string) => {
      events.push(`scope:${scopeUnit}`);
      return { ok: true as const, scopeUnit, action: 'kill' };
    });

    await releaseDesktopProcesses(clients, { ...root, ledgered: false }, { killTask, killScopeUnit, sleep: async () => {} });

    expect(killTask).not.toHaveBeenCalled();
    expect(events).toEqual(['scope:pc-task-root.scope', 'client:SIGTERM', 'client:SIGKILL']);
  });

  it('leaves client handles untouched when managed teardown is refused', async () => {
    const client = { kill: vi.fn(() => true) };
    const killTask = vi.fn(async () => ({
      ok: false as const,
      taskId: 'task-root',
      action: 'kill',
      error: 'command_failed' as const,
      detail: 'systemctl unavailable',
    }));
    const clearMarker = vi.fn();
    const markManagedTeardown = vi.fn(() => clearMarker);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      await releaseDesktopProcesses([client], root, { killTask, markManagedTeardown, sleep: async () => {} });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('leaving client handles untouched'));
      expect(markManagedTeardown).toHaveBeenCalledTimes(1);
      expect(clearMarker).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }

    expect(client.kill).not.toHaveBeenCalled();
  });

  // WI-1199802. A scope systemd has already collected is the state this function exists to
  // REACH, so it must not be reported as a refusal. Both consequences are asserted together
  // because the old behaviour got both wrong at once: it warned (which vitest-fail-on-console
  // then converted into red tests in suites that had actually passed), and it took the
  // refusal's early return, skipping the client-handle sweep entirely.
  it('treats an already-collected scope as success — no warning, and the client sweep still runs', async () => {
    const events: string[] = [];
    const client = {
      kill: vi.fn((signal: NodeJS.Signals) => { events.push(`client:${signal}`); return true; }),
    };
    const killScopeUnit = vi.fn(async (scopeUnit: string) => ({
      ok: false as const,
      scopeUnit,
      action: 'kill',
      error: 'already_gone' as const,
      detail: `scope ${scopeUnit} is no longer known to systemd — its transient scope was collected, so its process subtree is already gone`,
    }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      await releaseDesktopProcesses([client], { ...root, ledgered: false }, {
        killTask: vi.fn(),
        killScopeUnit,
        sleep: async () => {},
      });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }

    expect(events).toEqual(['client:SIGTERM', 'client:SIGKILL']);
  });

  // The CONTROL for the test above: a genuine refusal must keep BOTH of the old behaviours.
  // Without this, "stop warning on already_gone" could be over-applied to every !ok outcome
  // and nothing here would notice — the lookalike-cgroup refusal is security-relevant.
  it('still refuses loudly when the scope resolves to a foreign cgroup', async () => {
    const client = { kill: vi.fn(() => true) };
    const killScopeUnit = vi.fn(async (scopeUnit: string) => ({
      ok: false as const,
      scopeUnit,
      action: 'kill',
      error: 'no_target' as const,
      detail: `systemd returned no validated Papercusp cgroup for scope ${scopeUnit}`,
    }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      await releaseDesktopProcesses([client], { ...root, ledgered: false }, {
        killTask: vi.fn(),
        killScopeUnit,
        sleep: async () => {},
      });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('leaving client handles untouched'));
    } finally {
      warn.mockRestore();
    }

    expect(client.kill).not.toHaveBeenCalled();
  });
});

describe('releaseDesktopResources — owned accessibility teardown', () => {
  const root = {
    taskId: 'task-root',
    scopeUnit: 'pc-task-root.scope',
    confined: true,
    ledgered: true,
  };

  it('releases the a11y daemon even when managed desktop teardown is refused', async () => {
    const release = vi.fn();
    const client = { kill: vi.fn(() => true) };
    const killTask = vi.fn(async () => ({
      ok: false as const,
      taskId: 'task-root',
      action: 'kill',
      error: 'command_failed' as const,
      detail: 'systemctl unavailable',
    }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      await releaseDesktopResources([client], root, { release }, {
        killTask,
        markManagedTeardown: () => () => {},
        sleep: async () => {},
      });
    } finally {
      warn.mockRestore();
    }

    expect(release).toHaveBeenCalledOnce();
    expect(client.kill).not.toHaveBeenCalled();
  });
});
