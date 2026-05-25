import { describe, expect, it, vi } from 'vitest';
import { waitForHyperbeeBootstrap } from '../bootstrap-wait';
import type { BootstrapProgressSnapshot } from '../../sync/hyperbee/bootstrap-progress';

function snap(opts: Partial<BootstrapProgressSnapshot> = {}): BootstrapProgressSnapshot {
  return {
    workspaceId: 'ws',
    harnessSlug: 'h',
    mergedOps: 0,
    highestSeen: 0,
    lastChangeMs: 0,
    caughtUp: false,
    ...opts,
  };
}

describe('waitForHyperbeeBootstrap — validation', () => {
  it('rejects missing workspaceId', async () => {
    await expect(
      waitForHyperbeeBootstrap({
        workspaceId: '',
        harnessSlug: 'h',
        getProgress: () => null,
        sleep: async () => {},
      }),
    ).rejects.toThrow(/workspaceId/);
  });

  it('rejects missing harnessSlug', async () => {
    await expect(
      waitForHyperbeeBootstrap({
        workspaceId: 'w',
        harnessSlug: '',
        getProgress: () => null,
        sleep: async () => {},
      }),
    ).rejects.toThrow(/harnessSlug/);
  });
});

describe('waitForHyperbeeBootstrap — happy path', () => {
  it('returns caughtUp:true immediately when getProgress already reports caught up', async () => {
    const getProgress = vi.fn(() => snap({ caughtUp: true, highestSeen: 42 }));
    const sleep = vi.fn(async () => {});
    const r = await waitForHyperbeeBootstrap({
      workspaceId: 'w',
      harnessSlug: 'h',
      getProgress,
      sleep,
    });
    expect(r.caughtUp).toBe(true);
    expect(r.timedOut).toBe(false);
    expect(r.observed).toBe(42);
    expect(r.substrateInactive).toBe(false);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('polls until caughtUp flips true', async () => {
    let tick = 0;
    const getProgress = vi.fn(() => {
      tick++;
      return snap({ caughtUp: tick >= 3, highestSeen: tick * 5 });
    });
    const sleep = vi.fn(async () => {});
    const r = await waitForHyperbeeBootstrap({
      workspaceId: 'w',
      harnessSlug: 'h',
      pollMs: 1,
      getProgress,
      sleep,
    });
    expect(r.caughtUp).toBe(true);
    expect(r.observed).toBe(15);
    expect(getProgress).toHaveBeenCalledTimes(3);
  });

  it('reports highest observed mergedOps across the wait', async () => {
    let tick = 0;
    const getProgress = vi.fn(() => {
      tick++;
      // mergedOps oscillates; highestSeen only increases
      return snap({ caughtUp: tick >= 3, mergedOps: tick === 2 ? 1 : tick * 10, highestSeen: tick * 10 });
    });
    const r = await waitForHyperbeeBootstrap({
      workspaceId: 'w',
      harnessSlug: 'h',
      pollMs: 1,
      getProgress,
      sleep: async () => {},
    });
    expect(r.observed).toBe(30);
  });
});

describe('waitForHyperbeeBootstrap — timeout path', () => {
  it('returns timedOut:true once deadline passes', async () => {
    const fakeNow = (() => {
      let t = 1_000_000;
      return () => {
        const v = t;
        t += 30; // each call advances 30ms
        return v;
      };
    })();
    const getProgress = vi.fn(() => snap({ caughtUp: false, highestSeen: 1 }));
    const sleep = vi.fn(async () => {});
    const r = await waitForHyperbeeBootstrap({
      workspaceId: 'w',
      harnessSlug: 'h',
      timeoutMs: 100,
      pollMs: 25,
      getProgress,
      sleep,
      now: fakeNow,
    });
    expect(r.caughtUp).toBe(false);
    expect(r.timedOut).toBe(true);
    expect(r.observed).toBe(1);
    expect(r.substrateInactive).toBe(false);
  });
});

describe('waitForHyperbeeBootstrap — substrate inactive', () => {
  it('reports substrateInactive:true + timedOut:true when getProgress always returns null', async () => {
    const fakeNow = (() => {
      let t = 1_000_000;
      return () => {
        const v = t;
        t += 30;
        return v;
      };
    })();
    const getProgress = vi.fn(() => null);
    const r = await waitForHyperbeeBootstrap({
      workspaceId: 'w',
      harnessSlug: 'h',
      timeoutMs: 50,
      pollMs: 10,
      getProgress,
      sleep: async () => {},
      now: fakeNow,
    });
    expect(r.timedOut).toBe(true);
    expect(r.substrateInactive).toBe(true);
    expect(r.observed).toBe(0);
  });
});

describe('waitForHyperbeeBootstrap — onTick observer', () => {
  it('invokes onTick once per poll', async () => {
    let tick = 0;
    const getProgress = () => {
      tick++;
      return snap({ caughtUp: tick >= 4, highestSeen: tick });
    };
    const observed: Array<BootstrapProgressSnapshot | null> = [];
    await waitForHyperbeeBootstrap({
      workspaceId: 'w',
      harnessSlug: 'h',
      pollMs: 1,
      getProgress,
      sleep: async () => {},
      onTick: (s) => observed.push(s),
    });
    expect(observed.length).toBeGreaterThanOrEqual(4);
    expect(observed[observed.length - 1]?.caughtUp).toBe(true);
  });

  it('passes null to onTick when substrate has no snapshot yet', async () => {
    const fakeNow = (() => {
      let t = 1_000_000;
      return () => {
        const v = t;
        t += 30;
        return v;
      };
    })();
    const observed: Array<BootstrapProgressSnapshot | null> = [];
    await waitForHyperbeeBootstrap({
      workspaceId: 'w',
      harnessSlug: 'h',
      timeoutMs: 50,
      pollMs: 10,
      getProgress: () => null,
      sleep: async () => {},
      now: fakeNow,
      onTick: (s) => observed.push(s),
    });
    expect(observed.length).toBeGreaterThan(0);
    expect(observed[0]).toBeNull();
  });
});
