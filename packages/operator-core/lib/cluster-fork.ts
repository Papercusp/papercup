/**
 * cluster-fork.ts — P3-2 node:cluster primitive (operator-scalability-event-loop-2026-06-16).
 *
 * The reusable fork / respawn / drain engine for clustering the operator HTTP host:
 * the PRIMARY process runs the background machinery (DBOS / git-sync / substrate —
 * which MUST be exactly one process) and forks N request-only WORKERS that each
 * serve the Hono handler on the SAME port via SO_REUSEPORT (the OS load-balances
 * accepts across them). This module is the deterministic core — who-am-I, fork the
 * fleet, respawn a crashed worker (bounded so a crash-looping worker can't
 * fork-bomb the box), drain on shutdown — with `node:cluster` INJECTED so it
 * unit-tests without spawning real processes.
 *
 * Multi-process-safety is the CALLER's contract (enforced + documented at the call
 * site, not here):
 *   1. PG pool sizing MUST count the workers (boundedOrgPoolMax `expectedProcesses`
 *      = resource-profile.processCount) or the per-process pools multiply past PG
 *      `max_connections` — the exact 2026-06-17 exhaustion this effort began with.
 *   2. Cross-process state (sync-invalidate fan-out, flag-bus, rate-limit-config
 *      bus) MUST ride PG LISTEN/NOTIFY (the pg-listen-hub), not in-proc buses — a
 *      write on worker A is invisible to an SSE stream pinned to worker B otherwise.
 *   3. Single-socket servers (endpoint-IPC, the PTY WS data plane) must run in the
 *      PRIMARY only — but both are desktop-only (off on the server cluster target),
 *      so the server cluster doesn't hit them.
 */
import nodeCluster from 'node:cluster';

export type ClusterRole = 'primary' | 'worker' | 'single';

/** The slice of `node:cluster` this engine needs (injected; the real module
 *  satisfies it structurally). */
export interface ClusterLike {
  readonly isPrimary: boolean;
  fork(env?: Record<string, string>): ClusterWorkerLike;
  on(event: 'exit', cb: (worker: ClusterWorkerLike, code: number, signal: string | null) => void): void;
}
export interface ClusterWorkerLike {
  readonly id: number;
  readonly process: { pid?: number };
  kill(signal?: string): void;
}

export interface StartClusterOpts {
  /** Request workers to fork. <=1 ⇒ run single-process inline (no fork). */
  workers: number;
  /** Run in the PRIMARY (background machinery) BEFORE forking. Not run in a worker. */
  onPrimary?: () => void;
  /** Run in each WORKER — and in the single process when workers<=1 — to start the
   *  HTTP server (with reusePort so siblings share the port). */
  onWorker: () => void;
  /** Env injected into EVERY forked worker (merged over the inherited env). The
   *  caller sets the worker contract here — `PAPERCUSP_BACKGROUND_WORKERS=0` (a
   *  worker is request-only; the primary owns the background machinery) +
   *  `PAPERCUSP_EXPECTED_OPERATOR_PROCS=<processCount>` (so each worker's PG pools
   *  are sized for the whole fleet, not the box alone). */
  workerEnv?: Record<string, string>;
  /** Injected for tests; defaults to `node:cluster`. */
  cluster?: ClusterLike;
  /** Max automatic respawns of crashed workers (crash-loop guard). Default workers*5. */
  maxRespawns?: number;
  log?: (line: string) => void;
}

export interface ClusterHandle {
  role: ClusterRole;
  /** Workers actually forked (0 in single mode / inside a worker). */
  workerCount: number;
  /** PRIMARY only: stop respawning + signal every worker to exit (graceful drain).
   *  Wire to SIGTERM/SIGINT at the call site. No-op in worker/single roles. */
  drain?: (signal?: string) => void;
}

/**
 * Resolve the request-worker count from env + the host's recommendation. DEFAULT-OFF
 * (1 = single process): `'auto'`/`'on'`/`'true'`/`'1'` ⇒ `recommendedWorkers`
 * (resource-profile.httpWorkers — itself 1 on a laptop/workstation/embedded-PG host);
 * a positive number ⇒ exactly that many; unset / `'0'` / `'off'` / `'false'` / junk ⇒
 * 1. A process-MODEL boot switch (infra), not a runtime feature flag — hence env, not
 * a FLAG (cf. PAPERCUSP_BACKGROUND_WORKERS / PAPERCUSP_UTILITY_HOST). Pure + exported
 * for tests; the caller reads `process.env` + the profile.
 */
export function resolveClusterWorkers(
  env: { PAPERCUSP_CLUSTER_WORKERS?: string; PAPERCUSP_CLUSTER?: string },
  recommendedWorkers: number,
): number {
  const raw = env.PAPERCUSP_CLUSTER_WORKERS ?? env.PAPERCUSP_CLUSTER;
  if (!raw || raw === '0' || raw === 'off' || raw === 'false') return 1;
  if (raw === 'auto' || raw === 'on' || raw === 'true' || raw === '1') {
    return Math.max(1, Math.floor(Number.isFinite(recommendedWorkers) ? recommendedWorkers : 1));
  }
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n >= 1 ? n : 1; // 0<x<1 floors to 0 ⇒ fall back to 1
}

export function startCluster(opts: StartClusterOpts): ClusterHandle {
  const cluster = opts.cluster ?? (nodeCluster as unknown as ClusterLike);
  const log = opts.log ?? ((m) => console.log(m));
  const workers = Math.max(1, Math.floor(Number.isFinite(opts.workers) ? opts.workers : 1));

  // Single-process: forking one worker buys nothing — run both roles inline.
  if (workers <= 1) {
    opts.onPrimary?.();
    opts.onWorker();
    return { role: 'single', workerCount: 0 };
  }

  // A forked worker: serve requests only (the background machinery is the primary's).
  if (!cluster.isPrimary) {
    opts.onWorker();
    return { role: 'worker', workerCount: 0 };
  }

  // Primary: background machinery first, then fork + supervise the request fleet.
  opts.onPrimary?.();
  const maxRespawns = opts.maxRespawns ?? workers * 5;
  const forked: ClusterWorkerLike[] = [];
  let respawns = 0;
  let draining = false;

  for (let i = 0; i < workers; i++) forked.push(cluster.fork(opts.workerEnv));

  cluster.on('exit', (worker, code, signal) => {
    if (draining) return; // intentional shutdown — let workers go
    if (respawns >= maxRespawns) {
      log(`[cluster] worker ${worker.id} exited (code=${code} signal=${signal}); respawn budget exhausted (${maxRespawns}) — NOT respawning`);
      return;
    }
    respawns += 1;
    log(`[cluster] worker ${worker.id} exited (code=${code} signal=${signal}); respawning (${respawns}/${maxRespawns})`);
    forked.push(cluster.fork(opts.workerEnv));
  });

  return {
    role: 'primary',
    workerCount: workers,
    drain(signal = 'SIGTERM') {
      draining = true;
      for (const w of forked) {
        try {
          w.kill(signal);
        } catch {
          /* worker already gone */
        }
      }
    },
  };
}
