/**
 * fleet:kill core tests (WI-3728) — the injectable core only (killOne /
 * findTabShellPid / closeTerminalPid): routing (nursery vs desktop), self-kill
 * refusal, kill ordering (window resolved BEFORE the host dies), close_terminal
 * on/off, and the orphaned-window marker gate. Production wiring (PG lookup,
 * audit INSERT) is exercised by the fleet:cancel/turn:interrupt suites it mirrors.
 */
import { describe, it, expect } from 'vitest';
import { killOne, findTabShellPid, closeTerminalPid, type ProcInfo, type KillDeps } from './kill';
import type { PsuPtyHost } from '../../events/await/psu-pty-discovery';
import { linuxProcessIdentityFromStat, linuxStartTicksFromProcStat } from '../../process-identity';

const MARKER_CMD = "bash -lc printf … && touch .papercup-console-active.$$ … (eval 'psu --no-picker --fleet=x')";

/** A tiny fake process tree: pid → { ppid, cmdline, env } . */
function makeProcTree(
  nodes: Record<
    number,
    {
      ppid: number;
      cmdline: string | null;
      env?: boolean;
      processIdentity?: string | null;
      consoleIdentity?: string | null;
    }
  >,
) {
  const alive = new Set(Object.keys(nodes).map(Number));
  const kills: Array<{ pid: number; signal: string }> = [];
  const readProc = (pid: number): ProcInfo | null => {
    const n = nodes[pid];
    if (!n || !alive.has(pid)) return null;
    const processIdentity = n.processIdentity === undefined ? `linux:test-boot:${pid}` : n.processIdentity;
    const consoleIdentity = n.consoleIdentity === undefined && n.env ? processIdentity : n.consoleIdentity;
    return {
      ppid: n.ppid,
      cmdline: n.cmdline,
      processIdentity,
      environmentValue: (name: string) => {
        if (name === 'PAPERCUSP_HARNESS_SLUG') return n.env ? 'test-harness' : null;
        return name === 'PAPERCUSP_CONSOLE_IDENTITY' ? (consoleIdentity ?? null) : null;
      },
    };
  };
  const kill = (pid: number, signal: NodeJS.Signals): boolean => {
    if (!alive.has(pid)) return false;
    kills.push({ pid, signal });
    if (signal === 'SIGTERM' || signal === 'SIGKILL' || signal === 'SIGHUP') alive.delete(pid);
    return true;
  };
  return { readProc, kill, alive: (pid: number) => alive.has(pid), kills, aliveSet: alive };
}

const host = (pid: number): PsuPtyHost => ({
  ownerId: 'su-target',
  advSessionId: null,
  pid,
  ptyPid: pid,
  sock: '/tmp/fake.sock',
  command: 'psu',
  startedAt: Date.now(),
});

const trackedHost = (pid: number, advSessionId: string): PsuPtyHost => ({
  ...host(pid),
  advSessionId,
});

const noSleep = (_ms: number) => Promise.resolve();

describe('findTabShellPid', () => {
  it('walks up to the TOPMOST marker-carrying ancestor (the tab shell)', () => {
    const t = makeProcTree({
      100: { ppid: 1, cmdline: 'gnome-terminal-server' },
      200: { ppid: 100, cmdline: MARKER_CMD }, // tab shell (topmost marked)
      201: { ppid: 200, cmdline: MARKER_CMD }, // eval subshell (same cmdline)
      300: { ppid: 201, cmdline: 'node psu-launcher.mjs' },
    });
    expect(findTabShellPid(300, t.readProc)).toBe(200);
  });

  it('returns null when no ancestor carries the console marker (user-launched psu — nothing to close)', () => {
    const t = makeProcTree({
      100: { ppid: 1, cmdline: 'bash -l' },
      300: { ppid: 100, cmdline: 'node psu-launcher.mjs' },
    });
    expect(findTabShellPid(300, t.readProc)).toBeNull();
  });
});

