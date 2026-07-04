/**
 * log-snapshot — design A (snapshot-op-in-log) compaction primitives.
 *
 * Plan: substrate-peer-log-compaction-2026-06-13 P-004/P-005/P-007 (D-005 — owner
 * chose design A). Closes the P-009 gap: the append-only peer-log grows unbounded
 * and a new joiner re-folds full history from index 0.
 *
 * THE SHAPE (D-005). A snapshot is a regular `PeerLogOp` with a RESERVED table tag
 * `__snapshot__` — NOT a new `PeerLogOp.type` (which would ripple through every
 * put/del narrowing in toEnvelope / applyOpVia / read-merge). Its `value` is a
 * `SnapshotPayload` { coversUpTo, rows }: the minimal current-state put-set for
 * this peer's authored keys, plus the own-log length it summarizes. Consequence:
 *   - EXISTING readers treat it as a put to an unregistered table → `applyOpVia`
 *     finds no projection → drops it harmlessly. Producing a snapshot is safe even
 *     with old readers present.
 *   - ONLY the new flag-gated reader path (P-007) recognizes `__snapshot__`,
 *     expands `rows` into the fold, and lets a fresh joiner start its cursor at the
 *     snapshot index (skipping the summarized prefix).
 *
 * This module is PURE (no Corestore, no PG, no I/O): the builder folds an op array;
 * the producer wraps the result into one op. The append + reader integration live
 * in P-005 / P-007.
 */

import type { OwnLog, PeerLogOp } from './peer-log';

/** Reserved table tag identifying a snapshot op. No projection is registered for
 *  it, so non-snapshot-aware readers drop it (harmless). */
export const SNAPSHOT_TABLE_TAG = '__snapshot__';

/** One row in a snapshot — reconstitutes a single key's current state. Usually a
 *  live `put`; a `deleted: true` row is a TOMBSTONE (EI-1688) reconstituting a key
 *  whose current state is DELETED, carrying the del's ts/hlc. Preserves the winning
 *  op's ORIGINAL ts/hlc so cross-peer LWW at the reader compares by the real write
 *  time, not snapshot-creation time. */
export interface SnapshotRow {
  table: string;
  hbKey: string;
  value: unknown;
  /**
   * WI-808: the hive-rekey epoch the row's encrypted `value` was sealed under,
   * preserved verbatim so a snapshot-seeded joiner can still decrypt it. Without
   * it, an encrypted content op compacted into a snapshot would reconstitute with
   * `epoch == null` → the decrypt-gate treats the ciphertext as plaintext → silent
   * drop (the same class as the live-merge bug). Absent on plaintext rows.
   */
  epoch?: number;
  ts: number;
  schema_version: number;
  /** The winning op's HLC (P-010), preserved verbatim. */
  hlc?: string;
  /**
   * EI-1688 — a TOMBSTONE row: the key's latest op is a `del`, so it reconstitutes
   * as DELETED (the reader's `snapshotRowToEnvelope` emits a `del` env, seeding the
   * merge winner with the del's HLC so a later-arriving stale lower-clock PUT loses
   * the per-op winner-gate and is never re-applied — the put-after-del resurrection
   * fix). `value` is null on a tombstone (an old, pre-fix reader treats it as a
   * put(null) → decodeValue → null → dropped harmlessly; no resurrection-with-garbage).
   */
  deleted?: boolean;
}

