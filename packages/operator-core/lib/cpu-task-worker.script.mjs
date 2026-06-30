/**
 * Worker script for cpu-task-worker.ts — handles CPU-heavy synchronous work
 * off the operator main thread:
 *
 *   serialize  → JSON.stringify (with BigInt→Number replacer) + optional gzip
 *
 * Runs in a dedicated worker_threads thread so the main event loop is free
 * during the blocking compute. Protocol is intentionally minimal — one task
 * type, round-trip id for pending-map correlation.
 *
 * infra-perf-reliability-audit-round3-2026-06-19 P-011 / round4 P-002.
 *
 * Protocol (main → worker):
 *   { kind: 'serialize', id: number, value: unknown, gzip: boolean }
 *
 * Protocol (worker → main):
 *   { kind: 'ready' }
 *   { kind: 'serialize_ok', id: number, json: string|null, compressed: Uint8Array|null }
 *   { kind: 'serialize_err', id: number, error: string }
 *
 * Plain ESM .mjs (no TypeScript transform) — same convention as
 * local-embedder-worker.script.mjs.
 */

import { parentPort } from 'node:worker_threads';
import { gzip as gzipCallback } from 'node:zlib';
import { promisify } from 'node:util';

const gzipAsync = promisify(gzipCallback);

/**
 * BigInt-safe JSON.stringify replacer. Matches the replacer used in
 * rest-query-batch.ts so the worker output is byte-identical to what the
 * main thread produced before.
 */
function replaceBigInt(_k, v) {
  return typeof v === 'bigint' ? Number(v) : v;
}

parentPort.on('message', async (msg) => {
  if (!msg || typeof msg !== 'object') return;
  const { kind, id } = msg;

  if (kind !== 'serialize') return;

  try {
    const json = JSON.stringify(msg.value, replaceBigInt);

    if (msg.gzip) {
      // gzip runs async on a libuv thread pool slot — even from a worker
      // thread this avoids blocking the worker's own JS loop, and crucially
      // frees the MAIN loop immediately after postMessage returns the structured clone.
      const buf = await gzipAsync(json);
      // Transfer the underlying ArrayBuffer so the main thread receives
      // a zero-copy view (Transferable, avoids a Buffer clone across the channel).
      const arr = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
      parentPort.postMessage(
        { kind: 'serialize_ok', id, json: null, compressed: arr },
        [arr.buffer],
      );
    } else {
      parentPort.postMessage({ kind: 'serialize_ok', id, json, compressed: null });
    }
  } catch (err) {
    parentPort.postMessage({
      kind: 'serialize_err',
      id,
      error: err && err.message ? err.message : String(err),
    });
  }
});

// Signal ready immediately — no heavy init here; the worker is cheap to spawn.
parentPort.postMessage({ kind: 'ready' });
