/**
 * cpu-task-worker.ts — offload CPU-heavy synchronous work to a persistent
 * worker_threads Worker so the operator main event loop is not blocked.
 *
 * infra-perf-reliability-audit-round3-2026-06-19 P-011 / round4 P-002.
 *
 * Background: the F1 cpuprofile attributed two hot-path culprits that ran
 * SYNCHRONOUSLY on the main thread per SSE polling tick:
 *
 *  (a) JSON.stringify on large result-batch payloads (coord:plan-events
 *      3.5 MB, plans:list 358 KB) — blocks ~30–50 ms per call.
 *  (b) gzipSync on the same payloads — blocks ~50–100 ms per call.
 *
 * At 350–630 elevated windows/hr this compounds into p95 501 ms / worst
 * 3475 ms event-loop lag seen in round-3 cpuprofile captures.
 *
 * (b) IS GONE — the operator no longer compresses any response. It is a
 * loopback desktop sidecar, so gzip only ever shrank bytes that never left
 * the machine while costing CPU on both ends; this worker existed partly to
 * HIDE that cost rather than not pay it. Do not re-add compression here
 * (guard: scripts/check-no-wire-compression.mjs). (a) is real work that
 * still has to happen, so the serialize offload stays.
 *
 * Architecture: one persistent worker per process (lazy-spawned on first
 * call). The main thread postMessages a `{ kind:'serialize', id, value }`
 * envelope; the worker does JSON.stringify and transfers the result back.
 * Falls back to inline sync execution on the main thread when
 * worker_threads are unavailable or the worker crashes — byte-identical
 * behavior (same BigInt→Number replacer), just slower.
 *
 * The structured-clone transfer of `value` to the worker is faster than
 * JSON.stringify because V8 uses a compact binary format internally.
 * Main-thread blocking is reduced to the clone step (~10 ms for a 3.5 MB
 * object) rather than the full stringify (~30–50 ms).
 *
 * Pattern follows libs/generic/memory/src/local-embedder-worker.ts exactly —
 * INCLUDING, until WI-37688, its three transient-failure traps: a runtime
 * crash latched the offload off for the process lifetime, a request in flight
 * when the worker went away never settled, and the worker was never unref'd
 * so a one-off process could not exit. All three are fixed here and there;
 * see `syncWorkerRef`, `rejectAllPending` and MAX_CONSECUTIVE_CRASHES below,
 * and keep the two modules in step when either changes.
 */

import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

/**
 * Minimum batch-item count above which we prefer offloading to the worker
 * even without a byte estimate. Below this threshold the structured-clone
 * round-trip overhead (per-field visit) costs more than sync stringify.
 * Env-tunable; default 5 items (empirically ~32 KB+ for typical results).
 */
export const OFFLOAD_MIN_ITEMS = Math.max(
  1,
  Number(process.env.PAPERCUSP_CPU_WORKER_MIN_ITEMS) || 5,
);

interface PendingRequest {
  resolve: (r: WorkerResult) => void;
  reject: (err: Error) => void;
}

interface WorkerResult {
  json: string | null;
}

let _worker: Worker | null = null;
let _workerReady: Promise<void> | null = null;
let _nextId = 0;
const _pending = new Map<number, PendingRequest>();
let _workerDisabled = false;
let _consecutiveCrashes = 0;
/**
 * What `syncWorkerRef` last APPLIED to the worker's libuv handle.
 *
 * libuv exposes no ref-state getter, so this is the only way to report the
 * real thing. Do NOT replace it by re-deriving `_pending.size > 0` in the
 * diagnostic: that restates the code instead of observing it, and a
 * `syncWorkerRef` that stopped ref'ing entirely would still read as correct
 * (measured — that exact mutant SURVIVED the probe, WI-37688). `syncWorkerRef`
 * is the only writer.
 */
let _workerRefd = false;

/**
 * Consecutive runtime crashes after which the worker is given up on for good.
 *
 * A TRANSIENT crash must not disable the offload permanently (WI-37688): the
 * whole point of this module is to keep 30-50ms stringifies off the operator
 * main thread, and the sync fallback is byte-identical, so a permanent
 * disable is an INVISIBLE performance regression — no error, no exit code,
 * no log line, just the event-loop lag this module was built to remove.
 * But a worker that spawns fine and then crashes on every message must not
 * be respawned per request either, so recovery is bounded rather than
 * unlimited.
 */
