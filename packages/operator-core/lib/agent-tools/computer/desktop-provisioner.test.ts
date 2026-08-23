/**
 * desktop-provisioner.test.ts — pure-logic coverage: free-display selection
 * (never :0) and the host-display refusal. The live Xvfb path is exercised by
 * the end-to-end proof script, not here.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  findFreeDisplayNumber,
  provisionSandboxDesktop,
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
});
