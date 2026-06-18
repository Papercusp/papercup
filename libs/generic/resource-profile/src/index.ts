/**
 * @papercusp/resource-profile — detect a host's effective compute resources ONCE
 * at boot and derive every scale cap with explicit floors + ceilings, so nothing
 * is hardcoded for one machine.
 *
 * The same operator binary runs on a 2-core laptop (with an embedded Postgres
 * sharing the box) and on a 128-core server (with a dedicated native PG). Every
 * concurrency number — how many agents run at once, DBOS queue depth, the PG pool
 * size, serialization worker count — should scale between those two worlds instead
 * of being a constant tuned for one. This module is the ONE place that reads the
 * host once and turns it into those caps; consumers seed their defaults from it.
 *
 * BORROWABLE / generic-first: pure derivation behind a {@link configureResourceProfile}
 * seam. It does NOT import any host module — the caller injects the raw signals
 * (cores, RAM) and the two domain bits we can't sniff generically
 * ({@link ResourceSignals.embeddedPg}, {@link ResourceSignals.hostRole}). With no
 * injection it auto-detects from Node's `os` (cgroup-quota-aware
 * `os.availableParallelism()`, NOT raw `os.cpus().length`, so a 2-CPU-quota pod on
 * a 128-core node sees 2). Detection runs once and the derived caps are memoized;
 * call {@link resetResourceProfile} in tests.
 *
 * Every cap is `clamp(formula, FLOOR, CEILING)` — a floor so the smallest host
 * still makes forward progress (never 0 agents, never a 0-size pool) and a ceiling
 * so the largest host can't blow past what the rest of the system (PG max
 * connections, DBOS, file descriptors) can absorb.
 */

import { createRequire } from 'node:module';

/** Coarse host bucket, derived from effective core count. Drives nothing on its
 *  own — it's a label for diagnostics + a cheap switch consumers can branch on. */
export type HostClass = 'laptop' | 'workstation' | 'server';

/**
 * Whether THIS process runs the shared background machinery (DBOS pipelines,
 * federation drains, watchdogs) or only serves requests. A request-only host
 * derives smaller background-oriented caps (queue concurrency) because it isn't
 * the one draining the queues. Generic over the host's own meaning of "role".
 */
export type HostRole = 'full' | 'request-only' | 'utility';

/** Raw host signals — injected by the caller, or auto-detected from `os`. */
export interface ResourceSignals {
  /** EFFECTIVE core count (cgroup-quota-aware). Defaults to
   *  `os.availableParallelism()` — NOT `os.cpus().length`, which ignores a
   *  container CPU quota and over-reports on a big shared node. */
  cores: number;
  /** Total physical RAM in bytes (`os.totalmem()`). */
  totalMemBytes: number;
  /** Free RAM in bytes at detection time (`os.freemem()`). A second clamp on the
   *  agent cap: a 64-core box with 1 GB free shouldn't launch 16 agents. */
  freeMemBytes: number;
  /** Does an embedded Postgres share THIS box? When true the DB competes with the
   *  operator for the same cores/RAM, so the per-core agent budget halves. */
  embeddedPg: boolean;
  /** This process's role (see {@link HostRole}). Default `'full'`. */
  hostRole: HostRole;
}

/**
 * Recommended PostgreSQL server knobs derived from the host, PGTune-style.
 *
 * The stock Postgres defaults (`max_connections=100`, `shared_buffers=128MB`)
 * are sized for a tiny machine and never grow — on a 128-core / 251 GiB box
 * that is a 0.05%-of-RAM buffer cache and a connection ceiling a single
 * operator process can exhaust by itself. These caps scale the server to the
 * detected hardware (with floors so a laptop stays sane and ceilings so a huge
 * box can't ask for more shared memory than is wise). Applied two ways:
 *   - embedded Postgres (the desktop): fed straight into the postmaster's
 *     `-c key=value` flags at boot — the app autoadjusts with zero config;
 *   - native Postgres (a dev box / dedicated server): rendered into a
 *     `conf.d` drop-in by the `pg-autotune` script.
 *
 * Memory sizes are in **MiB**. Render to GUC strings via
 * {@link databaseTuningToSettings}.
 */