const MAX_CONSECUTIVE_CRASHES = 3;

function workerPath(): string {
  const here =
    typeof __filename !== 'undefined' ? __filename : fileURLToPath(import.meta.url);
  return resolve(dirname(here), 'cpu-task-worker.script.mjs');
}

/**
 * Hold the event loop open exactly while a request is in flight.
 *
 * An always-ref'd worker keeps a one-off process alive forever; an
 * always-unref'd one lets the process exit mid-request, stranding the
 * caller. Ref while `_pending` is non-empty, unref when idle — call after
 * EVERY mutation of `_pending`.
 */
function syncWorkerRef(): void {
  if (!_worker) return;
  if (_pending.size > 0) {
    _worker.ref();
    _workerRefd = true;
  } else {
    _worker.unref();
    _workerRefd = false;
  }
}

/**
 * Settle every in-flight request instead of dropping it.
 *
 * Clearing `_pending` without rejecting leaves each caller's promise pending
 * FOREVER — and the caller here is an HTTP route handler
 * (endpoint-route/routes/zero-harness/rest-query.ts), so a dropped request
 * is a response that is never sent.
 */
function rejectAllPending(err: Error): void {
  if (_pending.size === 0) return;
  for (const [, p] of _pending) p.reject(err);
  _pending.clear();
}

function ensureWorker(): Promise<void> {
  if (_workerDisabled) return Promise.reject(new Error('cpu-task worker disabled'));
  if (_workerReady) return _workerReady;

  _workerReady = new Promise<void>((resolveReady, rejectReady) => {
    try {
      _worker = new Worker(workerPath());
      // A fresh Worker is ref'd by libuv until we say otherwise.
      _workerRefd = true;
    } catch (err) {
      _workerDisabled = true;
      rejectReady(err as Error);
      return;
    }

    let initialized = false;

    _worker.on(
      'message',
      (msg: {
        kind: string;
        id?: number;
        json?: string | null;
        error?: string;
      }) => {
        if (msg.kind === 'ready') {
          initialized = true;
          syncWorkerRef();
          resolveReady();
          return;
        }
        if (typeof msg.id !== 'number') return;
        const p = _pending.get(msg.id);
        if (!p) return;
        _pending.delete(msg.id);
        syncWorkerRef();
        if (msg.kind === 'serialize_ok') {
          // Reset the crash run on a SERVED REQUEST, not on a successful
          // spawn: a worker that spawns cleanly and then dies on every
          // message would reset the counter each cycle and the breaker would
          // never trip — which is the one case it exists for.
          _consecutiveCrashes = 0;
          p.resolve({ json: msg.json ?? null });
        } else {
          p.reject(new Error(msg.error ?? 'cpu-task worker error'));
        }
      },
    );

    _worker.on('error', (err) => {
      rejectAllPending(err);
      // A runtime crash clears the HANDLE so the next call respawns — it does
      // NOT disable the offload. Only a run of consecutive crashes does, so a
      // transient failure self-heals while a permanently broken worker cannot
      // be respawned on every request (WI-37688).
      _worker = null;
      _workerReady = null;
      if (++_consecutiveCrashes >= MAX_CONSECUTIVE_CRASHES) _workerDisabled = true;
      if (!initialized) rejectReady(err);
    });

    _worker.on('exit', (code) => {
      if (code !== 0 && !initialized) {
        rejectReady(new Error(`cpu-task worker exited with code ${code} before ready`));
      }
      // A worker can exit WITHOUT an 'error' event (terminate, an OOM kill,
      // process.exit inside the thread). Stragglers must be settled here too,
      // or their callers wait forever.
      rejectAllPending(new Error(`cpu-task worker exited with code ${code}`));
      _worker = null;
      _workerReady = null;
    });
  });

  return _workerReady;
}

/** BigInt→Number replacer (inline fallback path — byte-identical to worker). */
function bigIntReplacer(_k: string, v: unknown): unknown {
  return typeof v === 'bigint' ? Number(v) : v;
}

