/**
 * WI-10002855 — the own-log compaction fold runs in a worker thread.
 *
 * The inline fold of the tower's first papercusp compaction (7.76M ops from index 0)
 * held bg-host's event loop for 30+ minutes: lag p50 2.8s, every PG connect timed out,
 * routines and git-sync stalled. These tests pin the replacement:
 *  - the offloaded producer appends BYTE-IDENTICAL blocks to the inline producer, for a
 *    fresh fold, a seeded fold (a prior set on the log) and deletes/tombstones — using
 *    the REAL worker thread, so the worker loading under this runtime is itself proven;
 *  - the raw read/append seam round-trips exactly what the json session stores;
 *  - a worker that cannot start fails the compaction (no silent inline fallback);
 *  - the worker's state machine refuses out-of-order use and releases its fold on finish.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import Corestore from 'corestore';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openOwnLog, type OwnLog, type PeerLogOp } from '../peer-log';
import {
  produceLogSnapshot,
  SnapshotAbortedError,
  SNAPSHOT_READ_CONCURRENCY,
  type SnapshotPayload,
} from '../log-snapshot';
import {
  acquireSnapshotFoldSlot,
  SNAPSHOT_FOLD_MAX_CONCURRENT,
  SnapshotFoldWorker,
  snapshotFoldSlotState,
} from '../snapshot-fold-offload';
import {
  createSnapshotFoldHandler,
  encodeStoredBlock,
  packBlocks,
  type SnapshotFoldResponse,
} from '../snapshot-fold-protocol';
import { CURRENT_SCHEMA_VERSION } from '../schema-version';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

/**
 * Every log shares ONE fixed primary key, so each store derives the SAME peer-log
 * keypair. The snapshot chunks embed `author_pubkey` (the log key), so without this two
 * logs could never produce identical bytes and the byte comparisons below would be
 * vacuous in the other direction — always failing for a reason unrelated to the fold.
 */
const TEST_PRIMARY_KEY = Buffer.alloc(32, 7);

