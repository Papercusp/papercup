/**
 * cluster-booted-handles-sync.ts — EI-8816: the booted-handles PUSH-sync that closes
 * the true-cluster blind spot.
 *
 * Root cause (per cluster-fork.ts's own doc comment + P3-2's design): in true-cluster
 * mode (`PAPERCUSP_CLUSTER` on, `workers > 1`) the PRIMARY process alone runs the
 * background machinery — `onPrimary()` boots the substrate — and never itself serves
 * HTTP; only the N forked request-only WORKERS (`onWorker()`, `PAPERCUSP_BACKGROUND_WORKERS=0`)
 * serve requests, via `SO_REUSEPORT`. `listBootedHandles()` (boot-all.ts) reads a
 * process-local module-scope `Map`, populated ONLY inside whichever process actually
 * booted the substrate — the primary. So every HTTP request for substrate status lands
 * on a worker whose own local map is (correctly, but misleadingly) always empty:
 * `dev:dogfood_substrate_status` / `GET /admin/dogfood-substrate-health` report
 * `bootedCount:0` and empty `harnesses`/`replicationLiveness` even when the substrate is
 * genuinely booted on the primary (EI-8810/P-059 cost a false "substrate not booted"
 * diagnosis from exactly this).
 *
 * Fix: a PUSH model (not request/reply) — chosen so `getInProcessSubstrateStatus()`
 * stays a pure SYNCHRONOUS function (no async/shape change needed in either of its two
 * callers). The PRIMARY periodically broadcasts its `listBootedHandles()` snapshot to
 * every live worker over `node:cluster` IPC (`ClusterHandle.broadcast`, cluster-fork.ts);
 * each WORKER caches the latest snapshot + its receipt time and reads it back
 * SYNCHRONOUSLY. `in-process-status.ts`'s `resolveEffectiveBootedHandles` then decides,
 * per read, whether to trust the local map directly (this process IS the substrate
 * owner — `nodeCluster.isPrimary`, true for the primary AND for single-process mode) or
 * to fall back to the cached remote snapshot (a genuine forked worker) — and reports an
 * explicit `reachedSubstrateOwner: false` (never a silently-empty `bootedCount: 0`) when
 * neither is available (e.g. the cache hasn't received a first snapshot yet, or has gone
 * stale because the primary is wedged/dead).
 *
 * Mirrors `system-health/cluster-lag-watchdog.ts`'s established worker↔primary IPC
 * convention (a typed message constant, a worker-side emitter, a primary-side listener)
 * rather than inventing a second mechanism.
 */

import { managedSetInterval } from '@papercusp/scheduled-registry';
import { listBootedHandles, type BootedHandleSummary } from './boot-all';

/** IPC message type the primary broadcasts to every worker each interval. */
export const BOOTED_HANDLES_SNAPSHOT_TYPE = 'papercusp:booted-handles-snapshot' as const;

export interface BootedHandlesSnapshotMessage {
  type: typeof BOOTED_HANDLES_SNAPSHOT_TYPE;
  handles: BootedHandleSummary[];
  sentAt: number;
}

export interface BootedHandlesBroadcasterHandle {
  stop(): void;
}

/**
 * PRIMARY side: periodically broadcast `listBootedHandles()` to every live worker via
 * the caller-supplied `broadcast` (wire to `ClusterHandle.broadcast` from cluster-fork.ts).
 * Broadcasts immediately on start (so a freshly-forked worker's cache isn't empty for a
 * full interval) then every `intervalMs`. The timer is registered under
 * `managedSetInterval` (category 'watchdog') so it is visible in `schedule:inventory`,
 * matching the sibling cluster-lag-watchdog convention.
 */
export function startBootedHandlesBroadcaster(opts: {
  broadcast: (message: BootedHandlesSnapshotMessage) => void;
  intervalMs?: number;
  now?: () => number;
}): BootedHandlesBroadcasterHandle {
  const intervalMs = opts.intervalMs ?? 5_000;
  const now = opts.now ?? (() => Date.now());
  const beat = (): void => {
    try {
      opts.broadcast({
        type: BOOTED_HANDLES_SNAPSHOT_TYPE,
        handles: listBootedHandles(),
        sentAt: now(),
      });
    } catch {
      /* best-effort — a dead/draining worker channel never throws past broadcast() anyway */
    }
  };
  beat();
  const timer = managedSetInterval('booted-handles-broadcast', intervalMs, beat, {
    category: 'watchdog',
  });
  return {
    stop() {
      timer.stop();
    },
  };
}

export interface RemoteBootedHandlesSnapshot {
  handles: BootedHandleSummary[];
  receivedAt: number;
}

/** Process-local cache of the latest snapshot received from the primary. Only ever
 *  populated in a genuine forked WORKER process (the primary never broadcasts to
 *  itself); stays `null` for the lifetime of a primary / single-process host. */
let cachedRemote: RemoteBootedHandlesSnapshot | null = null;

/**
 * WORKER side: listen for the primary's booted-handles broadcast and cache the latest
 * snapshot + receipt time. Registers a `process.on('message', ...)` listener by default
 * (injectable `on`/`off` for tests — synthetically emitting on the REAL `process` object
 * risks colliding with the test runner's own worker IPC, which uses the same event) — a
 * no-op safe to call in any process (a primary/single-process host simply never receives
 * this message type, so the cache stays `null` there, which `resolveEffectiveBootedHandles`
 * never consults for the owner process anyway).
 */
export function startWorkerBootedHandlesCache(
  opts: {
    now?: () => number;
    on?: (event: 'message', cb: (message: unknown) => void) => void;
    off?: (event: 'message', cb: (message: unknown) => void) => void;
  } = {},
): { stop(): void } {
  const now = opts.now ?? (() => Date.now());
  const on = opts.on ?? ((event: 'message', cb: (message: unknown) => void) => process.on(event, cb));
  const off = opts.off ?? ((event: 'message', cb: (message: unknown) => void) => process.off(event, cb));
  const listener = (message: unknown): void => {
    const m = message as Partial<BootedHandlesSnapshotMessage> | null | undefined;
    if (m?.type === BOOTED_HANDLES_SNAPSHOT_TYPE && Array.isArray(m.handles)) {
      cachedRemote = { handles: m.handles as BootedHandleSummary[], receivedAt: now() };
    }
  };
  on('message', listener);
  return {
    stop() {
      off('message', listener);
    },
  };
}

/** Read the latest cached remote snapshot (or `null` if none has ever arrived). Pure
 *  sync read — this is the seam `in-process-status.ts` wires as `resolveRemoteBootedHandles`. */
export function getCachedRemoteBootedHandles(): RemoteBootedHandlesSnapshot | null {
  return cachedRemote;
}

/** Test seam only — set/clear the module-scope cache directly without a real `process.on('message')` round-trip. */
export function _setCachedRemoteBootedHandlesForTests(snapshot: RemoteBootedHandlesSnapshot | null): void {
  cachedRemote = snapshot;
}