describe('killOne', () => {
  it('refuses self-kill', async () => {
    const r = await killOne({ actor: 'su-me', target: 'su-me', closeTerminal: true, reason: 'x' }, {});
    expect(r.ok).toBe(false);
    expect(r.code).toBe('self_kill_refused');
  });

  it('routes a nursery target to the cancel machinery; terminal is none', async () => {
    let cancelled: string | null = null;
    const deps: KillDeps = {
      cancelNursery: async (target) => {
        cancelled = target;
        return { spawn_id: 'sp-1', cancelled: ['sp-1', 'sp-2'], processes_aborted: 1 };
      },
      findHost: () => {
        throw new Error('must not reach the desktop leg for a nursery target');
      },
    };
    const r = await killOne({ actor: 'su-me', target: 'sp-1', closeTerminal: true, reason: 'x' }, deps);
    expect(cancelled).toBe('sp-1');
    expect(r.ok).toBe(true);
    expect(r.kind).toBe('nursery');
    expect(r.terminal).toBe('none');
    expect(r.cancelled).toEqual(['sp-1', 'sp-2']);
  });

  it('desktop: resolves the window BEFORE killing, SIGTERMs the host, closes the tab shell', async () => {
    const t = makeProcTree({
      100: { ppid: 1, cmdline: 'gnome-terminal-server' },
      200: { ppid: 100, cmdline: MARKER_CMD },
      300: { ppid: 200, cmdline: 'node psu-launcher.mjs' },
    });
    const deps: KillDeps = {
      cancelNursery: async () => null,
      findHost: () => host(300),
      readProc: t.readProc,
      kill: t.kill,
      alive: t.alive,
      sleep: noSleep,
    };
    const r = await killOne({ actor: 'su-me', target: 'su-target', closeTerminal: true, reason: 'wind-down' }, deps);
    expect(r.ok).toBe(true);
    expect(r.kind).toBe('desktop');
    expect(r.signal).toBe('SIGTERM');
    expect(r.terminal).toBe('closed');
    // Ordering: the host dies first (SIGTERM to 300), then the tab shell (SIGHUP to 200).
    const idxHost = t.kills.findIndex((k) => k.pid === 300 && k.signal === 'SIGTERM');
    const idxShell = t.kills.findIndex((k) => k.pid === 200 && k.signal === 'SIGHUP');
    expect(idxHost).toBeGreaterThanOrEqual(0);
    expect(idxShell).toBeGreaterThan(idxHost);
  });

  it('desktop close_terminal:false leaves the window open', async () => {
    const t = makeProcTree({
      100: { ppid: 1, cmdline: 'gnome-terminal-server' },
      200: { ppid: 100, cmdline: MARKER_CMD },
      300: { ppid: 200, cmdline: 'node psu-launcher.mjs' },
    });
    const deps: KillDeps = {
      cancelNursery: async () => null,
      findHost: () => host(300),
      readProc: t.readProc,
      kill: t.kill,
      alive: t.alive,
      sleep: noSleep,
    };
    const r = await killOne({ actor: 'su-me', target: 'su-target', closeTerminal: false, reason: 'x' }, deps);
    expect(r.ok).toBe(true);
    expect(r.terminal).toBe('left-open');
    expect(t.kills.some((k) => k.pid === 200)).toBe(false); // shell untouched
    expect(t.aliveSet.has(200)).toBe(true);
  });

  it('desktop: stamps the tracked adv_session after confirming the host died', async () => {
    const t = makeProcTree({
      300: { ppid: 1, cmdline: 'node psu-launcher.mjs' },
    });
    const ended: Array<{ id: string; signal: string }> = [];
    const deps: KillDeps = {
      cancelNursery: async () => null,
      findHost: () => trackedHost(300, '15153'),
      readProc: t.readProc,
      kill: t.kill,
      alive: t.alive,
      sleep: noSleep,
      markSessionEnded: async (id, signal) => {
        ended.push({ id, signal });
      },
    };

    const r = await killOne({ actor: 'su-me', target: 'su-target', closeTerminal: false, reason: 'stop' }, deps);

    expect(r.ok).toBe(true);
    expect(ended).toEqual([{ id: '15153', signal: 'SIGTERM' }]);
  });

  it('escalates to SIGKILL when the host survives SIGTERM', async () => {
    const stubborn = new Set([300]);
    const kills: Array<{ pid: number; signal: string }> = [];
    const deps: KillDeps = {
      cancelNursery: async () => null,
      findHost: () => host(300),
      readProc: () => null, // no ancestry → terminal not-found
      kill: (pid, signal) => {
        kills.push({ pid, signal });
        if (signal === 'SIGKILL') stubborn.delete(pid);
        return true; // SIGTERM "delivered" but the process ignores it
      },
      alive: (pid) => stubborn.has(pid),
      sleep: noSleep,
    };
    const r = await killOne({ actor: 'su-me', target: 'su-target', closeTerminal: true, reason: 'x' }, deps);
    expect(r.ok).toBe(true);
    expect(r.signal).toBe('SIGKILL');
    expect(r.terminal).toBe('not-found');
    expect(kills.filter((k) => k.pid === 300).map((k) => k.signal)).toEqual(
      expect.arrayContaining(['SIGTERM', 'SIGKILL']),
    );
  });

  it('reports not_found for a target with no nursery row and no live host', async () => {
    let cleared: string | null = null;
    let released: string[] = [];
    const deps: KillDeps = {
      cancelNursery: async () => null,
      findHost: () => null,
      clearPresence: async (ownerId) => {
        cleared = ownerId;
      },
      releaseSeatConsumptions: async (ownerIds) => {
        released = ownerIds;
      },
    };
    const r = await killOne({ actor: 'su-me', target: 'su-ghost', closeTerminal: true, reason: 'x' }, deps);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('not_found');
    expect(r.error).toContain('terminal_pids'); // the stale-window hint
    expect(cleared).toBe('su-ghost');
    expect(released).toEqual(['su-ghost']);
  });

  it('reports live_unmanaged for a fresh OMP-hook presence without clearing it', async () => {
    let cleared = false;
    let released = false;
    const audits: Array<{ action: string; subject: string }> = [];
    const deps: KillDeps = {
      cancelNursery: async () => null,
      findHost: () => null,
      findLiveUnmanaged: async () => ({
        source: 'omp-hook-session',
        heartbeatAt: '2026-08-12T08:10:00.000Z',
      }),
      clearPresence: async () => {
        cleared = true;
      },
      releaseSeatConsumptions: async () => {
        released = true;
      },
      audit: async (action, subject) => {
        audits.push({ action, subject });
      },
    };

    const r = await killOne({ actor: 'su-me', target: 'su-omp', closeTerminal: true, reason: 'wind-down' }, deps);

    expect(r).toMatchObject({
      ok: false,
      target: 'su-omp',
      kind: 'unmanaged',
      killed: false,
      code: 'live_unmanaged',
      terminal: 'not-found',
    });
    expect(r.error).toContain('turn:interrupt');
    expect(cleared).toBe(false);
    expect(released).toBe(false);
    expect(audits).toEqual([{ action: 'fleet.kill_unmanaged', subject: 'su-omp' }]);
  });
});