/**
 * Serialize a JSON response body via the CPU-task worker.
 *
 * When `itemCount` is above OFFLOAD_MIN_ITEMS the JSON.stringify is
 * offloaded to the worker thread so it does not block the main event loop.
 * Falls back to sync stringify when the worker is unavailable, disabled, or
 * the batch is small. The response is never compressed — see the file
 * header.
 *
 * @param value     The JS value to serialize.
 * @param itemCount Number of top-level items in the batch; used as a cheap
 *                  proxy for expected payload size.
 */
export async function serializeJsonResponse(
  value: unknown,
  itemCount: number,
): Promise<string> {
  const useWorker = !_workerDisabled && itemCount >= OFFLOAD_MIN_ITEMS;

  if (useWorker) {
    try {
      await ensureWorker();
      const id = _nextId++;
      const result = await new Promise<WorkerResult>((res, rej) => {
        _pending.set(id, { resolve: res, reject: rej });
        syncWorkerRef();
        try {
          _worker!.postMessage({ kind: 'serialize', id, value });
        } catch (err) {
          // A non-cloneable value (or a worker that vanished between the
          // await and here) must not leave a pending entry behind holding
          // the event loop open.
          _pending.delete(id);
          syncWorkerRef();
          rej(err as Error);
        }
      });

      if (result.json !== null) return result.json;
      // Unexpected null result — fall through to sync path.
    } catch {
      // Worker spawn failed or crashed — sync fallback below.
    }
  }

  // Sync fallback (small batch or worker unavailable).
  return JSON.stringify(value, bigIntReplacer);
}

/** Test seam — terminate the worker and reset module state. */
export async function _resetCpuWorker(): Promise<void> {
  if (_worker) {
    try {
      await _worker.terminate();
    } catch {
      /* noop */
    }
  }
  _worker = null;
  _workerReady = null;
  _workerDisabled = false;
  _consecutiveCrashes = 0;
  _workerRefd = false;
  // REJECT stragglers, never drop them — a bare `_pending.clear()` here left
  // the caller's promise unsettled forever (WI-37688). The 'exit' handler
  // fired by terminate() above normally drains this first; the loop is the
  // backstop for anything it did not reach.
  rejectAllPending(new Error('cpu-task worker reset while request in flight'));
  _nextId = 0;
}

/**
 * Test seam — drive the registered 'error' handler with a synthetic crash.
 *
 * The worker script is fully try/catch'd, so there is no message a test can
 * send that makes the thread throw; without this seam the crash-recovery path
 * (the defect in WI-37688 — a transient crash used to disable the offload for
 * the whole process lifetime) is unreachable from a test and would ship
 * unguarded. Emitting on the Worker invokes the REAL handler registered in
 * `ensureWorker`, not a copy of it.
 *
 * @returns false when there is no live worker to crash.
 */
export function _injectWorkerCrashForTest(err: Error): boolean {
  if (!_worker) return false;
  _worker.emit('error', err);
  return true;
}

/**
 * Diagnostics, surfaced by `GET /api/health/deep` as its `cpuWorker` block
 * (`endpoint-route/routes/misc/health-deep.ts` → `readCpuWorker`).
 *
 * That consumer is the point of this function, not a nicety: `disabled` latches
 * PERMANENTLY and the caller falls back to inline `JSON.stringify`, so a tripped
 * breaker emits byte-identical output with no error and no log — invisible
 * unless something reads it. It went unread for exactly that reason until
 * WI-37696; if you remove the last caller, this function is dead and the
 * breaker is silent again.
 *
 * `keepAlive` reports whether the worker is currently holding the event loop
 * open; read it in the SAME snapshot as `pendingCount` — asserting the two in
 * separate reads is a race, not an assertion (EI-20053788422725852).
 */
export function getCpuWorkerState(): {
  alive: boolean;
  disabled: boolean;
  pendingCount: number;
  minItems: number;
  keepAlive: boolean;
  consecutiveCrashes: number;
} {
  return {
    alive: _worker !== null,
    disabled: _workerDisabled,
    pendingCount: _pending.size,
    minItems: OFFLOAD_MIN_ITEMS,
    keepAlive: _worker !== null && _workerRefd,
    consecutiveCrashes: _consecutiveCrashes,
  };
}
