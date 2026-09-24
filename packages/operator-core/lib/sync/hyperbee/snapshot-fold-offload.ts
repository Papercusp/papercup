/**
 * WI-10002855 — the main-thread client for the snapshot-fold worker.
 *
 * One worker per compaction: the fold holds the whole live-key set, so it is stateful
 * and long-lived for exactly one run, and must never share a thread with anything a
 * request path waits on (cpu-task-worker.ts serves request serialization — a 30-minute
 * fold there would stall every large response).
 *
 * There is deliberately NO inline fallback. The inline fold is the defect: it froze
 * bg-host for 30+ minutes. If the worker cannot start or dies, the compaction FAILS —
 * `runOwnCompaction` records a `log compaction failed` boot row and the next merge pass
 * retries — which costs one snapshot, not the host.
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { SnapshotFoldWindowResult, SnapshotFoldWorkerLike } from './log-snapshot';
import { resolveMemoryWatchdogLimitMb } from '../../memory-watchdog';
import type { PeerLogOp } from './peer-log';
import {
  packBlocks,
  unpackBlocks,
  type SnapshotFoldRequest,
  type SnapshotFoldResponse,
} from './snapshot-fold-protocol';

type RequestBody = SnapshotFoldRequest extends infer R ? (R extends { id: number } ? Omit<R, 'id'> : never) : never;

/**
 * The bundled `.mjs` beside the executing module (dist-host / the desktop sidecar),
 * else the source-tree bootstrap that loads the `.ts` worker through tsx (tsx and
 * vitest runtimes — see snapshot-fold.worker.dev.mjs for why a plain `.ts` path fails).
 * Same bundled-first resolution as the event-loop sentinel worker, for the same
 * reason: esbuild emits no sibling assets on its own.
 */
export function snapshotFoldWorkerPath(): string {
  const here = typeof __filename !== 'undefined' ? __filename : fileURLToPath(import.meta.url);
  const dir = dirname(here);
  const bundled = resolve(dir, 'snapshot-fold.worker.mjs');
  return existsSync(bundled) ? bundled : resolve(dir, 'snapshot-fold.worker.dev.mjs');
}

/** Fraction of the host's committed-memory recycle limit the fold's old space may use. */
export const SNAPSHOT_FOLD_WORKER_HEAP_FRACTION = 0.45;
/** Floor, so a small-limit host can still fold a small pot. */
export const SNAPSHOT_FOLD_WORKER_MIN_HEAP_MB = 2048;

/**
 * WI-10002836 — the fold worker's explicit old-space cap, derived from the host's recycle
 * limit (`resolveMemoryWatchdogLimitMb`, 24576 MiB for bg-host on the tower).
 *
 * WHY EXPLICIT. Unset, the worker inherits the host's `--max-old-space-size` (12288 on
 * bg-host), and V8 does not count ArrayBuffers against it. MEASURED 2026-09-24: the fold
 * sat near that cap, GC-thrashing, while the process's committed memory climbed to
 * 25.1 GB and the memory watchdog recycled the WHOLE host, not the fold. Capping the
 * worker below the recycle limit makes a runaway fold end as a worker OOM, which
 * `SnapshotFoldWorker` reports as a failed compaction while the host keeps serving.
 * The remaining ~55% is for the host's own heap, its in-flight read windows and native memory.
 */
export function snapshotFoldWorkerHeapMb(limitMb: number = resolveMemoryWatchdogLimitMb()): number {
  return Math.max(SNAPSHOT_FOLD_WORKER_MIN_HEAP_MB, Math.floor(limitMb * SNAPSHOT_FOLD_WORKER_HEAP_FRACTION));
}

