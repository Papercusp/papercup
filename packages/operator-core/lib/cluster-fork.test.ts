/**
 * cluster-fork.test.ts — P3-2.
 *
 * The fork/respawn/drain engine with node:cluster injected — pins the role split
 * (primary forks + runs background; worker serves; single runs both inline), the
 * bounded crash-respawn (no fork-bomb), and that drain stops respawns + kills the
 * fleet.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  startCluster,
  type ClusterLike,
  type ClusterWorkerLike,
} from './cluster-fork';

class MockWorker implements ClusterWorkerLike {
  killed: string | undefined;
  readonly process: { pid?: number };
  constructor(readonly id: number) {
    this.process = { pid: 1000 + id };
  }
  kill(signal = 'SIGTERM'): void {
    this.killed = signal;
  }
}

class MockCluster implements ClusterLike {
  forks = 0;
  readonly workers: MockWorker[] = [];
  private exitCbs: Array<(w: ClusterWorkerLike, code: number, signal: string | null) => void> = [];
  constructor(readonly isPrimary: boolean) {}
  fork(): ClusterWorkerLike {
    const w = new MockWorker(++this.forks);
    this.workers.push(w);
    return w;
  }
  on(_e: 'exit', cb: (w: ClusterWorkerLike, code: number, signal: string | null) => void): void {
    this.exitCbs.push(cb);
  }
  emitExit(w: ClusterWorkerLike, code = 1, signal: string | null = null): void {
    for (const cb of this.exitCbs) cb(w, code, signal);
  }
}

describe('startCluster (P3-2)', () => {
  it('single mode (workers<=1): runs both roles inline, no fork', () => {
    const cl = new MockCluster(true);
    const onPrimary = vi.fn();
    const onWorker = vi.fn();
    const h = startCluster({ workers: 1, onPrimary, onWorker, cluster: cl, log: () => {} });
    expect(h.role).toBe('single');
    expect(onPrimary).toHaveBeenCalledOnce();
    expect(onWorker).toHaveBeenCalledOnce();
    expect(cl.forks).toBe(0);
  });

  it('primary: runs onPrimary + forks N workers, never onWorker', () => {
    const cl = new MockCluster(true);
    const onPrimary = vi.fn();
    const onWorker = vi.fn();
    const h = startCluster({ workers: 3, onPrimary, onWorker, cluster: cl, log: () => {} });
    expect(h.role).toBe('primary');
    expect(h.workerCount).toBe(3);
    expect(onPrimary).toHaveBeenCalledOnce();
    expect(onWorker).not.toHaveBeenCalled();
    expect(cl.forks).toBe(3);
  });

  it('worker: runs onWorker only (background stays on the primary)', () => {
    const cl = new MockCluster(false);
    const onPrimary = vi.fn();
    const onWorker = vi.fn();
    const h = startCluster({ workers: 3, onPrimary, onWorker, cluster: cl, log: () => {} });
    expect(h.role).toBe('worker');
    expect(onWorker).toHaveBeenCalledOnce();
    expect(onPrimary).not.toHaveBeenCalled();
  });

  it('respawns a crashed worker, bounded by maxRespawns (no fork-bomb)', () => {
    const cl = new MockCluster(true);
    startCluster({ workers: 2, onWorker: () => {}, cluster: cl, maxRespawns: 2, log: () => {} });
    expect(cl.forks).toBe(2);
    cl.emitExit(cl.workers[0]); // respawn 1
    expect(cl.forks).toBe(3);
    cl.emitExit(cl.workers[1]); // respawn 2
    expect(cl.forks).toBe(4);
    cl.emitExit(cl.workers[2]); // budget exhausted → no respawn
    expect(cl.forks).toBe(4);
  });

  it('drain stops respawns + signals every worker to exit', () => {
    const cl = new MockCluster(true);
    const h = startCluster({ workers: 2, onWorker: () => {}, cluster: cl, log: () => {} });
    h.drain?.('SIGTERM');
    expect(cl.workers.every((w) => w.killed === 'SIGTERM')).toBe(true);
    cl.emitExit(cl.workers[0]); // draining ⇒ no respawn
    expect(cl.forks).toBe(2);
  });
});