export interface DatabaseTuning {
  /** `max_connections` — server-wide backend ceiling. */
  readonly maxConnections: number;
  /** `superuser_reserved_connections` — slots kept for superusers so an
   *  exhausted pool never locks operators out of their own DB. */
  readonly superuserReservedConnections: number;
  /** `shared_buffers` (MiB) — the DB's dedicated page cache. ~25% RAM on a
   *  dedicated DB, a gentler ~15% when an embedded PG shares the box. */
  readonly sharedBuffersMb: number;
  /** `effective_cache_size` (MiB) — planner hint for total cache (OS + DB),
   *  not an allocation. ~75% RAM dedicated, ~50% embedded. */
  readonly effectiveCacheSizeMb: number;
  /** `maintenance_work_mem` (MiB) — for VACUUM / CREATE INDEX. */
  readonly maintenanceWorkMemMb: number;
  /** `work_mem` (MiB) — per sort/hash node. Sized so `max_connections` worth of
   *  concurrent sorts can't blow past RAM. */
  readonly workMemMb: number;
  /** `wal_buffers` (MiB). */
  readonly walBuffersMb: number;
  /** `max_worker_processes` — background-worker slot ceiling (>= the parallel
   *  caps below + replication senders). */
  readonly maxWorkerProcesses: number;
  /** `max_parallel_workers` — total parallel-query workers. */
  readonly maxParallelWorkers: number;
  /** `max_parallel_workers_per_gather` — parallel workers a single query may use. */
  readonly maxParallelWorkersPerGather: number;
  /** `max_parallel_maintenance_workers` — parallel workers for CREATE INDEX etc. */
  readonly maxParallelMaintenanceWorkers: number;
}

/** The memoized, fully-derived profile — every scale cap the app needs. */
export interface ResourceProfile {
  /** The (possibly injected) raw signals the caps were derived from. */
  readonly signals: Readonly<ResourceSignals>;
  /** Coarse bucket from effective cores: <=4 laptop, <=16 workstation, else server. */
  readonly hostClass: HostClass;
  /** Fleet-wide cap on concurrently-running agent spawns. The single most
   *  load-bearing number; everything else is sized around it. */
  readonly maxSimultaneousAgents: number;
  /** Concurrency for the background work queue (DBOS). 0 is never valid — the
   *  queue must always drain — so the floor is 1. */
  readonly dbosQueueConcurrency: number;
  /** Max connections for the operator's PG pool. Sized so concurrent agents +
   *  background workers each get a connection, capped well under PG's own
   *  `max_connections`. */
  readonly pgPoolMax: number;
  /** Dedicated worker threads for CPU-heavy serialization/encoding. **0 ⇒ run
   *  inline** on the main thread (a small host shouldn't pay for a thread pool). */
  readonly serializationWorkers: number;
  /** Embedding batch size — how many items to embed per call. Bigger hosts push
   *  bigger batches for throughput; small hosts keep latency/memory down. */
  readonly embedBatchSize: number;
  /** RECOMMENDED placement of the shared background machinery (DBOS pipelines,
   *  the routines engine, periodic timers, drains) given this host's capacity.
   *  `true` ⇒ keep it IN the serving process — the desktop default: splitting buys
   *  nothing on a small single-user box and just costs a second process. `false` ⇒
   *  a host big enough to warrant moving background work to its OWN process so it
   *  can't steal the request loop. Derived purely from capacity — split only on a
   *  server-class host with a dedicated (native) Postgres; a laptop/workstation, or
   *  ANY host whose PG is embedded on the same box, keeps it in-process. (P3-1 of
   *  operator-scalability-event-loop reads this; on the desktop the split is a
   *  no-op. Independent of {@link ResourceSignals.hostRole}, which is what THIS
   *  process is *configured* to do; this is what the *hardware* recommends.) */
  readonly backgroundInProcess: boolean;
  /** HTTP worker processes. **1 until a cluster actually exists** — wiring this
   *  >1 is a separate change (the app is single-process today). */
  readonly httpWorkers: number;
  /** Alias of {@link httpWorkers} for consumers that think in "process count".
   *  Also 1 until clustering lands. */
  readonly processCount: number;
  /** Recommended PostgreSQL server knobs for THIS host (see {@link DatabaseTuning}).
   *  The desktop's embedded PG reads these at boot; a native PG is tuned from them
   *  by the `pg-autotune` script. */
  readonly database: DatabaseTuning;
}

