import { describe, expect, it, vi } from 'vitest';
import {
  DESKTOP_DEV_PORT,
  DESKTOP_DEV_WRAPPER,
  parseProcessEnvironment,
  parseProcStat,
  resolveDesktopDevListener,
  restartDesktopDev,
} from './desktop-dev-restart';

const stat = (ppid: number, pgrp = 900, session = 900) => `900 (node) S ${ppid} ${pgrp} ${session} 0 0 0 0 0 0 0 0 0 0 0`;
const socketResult = (pid: number, ownerVisible = true) => ({
  sockets: [{
    port: DESKTOP_DEV_PORT,
    address: '127.0.0.1',
    family: 'ipv4' as const,
    pid: ownerVisible ? pid : null,
    pids: ownerVisible ? [pid] : [],
    listeners: 1,
    command: 'node',
    ownerVisible,
    reserved: false,
    acceptQueue: { pending: 0, backlog: 511 },
  }],
  matched: 1,
  totalListening: 1,
  truncated: false,
  ownerHidden: ownerVisible ? 0 : 1,
});

function makeDeps(overrides: Record<string, unknown> = {}) {
  const cmdlines: Record<number, string> = {
    101: '/usr/bin/node --import tsx bin/hono-host.ts',
    100: 'bash bin/dev-operator-ifneeded.sh',
    99: 'bash bin/desktop-dev-nohmr',
  };
  const stats: Record<number, string> = {
    101: stat(100, 900, 900),
    100: stat(99, 900, 900),
    99: stat(1, 900, 900),
  };
  const environ = [
    'PAPERCUSP_HONO_PORT=3270',
    'PAPERCUSP_PTY_WS_PORT=3274',
    'PAPERCUSP_BACKGROUND_WORKERS=0',
    'PAPERCUSP_CLUSTER=0',
    'PAPERCUSP_CLUSTER_WORKERS=0',
    'DBOS__VMID=desktop-dev-3270',
  ].join('\0');
  return {
    listSockets: vi.fn(async () => socketResult(101)),
    readCmdline: vi.fn(async (pid: number) => cmdlines[pid] ?? ''),
    readEnviron: vi.fn(async () => environ),
    readStat: vi.fn(async (pid: number) => stats[pid] ?? stat(1)),
    signal: vi.fn(),
    ...overrides,
  };
}

describe('desktop-dev restart identity guard', () => {
  it('parses proc stat and NUL-delimited environment without collapsing fields', () => {
    expect(parseProcStat(stat(100, 900, 901))).toMatchObject({ ppid: 100, processGroup: 900, session: 901 });
    expect(parseProcessEnvironment('A=1\0EMPTY=\0NO_EQUALS\0')).toEqual({ A: '1', EMPTY: '' });
  });

  it('accepts the canonical wrapper env without the SPA-only PAPERCUSP_DEV_API_TARGET marker', async () => {
    const deps = makeDeps();
    const result = await resolveDesktopDevListener(deps);
    expect(result).toMatchObject({ ok: true, pid: 101 });
    expect(result.listener?.parentChain.some((entry) => entry.cmdline.includes(DESKTOP_DEV_WRAPPER))).toBe(true);
    expect(result.listener?.env.PAPERCUSP_DEV_API_TARGET).toBeUndefined();
  });

  it('refuses a bound listener whose owner is hidden', async () => {
    const deps = makeDeps({ listSockets: vi.fn(async () => socketResult(101, false)) });
    await expect(resolveDesktopDevListener(deps)).resolves.toMatchObject({ ok: false, reason: 'desktop_dev_listener_owner_hidden' });
  });

  it('refuses a same-user process with the wrong identity markers', async () => {
    const deps = makeDeps({ readEnviron: vi.fn(async () => 'PAPERCUSP_HONO_PORT=3270\0DBOS__VMID=not-desktop\0') });
    await expect(resolveDesktopDevListener(deps)).resolves.toMatchObject({ ok: false, reason: 'desktop_dev_identity_mismatch', pid: 101 });
  });

  it('refuses a correctly shaped process that is not supervised by the desktop wrapper', async () => {
    const deps = makeDeps({ readCmdline: vi.fn(async (pid: number) => (pid === 100 ? 'bash unrelated-wrapper.sh' : '/usr/bin/node --import tsx bin/hono-host.ts')) });
    await expect(resolveDesktopDevListener(deps)).resolves.toMatchObject({ ok: false, reason: 'desktop_dev_supervisor_missing', pid: 101 });
  });

  it('revalidates the listener before SIGKILL and never signals an ancestor', async () => {
    const deps = makeDeps();
    const result = await restartDesktopDev(deps);
    expect(result).toMatchObject({ ok: true, pid: 101 });
    expect(deps.signal).toHaveBeenCalledTimes(1);
    expect(deps.signal).toHaveBeenCalledWith(101, 'SIGKILL');
    expect(deps.signal).not.toHaveBeenCalledWith(100, expect.anything());
    expect(deps.listSockets).toHaveBeenCalledTimes(2);
  });

  it('refuses to signal when the second identity lookup changes the pid', async () => {
    const deps = makeDeps({
      listSockets: vi
        .fn()
        .mockResolvedValueOnce(socketResult(101))
        .mockResolvedValueOnce(socketResult(202)),
    });
    const result = await restartDesktopDev(deps);
    expect(result).toMatchObject({ ok: false, reason: 'desktop_dev_listener_changed' });
    expect(deps.signal).not.toHaveBeenCalled();
  });
});
