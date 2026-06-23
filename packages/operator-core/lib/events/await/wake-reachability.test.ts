import { describe, it, expect } from 'vitest';
import {
  deriveWakeReachability,
  probeWakeReachability,
  type WakeReachabilityInput,
} from './wake-reachability';

/** A reachable baseline: standing await present, exited+resumable (the common console-loop path). */
const BASE: WakeReachabilityInput = {
  wakeable: true,
  ended: true,
  pid: null,
  pidAlive: false,
  hasPsuHost: false,
  hasManagedPty: false,
  resumable: true,
  presenceFresh: false,
};

describe('deriveWakeReachability — channel ladder mirrors executeWake', () => {
  it('gate 1: no standing await ⇒ none + loud no-session-now warning (the WI-655 root cause)', () => {
    const v = deriveWakeReachability({ ...BASE, wakeable: false, hasPsuHost: true });
    expect(v.reachable).toBe(false);
    expect(v.channel).toBe('none');
    expect(v.warning).toMatch(/no inbox-wake watch is armed/i);
    expect(v.warning).toMatch(/no-session-now/i);
  });

  it('psu-host socket ⇒ reachable via psu-socket, durable while alive (best path, beats pid logic)', () => {
    const v = deriveWakeReachability({ ...BASE, ended: false, pid: 123, pidAlive: true, hasPsuHost: true, resumable: false });
    expect(v).toMatchObject({ reachable: true, channel: 'psu-socket', durableWhileAlive: true });
    expect(v.warning).toBeUndefined();
  });

  it('live managed pty ⇒ reachable via managed-pty, durable while alive', () => {
    const v = deriveWakeReachability({ ...BASE, ended: false, pid: 999, pidAlive: true, hasManagedPty: true, resumable: false });
    expect(v).toMatchObject({ reachable: true, channel: 'managed-pty', durableWhileAlive: true });
    expect(v.warning).toBeUndefined();
  });

  it('exited + resumable ⇒ reachable via resume, NOT durable while alive, no warning', () => {
    const v = deriveWakeReachability({ ...BASE, ended: true, resumable: true });
    expect(v).toMatchObject({ reachable: true, channel: 'resume', durableWhileAlive: false });
    expect(v.warning).toBeUndefined();
  });

  it('ALIVE + uninjectable + resumable ⇒ resume but DEGRADED (the dead-zone warning)', () => {
    // The exact shape of a resumed/curl-driven su session: alive, no psu-host, no managed pty,
    // resumable handle. Reachable in principle (resume after exit) but a persistent process parks.
    const v = deriveWakeReachability({
      ...BASE,
      ended: false,
      pid: 555,
      pidAlive: true,
      hasPsuHost: false,
      hasManagedPty: false,
      resumable: true,
      presenceFresh: true,
    });
    expect(v).toMatchObject({ reachable: true, channel: 'resume', durableWhileAlive: false });
    expect(v.warning).toMatch(/PARK as inbox-only until it exits/i);
  });

  it('alive + uninjectable + NOT resumable ⇒ inbox-only, NOT reachable, loud warning', () => {
    const v = deriveWakeReachability({
      ...BASE,
      ended: false,
      pid: 777,
      pidAlive: true,
      resumable: false,
      presenceFresh: true,
    });
    expect(v).toMatchObject({ reachable: false, channel: 'inbox-only' });
    expect(v.warning).toMatch(/NOT wake-reachable as a fresh turn/i);
  });

  it('exited + not resumable + presence fresh ⇒ inbox-only, not reachable', () => {
    const v = deriveWakeReachability({ ...BASE, ended: true, resumable: false, presenceFresh: true });
    expect(v).toMatchObject({ reachable: false, channel: 'inbox-only' });
  });

  it('dead: exited + not resumable + not present ⇒ none, not reachable', () => {
    const v = deriveWakeReachability({ ...BASE, ended: true, resumable: false, presenceFresh: false });
    expect(v).toMatchObject({ reachable: false, channel: 'none' });
    expect(v.warning).toMatch(/dead session/i);
  });

  it('no-pid + fresh presence (hook-bootstrapped) treated alive; uninjectable+unresumable ⇒ inbox-only', () => {
    const v = deriveWakeReachability({
      ...BASE,
      ended: false,
      pid: null,
      pidAlive: false,
      resumable: false,
      presenceFresh: true,
    });
    expect(v).toMatchObject({ reachable: false, channel: 'inbox-only' });
  });
});

describe('probeWakeReachability — IO seam wiring (injected deps, fail-soft)', () => {
  const liveHandle = {
    handle: {
      kind: 'adv-session' as const,
      advSessionId: 42,
      agent: 'claude',
      sessionId: 'uuid-1',
      ompThreadId: null,
      cwd: '/tmp/x',
      pid: 4242,
    },
    note: 'ok',
  };

  it('no standing await ⇒ none, regardless of a live resumable session', async () => {
    const v = await probeWakeReachability('su-x', {
      captureHandle: async () => liveHandle,
      getSession: async () => ({ endedAt: null, pid: 4242 }) as any,
      findPsuHost: () => null,
      findPty: () => null,
      presence: async () => ({ stale: false, revoked: false }) as any,
      listAwaits: async () => [], // ← no standing await
      alive: () => true,
    });
    expect(v.channel).toBe('none');
    expect(v.reachable).toBe(false);
  });

  it('live psu-host socket ⇒ psu-socket', async () => {
    const v = await probeWakeReachability('su-x', {
      captureHandle: async () => liveHandle,
      getSession: async () => ({ endedAt: null, pid: 4242 }) as any,
      findPsuHost: () => ({ sock: '/run/psu.sock' }) as any,
      findPty: () => null,
      presence: async () => ({ stale: false, revoked: false }) as any,
      listAwaits: async () => [{ id: 1 }] as any,
      alive: () => true,
    });
    expect(v).toMatchObject({ reachable: true, channel: 'psu-socket' });
  });

  it('exited claude session with native id ⇒ resume', async () => {
    const v = await probeWakeReachability('su-x', {
      captureHandle: async () => liveHandle,
      getSession: async () => ({ endedAt: '2026-06-23T00:00:00Z', pid: 4242 }) as any,
      findPsuHost: () => null,
      findPty: () => null,
      presence: async () => ({ stale: true, revoked: false }) as any,
      listAwaits: async () => [{ id: 1 }] as any,
      alive: () => false,
    });
    expect(v).toMatchObject({ reachable: true, channel: 'resume' });
  });

  it('fail-soft: a throwing dep degrades to a conservative signal, never throws', async () => {
    const v = await probeWakeReachability('su-x', {
      captureHandle: async () => {
        throw new Error('boom');
      },
      getSession: async () => {
        throw new Error('boom');
      },
      findPsuHost: () => {
        throw new Error('boom');
      },
      findPty: () => {
        throw new Error('boom');
      },
      presence: async () => {
        throw new Error('boom');
      },
      listAwaits: async () => {
        throw new Error('boom');
      },
      alive: () => false,
    });
    // Everything failed ⇒ no await, no handle, no presence ⇒ none (not reachable), but it RETURNED.
    expect(v.reachable).toBe(false);
    expect(v.channel).toBe('none');
  });
});