/** Override any subset of the auto-detected signals. */
export type ResourceProfileConfig = Partial<ResourceSignals>;

// ---------------------------------------------------------------------------
// Derivation — pure, exported for unit tests (no memoization, no `os`).
// ---------------------------------------------------------------------------

const GIB = 1024 * 1024 * 1024;

function clamp(n: number, lo: number, hi: number): number {
  // A non-finite input (NaN/±Infinity) must never escape as a cap — NaN passes
  // straight through Math.min/Math.max and would poison every derived number
  // (and the host class) for the memoized process lifetime. Fall back to the
  // floor, the safe small-host default.
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Pure PostgreSQL server-tuning derivation from raw signals — PGTune-style,
 * every knob a `clamp(formula, FLOOR, CEILING)`. Exported + memo-free for unit
 * tests. See {@link DatabaseTuning} for what each knob is.
 *
 * | knob                          | formula                                            | floor |  ceiling |
 * |-------------------------------|----------------------------------------------------|-------|----------|
 * | maxConnections                | cores * 4                                          |  100  |   1000   |
 * | superuserReservedConnections  | round(maxConnections * 0.02)                       |    3  |     12   |
 * | sharedBuffersMb               | RAM * (embeddedPg ? 0.15 : 0.25)                   |  128  |  65536   |
 * | effectiveCacheSizeMb          | RAM * (embeddedPg ? 0.50 : 0.75)                   |  256  | 786432   |
 * | maintenanceWorkMemMb          | RAM / 16                                            |   64  |   2048   |
 * | workMemMb                     | (RAM - sharedBuffers) / (maxConnections * 4)       |    4  |     64   |
 * | walBuffersMb                  | sharedBuffers * 0.03                                |    4  |     64   |
 * | maxWorkerProcesses            | cores                                              |    8  |    256   |
 * | maxParallelWorkers            | cores                                              |    8  |    256   |
 * | maxParallelWorkersPerGather   | round(cores / 2)                                   |    1  |      8   |
 * | maxParallelMaintenanceWorkers | round(cores / 2)                                   |    1  |      8   |
 *
 * The embedded-vs-dedicated split mirrors the rest of the module: an embedded PG
 * shares the box with the operator + agents, so it takes a gentler slice of RAM
 * (it must not starve the very process it serves); a dedicated/native DB gets the
 * textbook PGTune fractions.
 */
export function deriveDatabaseTuning(signals: ResourceSignals): DatabaseTuning {
  const rawCores = Math.floor(signals.cores);
  const cores = Number.isFinite(rawCores) ? Math.max(1, rawCores) : 1;
  // Floor RAM at 0.5 GiB so a bogus/zero signal still yields finite, sane caps
  // (the clamps below would otherwise key off 0).
  const totalMb = Math.max(0.5 * 1024, (Number.isFinite(signals.totalMemBytes) ? signals.totalMemBytes : 0) / (1024 * 1024));
  const { embeddedPg } = signals;

  const maxConnections = clamp(cores * 4, 100, 1000);
  const superuserReservedConnections = clamp(Math.round(maxConnections * 0.02), 3, 12);
  const sharedBuffersMb = clamp(Math.round(totalMb * (embeddedPg ? 0.15 : 0.25)), 128, 65536);
  const effectiveCacheSizeMb = clamp(Math.round(totalMb * (embeddedPg ? 0.5 : 0.75)), 256, 786432);
  const maintenanceWorkMemMb = clamp(Math.round(totalMb / 16), 64, 2048);
  const workMemMb = clamp(Math.round((totalMb - sharedBuffersMb) / (maxConnections * 4)), 4, 64);
  const walBuffersMb = clamp(Math.round(sharedBuffersMb * 0.03), 4, 64);
  const maxWorkerProcesses = clamp(cores, 8, 256);
  const maxParallelWorkers = clamp(cores, 8, 256);
  const maxParallelWorkersPerGather = clamp(Math.round(cores / 2), 1, 8);
  const maxParallelMaintenanceWorkers = clamp(Math.round(cores / 2), 1, 8);

  return {
    maxConnections,
    superuserReservedConnections,
    sharedBuffersMb,
    effectiveCacheSizeMb,
    maintenanceWorkMemMb,
    workMemMb,
    walBuffersMb,
    maxWorkerProcesses,
    maxParallelWorkers,
    maxParallelWorkersPerGather,
    maxParallelMaintenanceWorkers,
  };
}

/**
 * The bounded size for EACH org pool (admin + app), so that all org pools across
 * all operator processes + per-process fixed overhead + other-DB pools (su-lock)
 * stay under the DB's `max_connections`. C1-1 / C5-2 of
 * backend-connection-scaling-2026-06-17 — the guard the P4-3 regression lacked
 * (it sized each pool to `pgPoolMax` with no awareness of the 2-pool × N-process
 * multiplication or the ceiling, so two server-profile operators could open ~208
 * connections against a 100-slot DB).
 *
 * Behind a transaction pooler the app pool maps to local pooler *client* slots,
 * not PG backends, so it is NOT bounded by the backend ceiling — returns
 * `desired`. By construction (when not pooled):
 *   bounded·2·procs + fixedOverhead·procs + otherDbs + superuserReserved ≤ maxConnections.
 */
export function boundedOrgPoolMax(opts: {
  /** The unbounded desired size (e.g. resource-profile pgPoolMax or an env override). */
  desired: number;
  /** The DB's max_connections ceiling (host-tuned). */
  maxConnections: number;
  /** superuser_reserved_connections (kept free for superusers). */
  superuserReserved: number;
  /** How many operator processes share this DB (dev box: :3070 + :3170 = 2). */
  expectedProcesses: number;
  /** Behind a transaction pooler → app pool ≠ PG backends; skip the bound. */
  behindPooler?: boolean;
  /** Non-org connections each process holds: admin-cache(8) + 5 LISTEN buses. */
  fixedOverheadPerProcess?: number;
  /** Connections from OTHER databases on the same instance (su-lock in papercusp_su). */
  reservedForOtherDbs?: number;
}): number {
  const desired = Math.max(1, Math.floor(Number.isFinite(opts.desired) ? opts.desired : 1));
  if (opts.behindPooler) return desired;
  const procs = Math.max(1, Math.floor(opts.expectedProcesses));
  const fixedPerProc = opts.fixedOverheadPerProcess ?? 13;
  const otherDbs = opts.reservedForOtherDbs ?? 32;
  const reserved = Math.max(0, opts.superuserReserved) + otherDbs + fixedPerProc * procs;
  const budgetForOrgPools = Math.max(2, opts.maxConnections - reserved);
  const perPoolCap = Math.floor(budgetForOrgPools / (procs * 2));
  return Math.max(1, Math.min(desired, perPoolCap));
}

/**
 * Render a {@link DatabaseTuning} into a map of Postgres GUC name → value string
 * (with MB units where the knob is a size). Feed to a `conf.d` file
 * (`${k} = ${v}`) or to embedded-postgres `-c` flags
 * (`Object.entries(...).flatMap(([k, v]) => ['-c', \`${k}=${v}\`])`).
 */
export function databaseTuningToSettings(t: DatabaseTuning): Record<string, string> {
  return {
    max_connections: String(t.maxConnections),
    superuser_reserved_connections: String(t.superuserReservedConnections),
    shared_buffers: `${t.sharedBuffersMb}MB`,
    effective_cache_size: `${t.effectiveCacheSizeMb}MB`,
    maintenance_work_mem: `${t.maintenanceWorkMemMb}MB`,
    work_mem: `${t.workMemMb}MB`,
    wal_buffers: `${t.walBuffersMb}MB`,
    max_worker_processes: String(t.maxWorkerProcesses),
    max_parallel_workers: String(t.maxParallelWorkers),
    max_parallel_workers_per_gather: String(t.maxParallelWorkersPerGather),
    max_parallel_maintenance_workers: String(t.maxParallelMaintenanceWorkers),
  };
}

/**
 * Pure cap derivation from raw signals. Each cap is `clamp(formula, FLOOR, CEIL)`.
 *
 * | cap                  | formula                                              | floor | ceiling |
 * |----------------------|------------------------------------------------------|-------|---------|
 * | maxSimultaneousAgents| round(cores * (embeddedPg ? 0.25 : 0.5)), then        |   1   |   16    |
 * |                      | also clamped by free RAM (~0.5 GiB budget/agent)     |       |         |
 * | dbosQueueConcurrency | round(cores * (embeddedPg ? 0.5 : 1))                |   1   |   32    |
 * |                      | request-only/utility role → halved (not the drainer) |       |         |
 * | pgPoolMax            | maxSimultaneousAgents + dbosQueueConcurrency + 4      |   4   |   64    |
 * | serializationWorkers | cores - 2  (0 ⇒ inline; only earned past ~4 cores)   |   0   |    8    |
 * | embedBatchSize       | 32 * 2^hostClassTier (laptop 32 / wkstn 64 / srv 128)|  16   |  256    |
 * | backgroundInProcess  | false only on a server-class host w/ native PG; else true | — | — |
 * | httpWorkers          | 1 (no cluster yet)                                   |   1   |    1    |
 */
export function deriveResourceProfile(signals: ResourceSignals): ResourceProfile {
  // Normalize cores to a finite >=1 integer. A non-finite signal (NaN from a
  // failed detect, ±Infinity) would otherwise flow through Math.floor unchanged
  // — NaN poisons every cap and the host class, +Infinity misclassifies as
  // 'server' and persists a non-finite signals.cores — so it falls back to a
  // single core (the smallest-host default).
  const rawCores = Math.floor(signals.cores);
  const cores = Number.isFinite(rawCores) ? Math.max(1, rawCores) : 1;
  const { embeddedPg, hostRole } = signals;
  const freeGib = Math.max(0, signals.freeMemBytes) / GIB;

  const hostClass: HostClass = cores <= 4 ? 'laptop' : cores <= 16 ? 'workstation' : 'server';

  // maxSimultaneousAgents: core-derived, halved when an embedded PG shares the box,
  // then a second clamp by free RAM (~0.5 GiB headroom per agent) so a big-core /
  // low-memory host doesn't oversubscribe RAM.
  const agentsByCore = Math.round(cores * (embeddedPg ? 0.25 : 0.5));
  const agentsByRam = Math.floor(freeGib / 0.5);
  const maxSimultaneousAgents = clamp(Math.min(agentsByCore, agentsByRam), 1, 16);

  // DBOS queue: a request-only / utility host isn't the queue drainer, so it gets
  // half the depth a full host would.
  const queueBase = Math.round(cores * (embeddedPg ? 0.5 : 1));
  const queueRoleFactor = hostRole === 'full' ? 1 : 0.5;
  const dbosQueueConcurrency = clamp(Math.round(queueBase * queueRoleFactor), 1, 32);

  // PG pool: one connection per concurrent agent + per queue worker + a small
  // fixed overhead for request handlers, capped well under PG max_connections.
  const pgPoolMax = clamp(maxSimultaneousAgents + dbosQueueConcurrency + 4, 4, 64);

  // Serialization threads are only worth their overhead once there are spare cores;
  // 0 means run inline on the main thread.
  const serializationWorkers = clamp(cores - 2, 0, 8);

  // Embedding batch grows by host class tier.
  const tier = hostClass === 'laptop' ? 0 : hostClass === 'workstation' ? 1 : 2;
  const embedBatchSize = clamp(32 * 2 ** tier, 16, 256);

  // Background placement: keep it in-process everywhere EXCEPT a server-class host
  // with a dedicated (native) PG, where a real multi-tenant box has the headroom +
  // the motivation to give background work its own process. A laptop/workstation,
  // or any host whose PG is embedded on the same box (the desktop), keeps it
  // in-process — the split would buy nothing and cost a second process.
  const backgroundInProcess = !(hostClass === 'server' && !embeddedPg);

  // No cluster yet — pinned to 1 (floor === ceiling).
  const httpWorkers = clamp(1, 1, 1);

  // PostgreSQL server knobs scaled to the same host (see deriveDatabaseTuning).
  const database = deriveDatabaseTuning(signals);

  return {
    signals: Object.freeze({ ...signals, cores }),
    hostClass,
    maxSimultaneousAgents,
    dbosQueueConcurrency,
    pgPoolMax,
    serializationWorkers,
    embedBatchSize,
    backgroundInProcess,
    httpWorkers,
    processCount: httpWorkers,
    database,
  };
}

// ---------------------------------------------------------------------------
// Auto-detection + memoized singleton.
// ---------------------------------------------------------------------------

/**
 * Read the raw host signals from Node's `os`. Uses cgroup-quota-aware
 * `os.availableParallelism()` for cores (NOT `os.cpus().length`). The two domain
 * bits we can't sniff generically default conservatively: `embeddedPg: false`
 * (assume a dedicated DB unless told otherwise) and `hostRole: 'full'`.
 */
export function detectResourceSignals(overrides?: ResourceProfileConfig): ResourceSignals {
  // Lazy-load node:os via createRequire so node:os stays OUT of the static import
  // graph (the pure derivation + types remain usable in a non-Node bundle) while
  // still working under ESM: this package is "type": "module", so a bare CJS
  // `require` is undefined in the ES module scope and crashed every tsx/ESM
  // consumer of getResourceProfile (e.g. the external-bench launchers).
  const os = createRequire(import.meta.url)('node:os') as typeof import('node:os');
  const cores = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
  return {
    cores,
    totalMemBytes: os.totalmem(),
    freeMemBytes: os.freemem(),
    embeddedPg: false,
    hostRole: 'full',
    ...overrides,
  };
}

let memoized: ResourceProfile | null = null;
let pendingConfig: ResourceProfileConfig | null = null;

/**
 * The seam: inject the domain signals (and optionally override detected ones)
 * BEFORE the first {@link getResourceProfile}. Idempotent until the profile is
 * realized; throws if called after the profile has already been memoized so a
 * late override can't silently no-op. Call once at boot.
 */
export function configureResourceProfile(config: ResourceProfileConfig): void {
  if (memoized) {
    throw new Error(
      'configureResourceProfile() called after the profile was already detected; ' +
        'configure it once at boot, before any getResourceProfile() consumer.',
    );
  }
  pendingConfig = { ...pendingConfig, ...config };
}

/**
 * The memoized profile. Detects the host ONCE (merging any
 * {@link configureResourceProfile} signals) and caches the derived caps for the
 * process lifetime.
 */
export function getResourceProfile(): ResourceProfile {
  if (!memoized) {
    memoized = deriveResourceProfile(detectResourceSignals(pendingConfig ?? undefined));
  }
  return memoized;
}

/** Test hook — clear the memoized profile + any pending config. */
export function resetResourceProfile(): void {
  memoized = null;
  pendingConfig = null;
}
