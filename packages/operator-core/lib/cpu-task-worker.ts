/**
 * cpu-task-worker.ts — offload CPU-heavy synchronous work to a persistent
 * worker_threads Worker so the operator main event loop is not blocked.
 *
 * infra-perf-reliability-audit-round3-2026-06-19 P-011 / round4 P-002.
 *
 * Background: the F1 cpuprofile attributed two hot-path culprits that run
 * SYNCHRONOUSLY on the main thread per SSE polling tick:
 *
 *  (a) JSON.stringify on large result-batch payloads (coord:plan-events
 *      3.5 MB, plans:list 358 KB) — blocks ~30–50 ms per call.
 *  (b) gzipSync on the same payloads — blocks ~50–100 ms per call.
 *
 * At 350–630 elevated windows/hr this compounds into p95 501 ms / worst
 * 3475 ms event-loop lag seen in round-3 cpuprofile captures.
 *
 * Architecture: one persistent worker per process (lazy-spawned on first
 * call). The main thread postMessages a `{ kind:'serialize', id, value,
 * gzip }` envelope; the worker does JSON.stringify + optional gzip and
 * transfers the result back. Falls back to inline sync execution on the
 * main thread when worker_threads are unavailable or the worker crashes —
 * byte-identical behavior (same BigInt→Number replacer), just slower.
 *
 * The structured-clone transfer of `value` to the worker is faster than
 * JSON.stringify because V8 uses a compact binary format internally.
 * Main-thread blocking is reduced to the clone step (~10 ms for a 3.5 MB
 * object) rather than stringify + gzip (~80–130 ms).
 *
 * Pattern follows libs/generic/memory/src/local-embedder-worker.ts exactly.
 */

import { Worker } from 'node:worker_threads';
import { gzipSync } from 'node:zlib';
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
  compressed: Uint8Array | null;
}

let _worker: Worker | null = null;
let _workerReady: Promise<void> | null = null;
let _nextId = 0;
const _pending = new Map<number, PendingRequest>();
let _workerDisabled = false;

function workerPath(): string {
  const here =
    typeof __filename !== 'undefined' ? __filename : fileURLToPath(import.meta.url);
  return resolve(dirname(here), 'cpu-task-worker.script.mjs');
}

function ensureWorker(): Promise<void> {
  if (_workerDisabled) return Promise.reject(new Error('cpu-task worker disabled'));
  if (_workerReady) return _workerReady;

  _workerReady = new Promise<void>((resolveReady, rejectReady) => {
    try {
      _worker = new Worker(workerPath());
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
        compressed?: Uint8Array | null;
        error?: string;
      }) => {
        if (msg.kind === 'ready') {
          initialized = true;
          resolveReady();
          return;
        }
        if (typeof msg.id !== 'number') return;
        const p = _pending.get(msg.id);
        if (!p) return;
        _pending.delete(msg.id);
        if (msg.kind === 'serialize_ok') {
          p.resolve({ json: msg.json ?? null, compressed: msg.compressed ?? null });
        } else {
          p.reject(new Error(msg.error ?? 'cpu-task worker error'));
        }
      },
    );

    _worker.on('error', (err) => {
      for (const [, p] of _pending) p.reject(err);
      _pending.clear();
      _workerDisabled = true;
      _worker = null;
      _workerReady = null;
      if (!initialized) rejectReady(err);
    });

    _worker.on('exit', (code) => {
      if (code !== 0 && !initialized) {
        rejectReady(new Error(`cpu-task worker exited with code ${code} before ready`));
      }
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
 * Produce an HTTP-ready body for a JSON response via the CPU-task worker.
 *
 * When `acceptsGzip` is true AND `itemCount` is above OFFLOAD_MIN_ITEMS,
 * both JSON.stringify AND gzip are offloaded to the worker thread so
 * neither blocks the main event loop. Falls back to sync stringify +
 * gzipSync when the worker is unavailable, disabled, or the batch is small.
 *
 * @param value       The JS value to serialize.
 * @param acceptsGzip True when the HTTP client sent Accept-Encoding: gzip.
 * @param itemCount   Number of top-level items in the batch; used as a
 *                    cheap proxy for expected payload size.
 */
export async function serializeJsonResponse(
  value: unknown,
  acceptsGzip: boolean,
  itemCount: number,
): Promise<{ body: string | Buffer; encoding: 'gzip' | null }> {
  const useWorker = !_workerDisabled && itemCount >= OFFLOAD_MIN_ITEMS;

  if (useWorker) {
    try {
      await ensureWorker();
      const id = _nextId++;
      const result = await new Promise<WorkerResult>((res, rej) => {
        _pending.set(id, { resolve: res, reject: rej });
        _worker!.postMessage({
          kind: 'serialize',
          id,
          value,
          gzip: acceptsGzip,
        });
      });

      if (acceptsGzip && result.compressed) {
        return { body: Buffer.from(result.compressed), encoding: 'gzip' };
      }
      if (!acceptsGzip && result.json !== null) {
        return { body: result.json, encoding: null };
      }
      // Unexpected null result — fall through to sync path.
    } catch {
      // Worker spawn failed or crashed — sync fallback below.
    }
  }

  // Sync fallback (small batch or worker unavailable).
  const json = JSON.stringify(value, bigIntReplacer);
  if (acceptsGzip && json.length >= 1024) {
    try {
      return { body: gzipSync(json), encoding: 'gzip' };
    } catch {
      /* gzip failed — return plain JSON */
    }
  }
  return { body: json, encoding: null };
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
  _pending.clear();
  _nextId = 0;
}

/** Diagnostics for /api/health and the loop-monitor dashboard. */
export function getCpuWorkerState(): {
  alive: boolean;
  disabled: boolean;
  pendingCount: number;
  minItems: number;
} {
  return {
    alive: _worker !== null,
    disabled: _workerDisabled,
    pendingCount: _pending.size,
    minItems: OFFLOAD_MIN_ITEMS,
  };
}