/** The `value` of a snapshot op. */
export interface SnapshotPayload {
  /**
   * The own-log length this snapshot summarizes: every op at index `< coversUpTo`
   * is reconstituted by `rows`, so a snapshot-aware reader can fold from
   * `coversUpTo` forward instead of from 0.
   */
  coversUpTo: number;
  /**
   * The minimal current-state put-set (latest live put per key) carried by THIS
   * chunk. For a multi-chunk snapshot (WI-2313) each chunk holds a disjoint subset
   * of the folded rows; the reader must fold ALL chunks of the set to reconstitute
   * the full state.
   */
  rows: SnapshotRow[];
  /**
   * WI-2313 — 0-based index of this chunk within its snapshot SET. Every chunk of
   * one set shares the same `coversUpTo`. ABSENT ⇒ a legacy single-op snapshot,
   * read as chunk 0. The snapshot rows for a large own log (papercup: thousands of
   * keys) serialized to a single op that exceeded hypercore's 15 MiB block ceiling
   * (`Hypercore.MAX_SUGGESTED_BLOCK_SIZE`) → `BAD_ARGUMENT` on append → the snapshot
   * never landed → seeding had nothing to fold from → every sidecar restart replayed
   * admitted member logs from index 0 (the WI-2105 REV-leg restart loop). Splitting
   * the rows across size-bounded chunk ops keeps each block under the ceiling.
   */
  chunkIdx?: number;
  /**
   * WI-2313 — total number of chunks in this snapshot set. ABSENT ⇒ a legacy
   * single-op snapshot (count 1). CRASH-CONSISTENCY (the correctness constraint):
   * the reader may only seed a fresh merge cursor past the summarized prefix once
   * ALL `chunkCount` chunks are durably present + contiguous; a partial/torn set
   * must fall back to a full replay from 0, NEVER a forward seed that would silently
   * skip the ops the missing chunks summarize.
   */
  chunkCount?: number;
}

/** True iff `op` is a snapshot op (reserved table tag). */
export function isSnapshotOp(op: { table?: string } | null | undefined): boolean {
  return !!op && op.table === SNAPSHOT_TABLE_TAG;
}

/**
 * EI-1688 — how long a snapshot keeps a TOMBSTONE row for a deleted key. A snapshot
 * must reconstitute a delete (not omit it) so a later-arriving stale lower-clock PUT
 * that federates past the snapshot horizon loses the merge winner-gate instead of
 * resurrecting the key. Past this horizon the tombstone is GC'd (the key reverts to
 * omitted) — a delayed put that old is beyond any realistic partition-heal window, so
 * it is unrecoverable anyway. Conservative default: 14 days. Tunable, not a constant
 * of correctness (any value ≥ the max partition-heal delay is correct; larger only
 * keeps a few more tombstone rows in the snapshot).
 */