async function freshLog(): Promise<OwnLog> {
  const dir = mkdtempSync(join(tmpdir(), 'wi10002855-'));
  const store = new Corestore(dir, { primaryKey: TEST_PRIMARY_KEY, unsafe: true });
  cleanups.push(async () => {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return openOwnLog(store);
}

/** Enough ops to span several read windows, with overwrites and deletes. */
function history(count: number, salt = ''): PeerLogOp[] {
  const ops: PeerLogOp[] = [];
  for (let i = 0; i < count; i++) {
    const key = `K-${i % 97}`;
    ops.push(
      i % 13 === 5
        ? {
            type: 'del',
            table: 'wi10002855_t',
            hbKey: key,
            value: null,
            ts: 10_000 + i,
            schema_version: CURRENT_SCHEMA_VERSION,
            author_pubkey: '', // the owner's single-writer log writes ''
          }
        : {
            type: 'put',
            table: i % 3 === 0 ? 'wi10002855_a' : 'wi10002855_t',
            hbKey: key,
            value: { i, salt, note: 'é∑ unicode survives the raw path' },
            ts: 10_000 + i,
            schema_version: CURRENT_SCHEMA_VERSION,
            author_pubkey: '',
            ...(i % 7 === 0 ? { hlc: `${10_000 + i}:0000:${salt || 'n'}` } : {}),
          },
    );
  }
  return ops;
}

async function rawRange(log: OwnLog, from: number, to: number): Promise<string[]> {
  const out: string[] = [];
  for (let i = from; i < to; i++) out.push(Buffer.from((await log.getRaw!(i))!).toString('hex'));
  return out;
}

const NOW = 50_000;
const inlineOpts = { now: NOW, schemaVersion: CURRENT_SCHEMA_VERSION, maxChunkBytes: 2_048 };
const offloadOpts = {
  ...inlineOpts,
  foldWorker: (init: { excludeTables: readonly string[] }) => SnapshotFoldWorker.open(init),
};

describe('the raw block seam (OwnLog.getRaw / appendRawBatch)', () => {
  it('reads the exact bytes the json session stores, and appends bytes that read back as the op', async () => {
    const log = await freshLog();
    const [op] = history(1);
    await log.append(op!);
    const raw = await log.getRaw!(0);
    expect(Buffer.from(raw!).equals(Buffer.from(encodeStoredBlock(op!)))).toBe(true);
    await log.appendRawBatch!([encodeStoredBlock(op!)]);
    expect(await log.get(1)).toEqual(await log.get(0));
    expect(await log.getRaw!(2)).toBeNull();
    expect(await log.getRaw!(-1)).toBeNull();
  });
});

describe('offloaded own compaction is byte-identical to the inline fold (real worker thread)', () => {
  it('fresh fold from index 0 across several read windows', async () => {
    const ops = history(SNAPSHOT_READ_CONCURRENCY * 3 + 17);
    const a = await freshLog();
    const b = await freshLog();
    await a.appendBatch(ops);
    await b.appendBatch(ops);

    const inline = await produceLogSnapshot(a, inlineOpts);
    const offloaded = await produceLogSnapshot(b, offloadOpts);

    expect(offloaded).toEqual(inline);
    expect(inline.appended).toBe(true);
    expect(inline.chunkCount).toBeGreaterThan(1); // the small chunk cap forces a multi-chunk set
    expect(await rawRange(b, 0, b.length)).toEqual(await rawRange(a, 0, a.length));
  });

  it('applies the P-530 live-receipt census identically inline and in the worker', async () => {
    const receipt = (hbKey: string): PeerLogOp => ({
      type: 'put',
      table: 'engineer-issues',
      hbKey,
      value: { payload: { resource_governor: { schemaVersion: 1, state: 'completed' } } },
      ts: 20_000,
      schema_version: CURRENT_SCHEMA_VERSION,
      author_pubkey: '',
    });
    const ops: PeerLogOp[] = [
      receipt('papercusp/WI-DEAD'),
      receipt('papercusp/WI-LIVE'),
      { ...receipt('papercusp/WI-NORMAL'), value: { payload: { real_work: true } } },
    ];
    const filter = {
      maxSourceIndexExclusive: ops.length,
      liveQualifiedKeys: ['papercusp/WI-LIVE'],
    };
    const a = await freshLog();
    const b = await freshLog();
    await a.appendBatch(ops);
    await b.appendBatch(ops);

    const inline = await produceLogSnapshot(a, { ...inlineOpts, governorReceiptFilter: filter });
    const offloaded = await produceLogSnapshot(b, { ...offloadOpts, governorReceiptFilter: filter });

    expect(offloaded).toEqual(inline);
    expect(inline.droppedGovernorReceipts).toBe(1);
    expect(inline.rowCount).toBe(2);
    expect(await rawRange(b, 0, b.length)).toEqual(await rawRange(a, 0, a.length));
    const rows = Array.from({ length: inline.chunkCount }, (_, i) => i)
      .map((i) => a.get(inline.coversUpTo + i))
      .reduce(
        async (accP, opP) => {
          const acc = await accP;
          const op = await opP;
          return acc.concat((op?.value as SnapshotPayload | undefined)?.rows ?? []);
        },
        Promise.resolve([] as SnapshotPayload['rows']),
      );
    await expect(rows).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ hbKey: 'papercusp/WI-LIVE' }),
        expect.objectContaining({ hbKey: 'papercusp/WI-NORMAL' }),
      ]),
    );
    await expect(rows).resolves.not.toEqual(
      expect.arrayContaining([expect.objectContaining({ hbKey: 'papercusp/WI-DEAD' })]),
    );
  });

  it('seeded fold: a prior complete set on the log is found by the summary seek and folded in the worker', async () => {
    const a = await freshLog();
    const b = await freshLog();
    for (const log of [a, b]) {
      await log.appendBatch(history(300, 'first'));
      await produceLogSnapshot(log, inlineOpts); // the prior set, written the same way on both
      await log.appendBatch(history(120, 'second'));
    }
    const hint = { coversUpTo: 300, chunkCount: (await produceLogSnapshotPeek(a)).chunkCount };

    const inline = await produceLogSnapshot(a, { ...inlineOpts, priorSnapshotHint: hint });
    const offloaded = await produceLogSnapshot(b, { ...offloadOpts, priorSnapshotHint: hint });

    expect(offloaded).toEqual(inline);
    expect(await rawRange(b, 0, b.length)).toEqual(await rawRange(a, 0, a.length));
  });

  it('an empty log appends nothing on either path', async () => {
    const log = await freshLog();
    expect(await produceLogSnapshot(log, offloadOpts)).toEqual({
      appended: false,
      coversUpTo: 0,
      rowCount: 0,
      chunkCount: 0,
    });
  });

  it('reports fold progress from the worker path, monotonically, ending at the log length', async () => {
    const log = await freshLog();
    await log.appendBatch(history(SNAPSHOT_READ_CONCURRENCY * 2 + 3));
    const seen: number[] = [];
    await produceLogSnapshot(log, { ...offloadOpts, onProgress: (p) => seen.push(p.processed) });
    expect(seen.length).toBeGreaterThanOrEqual(3);
    expect(seen).toEqual([...seen].sort((x, y) => x - y));
    expect(seen[seen.length - 1]).toBe(SNAPSHOT_READ_CONCURRENCY * 2 + 3);
  });

  it('shouldAbort stops a running fold between windows and appends nothing', async () => {
    const log = await freshLog();
    await log.appendBatch(history(SNAPSHOT_READ_CONCURRENCY * 4));
    const lengthBefore = log.length;
    let windows = 0;
    await expect(
      produceLogSnapshot(log, { ...offloadOpts, onProgress: () => void windows++, shouldAbort: () => windows >= 1 }),
    ).rejects.toThrow(/aborted mid-fold/);
    expect(log.length).toBe(lengthBefore);
  });
});

