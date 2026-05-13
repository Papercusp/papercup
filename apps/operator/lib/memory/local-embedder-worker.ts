/**
 * Worker-thread isolated local embedder.
 *
 * The @huggingface/transformers BGE-small pipeline runs ONNX inference
 * that can take 100-500ms per embedding on a modest CPU. Running it on
 * the Node.js main event loop blocks every concurrent request during
 * that window. This module wraps the pipeline in a `worker_threads`
 * Worker so embedding work happens off the main thread.
 *
 * Step B1 of Tier-3 follow-up arc.
 *
 * Architecture: one persistent worker per process (lazy-spawned on first
 * embed call). The worker holds the warm pipeline; main-thread requests
 * marshall {id, text} → worker via `postMessage`, await on a pending
 * Promise keyed by id, and resolve when {id, vector} comes back.
 *
 * Falls back to inline (main-thread) embedding if worker_threads can't
 * be loaded — keeps behavior backward-compatible.
 */

import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

interface PendingRequest {
  resolve: (v: number[]) => void;
  reject: (err: Error) => void;
}

let _worker: Worker | null = null;
let _workerReady: Promise<void> | null = null;
let _nextId = 0;
const _pending = new Map<number, PendingRequest>();
let _workerDisabled = false;

function workerPath(): string {
  // The worker script is co-located in the same dir as this module.
  // Resolved at runtime so the path works after build-time bundling
  // (Next standalone copies the file alongside).
  const here = typeof __filename !== 'undefined'
    ? __filename
    : fileURLToPath(import.meta.url);
  return resolve(dirname(here), 'local-embedder-worker.script.mjs');
}

function ensureWorker(): Promise<void> {
  if (_workerDisabled) return Promise.reject(new Error('worker disabled'));
  if (_workerReady) return _workerReady;

  _workerReady = new Promise<void>((resolveReady, rejectReady) => {
    try {
      _worker = new Worker(workerPath(), {
        // execArgv passthrough is fine — the script is plain JS,
        // no ts-node loader needed.
      });
    } catch (err) {
      _workerDisabled = true;
      rejectReady(err as Error);
      return;
    }

    let initialized = false;
    _worker.on('message', (msg: { kind: string; id?: number; vector?: number[]; error?: string }) => {
      if (msg.kind === 'ready') {
        initialized = true;
        resolveReady();
        return;
      }
      if (typeof msg.id !== 'number') return;
      const p = _pending.get(msg.id);
      if (!p) return;
      _pending.delete(msg.id);
      if (msg.kind === 'embed_ok' && Array.isArray(msg.vector)) {
        p.resolve(msg.vector);
      } else {
        p.reject(new Error(msg.error ?? 'worker error'));
      }
    });
    _worker.on('error', (err) => {
      // Reject every pending request — the worker crashed.
      for (const [, p] of _pending) p.reject(err);
      _pending.clear();
      _workerDisabled = true;
      _worker = null;
      _workerReady = null;
      if (!initialized) rejectReady(err);
    });
    _worker.on('exit', (code) => {
      if (code !== 0 && !initialized) {
        rejectReady(new Error(`worker exited with code ${code} before ready`));
      }
      _worker = null;
      _workerReady = null;
    });
  });

  return _workerReady;
}

/**
 * Embed `text` via the persistent worker thread. Returns a vector
 * (Array<number>) sized to the loaded model's output dimension.
 *
 * Throws when worker_threads is unavailable or the worker has failed
 * — callers should fall back to inline embedding in that case.
 */
export async function embedViaWorker(text: string): Promise<number[]> {
  await ensureWorker();
  if (!_worker) throw new Error('worker not initialized');

  const id = _nextId++;
  return new Promise<number[]>((resolveEmbed, rejectEmbed) => {
    _pending.set(id, { resolve: resolveEmbed, reject: rejectEmbed });
    _worker!.postMessage({ kind: 'embed', id, text });
  });
}

/** Test seam — drop the worker and reset state. */
export async function _resetWorker(): Promise<void> {
  if (_worker) {
    try { await _worker.terminate(); } catch { /* noop */ }
  }
  _worker = null;
  _workerReady = null;
  _workerDisabled = false;
  _pending.clear();
  _nextId = 0;
}

/** Telemetry for /settings/user/memory diagnostics. */
export function getWorkerState(): {
  alive: boolean;
  disabled: boolean;
  pendingCount: number;
} {
  return {
    alive: _worker !== null,
    disabled: _workerDisabled,
    pendingCount: _pending.size,
  };
}
