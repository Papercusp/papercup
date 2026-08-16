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
      const h = startBootedHandlesBroadcaster({
        intervalMs: 5_000,
        ownsSubstrate: true,
        broadcast: (m) => sent.push(m),
      });
      expect(sent).toEqual([
        {
          type: BOOTED_HANDLES_SNAPSHOT_TYPE,
          handles: [{ workspaceId: 'ws1', harnessSlug: 'a' }],
          sentAt: expect.any(Number),
          ownsSubstrate: true,
          // EI-20575137548097507: the broadcast now carries the means to ASSESS
          // these handles, not just enumerate them. Asserted as a present array
          // (empty here — this fixture registers no liveness) rather than
          // omitted, because a receiver reads an ABSENT field as "health
          // unobservable" and an empty one as "measured, nothing stalled".
          replicationLiveness: [],
        },
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
        ownsSubstrate: true,
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

  /**
   * EI-18735338283879820 recurrence guard. A NON-OWNER process (e.g. the request-only
   * :3070 host under the dedicated bg-host topology) has an unconditionally empty
   * listBootedHandles(). If it broadcasts, the receiver caches a FRESH empty snapshot and
   * renders `reachedSubstrateOwner:true, bootedCount:0` — a confident false zero
   * indistinguishable from a genuinely dead substrate, which is what sent WI-4070 chasing
   * a phantom network fault for 15 days while bg-host had 51 harnesses booted.
   *
   * Silence is the correct behaviour: no snapshot ⇒ the cache stays null ⇒ the read side
   * reports an honest `reachedSubstrateOwner:false` blind spot.
   */
  it('does NOT broadcast at all when this process does not own the substrate', () => {
    vi.useFakeTimers();
    try {
      const sent: unknown[] = [];
      H.state.booted = []; // a non-owner's local map is ALWAYS empty — that's the trap
      const h = startBootedHandlesBroadcaster({
        intervalMs: 5_000,
        ownsSubstrate: false,
        broadcast: (m) => sent.push(m),
      });
      expect(sent).toEqual([]); // not even the immediate start-up beat
      vi.advanceTimersByTime(60_000);
      expect(sent).toEqual([]); // and never on any later beat
      h.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stamps ownsSubstrate:true so the receiver can verify provenance', () => {
    vi.useFakeTimers();
    try {
      const sent: Array<{ ownsSubstrate?: boolean }> = [];
      H.state.booted = [];
      const h = startBootedHandlesBroadcaster({
        intervalMs: 5_000,
        ownsSubstrate: true,
        broadcast: (m) => sent.push(m),
      });
      // An EMPTY snapshot from the real owner is legitimate data (an idle substrate) —
      // it must still be sent, and marked as owner-sourced.
      expect(sent).toHaveLength(1);
      expect(sent[0]?.ownsSubstrate).toBe(true);
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
      ownsSubstrate: true,
    });
    expect(getCachedRemoteBootedHandles()).toEqual({
      handles: [{ workspaceId: 'ws1', harnessSlug: 'a' }],
      receivedAt: 1_000,
    });
    cache.stop();
  });

  /**
   * EI-18735338283879820, belt-and-braces half. Even if some future call site forgets the
   * send-side gate, an unowned snapshot must never reach the cache — because a fresh
   * EMPTY one is precisely what fabricates `reachedSubstrateOwner:true, bootedCount:0`.
   * A missing `ownsSubstrate` (an older process mid-rolling-deploy) is untrusted for the
   * same reason: degrade to an honest blind spot, never to a confident false zero.
   */
  it('REJECTS a snapshot that does not affirmatively claim substrate ownership', () => {
    const ch = fakeWorkerChannel();
    const cache = startWorkerBootedHandlesCache({ now: () => 1_000, on: ch.on, off: ch.off });
    ch.deliver({ type: BOOTED_HANDLES_SNAPSHOT_TYPE, handles: [], ownsSubstrate: false });
    expect(getCachedRemoteBootedHandles()).toBeNull();
    ch.deliver({ type: BOOTED_HANDLES_SNAPSHOT_TYPE, handles: [] }); // legacy: field absent
    expect(getCachedRemoteBootedHandles()).toBeNull();
    // A non-empty payload from a non-owner is rejected too — provenance decides, not size.
    ch.deliver({
      type: BOOTED_HANDLES_SNAPSHOT_TYPE,
      handles: [{ workspaceId: 'ws1', harnessSlug: 'a' }],
      ownsSubstrate: false,
    });
    expect(getCachedRemoteBootedHandles()).toBeNull();
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
    ch.deliver({
      type: BOOTED_HANDLES_SNAPSHOT_TYPE,
      handles: [{ workspaceId: 'ws1', harnessSlug: 'a' }],
      ownsSubstrate: true,
    });
    now = 2_000;
    ch.deliver({ type: BOOTED_HANDLES_SNAPSHOT_TYPE, handles: [], ownsSubstrate: true });
    expect(getCachedRemoteBootedHandles()).toEqual({ handles: [], receivedAt: 2_000 });
    cache.stop();
  });

  it('stop() removes the listener (a post-stop message is no longer cached)', () => {
    const ch = fakeWorkerChannel();
    const cache = startWorkerBootedHandlesCache({ now: () => 1_000, on: ch.on, off: ch.off });
    cache.stop();
    expect(ch.hasListener()).toBe(false);
    ch.deliver({
      type: BOOTED_HANDLES_SNAPSHOT_TYPE,
      handles: [{ workspaceId: 'ws1', harnessSlug: 'a' }],
      ownsSubstrate: true,
    });
    expect(getCachedRemoteBootedHandles()).toBeNull();
  });

  it('defaults to real process.on/off when none injected (smoke: does not throw)', () => {
    const cache = startWorkerBootedHandlesCache();
    expect(() => cache.stop()).not.toThrow();
  });
});