describe('closeTerminalPid (orphaned windows)', () => {
  it('refuses a pid without the papercusp console marker', async () => {
    const t = makeProcTree({ 500: { ppid: 1, cmdline: 'bash -l', env: false } });
    const r = await closeTerminalPid(500, { readProc: t.readProc, kill: t.kill, alive: t.alive, sleep: noSleep });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('refused');
    expect(t.aliveSet.has(500)).toBe(true);
  });

  it('closes a marked tab shell only when its launch identity matches its current birth identity', async () => {
    // After `exec $SHELL -l` the cmdline marker is GONE — only the env marker survives.
    const t = makeProcTree({ 500: { ppid: 1, cmdline: 'bash -l', env: true } });
    const r = await closeTerminalPid(500, { readProc: t.readProc, kill: t.kill, alive: t.alive, sleep: noSleep });
    expect(r.ok).toBe(true);
    expect(r.closed).toBe(true);
    expect(t.kills[0]).toEqual({ pid: 500, signal: 'SIGHUP' });
  });

  it('refuses a legacy env-only marker with no birth identity', async () => {
    const t = makeProcTree({
      500: { ppid: 1, cmdline: 'bash -l', env: true, consoleIdentity: null },
    });
    const r = await closeTerminalPid(500, { readProc: t.readProc, kill: t.kill, alive: t.alive, sleep: noSleep });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('birth identity');
    expect(t.kills).toEqual([]);
  });

  it('refuses a recycled pid whose recorded and current birth identities differ', async () => {
    const t = makeProcTree({
      500: {
        ppid: 1,
        cmdline: 'bash -l',
        env: true,
        processIdentity: 'linux:test-boot:999',
        consoleIdentity: 'linux:test-boot:500',
      },
    });
    const r = await closeTerminalPid(500, { readProc: t.readProc, kill: t.kill, alive: t.alive, sleep: noSleep });
    expect(r.ok).toBe(false);
    expect(t.kills).toEqual([]);
  });

  it('refuses protected session processes even if markers are spoofed', async () => {
    const t = makeProcTree({ 500: { ppid: 1, cmdline: '/usr/lib/systemd/systemd --user', env: true } });
    const r = await closeTerminalPid(500, { readProc: t.readProc, kill: t.kill, alive: t.alive, sleep: noSleep });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('protected');
    expect(t.kills).toEqual([]);
  });

  it('reports pid not found for a dead pid', async () => {
    const t = makeProcTree({});
    const r = await closeTerminalPid(999, { readProc: t.readProc, kill: t.kill, alive: t.alive, sleep: noSleep });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('pid not found');
  });
});

describe('kernel process identity parsing', () => {
  it('reads Linux starttime field 22 after a comm containing spaces and parens', () => {
    const stat = '42 (odd process) name) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 987654 20';
    expect(linuxStartTicksFromProcStat(stat)).toBe('987654');
    expect(linuxProcessIdentityFromStat('boot-abc\n', stat)).toBe('linux:boot-abc:987654');
  });
});
