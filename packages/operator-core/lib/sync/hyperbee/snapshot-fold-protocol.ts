/**
 * WI-10002855 — the message protocol and request handler for the snapshot-fold worker.
 *
 * WHY A WORKER. The first own-log compaction of an existing pot folds its WHOLE history.
 * On the tower's papercusp pot that is 7.76M ops (~37 GB of decoded JSON), and it ran on
 * bg-host's main thread: each 256-op window decoded and folded synchronously, and the
 * fold's live-key Map grew the main isolate's heap past 7 GB. Measured 2026-09-24:
 * event-loop lag p50 2.8s, every PG connect timed out, DBOS queues stalled, the
 * green-checkpoint fire was missed and git-sync stalled — for 30+ minutes.
 *
 * The fold is pure CPU over bytes, so it belongs off the event loop. The main thread
 * keeps only block I/O: it reads RAW blocks (`OwnLog.getRaw`, no JSON.parse), packs them
 * into one transferable buffer per window, and the worker decodes and folds them. The
 * row Map therefore lives in the WORKER's heap, whose GC never pauses the host. The
 * result comes back pre-encoded (`OwnLog.appendRawBatch`), so the main thread never
 * decodes or re-encodes the multi-GB snapshot either.
 *
 * This module is imported by BOTH sides and by the bundled worker, so it must stay
 * free of host-only imports: `log-snapshot.ts` is pure (type-only imports), and this
 * file adds nothing but that.
 */
import {
  buildSnapshotOpsFromRows,
  isSnapshotBlock,
  isSnapshotOp,
  SnapshotRowFolder,
  type SnapshotPayload,
} from './log-snapshot';
import type { PeerLogOp } from './peer-log';

export type SnapshotFoldRequest =
  | { kind: 'init'; id: number; excludeTables: string[] }
  | { kind: 'fold'; id: number; buf: ArrayBuffer; lengths: number[]; skipSnapshotOps?: boolean }
  | { kind: 'inspect'; id: number; buf: ArrayBuffer; lengths: number[] }
  | {
      kind: 'finish';
      id: number;
      now: number;
      coversUpTo: number;
      author_pubkey: string;
      ts: number;
      schema_version: number;
      maxChunkBytes?: number;
      excludeTables: string[];
    };

export type SnapshotFoldResponse =
  | { kind: 'ok'; id: number }
  | {
      kind: 'folded';
      id: number;
      decodedOps: number;
      decodedBytes: number;
      keyCount: number;
      /** Snapshot ops decoded and then passed over (`skipSnapshotOps`). */
      skippedSnapshotOps: number;
      /** The worker isolate's used heap after this fold, when the shell supplies a probe. */
      heapUsedBytes?: number;
    }
  | { kind: 'inspected'; id: number; ops: Array<PeerLogOp | null> }
  | { kind: 'finished'; id: number; buf: ArrayBuffer; lengths: number[]; rowCount: number }
  | { kind: 'error'; id: number; message: string };

/**
 * Pack blocks into ONE buffer (transferable, so crossing the thread boundary is a
 * pointer move, not a copy) plus their lengths. A null block is length -1.
 *
 * The copy into a fresh buffer is deliberate: hypercore can hand back views into a
 * larger shared allocation, and transferring THAT would detach memory still in use.
 */
export function packBlocks(blocks: ReadonlyArray<Uint8Array | null>): { buf: ArrayBuffer; lengths: number[] } {
  let total = 0;
  for (const b of blocks) if (b) total += b.byteLength;
  const out = new Uint8Array(total);
  const lengths: number[] = [];
  let off = 0;
  for (const b of blocks) {
    if (!b) {
      lengths.push(-1);
      continue;
    }
    out.set(b, off);
    off += b.byteLength;
    lengths.push(b.byteLength);
  }
  return { buf: out.buffer, lengths };
}

export function unpackBlocks(buf: ArrayBuffer, lengths: readonly number[]): Array<Uint8Array | null> {
  const view = new Uint8Array(buf);
  const out: Array<Uint8Array | null> = [];
  let off = 0;
  for (const len of lengths) {
    if (len < 0) {
      out.push(null);
      continue;
    }
    out.push(view.subarray(off, off + len));
    off += len;
  }
  return out;
}

const utf8Decoder = new TextDecoder();
const utf8Encoder = new TextEncoder();

/** Decode one stored block. Hypercore's `json` encoding is exactly UTF-8 `JSON.stringify`. */
export function decodeStoredBlock(block: Uint8Array): PeerLogOp {
  return JSON.parse(utf8Decoder.decode(block)) as PeerLogOp;
}

/** Encode one op exactly as hypercore's `json` encoding would store it. */
export function encodeStoredBlock(op: PeerLogOp): Uint8Array {
  return utf8Encoder.encode(JSON.stringify(op));
}

