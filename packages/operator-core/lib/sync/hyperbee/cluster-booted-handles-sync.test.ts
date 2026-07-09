/**
 * cluster-booted-handles-sync.test.ts — EI-8816.
 *
 * The PUSH half of the fix: the primary broadcasts its listBootedHandles() snapshot;
 * a worker caches the latest one + reads it back synchronously. Deterministic via fake
 * timers (broadcaster) + direct `process.emit('message', …)` (cache — mirrors how
 * `cluster.fork()`'s real IPC delivers a message to a worker process).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => {
  const state: { booted: Array<{ workspaceId: string; harnessSlug: string }> } = { booted: [] };
  return { state, listBootedHandles: () => state.booted };
});
vi.mock('./boot-all', () => ({ listBootedHandles: H.listBootedHandles }));

import {
  BOOTED_HANDLES_SNAPSHOT_TYPE,
  startBootedHandlesBroadcaster,
  startWorkerBootedHandlesCache,
  getCachedRemoteBootedHandles,
  _setCachedRemoteBootedHandlesForTests,
} from './cluster-booted-handles-sync';

beforeEach(() => {
  H.state.booted = [];
  _setCachedRemoteBootedHandlesForTests(null);
});

describe('startBootedHandlesBroadcaster (PRIMARY side)', () => {
  it('broadcasts immediately, then every intervalMs, with the latest listBootedHandles() snapshot', () => {
    vi.useFakeTimers();
    try {
      const sent: unknown[] = [];
      H.state.booted = [{ workspaceId: 'ws1', harnessSlug: 'a' }];
      const h = startBootedHandlesBroadcaster({ intervalMs: 5_000, broadcast: (m) => sent.push(m) });
      expect(sent).toEqual([
        { type: BOOTED_HANDLES_SNAPSHOT_TYPE, handles: [{ workspaceId: 'ws1', harnessSlug: 'a' }], sentAt: expect.any(Number) },
      ]);
      H.state.booted = [{ workspaceId: 'ws1', harnessSlug: 'a' }, { workspaceId: 'ws1', harnessSlug: 'b' }];
      vi.advanceTimersByTime(5_000);
      expect(sent).toHaveLength(2);
      expect((sent[1] as { handles: unknown[] }).handles).toHaveLength(2); // picks up the LATEST snapshot, not a stale one
      h.stop();
      vi.advanceTimersByTime(20_000);
      expect(sent).toHaveLength(2); // stopped — no further broadcasts
    } finally {
      vi.useRealTimers();
    }
  });

  it('swallows a broadcast throw (a worker mid-exit) rather than crashing the timer', () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const h = startBootedHandlesBroadcaster({
        intervalMs: 1_000,
        broadcast: () => {
          calls += 1;
          throw new Error('channel closed');
        },
      });
      expect(() => vi.advanceTimersByTime(3_000)).not.toThrow();
      expect(calls).toBeGreaterThan(1);
      h.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

/** A fake worker-side IPC channel: lets the test push 'message' events directly, without
 *  touching the REAL `process` object (which vitest's own forked-worker pool ALSO uses
 *  for 'message' IPC — a synthetic `process.emit('message', …)` in-test collided with it
 *  and crashed the test-runner worker with EPIPE). Mirrors cluster-lag-watchdog.test.ts's
 *  injected-cluster convention. */
function fakeWorkerChannel() {
  let listener: ((message: unknown) => void) | undefined;
  return {
    on: (_event: 'message', cb: (message: unknown) => void) => {
      listener = cb;
    },
    off: (_event: 'message', cb: (message: unknown) => void) => {
      if (listener === cb) listener = undefined;
    },
    deliver: (message: unknown) => listener?.(message),
    hasListener: () => listener !== undefined,
  };
}

describe('startWorkerBootedHandlesCache + getCachedRemoteBootedHandles (WORKER side)', () => {
  it('caches the latest snapshot message + its receipt time', () => {
    const ch = fakeWorkerChannel();
    const cache = startWorkerBootedHandlesCache({ now: () => 1_000, on: ch.on, off: ch.off });
    expect(getCachedRemoteBootedHandles()).toBeNull();
    ch.deliver({
      type: BOOTED_HANDLES_SNAPSHOT_TYPE,
      handles: [{ workspaceId: 'ws1', harnessSlug: 'a' }],
      sentAt: 999,
    });
    expect(getCachedRemoteBootedHandles()).toEqual({
      handles: [{ workspaceId: 'ws1', harnessSlug: 'a' }],
      receivedAt: 1_000,
    });
    cache.stop();
  });

  it('ignores non-matching / malformed messages (cluster internals, other IPC types)', () => {
    const ch = fakeWorkerChannel();
    const cache = startWorkerBootedHandlesCache({ now: () => 1_000, on: ch.on, off: ch.off });
    ch.deliver({ type: 'something-else' });
    ch.deliver({ type: BOOTED_HANDLES_SNAPSHOT_TYPE }); // missing handles
    ch.deliver(null);
    expect(getCachedRemoteBootedHandles()).toBeNull();
    cache.stop();
  });

  it('a later snapshot overwrites an earlier cached one', () => {
    let now = 1_000;
    const ch = fakeWorkerChannel();
    const cache = startWorkerBootedHandlesCache({ now: () => now, on: ch.on, off: ch.off });
    ch.deliver({ type: BOOTED_HANDLES_SNAPSHOT_TYPE, handles: [{ workspaceId: 'ws1', harnessSlug: 'a' }] });
    now = 2_000;
    ch.deliver({ type: BOOTED_HANDLES_SNAPSHOT_TYPE, handles: [] });
    expect(getCachedRemoteBootedHandles()).toEqual({ handles: [], receivedAt: 2_000 });
    cache.stop();
  });

  it('stop() removes the listener (a post-stop message is no longer cached)', () => {
    const ch = fakeWorkerChannel();
    const cache = startWorkerBootedHandlesCache({ now: () => 1_000, on: ch.on, off: ch.off });
    cache.stop();
    expect(ch.hasListener()).toBe(false);
    ch.deliver({ type: BOOTED_HANDLES_SNAPSHOT_TYPE, handles: [{ workspaceId: 'ws1', harnessSlug: 'a' }] });
    expect(getCachedRemoteBootedHandles()).toBeNull();
  });

  it('defaults to real process.on/off when none injected (smoke: does not throw)', () => {
    const cache = startWorkerBootedHandlesCache();
    expect(() => cache.stop()).not.toThrow();
  });
});
