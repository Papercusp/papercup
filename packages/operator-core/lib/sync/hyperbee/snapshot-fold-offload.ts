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
import type { SnapshotFoldWorkerLike } from './log-snapshot';
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
    worker.on('error', (err) => this.failAll(err instanceof Error ? err : new Error(String(err))));
    worker.on('exit', (code) => {
      if (!this.closed) this.failAll(new Error(`snapshot fold worker exited unexpectedly (code ${code})`));
    });
  }

  /** Spawn a worker and initialize its fold. Rejects if the worker cannot start. */
  static async open(
    init: { excludeTables: readonly string[] },
    opts: { workerPath?: string } = {},
  ): Promise<SnapshotFoldWorker> {
    const client = new SnapshotFoldWorker(new Worker(opts.workerPath ?? snapshotFoldWorkerPath()));
    try {
      await client.request({ kind: 'init', excludeTables: [...init.excludeTables] });
    } catch (e) {
      await client.close();
      throw e;
    }
    return client;
  }

  async fold(blocks: ReadonlyArray<Uint8Array | null>): Promise<{ decodedOps: number; decodedBytes: number }> {
    const { buf, lengths } = packBlocks(blocks);
    const res = await this.request({ kind: 'fold', buf, lengths }, [buf]);
    if (res.kind !== 'folded') throw new Error(`snapshot fold worker: unexpected reply ${res.kind} to fold`);
    return { decodedOps: res.decodedOps, decodedBytes: res.decodedBytes };
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
