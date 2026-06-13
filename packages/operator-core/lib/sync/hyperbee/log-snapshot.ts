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

/** One row in a snapshot — a put that reconstitutes a single key's current state.
 *  Preserves the winning op's ORIGINAL ts/hlc so cross-peer LWW at the reader
 *  compares by the real write time, not snapshot-creation time. */
export interface SnapshotRow {
  table: string;
  hbKey: string;
  value: unknown;
  ts: number;
  schema_version: number;
  /** The winning op's HLC (P-010), preserved verbatim. */
  hlc?: string;
}

/** The `value` of a snapshot op. */
export interface SnapshotPayload {
  /**
   * The own-log length this snapshot summarizes: every op at index `< coversUpTo`
   * is reconstituted by `rows`, so a snapshot-aware reader can fold from
   * `coversUpTo` forward instead of from 0.
   */
  coversUpTo: number;
  /** The minimal current-state put-set (latest live put per key). */
  rows: SnapshotRow[];
}

/** True iff `op` is a snapshot op (reserved table tag). */
export function isSnapshotOp(op: { table?: string } | null | undefined): boolean {
  return !!op && op.table === SNAPSHOT_TABLE_TAG;
}

/**
 * P-004 — the pure builder. Fold a peer's OWN-LOG ops to the minimal current-state
 * put-set:
 *   - latest op per (table, hbKey) wins — the own log is single-writer, so the
 *     highest-index op for a key IS its current state (no LWW needed within one log);
 *   - a key whose latest op is a `del` is OMITTED (current state = absent; the
 *     snapshot is the new baseline, so absence reconstitutes correctly);
 *   - a PRIOR snapshot op is EXPANDED (its rows fold in first), so re-snapshotting a
 *     log that already carries a snapshot is correct + idempotent;
 *   - each emitted row preserves its winning op's value/ts/hlc verbatim.
 * Output is sorted (table, then hbKey) for deterministic, testable bytes. Pure.
 */
export function buildSnapshotRows(ops: readonly PeerLogOp[]): SnapshotRow[] {
  // key → row, or null when the key's latest op is a del (omitted from output).
  const latest = new Map<string, SnapshotRow | null>();
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
      });
    } else if (op.type === 'del') {
      latest.set(key, null);
    }
  }
  const rows: SnapshotRow[] = [];
  for (const r of latest.values()) if (r) rows.push(r);
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
  const rows = buildSnapshotRows(opts.ops);
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
  /** Number of live keys in the snapshot. */
  rowCount: number;
}

/**
 * P-005 — the producer. Read the peer's OWN log, fold it to the minimal
 * current-state set, and APPEND one snapshot op (design A — additive; the prior
 * ops are NOT removed, so there is no Hypercore fork). A snapshot-aware reader
 * (P-007) can then fold from this op's index forward instead of from 0.
 *
 * Reads `[0, length)` of the own log once per compaction (the writer paying
 * O(history) once, vs every joiner paying it forever — the whole point). The
 * snapshot op lands at index `length` and carries `coversUpTo = length`.
 *
 * GATED: callers MUST flag-gate this (`papercusp-substrate-log-snapshot`,
 * default-off) until the P-008 cross-machine sparse-fetch proof passes. This
 * function itself does not read the flag — it is the pure mechanism; the gate
 * lives at the (future) call site so the producer stays unit-testable.
 */
export async function produceLogSnapshot(
  ownLog: OwnLog,
  opts: { now: number; schemaVersion: number },
): Promise<ProduceSnapshotResult> {
  const coversUpTo = ownLog.length;
  if (coversUpTo === 0) return { appended: false, coversUpTo: 0, rowCount: 0 };

  const ops: PeerLogOp[] = [];
  for (let i = 0; i < coversUpTo; i++) {
    const op = await ownLog.get(i);
    if (op) ops.push(op);
  }
  const snapshotOp = buildSnapshotOp({
    ops,
    coversUpTo,
    author_pubkey: ownLog.keyHex,
    ts: opts.now,
    schema_version: opts.schemaVersion,
  });
  await ownLog.append(snapshotOp);
  return {
    appended: true,
    coversUpTo,
    rowCount: (snapshotOp.value as SnapshotPayload).rows.length,
  };
}