/**
 * The op WITHOUT its bulk: a snapshot op keeps every payload field except `rows` (the
 * seek and the anchor check read only the set metadata and `excludeTables`), and any
 * other op keeps only what `isSnapshotOp` and span checks look at. This is what lets
 * the prior-snapshot seek run on the main thread without holding GBs of decoded rows.
 */
export function summarizeOp(op: PeerLogOp): PeerLogOp {
  if (isSnapshotOp(op)) {
    const payload = (op.value ?? {}) as SnapshotPayload;
    return { ...op, value: { ...payload, rows: [] } };
  }
  return { type: op.type, table: op.table, hbKey: op.hbKey, ts: op.ts, schema_version: op.schema_version } as PeerLogOp;
}

/** One transfer-ready reply. */
export interface SnapshotFoldReply {
  res: SnapshotFoldResponse;
  transfer: ArrayBuffer[];
}

/**
 * The worker's whole state machine, factored out of the thread shell so it is directly
 * testable. `init` → any number of `fold`/`inspect` → `finish` (which releases the fold).
 * Folds must arrive in ascending log-index order — the SnapshotRowFolder contract.
 */
export function createSnapshotFoldHandler(
  opts: {
    /**
     * WI-10002836 — this isolate's used heap, reported on every `folded` reply. The worker
     * shell passes `v8.getHeapStatistics().used_heap_size`; it is injected rather than
     * read here because `process.memoryUsage()` in a direct (main-thread) test would
     * report the TEST's heap and read as the fold's.
     */
    heapUsedBytes?: () => number;
  } = {},
): (req: SnapshotFoldRequest) => SnapshotFoldReply {
  let folder: SnapshotRowFolder | null = null;

  const requireFolder = (): SnapshotRowFolder => {
    if (!folder) throw new Error('snapshot fold worker: fold/finish before init (or after finish)');
    return folder;
  };

  return (req) => {
    try {
      switch (req.kind) {
        case 'init':
          folder = new SnapshotRowFolder({ excludeTables: req.excludeTables });
          return { res: { kind: 'ok', id: req.id }, transfer: [] };
        case 'fold': {
          // Counts are PER REQUEST; the caller totals them per scanned range.
          const f = requireFolder();
          let decodedOps = 0;
          let decodedBytes = 0;
          let skippedSnapshotOps = 0;
          for (const block of unpackBlocks(req.buf, req.lengths)) {
            if (!block) continue;
            // WI-10002836: the caller normally drops redundant snapshot chunks before
            // sending; this catches any it sent anyway, still without a parse.
            if (req.skipSnapshotOps && isSnapshotBlock(block)) {
              skippedSnapshotOps += 1;
              continue;
            }
            const op = decodeStoredBlock(block);
            // A snapshot op in another key order than `isSnapshotBlock` recognizes.
            if (req.skipSnapshotOps && isSnapshotOp(op)) {
              skippedSnapshotOps += 1;
              continue;
            }
            decodedOps += 1;
            // The stored block IS the op's UTF-8 JSON, so its length is the measure the
            // inline fold used to get by re-stringifying every op (a second full pass).
            decodedBytes += block.byteLength;
            f.add(op, op.value);
          }
          const heapUsedBytes = opts.heapUsedBytes?.();
          return {
            res: {
              kind: 'folded',
              id: req.id,
              decodedOps,
              decodedBytes,
              keyCount: f.keyCount,
              skippedSnapshotOps,
              ...(heapUsedBytes !== undefined ? { heapUsedBytes } : {}),
            },
            transfer: [],
          };
        }
        case 'inspect':
          return {
            res: {
              kind: 'inspected',
              id: req.id,
              ops: unpackBlocks(req.buf, req.lengths).map((b) => (b ? summarizeOp(decodeStoredBlock(b)) : null)),
            },
            transfer: [],
          };
        case 'finish': {
          const rows = requireFolder().finish({ now: req.now });
          const ops = buildSnapshotOpsFromRows({
            rows,
            coversUpTo: req.coversUpTo,
            author_pubkey: req.author_pubkey,
            ts: req.ts,
            schema_version: req.schema_version,
            maxChunkBytes: req.maxChunkBytes,
            excludeTables: req.excludeTables,
          });
          const rowCount = ops.reduce((sum, op) => sum + (op.value as SnapshotPayload).rows.length, 0);
          const packed = packBlocks(ops.map(encodeStoredBlock));
          folder = null; // release the live-key Map before the reply crosses back
          return {
            res: { kind: 'finished', id: req.id, buf: packed.buf, lengths: packed.lengths, rowCount },
            transfer: [packed.buf],
          };
        }
      }
    } catch (e) {
      return {
        res: { kind: 'error', id: req.id, message: e instanceof Error ? e.message : String(e) },
        transfer: [],
      };
    }
  };
}
