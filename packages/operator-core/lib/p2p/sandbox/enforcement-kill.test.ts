import { describe, expect, it } from 'vitest';
import { decideEnforcedKill, killForeignSessionProcess } from './enforcement-kill';

describe('decideEnforcedKill', () => {
  it('never kills a session that is not winding-down', () => {
    const d = decideEnforcedKill({ state: 'active', windDownStartedAt: null, now: 1000, graceMs: 100, cgroupPathExists: true });
    expect(d).toEqual({ shouldKill: false, reason: 'not_winding_down' });
  });

  it('never re-kills an already-terminal row (parked/reaped)', () => {
    for (const state of ['parked', 'reaped'] as const) {
      const d = decideEnforcedKill({ state, windDownStartedAt: 900, now: 1000, graceMs: 10, cgroupPathExists: true });
      expect(d.shouldKill).toBe(false);
    }
  });

  it('stays within grace', () => {
    const d = decideEnforcedKill({ state: 'winding-down', windDownStartedAt: 1000, now: 1050, graceMs: 100, cgroupPathExists: true });
    expect(d).toEqual({ shouldKill: false, reason: 'within_grace' });
  });

  it('kills once grace expires, preferring cgroup-freeze-kill when a cgroup exists', () => {
    const d = decideEnforcedKill({ state: 'winding-down', windDownStartedAt: 1000, now: 1200, graceMs: 100, cgroupPathExists: true });
    expect(d).toEqual({ shouldKill: true, reason: 'grace_expired', preferredMethod: 'cgroup-freeze-kill' });
  });

  it('falls back to sigkill-fallback when no cgroup exists', () => {
    const d = decideEnforcedKill({ state: 'winding-down', windDownStartedAt: 1000, now: 1200, graceMs: 100, cgroupPathExists: false });
    expect(d).toEqual({ shouldKill: true, reason: 'grace_expired', preferredMethod: 'sigkill-fallback' });
  });

  it('clock skew (negative age) never kills', () => {
    const d = decideEnforcedKill({ state: 'winding-down', windDownStartedAt: 2000, now: 1000, graceMs: 100, cgroupPathExists: true });
    expect(d.shouldKill).toBe(false);
  });
});

describe('killForeignSessionProcess', () => {
  it('sigkill-fallback signals the tracked pid directly', async () => {
    const signals: [number, string][] = [];
    const r = await killForeignSessionProcess(
      { pid: 4242, cgroupPath: null, method: 'sigkill-fallback' },
      { killSignal: (pid, sig) => signals.push([pid, sig]) },
    );
    expect(r).toEqual({ ok: true, method: 'sigkill-fallback' });
    expect(signals).toEqual([[4242, 'SIGKILL']]);
  });

  it('cgroup-freeze-kill freezes before signaling', async () => {
    const order: string[] = [];
    const r = await killForeignSessionProcess(
      { pid: 4242, cgroupPath: '/sys/fs/cgroup/p105/sess-1', method: 'cgroup-freeze-kill' },
      {
        freezeCgroup: async (p) => {
          order.push(`freeze:${p}`);
        },
        killSignal: (pid) => order.push(`kill:${pid}`),
      },
    );
    expect(r).toEqual({ ok: true, method: 'cgroup-freeze-kill' });
    expect(order).toEqual(['freeze:/sys/fs/cgroup/p105/sess-1', 'kill:4242']);
  });

  it('refuses cgroup-freeze-kill with no cgroupPath rather than silently sigkilling', async () => {
    const r = await killForeignSessionProcess({ pid: 1, cgroupPath: null, method: 'cgroup-freeze-kill' }, {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusal.code).toBe('kill-failed');
  });

  it('surfaces a signal-send exception as a typed refusal', async () => {
    const r = await killForeignSessionProcess(
      { pid: 1, cgroupPath: null, method: 'sigkill-fallback' },
      {
        killSignal: () => {
          throw new Error('ESRCH: no such process');
        },
      },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusal.detail).toMatch(/ESRCH/);
  });
});