export class SnapshotFoldWorker implements SnapshotFoldWorkerLike {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (r: SnapshotFoldResponse) => void; reject: (e: Error) => void }>();
  private failure: Error | null = null;
  private closed = false;

  private constructor(private readonly worker: Worker) {
    worker.on('message', (res: SnapshotFoldResponse) => {
      const waiter = this.pending.get(res.id);
      if (!waiter) return;
      this.pending.delete(res.id);
      if (res.kind === 'error') waiter.reject(new Error(`snapshot fold worker: ${res.message}`));
      else waiter.resolve(res);
    });
    // Named, so the compaction's failure row says WHICH worker died and why — a heap-cap
    // OOM (`resourceLimits`, WI-10002836) arrives here as Node's ERR_WORKER_OUT_OF_MEMORY.
    worker.on('error', (err) => {
      const e = err instanceof Error ? err : new Error(String(err));
      const code = (e as { code?: unknown }).code;
      this.failAll(new Error(`snapshot fold worker failed${typeof code === 'string' ? ` (${code})` : ''}: ${e.message}`));
    });
    worker.on('exit', (code) => {
      if (!this.closed) this.failAll(new Error(`snapshot fold worker exited unexpectedly (code ${code})`));
    });
  }

  /** Spawn a worker and initialize its fold. Rejects if the worker cannot start. */
  static async open(
    init: { excludeTables: readonly string[] },
    opts: { workerPath?: string; maxOldGenerationSizeMb?: number } = {},
  ): Promise<SnapshotFoldWorker> {
    const client = new SnapshotFoldWorker(
      new Worker(opts.workerPath ?? snapshotFoldWorkerPath(), {
        resourceLimits: { maxOldGenerationSizeMb: opts.maxOldGenerationSizeMb ?? snapshotFoldWorkerHeapMb() },
      }),
    );
    try {
      await client.request({ kind: 'init', excludeTables: [...init.excludeTables] });
    } catch (e) {
      await client.close();
      throw e;
    }
    return client;
  }

  async fold(
    blocks: ReadonlyArray<Uint8Array | null>,
    opts: { skipSnapshotOps?: boolean } = {},
  ): Promise<SnapshotFoldWindowResult> {
    const { buf, lengths } = packBlocks(blocks);
    const res = await this.request(
      { kind: 'fold', buf, lengths, ...(opts.skipSnapshotOps ? { skipSnapshotOps: true } : {}) },
      [buf],
    );
    if (res.kind !== 'folded') throw new Error(`snapshot fold worker: unexpected reply ${res.kind} to fold`);
    return {
      decodedOps: res.decodedOps,
      decodedBytes: res.decodedBytes,
      skippedSnapshotOps: res.skippedSnapshotOps,
      keyCount: res.keyCount,
      ...(res.heapUsedBytes !== undefined ? { heapUsedBytes: res.heapUsedBytes } : {}),
    };
  }

  async inspect(blocks: ReadonlyArray<Uint8Array | null>): Promise<Array<PeerLogOp | null>> {
    const { buf, lengths } = packBlocks(blocks);
    const res = await this.request({ kind: 'inspect', buf, lengths }, [buf]);
    if (res.kind !== 'inspected') throw new Error(`snapshot fold worker: unexpected reply ${res.kind} to inspect`);
    return res.ops;
  }

  async finish(args: {
    now: number;
    coversUpTo: number;
    author_pubkey: string;
    ts: number;
    schema_version: number;
    maxChunkBytes?: number;
    excludeTables: readonly string[];
  }): Promise<{ blocks: Uint8Array[]; rowCount: number }> {
    const res = await this.request({ kind: 'finish', ...args, excludeTables: [...args.excludeTables] });
    if (res.kind !== 'finished') throw new Error(`snapshot fold worker: unexpected reply ${res.kind} to finish`);
    const blocks = unpackBlocks(res.buf, res.lengths).map((b, i) => {
      if (!b) throw new Error(`snapshot fold worker: finish returned an empty chunk at ${i}`);
      return b;
    });
    return { blocks, rowCount: res.rowCount };
  }

  /** Terminate the thread (releasing its heap). Idempotent. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.failAll(new Error('snapshot fold worker closed'));
    await this.worker.terminate();
  }

  private request(body: RequestBody, transfer: ArrayBuffer[] = []): Promise<SnapshotFoldResponse> {
    if (this.failure) return Promise.reject(this.failure);
    const id = this.nextId++;
    return new Promise<SnapshotFoldResponse>((resolveReply, reject) => {
      this.pending.set(id, { resolve: resolveReply, reject });
      try {
        this.worker.postMessage({ ...body, id } as SnapshotFoldRequest, transfer);
      } catch (e) {
        this.pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  private failAll(err: Error): void {
    this.failure ??= err;
    for (const waiter of this.pending.values()) waiter.reject(err);
    this.pending.clear();
  }
}
