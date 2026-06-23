/**
 * cluster-lag-watchdog.test.ts — EI-1598/1608. The primary must SIGKILL a worker
 * that has stopped heart-beating (a synchronous wedge the worker-side recycler can't
 * catch), and must NOT kill a healthy beating worker or an as-yet-unseen one.
 *
 * The cluster + clock are injected, so this drives the absence logic deterministically
 * with no real fork/timers (same approach as cluster-fork.test.ts).
 */
import { describe, it, expect, vi } from 'vitest';
import {
  startClusterLagWatchdog,
  startWorkerHeartbeat,
  clusterLagWatchdogArmed,
  CLUSTER_HEARTBEAT_TYPE,
  type WatchdogClusterLike,
  type WatchdogWorkerRef,
} from './cluster-lag-watchdog';

/** A fake node:cluster primary: lets the test push 'message'/'exit' events + spy kills. */
function fakeCluster() {
  const handlers: { message?: (w: { id: number }, m: unknown) => void; exit?: (w: { id: number }, c: number, s: string | null) => void } = {};
  const kills: Array<{ id: number; signal?: string }> = [];
  const cluster: WatchdogClusterLike = {
    on(event: 'message' | 'exit', cb: never) {
      if (event === 'message') handlers.message = cb as never;
      else handlers.exit = cb as never;
    },
  };
  const workerById = (id: number): WatchdogWorkerRef => ({ id, kill: (signal) => kills.push({ id, signal }) });
  return {
    cluster,
    kills,
    beat: (id: number) => handlers.message?.({ id }, { type: CLUSTER_HEARTBEAT_TYPE }),
    otherMessage: (id: number) => handlers.message?.({ id }, { type: 'something-else' }),
    exit: (id: number) => handlers.exit?.({ id }, 0, 'SIGKILL'),
    workerById,
  };
}

describe('startClusterLagWatchdog (EI-1598/1608) — deterministic scan via fake timers', () => {
  it('kills only the silent worker; healthy + unseen workers survive', () => {
    vi.useFakeTimers();
    try {
      const f = fakeCluster();
      const wd = startClusterLagWatchdog({
        cluster: f.cluster,
        workerById: f.workerById,
        scanMs: 5_000,
        silenceMs: 30_000,
        now: () => Date.now(),
        log: () => {},
      });
      f.beat(1);
      f.beat(2);
      // Worker 2 keeps beating; worker 1 goes silent. Worker 3 is never seen.
      for (let i = 0; i < 8; i++) {
        vi.advanceTimersByTime(5_000); // 40s total
        f.beat(2); // 2 stays alive every 5s
      }
      expect(f.kills.map((k) => k.id)).toEqual([1]); // only the silent one
      expect(f.kills[0].signal).toBe('SIGKILL');
      expect(wd.watchedIds()).toEqual([2]); // 1 dropped on kill, 2 still tracked, 3 never registered
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops tracking a worker on exit (no kill after it is gone)', () => {
    vi.useFakeTimers();
    try {
      const f = fakeCluster();
      const wd = startClusterLagWatchdog({ cluster: f.cluster, workerById: f.workerById, scanMs: 5_000, silenceMs: 30_000, now: () => Date.now(), log: () => {} });
      f.beat(1);
      f.exit(1); // worker 1 exits (e.g. its own crash) before going silent
      vi.advanceTimersByTime(60_000);
      expect(f.kills).toEqual([]); // never killed — it was untracked on exit
      expect(wd.watchedIds()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores non-heartbeat IPC messages (cluster internals)', () => {
    vi.useFakeTimers();
    try {
      const f = fakeCluster();
      const wd = startClusterLagWatchdog({ cluster: f.cluster, workerById: f.workerById, scanMs: 5_000, silenceMs: 30_000, now: () => Date.now(), log: () => {} });
      f.otherMessage(1); // not a heartbeat → not registered → not watched
      vi.advanceTimersByTime(60_000);
      expect(f.kills).toEqual([]);
      expect(wd.watchedIds()).toEqual([]);
      wd.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stop() halts scanning (a now-silent worker is not killed after stop)', () => {
    vi.useFakeTimers();
    try {
      const f = fakeCluster();
      const wd = startClusterLagWatchdog({ cluster: f.cluster, workerById: f.workerById, scanMs: 5_000, silenceMs: 30_000, now: () => Date.now(), log: () => {} });
      f.beat(1);
      wd.stop();
      vi.advanceTimersByTime(60_000);
      expect(f.kills).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('startWorkerHeartbeat', () => {
  it('sends a heartbeat immediately and on each interval', () => {
    vi.useFakeTimers();
    try {
      const sent: unknown[] = [];
      const h = startWorkerHeartbeat({ beatMs: 2_000, send: (m) => sent.push(m) });
      expect(sent).toEqual([{ type: CLUSTER_HEARTBEAT_TYPE }]); // immediate announce
      vi.advanceTimersByTime(6_000);
      expect(sent.length).toBe(4); // 1 immediate + 3 intervals
      h.stop();
      vi.advanceTimersByTime(10_000);
      expect(sent.length).toBe(4); // stopped — no more beats
    } finally {
      vi.useRealTimers();
    }
  });

  it('is an inert no-op when no send channel exists (single-process / not a fork)', () => {
    const h = startWorkerHeartbeat({ send: undefined });
    expect(() => h.stop()).not.toThrow();
  });

  it('swallows a send throw (channel closed mid-beat)', () => {
    vi.useFakeTimers();
    try {
      const h = startWorkerHeartbeat({ beatMs: 1_000, send: () => { throw new Error('channel closed'); } });
      expect(() => vi.advanceTimersByTime(3_000)).not.toThrow();
      h.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('clusterLagWatchdogArmed', () => {
  it('is default-OFF and armed only by PAPERCUSP_CLUSTER_LAG_WATCHDOG=1', () => {
    expect(clusterLagWatchdogArmed({})).toBe(false);
    expect(clusterLagWatchdogArmed({ PAPERCUSP_CLUSTER_LAG_WATCHDOG: '0' })).toBe(false);
    expect(clusterLagWatchdogArmed({ PAPERCUSP_CLUSTER_LAG_WATCHDOG: '1' })).toBe(true);
  });
});
