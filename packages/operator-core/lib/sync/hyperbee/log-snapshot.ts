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
   * The winning op's ORIGINAL `author_pubkey`, preserved verbatim. This is part of the
   * epoch-decrypt AEAD associated data (`opId = sha256([table, hbKey, author_pubkey])`,
   * hive-epoch-serving.deriveOpId), so it MUST survive compaction for an encrypted row to
   * decrypt after snapshotting. Without it the reader fell back to the SNAPSHOT op's
   * author (its source-log key, NOT the content op's author) → the AAD opId diverged from
   * what sealed the ciphertext → every encrypted row silently decrypt-dropped on a
   * snapshot-seeded read (the seed "β" bug: on the owner's single-writer log content ops
   * carry author='' while the snapshot op carries the core-log key). Absent on legacy
   * pre-fix snapshots (the reader then falls back to the snapshot op's author).
   */
  author_pubkey?: string;
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
  /**
   * Tables this snapshot's own fold DROPPED (`SnapshotRowFolder.excludeTables`),
   * sorted. ABSENT ⇒ either nothing was excluded, or the set predates this field.
   *
   * Recorded because the rows alone cannot express it: an excluded table is simply
   * missing, indistinguishable from a table that never had rows. Without this,
   * anyone seeding a fold FROM this snapshot cannot tell whether it summarizes the
   * prefix completely or only the part some other producer cared about — and there
   * are two producers on the live own log with different sets (`boot.ts` filters
   * `SEED_EXCLUDED_TABLES` on the release-cut head-snapshot route, while routine
   * compaction excludes nothing). `conflictingSnapshotExclusion` is the consumer.
   */
  excludeTables?: string[];
}

/**
 * Seed-only transform result that removes the row entirely from the public snapshot.
 *
 * A key cannot be safely redacted in place: it is part of the row's address (and, for
 * encrypted rows, its AAD). Rewriting one can orphan the row or collide with another key.
 * The public seed therefore drops an identity-bearing key and lets normal post-install
 * replication recover the private row from the original author log.
 */
export const DROP_SNAPSHOT_ROW = Symbol('DROP_SNAPSHOT_ROW');

/**
 * Seed-only value projection applied while folding a private log into a public snapshot.
 * Return {@link DROP_SNAPSHOT_ROW} to omit the addressed row without mutating the source.
 */
export type SnapshotValueTransform = (
  value: unknown,
  context: {
    table: string;
    hbKey: string;
  },
) => unknown;

/** Sentinel so a decoded `null`/`undefined` value is still treated as read-once. */
const NO_DECODED_VALUE = Symbol('no-decoded-value');

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
  const folder = new SnapshotRowFolder();
  folder.addAll(ops);
  return folder.finish(opts);
}

/**
 * P-014 — the INCREMENTAL form of `buildSnapshotRows`. Same fold, same output, but
 * it consumes ops one window at a time so the caller never has to hold the whole
 * history in memory.
 *
 * WHY THIS EXISTS. `produceLogSnapshot` used to materialize every decoded op of the
 * own log into one `ops: PeerLogOp[]` and hand that array to the builder. The fold's
 * OUTPUT is bounded by the LIVE KEY COUNT (latest live op per key), but its INPUT was
 * bounded by the OP COUNT — and on this box's real corpus that is 461,475 ops of
 * accumulated history. Measured 2026-08-09: the holder reached `20.1G memory peak` and
 * died of heap exhaustion (SIGABRT status=134, V8 stack in `String::NewFromOneByte`)
 * ~110s into the read. Folding as each window arrives makes peak retention
 * (live keys + ONE read window) instead of (whole history).
 *
 * ⚠ That memory wall was ALWAYS there — it was MASKED by the serial-read latency bug
 * (see `SNAPSHOT_READ_CONCURRENCY`): the read was so slow the holder got recycled on
 * its ~8.5-min watchdog cadence before the heap could fill. Fixing the latency let
 * execution actually reach the ceiling. Two bugs, one symptom.
 *
 * ORDER IS THE CONTRACT. The own log is single-writer, so the LATEST op per key wins
 * BY POSITION — callers MUST `add` ops in ascending log-index order, exactly as the
 * array form iterates. `buildSnapshotRows` is implemented on top of this class, so
 * the property suite (`log-snapshot.property.test.ts`, PREFIX-REPLACEMENT FAITHFULNESS)
 * exercises this fold rather than a parallel copy of it — the two cannot drift.
 */
export class SnapshotRowFolder {
  /** key → its current-state row (live put OR a `deleted` tombstone). */
  private readonly latest = new Map<string, SnapshotRow>();

  /**
   * Tables to drop entirely from the fold (EI-20108164746219771). Empty by default,
   * so every existing caller is byte-for-byte unchanged.
   *
   * WHY THIS IS A FOLD-TIME FILTER AND NOT A finish() FILTER: it must apply to BOTH
   * branches of `add` — a PRIOR snapshot op expands its rows back in, so filtering
   * only raw put/del ops would silently re-admit an excluded table the moment the
   * source log already contained a snapshot. The shipped seed is exactly that case
   * (measured: its 45 blocks are entirely a snapshot set, rawOps=0), so the
   * expansion branch is the one that actually matters here, not the put/del branch.
   *
   * Dropping at fold time rather than at finish() also means excluded rows are never
   * retained at all, which is the point when the reason for excluding them is that
   * they carry identity.
   */
  private readonly excludeTables: ReadonlySet<string>;
  /** Optional seed-only projection; omitted callers remain byte-for-byte unchanged. */
  private readonly transformValue?: SnapshotValueTransform;

  constructor(opts?: { excludeTables?: Iterable<string>; transformValue?: SnapshotValueTransform }) {
    this.excludeTables = new Set(opts?.excludeTables ?? []);
    this.transformValue = opts?.transformValue;
  }

  /** Number of distinct keys folded so far — the real bound on peak retention. */
  get keyCount(): number {
    return this.latest.size;
  }