export const SNAPSHOT_TOMBSTONE_HORIZON_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * P-004 — the pure builder. Fold a peer's OWN-LOG ops to the minimal current-state
 * set:
 *   - latest op per (table, hbKey) wins — the own log is single-writer, so the
 *     highest-index op for a key IS its current state (no LWW needed within one log);
 *   - a key whose latest op is a `del` is reconstituted as a TOMBSTONE row
 *     (`deleted: true`, value null, the del's ts/hlc) rather than OMITTED — EI-1688:
 *     a snapshot-seeded reader must learn the key was deleted (with the del's HLC) so
 *     a stale lower-clock PUT arriving past the horizon loses the merge winner-gate.
 *     A tombstone older than `opts.tombstoneHorizonMs` (relative to `opts.now`) is
 *     GC'd back to OMITTED (the pre-EI-1688 behavior — acceptable past the horizon);
 *   - a PRIOR snapshot op is EXPANDED (its rows — live AND tombstone — fold in first),
 *     so re-snapshotting a log that already carries a snapshot is correct + idempotent;
 *   - each emitted row preserves its winning op's value/ts/hlc verbatim.
 * Output is sorted (table, then hbKey) for deterministic, testable bytes. Pure.
 */
export function buildSnapshotRows(
  ops: readonly PeerLogOp[],
  opts?: { now?: number; tombstoneHorizonMs?: number },
): SnapshotRow[] {
  // key → its current-state row (live put OR a `deleted` tombstone).
  const latest = new Map<string, SnapshotRow>();
  for (const op of ops) {
    if (isSnapshotOp(op)) {
      const payload = op.value as SnapshotPayload | undefined;
      if (payload && Array.isArray(payload.rows)) {
        for (const r of payload.rows) latest.set(`${r.table}::${r.hbKey}`, r);
      }
      continue;
    }
    const key = `${op.table}::${op.hbKey}`;
    if (op.type === 'put') {
      latest.set(key, {
        table: op.table,
        hbKey: op.hbKey,
        value: op.value,
        ts: op.ts,
        schema_version: op.schema_version,
        ...(op.hlc ? { hlc: op.hlc } : {}),
        // WI-808: preserve the rekey epoch so a snapshot-seeded joiner can decrypt
        // an encrypted content row (a `del` tombstone is never encrypted → omitted).
        ...(op.epoch != null ? { epoch: op.epoch } : {}),
      });
    } else if (op.type === 'del') {
      // EI-1688: reconstitute the delete as a tombstone (carry the del's ts/hlc),
      // NOT omitted — so the reader's winner-fold knows the key was deleted.
      latest.set(key, {
        table: op.table,
        hbKey: op.hbKey,
        value: null,
        ts: op.ts,
        schema_version: op.schema_version,
        ...(op.hlc ? { hlc: op.hlc } : {}),
        deleted: true,
      });
    }
  }
  // GC tombstones older than the horizon (revert them to omitted). `now` undefined
  // ⇒ no GC (carry all tombstones — safe; only a snapshot producer supplies `now`).
  const now = opts?.now;
  const horizon = opts?.tombstoneHorizonMs ?? SNAPSHOT_TOMBSTONE_HORIZON_MS;
  const rows: SnapshotRow[] = [];
  for (const r of latest.values()) {
    if (r.deleted && now != null && r.ts < now - horizon) continue; // GC'd tombstone
    rows.push(r);
  }
  rows.sort((a, b) =>
    a.table === b.table ? cmpStr(a.hbKey, b.hbKey) : cmpStr(a.table, b.table),
  );
  return rows;
}

function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Wrap a peer's minimal current-state set into ONE snapshot `PeerLogOp` (type
 * 'put', reserved table tag). `coversUpTo` is the own-log length at snapshot time
 * (so the reader knows the index this snapshot summarizes). The op carries no
 * `hlc` of its own — it is a meta op, not a per-key write; its embedded `rows`
 * carry the per-key HLCs that matter for LWW.
 */
export function buildSnapshotOp(opts: {
  ops: readonly PeerLogOp[];
  coversUpTo: number;
  author_pubkey: string;
  ts: number;
  schema_version: number;
}): PeerLogOp {
  // EI-1688: pass `now` (= the snapshot ts) so old tombstones GC out at production.
  const rows = buildSnapshotRows(opts.ops, { now: opts.ts });
  const payload: SnapshotPayload = { coversUpTo: opts.coversUpTo, rows };
  return {
    type: 'put',
    table: SNAPSHOT_TABLE_TAG,
    hbKey: `snapshot/${opts.coversUpTo}`,
    value: payload,
    ts: opts.ts,
    schema_version: opts.schema_version,
    author_pubkey: opts.author_pubkey,
  };
}

/**
 * WI-2313 — max SERIALIZED bytes of the `rows` payload packed into ONE snapshot
 * chunk op. Hypercore rejects an appended block over `MAX_SUGGESTED_BLOCK_SIZE`
 * (15 MiB) with `BAD_ARGUMENT: Appended block exceeds the maximum suggested block
 * size`; the whole-state snapshot for a large own log (papercup: thousands of
 * plan/plan-part/coord keys) exceeded that as a single append, so the snapshot
 * never landed and every sidecar restart replayed admitted member logs from 0
 * (the WI-2105 REV-leg restart loop). We chunk the rows across N ops each under
 * this budget — well below the 15 MiB block ceiling so the JSON envelope + array
 * overhead fit in the headroom. A tunable, not a constant of correctness: any
 * value in (0, ~14 MiB) is correct; smaller ⇒ more, smaller blocks (faster
 * individual WAN fetch, more replication round-trips).
 */
export const SNAPSHOT_MAX_CHUNK_BYTES = 4 * 1024 * 1024;

/**
 * WI-2313 — split a snapshot's folded rows into chunks each within `maxBytes` of
 * serialized payload, so no single snapshot op exceeds hypercore's block ceiling.
 * Greedy pack in the builder's deterministic (table, hbKey) order. A single row
 * larger than `maxBytes` gets its OWN chunk (it was individually appendable as a
 * normal op, so it is under the 15 MiB hard ceiling). Empty input ⇒ ONE empty
 * chunk, so a snapshot of an all-deleted log still anchors its `coversUpTo` in the
 * log (the seed can still skip the summarized-and-dead prefix). Pure.
 */
export function chunkSnapshotRows(
  rows: readonly SnapshotRow[],
  maxBytes: number = SNAPSHOT_MAX_CHUNK_BYTES,
): SnapshotRow[][] {
  if (rows.length === 0) return [[]];
  const budget = maxBytes > 0 ? maxBytes : SNAPSHOT_MAX_CHUNK_BYTES;
  const chunks: SnapshotRow[][] = [];
  let cur: SnapshotRow[] = [];
  let curBytes = 0;
  for (const row of rows) {
    const rowBytes = Buffer.byteLength(JSON.stringify(row), 'utf8');
    // Close the current chunk before adding a row that would overflow the budget —
    // but never emit an EMPTY chunk (a single over-budget row rides alone).
    if (cur.length > 0 && curBytes + rowBytes > budget) {
      chunks.push(cur);
      cur = [];
      curBytes = 0;
    }
    cur.push(row);
    curBytes += rowBytes;
  }
  chunks.push(cur);
  return chunks;
}

/** WI-2313 — wrap ONE chunk of a snapshot set into a reserved-tag op. All chunks
 *  of a set share `coversUpTo`; `chunkIdx` / `chunkCount` let the reader recognize
 *  the set and require every chunk before seeding a cursor. The hbKey is unique
 *  per (coversUpTo, chunkIdx). */
function buildSnapshotChunkOp(opts: {
  rows: SnapshotRow[];
  coversUpTo: number;
  chunkIdx: number;
  chunkCount: number;
  author_pubkey: string;
  ts: number;
  schema_version: number;
}): PeerLogOp {
  const payload: SnapshotPayload = {
    coversUpTo: opts.coversUpTo,
    rows: opts.rows,
    chunkIdx: opts.chunkIdx,
    chunkCount: opts.chunkCount,
  };
  return {
    type: 'put',
    table: SNAPSHOT_TABLE_TAG,
    hbKey: `snapshot/${opts.coversUpTo}/${opts.chunkIdx}-of-${opts.chunkCount}`,
    value: payload,
    ts: opts.ts,
    schema_version: opts.schema_version,
    author_pubkey: opts.author_pubkey,
  };
}

/**
 * WI-2313 — the CHUNKED producer builder (the fix for the oversized-block bug).
 * Fold `ops` to the minimal current-state set (`buildSnapshotRows`), split it into
 * size-bounded chunks (`chunkSnapshotRows`), and wrap each into a snapshot op. All
 * returned ops share `coversUpTo` and are meant to be appended CONTIGUOUSLY (one
 * `appendBatch`) so the reader recognizes the set as the span
 * `[coversUpTo, coversUpTo + N)`. Always returns ≥1 op. Pure.
 */
export function buildSnapshotOps(opts: {
  ops: readonly PeerLogOp[];
  coversUpTo: number;
  author_pubkey: string;
  ts: number;
  schema_version: number;
  maxChunkBytes?: number;
}): PeerLogOp[] {
  // EI-1688: pass `now` (= the snapshot ts) so old tombstones GC out at production.
  const rows = buildSnapshotRows(opts.ops, { now: opts.ts });
  const chunks = chunkSnapshotRows(rows, opts.maxChunkBytes ?? SNAPSHOT_MAX_CHUNK_BYTES);
  const chunkCount = chunks.length;
  return chunks.map((chunkRows, chunkIdx) =>
    buildSnapshotChunkOp({
      rows: chunkRows,
      coversUpTo: opts.coversUpTo,
      chunkIdx,
      chunkCount,
      author_pubkey: opts.author_pubkey,
      ts: opts.ts,
      schema_version: opts.schema_version,
    }),
  );
}

/**
 * Default compaction cadence: compact the own log once it has grown this many
 * ops PAST the last snapshot's `coversUpTo`. Compaction reads the whole own log
 * (O(history)) once per fire, so it must be infrequent — this threshold trades a
 * larger replay tail for fewer O(history) writer scans. A tunable, not a constant
 * of correctness (any positive value is correct; this only sets the cadence).
 */
export const SNAPSHOT_COMPACT_EVERY_OPS = 1000;

/**
 * Should the own log be compacted now? True when it has grown at least
 * `threshold` ops since the last snapshot it produced (`lastCoversUpTo`, 0 if it
 * never snapshotted). Pure — the caller supplies the lengths so this is trivially
 * testable and free of clock/IO.
 */
export function shouldCompactOwnLog(
  currentLength: number,
  lastCoversUpTo: number,
  threshold: number = SNAPSHOT_COMPACT_EVERY_OPS,
): boolean {
  if (threshold <= 0) return false;
  return currentLength - lastCoversUpTo >= threshold;
}

export interface ProduceSnapshotResult {
  /** False when there was nothing to snapshot (empty log) — no op appended. */
  appended: boolean;
  /** Own-log length the appended snapshot summarizes (its `coversUpTo`). */
  coversUpTo: number;
  /** Number of live keys in the snapshot (summed across all chunks). */
  rowCount: number;
  /** WI-2313 — number of chunk ops appended for this snapshot (≥1 when appended,
   *  0 when nothing was appended). The set occupies `[coversUpTo, coversUpTo + N)`. */
  chunkCount: number;
}

/**
 * P-005 — the producer. Read the peer's OWN log, fold it to the minimal
 * current-state set, and APPEND the snapshot (design A — additive; the prior ops
 * are NOT removed, so there is no Hypercore fork). A snapshot-aware reader (P-007)
 * can then fold from the snapshot's index forward instead of from 0.
 *
 * WI-2313 — the snapshot is CHUNKED: the folded rows are split across N ops each
 * under `SNAPSHOT_MAX_CHUNK_BYTES` (well below hypercore's 15 MiB block ceiling)
 * and appended in ONE `appendBatch` so the chunks land CONTIGUOUSLY at
 * `[coversUpTo, coversUpTo + N)`. Before this, the whole state went in a SINGLE
 * append that, for a large own log, blew the block ceiling (`BAD_ARGUMENT`) → the
 * snapshot never landed → the cursor never seeded → every restart replayed from 0.
 *
 * Reads `[0, length)` of the own log once per compaction (the writer paying
 * O(history) once, vs every joiner paying it forever — the whole point). Chunk 0
 * lands at index `length` and every chunk carries `coversUpTo = length`.
 *
 * GATED: callers MUST flag-gate this (`papercusp-substrate-log-snapshot`) until
 * the P-008 cross-machine sparse-fetch proof passes. This function itself does not
 * read the flag — it is the pure mechanism; the gate lives at the call site so the
 * producer stays unit-testable.
 */
export async function produceLogSnapshot(
  ownLog: OwnLog,
  opts: { now: number; schemaVersion: number; maxChunkBytes?: number },
): Promise<ProduceSnapshotResult> {
  const coversUpTo = ownLog.length;
  if (coversUpTo === 0) return { appended: false, coversUpTo: 0, rowCount: 0, chunkCount: 0 };

  const ops: PeerLogOp[] = [];
  for (let i = 0; i < coversUpTo; i++) {
    const op = await ownLog.get(i);
    if (op) ops.push(op);
  }
  const snapshotOps = buildSnapshotOps({
    ops,
    coversUpTo,
    author_pubkey: ownLog.keyHex,
    ts: opts.now,
    schema_version: opts.schemaVersion,
    maxChunkBytes: opts.maxChunkBytes,
  });
  // Append the whole set in ONE batch so the chunks land CONTIGUOUSLY at
  // [coversUpTo, coversUpTo + N) — the reader recognizes the set by that span and
  // only seeds a cursor once every chunk is present (crash-consistency guard).
  await ownLog.appendBatch(snapshotOps);
  const rowCount = snapshotOps.reduce(
    (sum, op) => sum + (op.value as SnapshotPayload).rows.length,
    0,
  );
  return { appended: true, coversUpTo, rowCount, chunkCount: snapshotOps.length };
}