/** chunkCount of the newest set: it is the only snapshot on the log in the seeded test. */
async function produceLogSnapshotPeek(log: OwnLog): Promise<{ chunkCount: number }> {
  const op = await log.get(300);
  return { chunkCount: (op!.value as { chunkCount: number }).chunkCount };
}

describe('no inline fallback: a worker that cannot run fails the compaction', () => {
  it('open() rejects when the worker script does not exist', async () => {
    await expect(
      SnapshotFoldWorker.open(
        { excludeTables: [] },
        { workerPath: join(tmpdir(), 'no-such-snapshot-fold.worker.mjs') },
      ),
    ).rejects.toBeTruthy();
  });

  it('the producer surfaces the failure and appends nothing', async () => {
    const log = await freshLog();
    await log.appendBatch(history(10));
    await expect(
      produceLogSnapshot(log, {
        ...inlineOpts,
        foldWorker: () => Promise.reject(new Error('worker unavailable')),
      }),
    ).rejects.toThrow(/worker unavailable/);
    expect(log.length).toBe(10);
  });
});

describe('the worker state machine (createSnapshotFoldHandler)', () => {
  const block = (op: PeerLogOp) => packBlocks([encodeStoredBlock(op)]);

  it('refuses a fold before init, and after finish released the fold', () => {
    const handle = createSnapshotFoldHandler();
    const [op] = history(1);
    const before: SnapshotFoldResponse = handle({ kind: 'fold', id: 1, ...block(op!) }).res;
    expect(before.kind).toBe('error');

    expect(handle({ kind: 'init', id: 2, excludeTables: [] }).res.kind).toBe('ok');
    const folded = handle({ kind: 'fold', id: 3, ...block(op!) }).res;
    expect(folded).toMatchObject({ kind: 'folded', decodedOps: 1, keyCount: 1 });
    const finished = handle({
      kind: 'finish',
      id: 4,
      now: NOW,
      coversUpTo: 1,
      author_pubkey: 'k',
      ts: NOW,
      schema_version: CURRENT_SCHEMA_VERSION,
      excludeTables: [],
    });
    expect(finished.res).toMatchObject({ kind: 'finished', rowCount: 1 });
    expect(finished.transfer).toHaveLength(1);
    expect(handle({ kind: 'fold', id: 5, ...block(op!) }).res.kind).toBe('error');
  });

  it('inspect returns snapshot metadata without rows, and keeps non-snapshot ops tiny', () => {
    const handle = createSnapshotFoldHandler();
    const snapshotOp = {
      type: 'put',
      table: '__snapshot__',
      hbKey: 'snap',
      ts: 1,
      schema_version: CURRENT_SCHEMA_VERSION,
      value: { coversUpTo: 7, chunkIdx: 0, chunkCount: 2, excludeTables: ['x'], rows: [{ table: 't', hbKey: 'k' }] },
    } as unknown as PeerLogOp;
    const [plain] = history(1);
    const res = handle({
      kind: 'inspect',
      id: 1,
      ...packBlocks([encodeStoredBlock(snapshotOp), null, encodeStoredBlock(plain!)]),
    }).res;
    expect(res.kind).toBe('inspected');
    const ops = (res as Extract<SnapshotFoldResponse, { kind: 'inspected' }>).ops;
    expect(ops[0]!.value).toEqual({ coversUpTo: 7, chunkIdx: 0, chunkCount: 2, excludeTables: ['x'], rows: [] });
    expect(ops[1]).toBeNull();
    expect(ops[2]).not.toHaveProperty('value');
  });
});

