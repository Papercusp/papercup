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
  /** HTTP worker processes. **1 until a cluster actually exists** — wiring this
   *  >1 is a separate change (the app is single-process today). */
  readonly httpWorkers: number;
  /** Alias of {@link httpWorkers} for consumers that think in "process count".
   *  Also 1 until clustering lands. */
  readonly processCount: number;
}

/** Override any subset of the auto-detected signals. */
export type ResourceProfileConfig = Partial<ResourceSignals>;

// ---------------------------------------------------------------------------
// Derivation — pure, exported for unit tests (no memoization, no `os`).
// ---------------------------------------------------------------------------

const GIB = 1024 * 1024 * 1024;

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
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
 * | httpWorkers          | 1 (no cluster yet)                                   |   1   |    1    |
 */
export function deriveResourceProfile(signals: ResourceSignals): ResourceProfile {
  const cores = Math.max(1, Math.floor(signals.cores));
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

  // No cluster yet — pinned to 1 (floor === ceiling).
  const httpWorkers = clamp(1, 1, 1);

  return {
    signals: Object.freeze({ ...signals, cores }),
    hostClass,
    maxSimultaneousAgents,
    dbosQueueConcurrency,
    pgPoolMax,
    serializationWorkers,
    embedBatchSize,
    httpWorkers,
    processCount: httpWorkers,
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
  // Lazy require so the pure derivation + types are usable in a non-Node bundle.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const os = require('node:os') as typeof import('node:os');
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
