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
  resolveClusterWorkers,
  resolveExpectedOperatorProcs,
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
  on(event: 'exit', cb: (w: ClusterWorkerLike, code: number, signal: string | null) => void): void;
  on(event: 'message', cb: (w: ClusterWorkerLike, message: unknown) => void): void;
  on(
    event: 'exit' | 'message',
    cb:
      | ((w: ClusterWorkerLike, code: number, signal: string | null) => void)
      | ((w: ClusterWorkerLike, message: unknown) => void),
  ): void {
    if (event === 'exit') {
      this.exitCbs.push(cb as (w: ClusterWorkerLike, code: number, signal: string | null) => void);
    }
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

describe('startCluster boot-failure backstop (2026-06-25 inconsistent-release incident)', () => {
  it('a generation failing to boot (none ever healthy) → onUnbootable, respawn storm halts', () => {
    const cl = new MockCluster(true);
    let fakeNow = 0;
    const onUnbootable = vi.fn();
    startCluster({
      workers: 3,
      onWorker: () => {},
      cluster: cl,
      maxRespawns: 15, // a 32-worker-style budget the storm would otherwise burn through
      bootGraceMs: 10_000,
      now: () => fakeNow,
      onUnbootable,
      log: () => {},
    });
    expect(cl.forks).toBe(3);
    cl.emitExit(cl.workers[0]); // boot-failure 1/3 (uptime 0) → still respawns
    cl.emitExit(cl.workers[1]); // boot-failure 2/3 → still respawns
    expect(cl.forks).toBe(5);
    expect(onUnbootable).not.toHaveBeenCalled();
    cl.emitExit(cl.workers[2]); // boot-failure 3/3 → UNBOOTABLE: stop, signal the caller
    expect(onUnbootable).toHaveBeenCalledOnce();
    expect(onUnbootable).toHaveBeenCalledWith({
      consecutiveBootFailures: 3,
      lastCode: 1,
      lastSignal: null,
    });
    const forksAtGiveUp = cl.forks;
    cl.emitExit(cl.workers[3]); // already unbootable → ignored, no further forking
    expect(cl.forks).toBe(forksAtGiveUp);
    expect(cl.forks).toBeLessThan(15); // nowhere near the full respawn-budget storm
  });

  it('a worker that booted healthy then crashed is respawned — onUnbootable never fires after a healthy boot', () => {
    const cl = new MockCluster(true);
    let fakeNow = 0;
    const onUnbootable = vi.fn();
    startCluster({
      workers: 2,
      onWorker: () => {},
      cluster: cl,
      bootGraceMs: 10_000,
      now: () => fakeNow,
      onUnbootable,
      log: () => {},
    });
    expect(cl.forks).toBe(2);
    fakeNow = 20_000; // both workers have been up well past the grace window
    cl.emitExit(cl.workers[0]); // runtime crash after healthy uptime → normal respawn
    expect(cl.forks).toBe(3);
    expect(onUnbootable).not.toHaveBeenCalled();
    // Once the build is PROVEN bootable, even an instant exit is just a runtime crash → respawn.
    cl.emitExit(cl.workers[2]); // w3 forked at t=20000, exits at t=20000 (uptime 0) but sawHealthy
    expect(cl.forks).toBe(4);
    expect(onUnbootable).not.toHaveBeenCalled();
  });

  it('inert without onUnbootable: instant boot-failures use the legacy respawn budget (opt-in)', () => {
    const cl = new MockCluster(true);
    startCluster({ workers: 2, onWorker: () => {}, cluster: cl, maxRespawns: 3, bootGraceMs: 10_000, log: () => {} });
    expect(cl.forks).toBe(2);
    cl.emitExit(cl.workers[0]); // respawn 1/3 — no early short-circuit despite uptime 0
    cl.emitExit(cl.workers[1]); // respawn 2/3
    cl.emitExit(cl.workers[2]); // respawn 3/3
    expect(cl.forks).toBe(5);
    cl.emitExit(cl.workers[3]); // budget exhausted → no respawn
    expect(cl.forks).toBe(5);
  });
});

describe('resolveClusterWorkers (P3-2 gate)', () => {
  const REC = 8; // resource-profile.httpWorkers recommendation

  it('defaults OFF (1) when unset or explicitly disabled', () => {
    expect(resolveClusterWorkers({}, REC)).toBe(1);
    for (const v of ['0', 'off', 'false']) {
      expect(resolveClusterWorkers({ PAPERCUSP_CLUSTER: v }, REC)).toBe(1);
    }
  });

  it('auto/on/true/1 ⇒ the host recommendation', () => {
    for (const v of ['auto', 'on', 'true', '1']) {
      expect(resolveClusterWorkers({ PAPERCUSP_CLUSTER: v }, REC)).toBe(REC);
    }
  });

  it('a positive number ⇒ exactly that many workers', () => {
    expect(resolveClusterWorkers({ PAPERCUSP_CLUSTER: '4' }, REC)).toBe(4);
    expect(resolveClusterWorkers({ PAPERCUSP_CLUSTER: '16' }, REC)).toBe(16);
  });

  it('PAPERCUSP_CLUSTER_WORKERS takes precedence over PAPERCUSP_CLUSTER', () => {
    expect(resolveClusterWorkers({ PAPERCUSP_CLUSTER_WORKERS: '3', PAPERCUSP_CLUSTER: 'off' }, REC)).toBe(3);
  });

  it('junk / non-positive ⇒ 1 (safe default)', () => {
    expect(resolveClusterWorkers({ PAPERCUSP_CLUSTER: 'banana' }, REC)).toBe(1);
    expect(resolveClusterWorkers({ PAPERCUSP_CLUSTER: '-2' }, REC)).toBe(1);
    expect(resolveClusterWorkers({ PAPERCUSP_CLUSTER: '0.5' }, REC)).toBe(1);
  });

  it('auto with a non-finite recommendation falls back to 1', () => {
    expect(resolveClusterWorkers({ PAPERCUSP_CLUSTER: 'auto' }, Number.NaN)).toBe(1);
  });
});

describe('resolveExpectedOperatorProcs (R1 — PG-pool budget divisor)', () => {
  it('uses the real cluster topology (workers + 1 primary), NOT the embedded-PG profile pin', () => {
    // The bug: embedded-PG profileProcessCount pins to 1 → pools sized for ~1 proc → 68-conn
    // over-provisioning. With 2 workers the divisor must be 3 (2 workers + 1 primary).
    expect(
      resolveExpectedOperatorProcs({ clusterWorkers: 2, profileProcessCount: 1 }),
    ).toBe(3);
    expect(
      resolveExpectedOperatorProcs({ clusterWorkers: 4, profileProcessCount: 1 }),
    ).toBe(5);
  });

  it('single-process (clusterWorkers<=1) ⇒ 1 unless the profile/override says more', () => {
    expect(resolveExpectedOperatorProcs({ clusterWorkers: 1, profileProcessCount: 1 })).toBe(1);
    expect(resolveExpectedOperatorProcs({ clusterWorkers: 0, profileProcessCount: 1 })).toBe(1);
  });

  it('honors an explicit operator override when it is LARGER (count staging/aux on the box)', () => {
    expect(
      resolveExpectedOperatorProcs({ clusterWorkers: 2, profileProcessCount: 1, explicit: 5 }),
    ).toBe(5);
    expect(
      resolveExpectedOperatorProcs({ clusterWorkers: 2, profileProcessCount: 1, explicit: '6' }),
    ).toBe(6);
  });

  it('never sizes for FEWER procs than exist — a too-small override cannot under-provision', () => {
    // explicit=1 must NOT win over the real 3-proc cluster (that would re-create the bug).
    expect(
      resolveExpectedOperatorProcs({ clusterWorkers: 2, profileProcessCount: 1, explicit: 1 }),
    ).toBe(3);
    // a larger profile count still wins (a dedicated-PG server-class host).
    expect(
      resolveExpectedOperatorProcs({ clusterWorkers: 2, profileProcessCount: 8 }),
    ).toBe(8);
  });

  it('ignores junk/zero/negative override + non-finite profile', () => {
    expect(
      resolveExpectedOperatorProcs({ clusterWorkers: 2, profileProcessCount: Number.NaN, explicit: 'nope' }),
    ).toBe(3);
    expect(
      resolveExpectedOperatorProcs({ clusterWorkers: 2, profileProcessCount: 1, explicit: -4 }),
    ).toBe(3);
  });
});