  /** Fold ONE op. Must be called in ascending log-index order (see the class note).
   * `decodedValue` is an internal read-once seam used by the producer diagnostics;
   * callers that do not already have the decoded value keep the original behavior. */
  add(op: PeerLogOp, decodedValue: unknown = NO_DECODED_VALUE): void {
    const decoded = decodedValue === NO_DECODED_VALUE ? op.value : decodedValue;
    if (isSnapshotOp(op)) {
      // A PRIOR snapshot expands: its rows (live AND tombstone) fold in as if they
      // were the ops they summarize, so re-snapshotting is correct + idempotent.
      const payload = decoded as SnapshotPayload | undefined;
      if (payload && Array.isArray(payload.rows)) {
        for (const r of payload.rows) {
          if (this.excludeTables.has(r.table)) continue;
          const key = `${r.table}::${r.hbKey}`;
          const value = this.transformValue
            ? this.transformValue(r.value, { table: r.table, hbKey: r.hbKey })
            : r.value;
          if (value === DROP_SNAPSHOT_ROW) {
            // A prior raw op for the same key may already be in the fold. The newest
            // snapshot row is authoritative, so a filtered winner must remove it too.
            this.latest.delete(key);
            continue;
          }
          this.latest.set(key, value === r.value ? r : { ...r, value });
        }
      }
      return;
    }
    if (this.excludeTables.has(op.table)) return;
    const key = `${op.table}::${op.hbKey}`;
    if (op.type === 'put') {
      const rowValue = this.transformValue
        ? this.transformValue(decoded, { table: op.table, hbKey: op.hbKey })
        : decoded;
      if (rowValue === DROP_SNAPSHOT_ROW) {
        // The key may have an earlier accepted winner. Dropping the latest PUT must
        // remove that stale winner rather than silently resurrecting it in the seed.
        this.latest.delete(key);
        return;
      }
      this.latest.set(key, {
        table: op.table,
        hbKey: op.hbKey,
        value: rowValue,
        ts: op.ts,
        schema_version: op.schema_version,
        ...(op.hlc ? { hlc: op.hlc } : {}),
        // WI-808: preserve the rekey epoch so a snapshot-seeded joiner can decrypt
        // an encrypted content row (a `del` tombstone is never encrypted → omitted).
        ...(op.epoch != null ? { epoch: op.epoch } : {}),
        // β (seed 57-drop sibling): preserve the ORIGINAL author_pubkey — it is bound
        // into the epoch-decrypt AAD (opId), so a snapshot-seeded reader must reconstruct
        // it EXACTLY, not substitute the snapshot op's author. Kept even when '' (the
        // owner single-writer log) so the reader distinguishes "author was ''" from a
        // legacy author-less row. Undefined ⇒ omitted (a peer on a pre-author build).
        ...(op.author_pubkey != null ? { author_pubkey: op.author_pubkey } : {}),
      });
    } else if (op.type === 'del') {
      // EI-1688: reconstitute the delete as a tombstone (carry the del's ts/hlc),
      // NOT omitted — so the reader's winner-fold knows the key was deleted.
      this.latest.set(key, {
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

  /** Fold a batch, in order. */
  addAll(ops: Iterable<PeerLogOp>): void {
    for (const op of ops) this.add(op);
  }

  /**
   * Emit the minimal current-state set: GC tombstones past the horizon, then sort
   * (table, then hbKey) for deterministic, testable bytes. Does not reset the folder.
   */
  finish(opts?: { now?: number; tombstoneHorizonMs?: number }): SnapshotRow[] {
    // GC tombstones older than the horizon (revert them to omitted). `now` undefined
    // ⇒ no GC (carry all tombstones — safe; only a snapshot producer supplies `now`).
    const now = opts?.now;
    const horizon = opts?.tombstoneHorizonMs ?? SNAPSHOT_TOMBSTONE_HORIZON_MS;
    const rows: SnapshotRow[] = [];
    for (const r of this.latest.values()) {
      if (r.deleted && now != null && r.ts < now - horizon) continue; // GC'd tombstone
      rows.push(r);
    }
    rows.sort((a, b) => (a.table === b.table ? cmpStr(a.hbKey, b.hbKey) : cmpStr(a.table, b.table)));
    return rows;
  }
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
  excludeTables?: readonly string[];
}): PeerLogOp {
  const payload: SnapshotPayload = {
    coversUpTo: opts.coversUpTo,
    rows: opts.rows,
    chunkIdx: opts.chunkIdx,
    chunkCount: opts.chunkCount,
  };
  // Omitted when nothing was excluded, so an unfiltered snapshot stays byte-for-byte
  // what it was before this field existed. Sorted for a stable serialization.
  if (opts.excludeTables && opts.excludeTables.length > 0) {
    payload.excludeTables = [...opts.excludeTables].sort();
  }
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
  /** Recorded on every chunk; see `SnapshotPayload.excludeTables`. */
  excludeTables?: readonly string[];
}): PeerLogOp[] {
  // EI-1688: pass `now` (= the snapshot ts) so old tombstones GC out at production.
  const rows = buildSnapshotRows(opts.ops, { now: opts.ts });
  return buildSnapshotOpsFromRows({ ...opts, rows });
}

/**
 * P-014 — the second half of `buildSnapshotOps`, taking rows that are ALREADY folded.
 * Chunk + wrap only; the tombstone GC has already happened inside the fold, so callers
 * MUST have passed `now` to `SnapshotRowFolder.finish` (as `produceLogSnapshot` does).
 *
 * Exists so the streaming producer can hand over a `SnapshotRowFolder`'s output without
 * round-tripping through an `ops` array it deliberately never built. Pure.
 */
export function buildSnapshotOpsFromRows(opts: {
  rows: readonly SnapshotRow[];
  coversUpTo: number;
  author_pubkey: string;
  ts: number;
  schema_version: number;
  maxChunkBytes?: number;
  /** Recorded on every chunk; see `SnapshotPayload.excludeTables`. */
  excludeTables?: readonly string[];
}): PeerLogOp[] {
  const chunks = chunkSnapshotRows(opts.rows, opts.maxChunkBytes ?? SNAPSHOT_MAX_CHUNK_BYTES);
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
      excludeTables: opts.excludeTables,
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
 * How many own-log blocks `produceLogSnapshot` reads concurrently.
 *
 * A tunable, not a constant of correctness: any positive value produces the SAME
 * `ops` array (see the ordering note at the read site), it only sets how much of the
 * O(history) read is in flight at once. It exists because the serial form made the
 * snapshot uncompletable on a real corpus — 461,475 blocks unfinished after 29 min
 * (P-014, 2026-08-09).
 *
 * Sized to be well clear of latency-bound without holding an unreasonable number of
 * decoded blocks in flight.
 *
 * ⚠ This window IS now a term in peak memory. It was not when this constant landed —
 * the producer accumulated the whole decoded history, which dwarfed any window — but
 * that accumulation is exactly what the incremental fold removed (`SnapshotRowFolder`),
 * so peak retention is now (live keys + ONE window of this many decoded blocks). Raising
 * it trades heap for fewer round-trips; it is still not a constant of correctness.
 */
export const SNAPSHOT_READ_CONCURRENCY = 256;

/**
 * A bounded progress marker for the filtered seed scan. `processed` is the
 * source-log cursor, not a percentage or an estimate: a reader is making real
 * progress only after a whole bounded window has been read and folded.
 */
export interface SnapshotFoldProgress {
  /** Named phase so a future multi-phase seed cut cannot conflate counters. */
  phase: string;
  /** Stable author/core identity when the source exposes one. */
  coreKey?: string;
  /** Absolute source-log span represented by this fold invocation. */
  sourceStart: number;
  sourceEnd: number;
  /** Number of source-log blocks folded so far. Monotonic within one scan. */
  processed: number;
  /** Source-log length captured for this scan. */
  total: number;
  /** Decoded source operations consumed by the folder so far. */
  decodedOps: number;
  /** Approximate UTF-8 bytes represented by those decoded operations. */
  decodedBytes: number;
}

/** Diagnostic emitted when the source cursor has not advanced for `stallMs`. */
export interface SnapshotFoldStall extends SnapshotFoldProgress {
  /** Wall-clock time for which the cursor remained unchanged. */
  stalledForMs: number;
}

export type SnapshotFoldProgressCallback = (progress: SnapshotFoldProgress) => void;
export type SnapshotFoldStallCallback = (stall: SnapshotFoldStall) => void;

export function formatSnapshotFoldStall(stall: SnapshotFoldStall): string {
  const phase = stall.phase.slice(0, 64).replace(/[^a-zA-Z0-9_.:-]/g, '_');
  const core = stall.coreKey?.slice(0, 64).replace(/[^a-zA-Z0-9_.:-]/g, '_') || 'unknown';
  return `phase=${phase} core=${core} sourceStart=${stall.sourceStart} sourceEnd=${stall.sourceEnd} ` +
    `cursor=${stall.processed}/${stall.total} decodedOps=${stall.decodedOps} ` +
    `decodedBytes=${stall.decodedBytes} stalledForMs=${stall.stalledForMs}`;
}

/**
 * A single read window may legitimately be slow, so this is only an
 * observability threshold. It is never a total scan timeout and the watchdog
 * never rejects or cancels the underlying read.
 */
export const FILTERED_SNAPSHOT_SCAN_STALL_MS = 30_000;

const FILTERED_SNAPSHOT_SCAN_PHASE = 'filtered-source-scan';

interface FoldLogRangeOptions {
  phase?: string;
  coreKey?: string;
  onProgress?: SnapshotFoldProgressCallback;
  onStall?: SnapshotFoldStallCallback;
  stallMs?: number;
}

/**
 * The producer-side view of a COMPLETE prior snapshot set. The reader exposes
 * the same seed discovery through `read-merge.ts`, but importing that module
 * here would create a runtime cycle (`read-merge` already imports this module).
 * Keep this small local mirror so the writer can reuse the verified chunk reads
 * when it seeds its folder.
 */
interface ProducerSnapshotSeed {
  coversUpTo: number;
  chunkCount: number;
  chunks: PeerLogOp[];
}

/**
 * Keep seed discovery bounded when a log has never been snapshotted. The reader
 * uses the same four-compaction-window bound; a producer snapshot is expected
 * to be within one cadence window of the tail, while a missing/old seed safely
 * falls back to the full fold below.
 */
const PRODUCER_SNAPSHOT_SCAN_LOOKBACK = SNAPSHOT_COMPACT_EVERY_OPS * 4;

/**
 * Find and read the newest complete snapshot set near the own-log tail.
 *
 * A complete set is the contiguous span `[coversUpTo, coversUpTo + chunkCount)`
 * whose every block is a snapshot op carrying the same set metadata. A torn or
 * malformed candidate is skipped, and a read failure simply disables seeding
 * for this invocation: folding from zero remains correct and is preferable to
 * guessing that a partial set summarizes history.
 */
/**
 * Decide whether a discovered prior snapshot may SEED a fold that excludes
 * `callerExcluded` — returning the offending table name, or null when safe.
 *
 * Direction is the whole point, and it is asymmetric. A table the snapshot dropped
 * but THIS fold wants to KEEP is unrecoverable from the snapshot's rows, so seeding
 * would silently yield a THINNER result than the full fold it replaces — on the seed
 * path, shipped to a customer as if the source had no such rows. The converse is
 * harmless: a table the snapshot KEPT but this fold drops is filtered again by
 * `SnapshotRowFolder.add`, which applies `excludeTables` to expanded chunk rows too.
 *
 * ⚠ An ABSENT record is deliberately TRUSTED rather than treated as a conflict, and
 * that is a bounded, self-closing exposure rather than an oversight:
 *  - every snapshot already on a live log predates this field, and refusing the seek
 *    for them would force exactly the from-zero fold `produceLogSnapshot` documents
 *    as UNCOMPLETABLE on the live log (five successive release cuts died there), so
 *    fail-closed here would regress a fixed critical bug to guard a narrower one;
 *  - legacy sets age out within one compaction cadence (`SNAPSHOT_COMPACT_EVERY_OPS`),
 *    after which every snapshot on the log carries its own provenance;
 *  - the only table any producer in this tree has ever dropped is `presence`
 *    (`SEED_EXCLUDED_TABLES`), which self-heals within one 30s keep-alive.
 */
function conflictingSnapshotExclusion(
  seed: ProducerSnapshotSeed,
  callerExcluded: ReadonlySet<string>,
): string | null {
  for (const chunk of seed.chunks) {
    const recorded = (chunk.value as SnapshotPayload | undefined)?.excludeTables;
    if (!recorded) continue;
    for (const table of recorded) {
      if (!callerExcluded.has(table)) return table;
    }
  }
  return null;
}

async function findLatestProducerSnapshot(
  log: Pick<OwnLog, 'length' | 'get'>,
): Promise<ProducerSnapshotSeed | null> {
  const length = log.length;
  const floor = Math.max(0, length - PRODUCER_SNAPSHOT_SCAN_LOOKBACK);
  const cache = new Map<number, PeerLogOp | null>();

  const readAt = async (index: number): Promise<PeerLogOp | null> => {
    const cached = cache.get(index);
    if (cached !== undefined || cache.has(index)) return cached ?? null;
    try {
      const op = await log.get(index);
      cache.set(index, op);
      return op;
    } catch {
      // The producer is local, but a transient read failure must not turn a
      // safe full fold into a false forward seed. The fold itself will surface
      // a persistent failure if the block cannot actually be read.
      cache.set(index, null);
      return null;
    }
  };

  for (let index = length - 1; index >= floor; index--) {
    const candidate = await readAt(index);
    if (!candidate || !isSnapshotOp(candidate)) continue;

    const payload = candidate.value as SnapshotPayload | undefined;
    const coversUpTo = payload?.coversUpTo;
    const chunkCount = payload?.chunkCount ?? 1;
    if (
      typeof coversUpTo !== 'number' ||
      !Number.isInteger(coversUpTo) ||
      coversUpTo < 0 ||
      !Number.isInteger(chunkCount) ||
      chunkCount < 1 ||
      coversUpTo + chunkCount > length
    ) {
      continue;
    }

    const chunks: PeerLogOp[] = [];
    let complete = true;
    for (let chunkIdx = 0; chunkIdx < chunkCount; chunkIdx++) {
      const chunk = await readAt(coversUpTo + chunkIdx);
      const chunkPayload = chunk?.value as SnapshotPayload | undefined;
      if (
        !chunk ||
        !isSnapshotOp(chunk) ||
        !chunkPayload ||
        chunkPayload.coversUpTo !== coversUpTo ||
        (chunkPayload.chunkCount ?? 1) !== chunkCount ||
        (chunkPayload.chunkIdx ?? 0) !== chunkIdx
      ) {
        complete = false;
        break;
      }
      chunks.push(chunk);
    }
    if (complete) return { coversUpTo, chunkCount, chunks };

    // Skip the rest of a known candidate span when it is torn. Keep the loop
    // strictly moving backward even for malformed metadata that points ahead.
    index = Math.min(index - 1, coversUpTo - 1);
  }
  return null;
}

/**
 * Watch one monotonically advancing source cursor. The alarm is edge-triggered
 * for each cursor value: a scan that keeps advancing can run for hours without
 * a wall-clock false positive, while a read that never completes produces one
 * useful diagnostic and does not create a repeating timer storm.
 */
function watchFoldCursor(
  from: number,
  to: number,
  opts: Required<Pick<FoldLogRangeOptions, 'phase' | 'onStall'>> & {
    coreKey?: string;
    stallMs: number;
  },
): {
  advance: (processed: number, decodedOps: number, decodedBytes: number) => void;
  stop: () => void;
} {
  let processed = from;
  let decodedOps = 0;
  let decodedBytes = 0;
  let lastProgressAt = Date.now();
  let alarmedAt: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const arm = (): void => {
    if (timer !== undefined || processed >= to || alarmedAt === processed) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (processed >= to || alarmedAt === processed) return;
      const stalledForMs = Date.now() - lastProgressAt;
      if (stalledForMs < opts.stallMs) {
        arm();
        return;
      }
      alarmedAt = processed;
      opts.onStall({
        phase: opts.phase,
        ...(opts.coreKey ? { coreKey: opts.coreKey } : {}),
        sourceStart: from,
        sourceEnd: to,
        processed,
        total: to,
        decodedOps,
        decodedBytes,
        stalledForMs,
      });
    }, opts.stallMs);
    timer.unref?.();
  };

  arm();
  return {
    advance(next: number, nextDecodedOps: number, nextDecodedBytes: number): void {
      // The fold loop is sequential by construction. Keep the guard defensive
      // so a future caller cannot make an alarm appear to recover backwards.
      if (next < processed) return;
      processed = next;
      decodedOps = nextDecodedOps;
      decodedBytes = nextDecodedBytes;
      lastProgressAt = Date.now();
      alarmedAt = undefined;
      arm();
    },
    stop(): void {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
  };
}

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
 * Seeds from the newest complete prior snapshot when one is available, then
 * reads only the post-snapshot tail. On the first compaction (or when no recent
 * complete set can be verified) it safely falls back to `[0, length)`. Chunk 0
 * lands at index `length` and every chunk carries `coversUpTo = length`.
 *
 * GATED: callers MUST flag-gate this (`papercusp-substrate-log-snapshot`) until
 * the P-008 cross-machine sparse-fetch proof passes. This function itself does not
 * read the flag — it is the pure mechanism; the gate lives at the call site so the
 * producer stays unit-testable.
 */
/**
 * Fold `log[from, to)` into `folder`, with the two properties P-014 paid for.
 *
 * Extracted so the SEED path (`produceFilteredSnapshotIntoLog`) reuses this exact
 * discipline instead of growing a second, subtly-different read loop — the read is
 * the dangerous part, not the fold.
 *
 * 1. BOUNDED PIPELINE, NOT SERIAL AWAITS. The serial form pays a full async
 *    round-trip per block, so it runs at ~1/latency ops/sec regardless of store
 *    speed. Measured 2026-08-09: 461,475 blocks had not finished after 29 MINUTES,
 *    and since the producer restarts from index 0 every time, that is not a slow
 *    operation but an UNCOMPLETABLE one.
 * 2. FOLD THEN DROP, AND YIELD TO THE MACROTASK QUEUE. Each window is folded and
 *    released (peak retention = live keys + one window, not the whole op count —
 *    materializing all decoded ops is what produced a `20.1G memory peak` and a
 *    SIGABRT). And `await` alone yields only to the MICROTASK queue: a warm local
 *    log resolves in-tick, so a loop of awaits starves every `setInterval` in the
 *    process. Measured: a head snapshot ran 455s with ZERO `harness_shared.routines`
 *    fires for the whole window — a 9-minute hole — and `bghost-watchdog` correctly
 *    read the frozen ticker and restarted the unit, killing the snapshot. The
 *    operation was killing its own host, which no timeout budget can fix.
 *    `setImmediate` runs in the check phase, reached only after timers get their
 *    turn, so one per window keeps the ticker alive and changes neither what is
 *    folded nor in what order.
 */
async function foldLogRangeInto(
  log: Pick<OwnLog, 'get'>,
  folder: SnapshotRowFolder,
  from: number,
  to: number,
  opts: FoldLogRangeOptions = {},
): Promise<void> {
  const watchdog =
    opts.onStall && opts.stallMs !== undefined && opts.stallMs > 0
      ? watchFoldCursor(from, to, {
        phase: opts.phase ?? 'source-scan',
        ...(opts.coreKey ? { coreKey: opts.coreKey } : {}),
        onStall: opts.onStall,
        stallMs: opts.stallMs,
      })
      : undefined;
  let decodedOps = 0;
  let decodedBytes = 0;
  try {
    for (let start = from; start < to; start += SNAPSHOT_READ_CONCURRENCY) {
      const end = Math.min(start + SNAPSHOT_READ_CONCURRENCY, to);
      const window = await Promise.all(Array.from({ length: end - start }, (_, k) => log.get(start + k)));
      for (const op of window) {
        if (!op) continue;
        // Read the decoded value once, both to fold it and to measure the bounded
        // source volume. This avoids a second getter read on instrumented logs.
        const decodedValue = op.value;
        decodedOps += 1;
        const encoded = JSON.stringify({
          type: op.type,
          table: op.table,
          hbKey: op.hbKey,
          value: decodedValue,
          ts: op.ts,
          schema_version: op.schema_version,
          ...(op.author_pubkey != null ? { author_pubkey: op.author_pubkey } : {}),
          ...(op.hlc ? { hlc: op.hlc } : {}),
          ...(op.epoch != null ? { epoch: op.epoch } : {}),
        });
        decodedBytes += encoded === undefined ? 0 : Buffer.byteLength(encoded, 'utf8');
        folder.add(op, decodedValue);
      }
      watchdog?.advance(end, decodedOps, decodedBytes);
      opts.onProgress?.({
        phase: opts.phase ?? 'source-scan',
        ...(opts.coreKey ? { coreKey: opts.coreKey } : {}),
        sourceStart: from,
        sourceEnd: to,
        processed: end,
        total: to,
        decodedOps,
        decodedBytes,
      });
      // `window` falls out of scope here — the decoded blocks it held are collectable.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  } finally {
    watchdog?.stop();
  }
}

export async function produceLogSnapshot(
  ownLog: OwnLog,
  opts: {
    now: number;
    schemaVersion: number;
    maxChunkBytes?: number;
    /** Optional bounded progress sink for the own-compaction fold. */
    onProgress?: SnapshotFoldProgressCallback;
    /** Optional cursor-stall diagnostic for the own-compaction fold. */
    onStall?: SnapshotFoldStallCallback;
    /** Override the own-compaction cursor-stall threshold. */
    stallMs?: number;
    /**
     * Tables dropped from the fold (EI-20108164746219771). Omitted by every live
     * caller, so the behavior of the running system is unchanged; supplied only by
     * the seed cut, which must not ship runtime/identity-bearing rows.
     */
    excludeTables?: Iterable<string>;
  },
): Promise<ProduceSnapshotResult> {
  // Re-anchored after the read by the ANCHOR CONVERGENCE below (WI-37526), so `let`.
  let coversUpTo = ownLog.length;
  if (coversUpTo === 0) return { appended: false, coversUpTo: 0, rowCount: 0, chunkCount: 0 };

  // Read the history with a bounded PIPELINE, not one awaited `get` at a time.
  //
  // The serial form (`for i… await ownLog.get(i)`) pays a full async round-trip per
  // block, so it runs at ~1/latency ops/sec no matter how cheap the store is. Measured
  // on this box 2026-08-09 (P-014): 461,475 blocks had not finished after 29 MINUTES of
  // one saturated core — and the holder is recycled on a ~8.5-min watchdog cadence, so
  // the snapshot could never finish before its own process was restarted. Because
  // `produceLogSnapshot` restarts from index 0 every time, that is not a slow operation
  // but an UNCOMPLETABLE one: five successive release cuts failed here, and no retry
  // budget can fix a non-resumable job that outlives its host.
  //
  // This is the same defect `RemoteLog.prefetch` already exists to solve on the replica
  // path ("without it, WAN merge ingest is RTT-bound at ~1/RTT ops/sec per log" — EI-92);
  // the own-log read never got the equivalent treatment.
  //
  // Order is preserved: `Promise.all` resolves positionally and the windows advance
  // sequentially, so ops are folded in exactly the index order the serial loop produced —
  // which the fold depends on (last-writer-wins per key).
  //
  // And each window is FOLDED THEN DROPPED rather than accumulated (P-014, half 2). The
  // fold's output is bounded by the LIVE KEY COUNT; only its input was ever bounded by the
  // OP COUNT, and materializing all 461,475 decoded ops first is what put the holder at a
  // `20.1G memory peak` and killed it with SIGABRT ~110s in. Peak retention is now
  // (live keys + one window of SNAPSHOT_READ_CONCURRENCY blocks). See `SnapshotRowFolder`.
  const folder = new SnapshotRowFolder({ excludeTables: opts.excludeTables });

  // A prior complete snapshot already represents every op before its anchor.
  // Seed those rows directly and start the streaming fold after the entire
  // chunk span, so the producer's second invocation is O(new tail), not
  // O(history). If no complete set is discoverable in the bounded scan window,
  // foldedUpTo remains zero and the existing full-fold behavior is preserved.
  const ownExcluded = new Set(opts.excludeTables ?? []);
  const priorSnapshot = await findLatestProducerSnapshot(ownLog);
  let foldedUpTo = 0;
  if (priorSnapshot) {
    // TWO PRODUCERS SHARE THIS LOG WITH DIFFERENT SETS (boot.ts): the release-cut
    // head-snapshot route filters `SEED_EXCLUDED_TABLES`, routine compaction excludes
    // nothing. `findLatestProducerSnapshot` returns whichever is NEWEST, so without
    // this check an unfiltered compaction could seed from the filtered set and then
    // republish it as if nothing had been excluded — dropping those rows from the
    // log's snapshot lineage permanently.
    const conflict = conflictingSnapshotExclusion(priorSnapshot, ownExcluded);
    if (conflict) {
      console.error(
        `[snapshot] own compaction: prior snapshot at ${priorSnapshot.coversUpTo} excluded ` +
          `table '${conflict}' which this fold keeps; folding from 0 instead of seeding ` +
          `(correct, but O(history) — see conflictingSnapshotExclusion)`,
      );
    } else {
      for (const chunk of priorSnapshot.chunks) folder.add(chunk);
      foldedUpTo = priorSnapshot.coversUpTo + priorSnapshot.chunkCount;
    }
  }

  /**
   * Fold `[from, to)` into the folder. Factored out of the main loop so the ANCHOR
   * CONVERGENCE below can reuse it for the (tiny) delta that arrives mid-read.
   */
  const foldRange = (from: number, to: number): Promise<void> =>
    foldLogRangeInto(ownLog, folder, from, to, {
      phase: 'own-compaction',
      coreKey: ownLog.keyHex,
      onProgress: opts.onProgress,
      onStall: opts.onStall ?? ((stall) => {
        console.error(
          `[snapshot] own compaction stalled in ${formatSnapshotFoldStall(stall)}; ` +
            `the scan remains live and will not be aborted by this diagnostic`,
        );
      }),
      stallMs: opts.stallMs ?? FILTERED_SNAPSHOT_SCAN_STALL_MS,
    });

  await foldRange(foldedUpTo, coversUpTo);
  // The initial target was captured before seed discovery. A concurrent append
  // can therefore make the verified seed span newer than that target; never
  // move the cursor backward in that case.
  foldedUpTo = Math.max(foldedUpTo, coversUpTo);

  // ── ANCHOR CONVERGENCE (WI-37526) ────────────────────────────────────────────
  //
  // The set's anchor MUST equal the index the chunks actually land at, because the
  // reader locates a set STRICTLY by span: `verifySnapshotSet` reads chunk j at
  // `coversUpTo + j` (read-merge.ts:437) and, on a miss, seeks BACKWARD past
  // `coversUpTo` (read-merge.ts:558) — so a set that lands even ONE block late is
  // not merely hard to find, it is unfindable forever.
  //
  // Capturing `coversUpTo = ownLog.length` before an O(history) read and appending
  // after it breaks that invariant whenever ANY op is appended meanwhile. MEASURED
  // 2026-08-10 on the live 1.23M-block log: the read took 43.7s, 55 ops arrived in
  // that window, and all 45 chunks landed at [1232912, 1232957) while carrying
  // `coversUpTo=1232857`. Every chunk was present, readable and correctly tagged —
  // and `findLatestCompleteSnapshot` still reported `none-in-window`, so
  // `computeSparseFrom` returned 0 and the seed guard refused a full-history seed.
  // That is the whole of P-014's "sparse cut degrades to full history", and it is
  // why the failure looked intermittent: a FAST snapshot (28s, run h) races fewer
  // appends and sometimes lands at offset 0 by luck, which reads as success.
  //
  // So: fold the delta that arrived during the read and re-anchor to the new tail.
  // Cost is the delta, not the history (55 ops against 1.23M). Folding a prior
  // snapshot op is explicitly idempotent (`SnapshotRowFolder.add`), so re-folding a
  // previous attempt's orphaned chunks is safe.
  const MAX_CONVERGE_PASSES = 8;
  for (let pass = 0; pass < MAX_CONVERGE_PASSES && ownLog.length > foldedUpTo; pass++) {
    const target = ownLog.length;
    await foldRange(foldedUpTo, target);
    foldedUpTo = target;
  }
  coversUpTo = foldedUpTo;

  // EI-1688: `now` (= the snapshot ts) GCs tombstones past the horizon at production —
  // the same argument `buildSnapshotOps` passes for the non-streaming path.
  const rows = folder.finish({ now: opts.now });
  const snapshotOps = buildSnapshotOpsFromRows({
    rows,
    coversUpTo,
    author_pubkey: ownLog.keyHex,
    ts: opts.now,
    schema_version: opts.schemaVersion,
    maxChunkBytes: opts.maxChunkBytes,
    excludeTables: opts.excludeTables ? [...ownExcluded] : undefined,
  });
  // Append the whole set in ONE batch so the chunks land CONTIGUOUSLY at
  // [coversUpTo, coversUpTo + N) — the reader recognizes the set by that span and
  // only seeds a cursor once every chunk is present (crash-consistency guard).
  await ownLog.appendBatch(snapshotOps);

  // ── VERIFY THE ANCHOR HELD ───────────────────────────────────────────────────
  //
  // Convergence shrinks the race window from the whole read (~44s) to the gap
  // between the last length read and the append, but does not close it: a writer
  // can still interleave. Reporting `appended: true` for a set the reader can never
  // find is the failure mode that cost ~6 cut attempts across several sessions —
  // the producer claimed success and the consequence surfaced 40+ minutes later as
  // a misleading "no complete snapshot within the reader scan window". A snapshot
  // that cannot be located is not a snapshot, so this FAILS LOUDLY instead.
  const anchorOp = await ownLog.get(coversUpTo);
  const anchorIsSnapshot = anchorOp != null && isSnapshotOp(anchorOp);
  const anchorCovers = anchorIsSnapshot ? (anchorOp.value as SnapshotPayload | undefined)?.coversUpTo : undefined;
  if (anchorCovers !== coversUpTo) {
    throw new Error(
      `[snapshot] anchor race: appended a ${snapshotOps.length}-chunk set for coversUpTo=${coversUpTo}, ` +
        `but index ${coversUpTo} does not hold chunk 0 of that set (found ` +
        `${anchorIsSnapshot ? `a snapshot for coversUpTo=${String(anchorCovers)}` : anchorOp == null ? `no readable op` : `a non-snapshot op`}). ` +
        `A concurrent append displaced the set, and the reader locates a set only at ` +
        `[coversUpTo, coversUpTo+chunkCount) — so it would be unfindable. Refusing to report ` +
        `success; retry the snapshot when the own log is quieter (WI-37526).`,
    );
  }

  const rowCount = snapshotOps.reduce((sum, op) => sum + (op.value as SnapshotPayload).rows.length, 0);
  return { appended: true, coversUpTo, rowCount, chunkCount: snapshotOps.length };
}

/**
 * Fold `sourceLog` and write the resulting snapshot set into a DIFFERENT log
 * (EI-20108164746219771 — the seed must not ship the owner's identity).
 *
 * ── WHY THIS EXISTS INSTEAD OF `produceLogSnapshot(ownLog, { excludeTables })` ──
 * The seed cut cannot filter in place. `cut-seed-cli` appends its head snapshot to
 * the LIVE own log (P-004 requires it inside the reader's tail-scan window), and
 * readers fold FORWARD from the newest complete snapshot, skipping everything below
 * its `coversUpTo`. So a table-incomplete snapshot in the live log does not merely
 * omit rows from the seed — it makes those rows UNREACHABLE for every live reader
 * that seeds from it. Trading a live read-model regression for a privacy fix is not
 * a fix. (Stripping rows from already-written blocks is not available either: blocks
 * are Merkle-signed and append-only.)
 *
 * So the seed becomes a PRODUCT rather than a slice of the owner's private log: mint
 * a separate core, put exactly one filtered snapshot set in it, ship that. The live
 * log is never written.
 *
 * ── THE PART THAT IS EASY TO GET WRONG: `coversUpTo` IS DUAL-PURPOSE ──
 * It means both "this set summarizes source ops below N" AND "this set physically
 * begins at index N". `produceLogSnapshot` can conflate them safely because source
 * and target are the same log. HERE THEY DIVERGE: the reader uses it purely as a
 * LOCATION (`verifySnapshotSet` reads chunk j at `coversUpTo + j`, read-merge.ts:437,
 * and on a miss seeks BACKWARD past it, :558), so it MUST be the TARGET's append
 * position — not the source's length. Anchoring to the source length would place a
 * perfectly valid, fully readable set at coordinates nothing ever looks at, which is
 * precisely the unfindable-set failure WI-37526 cost ~6 release cuts to diagnose.
 *
 * The target is expected to be fresh (length 0), but the target's own length is used
 * rather than a hardcoded 0 so appending to a non-empty synthetic core stays correct.
 */
export async function produceFilteredSnapshotIntoLog(
  sourceLog: Pick<OwnLog, 'get' | 'length'>,
  targetLog: OwnLog,
  opts: {
    now: number;
    schemaVersion: number;
    excludeTables?: Iterable<string>;
    /** Optional seed-only value projection; never used by the live-log producer. */
    transformValue?: SnapshotValueTransform;
    maxChunkBytes?: number;
    /** Bounded progress after each source-log read/fold window. */
    onProgress?: SnapshotFoldProgressCallback;
    /** Cursor-stall diagnostic; the scan itself is never timed out. */
    onStall?: SnapshotFoldStallCallback;
    /** Override the diagnostic threshold in tests or a release runner. */
    stallMs?: number;
  },
): Promise<ProduceSnapshotResult> {
  // An EMPTY SOURCE means there is nothing to seed — mirror `produceLogSnapshot`'s
  // `coversUpTo === 0` early return rather than minting a core whose only content is
  // a vacuous snapshot. (`chunkSnapshotRows([])` yields ONE empty chunk, not zero, so
  // without this the function would report `appended: true` for a set summarizing
  // nothing.)
  //
  // Deliberately NOT the same as "folded to zero rows": a NON-empty source whose rows
  // are all excluded or all tombstoned still gets a real, empty snapshot, because
  // "this hive has no shippable content" is a meaningful statement to seed with,
  // whereas "there was no source" is not.
  if (sourceLog.length === 0) {
    return { appended: false, coversUpTo: targetLog.length, rowCount: 0, chunkCount: 0 };
  }

  const folder = new SnapshotRowFolder({
    excludeTables: opts.excludeTables,
    transformValue: opts.transformValue,
  });
  const reportStall =
    opts.onStall ??
    ((stall: SnapshotFoldStall) => {
      console.error(
        `[snapshot] filtered source scan stalled in ${formatSnapshotFoldStall(stall)}; ` +
          `the scan remains live and will not be aborted by this diagnostic`,
      );
    });
  // ── SEED FROM THE PRIOR SNAPSHOT, LIKE `produceLogSnapshot` ALREADY DOES ─────────
  //
  // This fold used to start at a HARDCODED 0 while its sibling (:940) sought the latest
  // producer snapshot and folded only the new tail, documented "O(new tail), not
  // O(history)". The seed path never got that treatment, and the cost is not a constant
  // factor — it is re-expanding every SUPERSEDED snapshot generation still sitting in the
  // log's tail. A snapshot chunk block carries ~1,356 rows where a raw put carries ~1, so
  // a tiny minority of blocks dominates the scan.
  //
  // MEASURED on the failed 0.0.21 cut (2026-09-18, /tmp/papercup-release-cut.log, 199
  // time-throttled progress lines at CUT_SEED_FILTERED_PROGRESS_INTERVAL_MS=60_000, so
  // each delta IS a blocks-per-minute rate): deciles 0-8 are FLAT at 44k-91k blocks/min,
  // then the tail collapses to exactly 256 (= SNAPSHOT_READ_CONCURRENCY, one read window
  // per >=60s). 96 of 198 intervals — about half the ~7h wall clock — advanced 1.1% of the
  // blocks. 39,340,332 row-projections to yield 1,415,542 rows: 27.7x redundant.
  //
  // The same-run control is what sizes this, rather than an estimate: that cut also built
  // a COMPLETE head snapshot over the same data via the seeking path in 435,920ms (7.3
  // min, 1045 chunks, 1,416,626 rows) — and then folded from 0 anyway, ignoring it. Same
  // box, same data, same fold primitive: 7.3 minutes with the seek, ~7 hours without.
  const priorSnapshot = await findLatestProducerSnapshot(sourceLog);
  let foldFrom = 0;
  if (priorSnapshot) {
    // The guard that makes this safe to ship rather than merely fast. See
    // `conflictingSnapshotExclusion`: seeding from a snapshot that dropped a table THIS
    // seed keeps would ship a silently THINNER seed, which is strictly worse than a slow
    // one. Falling back to the full fold is always correct.
    const conflict = conflictingSnapshotExclusion(priorSnapshot, new Set(opts.excludeTables ?? []));
    if (conflict) {
      console.error(
        `[snapshot] filtered source scan: prior snapshot at ${priorSnapshot.coversUpTo} ` +
          `excluded table '${conflict}' which this seed keeps; folding the full source ` +
          `instead of seeding (correct, but O(history))`,
      );
    } else {
      for (const chunk of priorSnapshot.chunks) folder.add(chunk);
      foldFrom = priorSnapshot.coversUpTo + priorSnapshot.chunkCount;
    }
  }

  await foldLogRangeInto(sourceLog, folder, foldFrom, sourceLog.length, {
    phase: FILTERED_SNAPSHOT_SCAN_PHASE,
    coreKey: (sourceLog as Partial<Pick<OwnLog, 'keyHex'>>).keyHex,
    onProgress: opts.onProgress,
    onStall: reportStall,
    stallMs: opts.stallMs ?? FILTERED_SNAPSHOT_SCAN_STALL_MS,
  });

  const rows = folder.finish({ now: opts.now });
  // The TARGET's append position — see the dual-purpose note above.
  const coversUpTo = targetLog.length;
  const snapshotOps = buildSnapshotOpsFromRows({
    rows,
    coversUpTo,
    // The set is authored by the core that CARRIES it. Individual rows keep their
    // original `author_pubkey` (SnapshotRowFolder preserves it, because it is bound
    // into the epoch-decrypt AAD), so provenance of the CONTENT is unchanged — only
    // the envelope is re-authored.
    author_pubkey: targetLog.keyHex,
    ts: opts.now,
    schema_version: opts.schemaVersion,
    maxChunkBytes: opts.maxChunkBytes,
    // What THIS fold dropped, so anyone folding the shipped seed forward inherits the
    // same protection rather than having to know the cutter's policy.
    excludeTables: opts.excludeTables ? [...new Set(opts.excludeTables)] : undefined,
  });

  if (snapshotOps.length === 0) {
    return { appended: false, coversUpTo, rowCount: 0, chunkCount: 0 };
  }

  await targetLog.appendBatch(snapshotOps);

  // Same anchor verification produceLogSnapshot performs. A fresh single-writer core
  // has no concurrent appender, so this should be unreachable — which is exactly why
  // it is worth asserting: if it ever fires, the target was not the private core this
  // function assumes, and shipping an unfindable seed would otherwise look like success.
  const anchorOp = await targetLog.get(coversUpTo);
  const anchorIsSnapshot = anchorOp != null && isSnapshotOp(anchorOp);
  const anchorCovers = anchorIsSnapshot ? (anchorOp.value as SnapshotPayload | undefined)?.coversUpTo : undefined;
  if (anchorCovers !== coversUpTo) {
    throw new Error(
      `[snapshot] synthetic-core anchor race: appended a ${snapshotOps.length}-chunk set for ` +
        `coversUpTo=${coversUpTo}, but that index does not hold chunk 0 of it. The target log ` +
        `is not exclusively held by this cut, so the set would be unfindable (WI-37526).`,
    );
  }

  const rowCount = snapshotOps.reduce((sum, op) => sum + (op.value as SnapshotPayload).rows.length, 0);
  return { appended: true, coversUpTo, rowCount, chunkCount: snapshotOps.length };
}