/**
 * WI-10002836 — the per-worker heap cap bounds the host only if folds do not stack: one
 * bg-host boots ~100 pots, many due at the same boot. `SnapshotFoldWorker.open` therefore
 * takes a process-wide fold slot, held until the worker is gone. A leaked slot would freeze
 * every other pot's compaction forever, so each release path is pinned here.
 */
describe('process-wide fold slots (SNAPSHOT_FOLD_MAX_CONCURRENT)', () => {
  const settle = () => new Promise((r) => setTimeout(r, 20));

  it('allows one fold at a time by default', () => {
    expect(SNAPSHOT_FOLD_MAX_CONCURRENT).toBe(1);
  });

  it('a second acquire waits for the first release; release is idempotent', async () => {
    expect(snapshotFoldSlotState()).toEqual({ active: 0, waiting: 0 });
    const release1 = await acquireSnapshotFoldSlot();
    let granted2 = false;
    const second = acquireSnapshotFoldSlot().then((r) => {
      granted2 = true;
      return r;
    });
    await settle();
    expect(granted2).toBe(false);
    expect(snapshotFoldSlotState()).toEqual({ active: 1, waiting: 1 });

    release1();
    const release2 = await second;
    expect(granted2).toBe(true);
    release1(); // a double release must not hand out a second concurrent slot
    expect(snapshotFoldSlotState()).toEqual({ active: 1, waiting: 0 });
    release2();
    expect(snapshotFoldSlotState()).toEqual({ active: 0, waiting: 0 });
  });

  it('an abort while queued rejects with SnapshotAbortedError and leaves the queue', async () => {
    const release1 = await acquireSnapshotFoldSlot();
    const ac = new AbortController();
    const queued = acquireSnapshotFoldSlot(ac.signal);
    await settle();
    expect(snapshotFoldSlotState()).toEqual({ active: 1, waiting: 1 });
    ac.abort();
    await expect(queued).rejects.toBeInstanceOf(SnapshotAbortedError);
    expect(snapshotFoldSlotState()).toEqual({ active: 1, waiting: 0 });
    release1();
    expect(snapshotFoldSlotState()).toEqual({ active: 0, waiting: 0 });
  });

  it('an already-aborted signal is refused without taking a slot', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(acquireSnapshotFoldSlot(ac.signal)).rejects.toBeInstanceOf(SnapshotAbortedError);
    expect(snapshotFoldSlotState()).toEqual({ active: 0, waiting: 0 });
  });

  it('a second worker waits while one is open, and close() hands the slot on (real worker)', async () => {
    const first = await SnapshotFoldWorker.open({ excludeTables: [] });
    let opened2 = false;
    const secondOpen = SnapshotFoldWorker.open({ excludeTables: [] }).then((w) => {
      opened2 = true;
      return w;
    });
    await settle();
    expect(opened2).toBe(false);
    expect(snapshotFoldSlotState()).toEqual({ active: 1, waiting: 1 });
    await first.close();
    const second = await secondOpen;
    expect(snapshotFoldSlotState()).toEqual({ active: 1, waiting: 0 });
    await second.close();
    await second.close(); // idempotent
    expect(snapshotFoldSlotState()).toEqual({ active: 0, waiting: 0 });
  });

  it('a worker that dies without close() (e.g. a heap-cap OOM) still releases its slot', async () => {
    const w = await SnapshotFoldWorker.open({ excludeTables: [] });
    expect(snapshotFoldSlotState().active).toBe(1);
    await (w as unknown as { worker: { terminate(): Promise<number> } }).worker.terminate();
    await vi.waitFor(() => expect(snapshotFoldSlotState()).toEqual({ active: 0, waiting: 0 }));
    await expect(w.fold([])).rejects.toThrow(/exited unexpectedly/);
    await w.close();
    expect(snapshotFoldSlotState()).toEqual({ active: 0, waiting: 0 });
  });

  it('a worker that cannot start releases its slot', async () => {
    await expect(
      SnapshotFoldWorker.open(
        { excludeTables: [] },
        { workerPath: join(tmpdir(), 'no-such-snapshot-fold.worker.mjs') },
      ),
    ).rejects.toBeTruthy();
    await vi.waitFor(() => expect(snapshotFoldSlotState()).toEqual({ active: 0, waiting: 0 }));
  });
});
