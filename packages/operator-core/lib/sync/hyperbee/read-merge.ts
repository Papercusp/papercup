/**
 * read-merge.ts — LWW read-merge over admitted per-peer logs (Model B, Stage 2).
 *
 * Stage 1 (`peer-log.ts`) gives each peer a single-writer append-only log of
 * `PeerLogOp`s. This stage reads ALL admitted logs, resolves same-key conflicts
 * last-writer-wins ACROSS authors, and materializes the winners through the
 * EXISTING projection layer (`applyHyperbeeOpToPg`). It reuses, and does not
 * reinvent:
 *
 *   - `lwwPick(a, b)` from `./projection` — picks the op to keep (later `ts`
 *     wins; `del` beats `put` on a `ts` tie).
 *   - `applyHyperbeeOpToPg(op)` from `./projection` — dispatches a put/del op to
 *     the registered per-table writer; returns true iff applied. Its clobber-
 *     event hook (`observeMergedOp`) fires only when the op carries a
 *     `writerPubkey`, so we thread `author_pubkey` through as `writerPubkey`.
 *
 * Single responsibility: read → map → LWW-fold → apply → count. It does NOT
 * refresh remote logs — the caller (Stage 4's boot driver) calls `update()`
 * before passing logs in; we read `[0, min(length, cap))` as presented.
 *
 * Stage 6 adds a per-LOG op-count cap (`maxOpsPerAuthor`) so one noisy author
 * can't make a merge pass ingest unbounded ops (the DoS Phase-4 reshape: a
 * peer that bloats its own log only delays its own tail, not the whole merge).
 */

import type { OpEnvelope } from './op-envelope-types';
import type { PeerLogOp } from './peer-log';
import { applyHyperbeeOpToPg, lwwPick } from './projection';
import { encodeHlc } from '@papercusp/locks-core';
import { logIfStageStalls } from './stage-stall-log';
import {
  isSnapshotOp,
  SNAPSHOT_COMPACT_EVERY_OPS,
  type SnapshotPayload,
  type SnapshotRow,
} from './log-snapshot';

/**
 * Structural view of a log the merge can read. Stage 1's `RemoteLog` / `OwnLog`
 * both satisfy this (they expose `keyHex`, `length`, and a decoding `get(i)`).
 * The merge needs no `update()` here — see the module doc-comment.
 */
export interface AdmittedLog {
  readonly keyHex: string;
  readonly length: number;
  get(i: number): Promise<PeerLogOp | null>;
  /**
   * WI-1856 (G9): release the underlying Hypercore session (present on a
   * `RemoteLog` from `openRemoteLog`; the own writable log is never revoked so
   * it need not implement this). Optional + feature-detected by callers (e.g.
   * `boot.ts`'s `revoke()`) so hand-rolled `AdmittedLog`/`RemoteLog` test
   * fixtures elsewhere in the codebase don't need a stub.
   */
  close?(): Promise<void>;
}

/** Default per-op read timeout. A connected-but-withholding peer's
 *  `get(i, {wait:true})` can block forever; bounding it keeps the merge lock
 *  from being held hostage (the op is skipped + retried on the next pass). */
export const DEFAULT_GET_TIMEOUT_MS = 5000;

/** Default per-LOG op-count cap. A single admitted log contributes at most this
 *  many ops to a merge pass; the rest are skipped this pass (and `onCapped`
 *  fires). Bounds the DoS where a noisy peer bloats its own log to force the
 *  merge to ingest unbounded ops. Override (or disable with `<= 0`) via
 *  `MergeOpts.maxOpsPerAuthor`. */
export const DEFAULT_MAX_OPS_PER_AUTHOR = 50_000;

/** Yield a macrotask to the event loop every this-many merge-loop iterations.
 *  Local-corestore `get`s resolve via MICROTASK, so without an explicit yield
 *  the incremental merge's inner loop runs its whole pass budget (up to 50k
 *  awaits per log) as one event-loop turn — at the 1Hz merge poll that
 *  monopolized the loop and burned ~1.5 cores continuously (EI-81). */
export const MERGE_YIELD_EVERY_OPS = 1000;

/** WI-2344: a SECOND, TIME-based bound alongside `MERGE_YIELD_EVERY_OPS`. The
 *  op-count bound alone assumes ops are cheap-and-uniform; on a from-0 replay
 *  against a loaded/slow PG (or many wide snapshot-expansion rows per op —
 *  see `isSnapshotOp` below), a single 1000-op chunk between yields can itself
 *  run long enough to trip the bg-host watchdog's 240s "genuinely frozen"
 *  threshold (observed 2026-07-04, load 34/128 — not box-saturation, just a
 *  long uninterrupted chunk). Checked every iteration alongside the op
 *  counter so whichever bound fires first wins; comfortably under the 240s
 *  watchdog so a slow chunk still yields well before that budget. */
export const MERGE_YIELD_MAX_MS = 250;

/** WI-2105 — persist the merge cursor to PG at most every this-many decoded ops
 *  DURING a pass (plus once per log at completion). Coarser than the event-loop
 *  yield cadence so a big fold does ~O(ops/5000) small upserts, not one per
 *  yield; fine-grained enough that a watchdog restart loses at most this many
 *  ops of re-fold (all idempotent). Intra-pass because a single large-backlog
 *  pass can outlast the 240s bg-host watchdog and never return — persisting only
 *  after the pass returned would capture nothing (the WI-2105 REV restart loop). */
export const MERGE_PERSIST_EVERY_OPS = 5000;

/** WI-4020: default cap on `MergeCursor.winners`' entry count. `winners` is
 *  durable-for-the-process (unlike the transient per-call map in
 *  `mergeAdmittedLogs`) and grows by one entry per distinct (table, hbKey)
 *  ever merged, with no eviction — a long-lived host merging a
 *  perpetually-growing federation accumulates one entry per live row FOREVER.
 *  Bounding it is safe because `winners` is a FAST-PATH cache layered on an
 *  independently-authoritative floor, not the sole correctness mechanism: see
 *  `mergeAdmittedLogsIncremental`'s "POST-CURSOR-RESET DOUBLE-APPLY SAFETY"
 *  doc comment — every PG projection writer re-guards with its own
 *  `fed_ts`/`fed_hlc` `ON CONFLICT` check, so a `winners` MISS (evicted OR
 *  never-seen) only ever costs a harmless redundant `apply()` attempt (PG
 *  accepts it if legitimately newer, no-ops if stale) — never an incorrect
 *  write. `<= 0` disables the bound (today's unbounded behavior). Override
 *  via `IncrementalMergeOpts.maxWinnersEntries`. */
export const DEFAULT_MAX_WINNERS_ENTRIES = 500_000;

/** `await` point that defers to the macrotask queue (setImmediate), letting
 *  timers/IO/HTTP run between merge chunks. */
const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

export interface MergeOpts {
  /** Override the apply sink (defaults to `applyHyperbeeOpToPg`). For tests. */
  applyImpl?: (op: OpEnvelope) => Promise<boolean>;
  /**
   * Per-op `log.get(i)` timeout (ms). A `get` that doesn't resolve within this
   * window is treated as "block not available yet" → the op is skipped (NOT an
   * error). Bounds a withholding remote peer so it can't hold the merge lock.
   * Defaults to `DEFAULT_GET_TIMEOUT_MS`. Pass `0` / a non-positive value to
   * disable the timeout (e.g. tests over instant fakes).
   */
  getTimeoutMs?: number;
  /**
   * Per-LOG op-count cap (Stage 6). Each admitted log contributes at most this
   * many ops to a single merge pass; if `log.length` exceeds the cap, only the
   * first `cap` ops are read/applied this pass and `onCapped` fires ONCE for
   * that log. Bounds the DoS where one noisy author bloats its own log to make
   * the merge ingest unbounded ops. Defaults to `DEFAULT_MAX_OPS_PER_AUTHOR`.
   * Pass `0` / a non-positive value to disable the cap (read all ops).
   */
  maxOpsPerAuthor?: number;
  /**
   * Called once per log whose `length` exceeded `maxOpsPerAuthor` (so the merge
   * read only the first `cap` of `totalLength` ops). Best-effort observability
   * hook (e.g. record a `peer_capped` boot-history event); must not throw —
   * a failing callback is swallowed so it can't abort the merge pass.
   */
  onCapped?: (keyHex: string, totalLength: number, cap: number) => void;
}

/**
 * Race a `log.get(i)` against a timeout. Resolves to the op on success, or
 * `null` when the read rejects OR doesn't resolve in time (both are "skip this
 * op"). Never rejects — a misbehaving peer's read can't abort the merge pass.
 */
async function readOpBounded(
  log: AdmittedLog,
  i: number,
  timeoutMs: number,
): Promise<PeerLogOp | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const get = Promise.resolve(log.get(i));
    if (timeoutMs <= 0) {
      // Timeout disabled — still guard the rejection (caller wants per-op
      // isolation regardless of the timeout).
      return await get;
    }
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
      // Don't keep the event loop alive on the timeout alone.
      if (typeof (timer as { unref?: () => void }).unref === 'function') {
        (timer as { unref: () => void }).unref();
      }
    });
    return await Promise.race([get, timeout]);
  } catch {
    // A rejected read (peer stream closed / decode error) skips just this op.
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Map a single-writer `PeerLogOp` to a projection-layer `OpEnvelope`. The
 * writer's `author_pubkey` becomes `writerPubkey` so the clobber-event hook in
 * `applyHyperbeeOpToPg` fires with the right author.
 *
 * G1 Provenance (P-002): `sourceLogKeyHex` is set to the source log's `keyHex`
 * so the apply path can determine `origin` by comparing against the own log's
 * `keyHex` — the log-source approach is authoritative + unforgeable.
 */
/**
 * P-007 (design A): the rows carried by a snapshot op (`__snapshot__`), or `[]`
 * for a malformed payload. Each row reconstitutes one key's current state.
 */
function snapshotRows(op: PeerLogOp): SnapshotRow[] {
  const payload = op.value as SnapshotPayload | undefined;
  return payload && Array.isArray(payload.rows) ? payload.rows : [];
}

/**
 * P-007 (design A): map one snapshot row to an `OpEnvelope` (a put), preserving
 * its original ts/hlc so it folds + LWW-compares exactly as the original write
 * did. `sourceLogKeyHex` comes from the snapshot op's source log, so origin
 * resolution is identical to a normal op from that peer.
 *
 * `writerPubkey` is the ROW's own preserved `author_pubkey` (the original content op's
 * author), NOT the snapshot op's author — it is bound into the epoch-decrypt AAD (opId),
 * so substituting the snapshot op's author makes every encrypted row decrypt-drop (the
 * seed "β" / 57-drop bug). A LEGACY author-less row (a pre-β snapshot) falls back to `''`,
 * the owner single-writer-log author convention every pre-β snapshot was compacted under —
 * NOT the snapshot op's source-log KEY, which is a hypercore key, never a content author.
 * Proven against the shipped seed: the log-key fallback decrypts 0 of its 11308 encrypted
 * snapshot rows (the 57-drop), while '' decrypts all 9937 owner-authored ones. A
 * member-authored legacy row (author ≠ '', e.g. a relayed coord-message) can't be
 * reconstructed from an author-less row — it relies on a β re-cut or the live join delta.
 */
function snapshotRowToEnvelope(
  row: SnapshotRow,
  sourceLogKeyHex: string,
): OpEnvelope {
  return {
    // EI-1688: a tombstone row reconstitutes a DELETE. Emitting a `del` env seeds the
    // merge winner with the del's ts/hlc, so a later-arriving stale lower-clock PUT
    // loses the per-op winner-gate (`!beatsStored(env, prev) → continue`) and is never
    // re-applied — the put-after-del resurrection fix, fold-level (no PG tombstone).
    type: row.deleted ? 'del' : 'put',
    table: row.table,
    hbKey: row.hbKey,
    value: row.value,
    ts: row.ts,
    schema_version: row.schema_version,
    ...(row.hlc ? { hlc: row.hlc } : {}),
    // WI-808: carry the rekey epoch from a snapshot row so the decrypt-gate can
    // resolve the key (mirrors toEnvelope; absent on plaintext / tombstone rows).
    ...(row.epoch != null ? { epoch: row.epoch } : {}),
    // β / 57-drop: the ROW's preserved original author is the AAD author the ciphertext was
    // sealed under — use it. A legacy author-less row (pre-β snapshot) falls back to `''`,
    // the owner single-writer-log convention it was compacted under — NOT the snapshot op's
    // source-log key (a hypercore key, never a content author → AAD diverges → decrypt-drop
    // = the 57-drop). `??` (not `||`) so a genuine '' row author is preserved.
    writerPubkey: row.author_pubkey ?? '',
    sourceLogKeyHex,
  };
}

function toEnvelope(op: PeerLogOp, sourceLogKeyHex: string): OpEnvelope {
  return {
    type: op.type,
    table: op.table,
    hbKey: op.hbKey,
    value: op.value,
    ts: op.ts,
    schema_version: op.schema_version,
    // P-010: carry the HLC through so `lwwPick`/`beatsStored` can order by it.
    // Before this, the envelope dropped `hlc`, so even an op that DID carry one
    // (e.g. a peer on a newer build) fell back to wall-clock `ts` at merge time.
    ...(op.hlc ? { hlc: op.hlc } : {}),
    // WI-808: carry the epoch stamp onto the OpEnvelope the apply-side decrypt-gate
    // reads. Before this, the merge dropped `epoch` (exactly as it once dropped
    // `hlc`), so an encrypted content op arrived at the gate with `epoch == null` →
    // treated as plaintext → ciphertext passed to scopedApply → silent drop on the
    // joiner (zero decrypt-gate trace). Absent on plaintext ops (today's path).
    ...(op.epoch != null ? { epoch: op.epoch } : {}),
    writerPubkey: op.author_pubkey,
    sourceLogKeyHex,
  };
}

/**
 * Read every admitted log, LWW-resolve same-key conflicts across authors, and
 * apply each winner via the projection layer.
 *
 * @returns the count of ops that actually applied (the apply sink returned true).
 */
export async function mergeAdmittedLogs(logs: AdmittedLog[], opts?: MergeOpts): Promise<number> {
  const apply = opts?.applyImpl ?? applyHyperbeeOpToPg;
  const getTimeoutMs = opts?.getTimeoutMs ?? DEFAULT_GET_TIMEOUT_MS;
  const maxOpsPerAuthor = opts?.maxOpsPerAuthor ?? DEFAULT_MAX_OPS_PER_AUTHOR;
  const onCapped = opts?.onCapped;

  // 1+2. Read each log's ops (skip nulls) and map to OpEnvelope.
  // 3. Fold into per-(table, hbKey) LWW winners as we go.
  //
  // Each `get(i)` is BOUNDED + per-op isolated (readOpBounded): a read that
  // rejects OR doesn't resolve within `getTimeoutMs` is skipped (treated as
  // "block not available yet"), NOT allowed to bubble and abort the whole
  // pass. This keeps one connected-but-withholding peer from starving the own
  // log + other peers while the caller holds the merge lock — the skipped op
  // is retried on the next pass once the block downloads.
  //
  // Per-LOG cap (Stage 6): a log contributes at most `maxOpsPerAuthor` ops to
  // this pass — we iterate `i` over `[0, min(length, cap))`. If `length`
  // exceeds the cap, `onCapped` fires once for that log. Reading the FIRST
  // `cap` ops is the simple, deterministic policy: a more sophisticated policy
  // could prefer recent ops (read the tail), but first-N suffices for the
  // cap's purpose — bounding per-pass ingest from any single author so a noisy
  // peer can't make the merge unbounded. A `<= 0` cap disables the bound.
  const winners = new Map<string, OpEnvelope>();
  let opsSinceYield = 0;
  // WI-2344: wall-clock companion to the op counter, same rationale as the
  // incremental merge below (MERGE_YIELD_MAX_MS).
  let lastYieldAt = Date.now();
  for (const log of logs) {
    const cap = maxOpsPerAuthor;
    const capped = cap > 0 && log.length > cap;
    if (capped) {
      try {
        onCapped?.(log.keyHex, log.length, cap);
      } catch {
        // Observability hook must never abort the merge pass.
      }
    }
    const upper = capped ? cap : log.length;
    for (let i = 0; i < upper; i++) {
      // EI-81: local-corestore gets resolve via microtask — yield a macrotask
      // every ~1k iterations so a full re-fold can't monopolize the event loop.
      // WI-2344: OR every MERGE_YIELD_MAX_MS of wall-clock, whichever first.
      if (++opsSinceYield >= MERGE_YIELD_EVERY_OPS || Date.now() - lastYieldAt >= MERGE_YIELD_MAX_MS) {
        opsSinceYield = 0;
        lastYieldAt = Date.now();
        await yieldToEventLoop();
      }
      const op = await readOpBounded(log, i, getTimeoutMs);
      if (!op) continue;
      // P-007 (design A): a snapshot op reconstitutes many keys at once — expand
      // its rows and fold each (so folding from a snapshot index lands the same
      // winners a full fold from 0 would). Non-snapshot-aware callers never reach
      // here because snapshot ops only exist once the flag-gated producer ran.
      if (isSnapshotOp(op)) {
        for (const row of snapshotRows(op)) {
          const env = snapshotRowToEnvelope(row, log.keyHex);
          const groupKey = `${env.table}::${env.hbKey}`;
          const prev = winners.get(groupKey);
          winners.set(groupKey, prev ? lwwPick(prev, env) : env);
        }
        continue;
      }
      const env = toEnvelope(op, log.keyHex);
      const groupKey = `${env.table}::${env.hbKey}`;
      const prev = winners.get(groupKey);
      winners.set(groupKey, prev ? lwwPick(prev, env) : env);
    }
  }

  // 4+5. Apply each winning op; count those that applied.
  let applied = 0;
  for (const env of winners.values()) {
    if (await apply(env)) applied++;
  }
  return applied;
}

/* ------------------------------------------------------------------ *
 * Incremental merge (the EI-79 residual — p2p-performance-suite P-013)
 * ------------------------------------------------------------------ */

/**
 * Compact per-key winner record. Holds ONLY what the LWW comparison needs —
 * not the op value — so the standing fold state costs ~tens of bytes per live
 * key instead of retaining every winning payload.
 */
interface WinnerMeta {
  ts: number;
  hlc?: string;
  type: 'put' | 'del';
  src: string; // sourceLogKeyHex ('' when absent) — lwwPick's total-order tiebreak
}

/** Result of one physical `log.get(position)` attempt. */
type ReadAttemptResult =
  | { kind: 'op'; op: PeerLogOp | null }
  | { kind: 'read-error'; err: unknown };

/**
 * Durable-for-the-process fold state of an incremental merge: per-log read
 * cursors + the materialized per-key winner metadata. Created once per booted
 * harness (`createMergeCursor`) and threaded through every
 * `mergeAdmittedLogsIncremental` pass. NOT persisted — a process restart
 * rebuilds it with one full pass (the same cost as today's boot backfill).
 */
export interface MergeCursor {
  /** keyHex → next log index to read. */
  positions: Map<string, number>;
  /** `${table}::${hbKey}` → current winner meta. */
  winners: Map<string, WinnerMeta>;
  /**
   * WI-255: per-op CONSECUTIVE apply-throw counter (op-identity → count). The
   * winner is now recorded only AFTER a non-throwing apply, so a TRANSIENT apply
   * throw (a PG blip/deadlock/timeout mid-merge) leaves the op un-deduped and it
   * is retried next pass instead of being skipped forever (the data-loss bug).
   * This counter bounds a PERSISTENTLY-throwing (poison) op so it quarantines
   * (record+skip+log) instead of looping. Optional for back-compat with cursors
   * built as a bare `{ positions, winners }` (lazily initialized at the apply site).
   */
  applyThrows?: Map<string, number>;
  /**
   * WI-2003: per-position CONSECUTIVE read-throw counter (`${log.keyHex}:${pos}`
   * → count), the READ-side mirror of `applyThrows`. `readOpBoundedDetailed`
   * distinguishes a genuinely TRANSIENT timeout (peer withholding/offline — kept
   * as unbounded retry-via-break, unchanged) from a REJECTED read (e.g. a
   * hypercore/signature verify failure during identity divergence) — the latter
   * bounds via this counter and dead-letters (advances past the position) after
   * `MAX_READ_THROWS`, instead of `break`ing forever and wedging every
   * SUBSEQUENT op in that peer's strictly-sequential single-writer log (the
   * "silent REV fed_event outage class", WI-2003). Optional for back-compat.
   */
  readThrows?: Map<string, number>;
  /**
   * WI-2141796: per-position CONSECUTIVE read-STALL counter (`${log.keyHex}:${pos}`
   * → count) for the `unavailable` (transient-timeout) branch. That branch is
   * deliberately an UNBOUNDED retry-via-break and this counter does NOT change
   * that — it exists purely so the retry is VISIBLE.
   *
   * The measured failure it makes observable (2026-09-02, tower): the papercusp
   * cursor on log `cb54460d98d8` sat at position 12048 for hours while the writer
   * ran on to 25k+, so every inbound coordination row behind it was unreachable.
   * NOTHING reported it. The `unavailable` break logs nothing, no apply is
   * attempted (so no timeout/quarantine/constraint error fires), the peer stays
   * connected so replication-liveness reads `live`/`healthy`, and the cursor ROW's
   * `updated_at` keeps moving because positions are persisted as ONE map — a
   * sibling log advancing re-stamps the frozen one. A moving `updated_at` beside a
   * frozen `position` reads exactly like a healthy merge, which is what made this
   * cost hours to find: every available signal was a per-op or per-connection
   * bound, and the failure lives in whether a SPECIFIC POSITION ever advances.
   */
  readStalls?: Map<string, number>;
  /**
   * P-203 / D-018: `${log.keyHex}:${position}` → late results from timed-out
   * reads. A result that eventually arrives is consumed before another read is
   * issued, while a never-settling attempt still permits the existing retry
   * semantics on the next pass.
   */
  lateReadResults?: Map<string, ReadAttemptResult[]>;
}

export function createMergeCursor(): MergeCursor {
  return {
    positions: new Map(),
    winners: new Map(),
    applyThrows: new Map(),
    readThrows: new Map(),
    readStalls: new Map(),
    lateReadResults: new Map(),
  };
}

/**
 * Default backward-scan bound for `findLatestSnapshotIndex`. By the compaction
 * cadence (`SNAPSHOT_COMPACT_EVERY_OPS`) the latest snapshot is at most ~threshold
 * ops behind the tail, so scanning a few cadence-windows back finds it; if none is
 * found in the window we fall back to folding from 0 (today's behavior — safe, no
 * regression), which bounds a fresh joiner of a NON-compacted log from paying
 * O(total-history) just to discover there is no snapshot.
 */
export const SNAPSHOT_SCAN_LOOKBACK = SNAPSHOT_COMPACT_EVERY_OPS * 4;

/**
 * WI-2313 — verify a snapshot SET fully occupies `[coversUpTo, coversUpTo + chunkCount)`:
 * every chunk present (readable), a snapshot op, tagged with the SAME `coversUpTo`,
 * the SAME `chunkCount`, and its correct `chunkIdx`. THE crash-consistency guard for
 * seeding: a fresh cursor may skip the summarized prefix ONLY when the whole set is
 * durably present; a partial/torn set (a chunk still downloading on a sparse
 * replica, or a torn append) must fall back to a full replay from 0 — NEVER a
 * forward seed that would silently skip the ops the missing chunks summarize
 * (silent REV row loss, worse than slow). A legacy single-op snapshot (no chunk
 * fields) reads as a complete 1-chunk set. Per-op reads are bounded (a withholding
 * peer can't hang it — an unreadable chunk just fails verification).
 */
async function verifySnapshotSet(
  log: AdmittedLog,
  coversUpTo: number,
  chunkCount: number,
  getTimeoutMs: number,
): Promise<VerifySetResult> {
  if (coversUpTo < 0 || chunkCount < 1) return { ok: false, reason: 'torn' };
  if (coversUpTo + chunkCount > log.length) return { ok: false, reason: 'torn' }; // extends past the tail → incomplete
  for (let j = 0; j < chunkCount; j++) {
    const idx = coversUpTo + j;
    const r = await readOpBoundedDetailed(log, idx, getTimeoutMs);
    // WI-37553 — UNREADABLE IS NOT TORN. A bounded get that timed out (or threw) says
    // NOTHING about whether the chunk is present; reporting it as `torn` made a COMPLETE
    // set look broken. Readers tolerate that (they just fold from 0), but the seed CUTTER
    // reads it as "no snapshot" and silently degrades a sparse cut into shipping FULL
    // history — measured: a 44-chunk set sitting 48 blocks from the tail, read off a live
    // WAL-churning corestore, yielded a 5.62 GB seed that the degradation guard refused,
    // failing a release cut 52 minutes in. Surface the distinction; let the caller decide.
    if (r.kind !== 'op') {
      return {
        ok: false,
        reason: 'unreadable',
        atIndex: idx,
        cause: r.kind === 'unavailable' ? 'timeout' : 'read-error',
      };
    }
    const op = r.op;
    if (!op || !isSnapshotOp(op)) return { ok: false, reason: 'torn' };
    const p = op.value as SnapshotPayload | undefined;
    if (!p || p.coversUpTo !== coversUpTo) return { ok: false, reason: 'torn' };
    if ((p.chunkCount ?? 1) !== chunkCount) return { ok: false, reason: 'torn' };
    if ((p.chunkIdx ?? 0) !== j) return { ok: false, reason: 'torn' };
  }
  return { ok: true };
}

/** WI-2313 — seed descriptor for the latest COMPLETE snapshot set in a log. */
export interface SnapshotSeed {
  /** Index of chunk 0 — where a fresh cursor starts so the forward fold reads
   *  EVERY chunk of the set (then the post-snapshot tail). Equals `coversUpTo` for
   *  a log whose chunks were appended contiguously at its tail (the producer's
   *  `appendBatch`). */
  seedIndex: number;
  /** Own-log length the set summarizes (the chunks' shared `coversUpTo`). */
  coversUpTo: number;
  /** Number of chunks in the set. */
  chunkCount: number;
}

/** WI-37553 — why a snapshot-set verification failed. `unreadable` (a bounded get timed
 *  out or threw) is NOT evidence the set is broken; `torn` is. */
export type VerifySetResult =
  | { ok: true }
  | { ok: false; reason: 'torn' }
  | { ok: false; reason: 'unreadable'; atIndex: number; cause: 'timeout' | 'read-error' };

/** WI-37553 — the outcome of a backward snapshot scan. Only `none-in-window` means
 *  "there is genuinely no snapshot to seed from"; `unreadable` means "ask again". */
export type SnapshotScanOutcome =
  | { kind: 'found'; seed: SnapshotSeed }
  | { kind: 'unreadable'; atIndex: number; cause: 'timeout' | 'read-error' }
  | { kind: 'none-in-window'; scannedFrom: number; floor: number };

/**
 * WI-2313 (supersedes the single-op P-007 scan): find the latest COMPLETE snapshot
 * set near the tail. Scans BACKWARD within `maxLookback`; on hitting any chunk of a
 * set it derives the set span `[coversUpTo, coversUpTo + chunkCount)` from that
 * chunk's payload and verifies the whole span (`verifySnapshotSet`). A verified set
 * ⇒ its chunk-0 index; a TORN set ⇒ skip its whole span and keep scanning older
 * history for an earlier complete set; none in the window ⇒ `null` (caller folds
 * from 0). Touches only `[seedIndex, length)` + the set's chunks — exactly the tail
 * a snapshot-seeded fold reads anyway, so it adds no download a fresh joiner
 * wouldn't already pay.
 */
export async function findLatestCompleteSnapshot(
  log: AdmittedLog,
  maxLookback: number = SNAPSHOT_SCAN_LOOKBACK,
  getTimeoutMs: number = DEFAULT_GET_TIMEOUT_MS,
): Promise<SnapshotSeed | null> {
  const r = await findLatestCompleteSnapshotDetailed(log, maxLookback, getTimeoutMs);
  return r.kind === 'found' ? r.seed : null;
}

/**
 * WI-37553 — the same scan as {@link findLatestCompleteSnapshot}, but it says WHY it
 * came back empty instead of collapsing every cause into `null`.
 *
 * `null` is the right answer for a READER (fold from 0 — correct, just slower), which is
 * why the boolean-ish wrapper above is unchanged. It is the WRONG answer for the seed
 * CUTTER: there, "I could not read the tail" and "there is genuinely no snapshot here"
 * have opposite remedies — retry vs. ship full history — and conflating them silently
 * turned a transient 5s read timeout into a 5.62 GB full-history seed.
 *
 * Outcomes:
 *  - `found`          — a verified complete set; `seed.seedIndex` is chunk 0.
 *  - `unreadable`     — a bounded get timed out / threw. Says NOTHING about whether a
 *                       snapshot exists. Retry (ideally with a longer timeout) before
 *                       concluding anything.
 *  - `none-in-window` — the scan genuinely reached `floor` having read every block. This
 *                       is the only outcome that justifies falling back to full history.
 */
export async function findLatestCompleteSnapshotDetailed(
  log: AdmittedLog,
  maxLookback: number = SNAPSHOT_SCAN_LOOKBACK,
  getTimeoutMs: number = DEFAULT_GET_TIMEOUT_MS,
): Promise<SnapshotScanOutcome> {
  const len = log.length;
  const floor = maxLookback > 0 ? Math.max(0, len - maxLookback) : 0;
  let i = len - 1;
  while (i >= floor) {
    const r = await readOpBoundedDetailed(log, i, getTimeoutMs);
    if (r.kind !== 'op') {
      // Unavailable/withholding tail. The READER wrapper turns this back into `null`
      // (fold from 0 — safe); the cutter gets the truth so it can retry.
      return { kind: 'unreadable', atIndex: i, cause: r.kind === 'unavailable' ? 'timeout' : 'read-error' };
    }
    const op = r.op;
    if (!op) return { kind: 'unreadable', atIndex: i, cause: 'timeout' };
    if (isSnapshotOp(op)) {
      const p = op.value as SnapshotPayload | undefined;
      const coversUpTo = p?.coversUpTo ?? 0;
      const chunkCount = p?.chunkCount ?? 1;
      const v = await verifySnapshotSet(log, coversUpTo, chunkCount, getTimeoutMs);
      if (v.ok) return { kind: 'found', seed: { seedIndex: coversUpTo, coversUpTo, chunkCount } };
      // A set we could not READ is not a set we know to be torn — propagate, don't skip
      // past it. Skipping was how a complete-but-slow-to-read set vanished from the scan.
      if (v.reason === 'unreadable') return { kind: 'unreadable', atIndex: v.atIndex, cause: v.cause };
      // Genuinely torn/corrupt — skip its whole span and look for an earlier complete one.
      // `Math.min` keeps the scan strictly backward even if a corrupt payload reports a
      // coversUpTo ahead of the current index.
      i = Math.min(coversUpTo - 1, i - 1);
      continue;
    }
    i--;
  }
  return { kind: 'none-in-window', scannedFrom: len - 1, floor };
}

/**
 * P-007 (design A): the index a FRESH cursor should seed at — the chunk-0 index of
 * the latest COMPLETE snapshot set, or `null` if none within `maxLookback` of the
 * tail. WI-2313: the seed fires ONLY for a whole present set, so a partial
 * multi-chunk set never seeds a cursor ahead of un-folded ops. Thin wrapper over
 * `findLatestCompleteSnapshot` (kept for the boot compaction-cadence anchor +
 * `seedCursorFromSnapshots`).
 */
export async function findLatestSnapshotIndex(
  log: AdmittedLog,
  maxLookback: number = SNAPSHOT_SCAN_LOOKBACK,
  getTimeoutMs: number = DEFAULT_GET_TIMEOUT_MS,
): Promise<number | null> {
  const seed = await findLatestCompleteSnapshot(log, maxLookback, getTimeoutMs);
  return seed ? seed.seedIndex : null;
}

/**
 * P-007 (design A): seed a FRESH merge cursor at each log's latest COMPLETE
 * snapshot set so a new joiner (or a post-reset re-fold) folds from the snapshot
 * forward instead of from 0 — the new-joiner replay-skip. Only seeds a log with NO
 * cursor position yet (fresh); an already-advanced cursor is left untouched
 * (idempotent, never rewinds a live fold). A log with no snapshot is left at 0
 * (folds from scratch, today's behavior). FLAG-GATED by the caller (boot.ts) —
 * off ⇒ never called ⇒ cursor seeds at 0, byte-identical to today.
 *
 * WI-2313 crash-consistency: the seed comes from `findLatestSnapshotIndex`, which
 * returns a set's chunk-0 index ONLY when every chunk is present + contiguous. A
 * partial/torn multi-chunk set yields `null` ⇒ this leaves the log at 0 (full
 * replay), never seeding the cursor PAST ops that unread chunks summarize.
 */
export async function seedCursorFromSnapshots(
  logs: AdmittedLog[],
  cursor: MergeCursor,
  opts?: { maxLookback?: number; getTimeoutMs?: number },
): Promise<void> {
  for (const log of logs) {
    if (cursor.positions.has(log.keyHex)) continue; // already folding — don't rewind
    const idx = await findLatestSnapshotIndex(
      log,
      opts?.maxLookback ?? SNAPSHOT_SCAN_LOOKBACK,
      opts?.getTimeoutMs ?? DEFAULT_GET_TIMEOUT_MS,
    );
    if (idx !== null && idx > 0) cursor.positions.set(log.keyHex, idx);
  }
}

/* ------------------------------------------------------------------ *
 * WI-2105 REV fix — durable merge-cursor persistence (PG-cursor)
 * ------------------------------------------------------------------ */

/**
 * WI-2105 — injected persistence seam for merge-cursor positions. Keeps this
 * module free of a live PG dependency: boot.ts wires a Postgres-backed store
 * (harness_shared.substrate_merge_cursor, resolved via getHarnessAdminUrl —
 * never a hardcoded localhost), tests inject an in-memory fake. `load`/`save`
 * are keyed by (workspaceId, harnessSlug) that the store closes over, so this
 * interface speaks only the per-log keyHex→position map.
 */
/**
 * Durable lifecycle attached to one peer log. `unknown` is deliberately a real
 * state: cursor rows predate durable identity metadata, and silence alone is
 * never evidence that an operator intentionally retired a peer.
 */
export type MergeCursorPeerLifecycleState = 'unknown' | 'active' | 'retired';

export interface MergeCursorPeerLifecycle {
  logKeyHex: string;
  devicePubkey: string | null;
  state: MergeCursorPeerLifecycleState;
  updatedAt: Date | null;
}

/** Only explicit identity-bearing events may move a row out of `unknown`. */
export interface MergeCursorPeerLifecycleUpdate {
  logKeyHex: string;
  devicePubkey: string;
  state: Exclude<MergeCursorPeerLifecycleState, 'unknown'>;
}

export interface MergeCursorPeerLifecycleStore {
  /** Load lifecycle independently of apply binding; identity is not projection-scoped. */
  load(): Promise<Map<string, MergeCursorPeerLifecycle>>;
  /**
   * Persist explicit active/retired evidence. A missing cursor row is created at
   * position 0 under the current binding; an existing row keeps its position and
   * binding so a lifecycle transition can never rewind or re-scope a fold.
   */
  upsert(updates: readonly MergeCursorPeerLifecycleUpdate[], applyBinding: string | null): Promise<void>;
}

export interface MergeCursorStore {
  /**
   * Persisted positions for this (workspace, harness) that are VALID under
   * `applyBinding`: keyHex → next index. EI-18773697830188393 — a position means
   * "every op below this index has been applied", and whether an op applies is
   * decided by the pot-home projection scope it was folded through (the federation
   * demux key). Progress recorded under a DIFFERENT scope is therefore not resumable
   * (its ops were dropped, not applied), so the store must not return it.
   */
  load(applyBinding: string | null): Promise<Map<string, number>>;
  /**
   * Upsert the given positions, STAMPED with the apply binding they were folded
   * under. Best-effort; may throw — the caller isolates it.
   */
  save(positions: ReadonlyMap<string, number>, applyBinding: string | null): Promise<void>;
  /**
   * Optional while non-PG/in-memory fakes retain the position-only contract.
   * The canonical PG implementation always provides this nested store.
   */
  peerLifecycle?: MergeCursorPeerLifecycleStore;
}

/**
 * EI-20317490590418053 — boot-lifetime cache of PG cursor seeds.
 *
 * A substrate boot can admit remote logs AFTER its first merge pass. Loading PG
 * once and copying every persisted key into the live cursor is unsafe: entries
 * for not-yet-admitted logs look exactly like REMOVED logs to boot's log-set
 * invariant, which resets the whole fold. The old one-shot latch then prevents
 * those late logs from ever receiving their persisted positions, so they replay
 * from zero and can starve the actual tail indefinitely.
 *
 * This cache separates the durable seed SET from the live admitted-log cursor:
 * it loads once, copies positions only for keys admitted in the current pass,
 * and remains reusable when another log is admitted later. The durable set is
 * binding-scoped, so resolving a different apply binding reloads it instead of
 * treating the first (often empty) load as authoritative for the whole boot. A
 * structural fold invalidation (removal, truncation, or lost deferred state)
 * still disables it for the remainder of the boot; reusing progress after one
 * of those events would be the same unsafe skip the original latch avoided.
 */
export interface PgMergeCursorSeedCache {
  seed(
    cursor: MergeCursor,
    store: MergeCursorStore,
    applyBinding: string | null,
    admittedKeyHexes: Iterable<string>,
  ): Promise<void>;
  invalidate(): void;
}

/** Copy safe persisted positions into a cursor, optionally filtering to keys
 * admitted RIGHT NOW. Exported for the direct one-shot helper and focused tests. */
export function seedCursorFromPgCache(
  cursor: MergeCursor,
  saved: ReadonlyMap<string, number>,
  admittedKeyHexes?: Iterable<string>,
): void {
  const entries: Iterable<readonly [string, number]> = admittedKeyHexes
    ? (function* () {
        for (const keyHex of admittedKeyHexes) {
          const position = saved.get(keyHex);
          if (position !== undefined) yield [keyHex, position] as const;
        }
      })()
    : saved;
  for (const [keyHex, position] of entries) {
    if (position > 0 && !cursor.positions.has(keyHex)) {
      cursor.positions.set(keyHex, position);
    }
  }
}

/** Create one seed cache per booted harness. A failed load is one-shot and
 * fail-open (the caller logs it; folds start at zero), matching the old latch. */
export function createPgMergeCursorSeedCache(): PgMergeCursorSeedCache {
  let saved: ReadonlyMap<string, number> | undefined;
  let savedApplyBinding: string | null | undefined;
  let invalidated = false;
  return {
    async seed(cursor, store, applyBinding, admittedKeyHexes) {
      if (invalidated) return;
      if (!saved || savedApplyBinding !== applyBinding) {
        try {
          saved = await store.load(applyBinding);
          savedApplyBinding = applyBinding;
        } catch (error) {
          invalidated = true;
          throw error;
        }
      }
      seedCursorFromPgCache(cursor, saved, admittedKeyHexes);
    },
    invalidate() {
      invalidated = true;
      saved = undefined;
      savedApplyBinding = undefined;
    },
  };
}

/**
 * WI-2105 REV fix — seed a merge cursor's per-log positions from PG BEFORE the
 * first fold, so a bg-host restart RESUMES each log's fold where it left off
 * instead of re-folding from 0. Only seeds a log with NO in-memory position yet
 * (idempotent; never rewinds a live fold) and only to a position > 0. Unlike
 * `seedCursorFromSnapshots` (own-log-only, requires the log be snapshottable by
 * this peer), this resumes ANY admitted log — including an orphaned peer log the
 * tower can no longer snapshot (the e06b8704 case that WI-2313 could not fix).
 *
 * CRASH-CONSISTENCY: the persisted position is written persist-AFTER-apply (see
 * `persistCursor` and the boot `onCursorAdvance` hook), so it never points past a
 * durably-applied op. Seeding at it therefore skips ONLY ops whose projection
 * writes already committed; re-folding from it would re-apply idempotently
 * (LWW put/del), so seeding is strictly safe and strictly cheaper. A load
 * failure is the caller's to isolate → leaves positions at 0 (full re-fold,
 * slower but correct).
 *
 * SCOPE-CONDITIONAL (EI-18773697830188393): `applyBinding` is the pot-home projection
 * scope the fold is about to run under. Only progress recorded under the SAME scope is
 * resumable — an op folded through a different (e.g. mis-resolved) hive-home binding was
 * DEMUX-DROPPED rather than applied, even though the cursor marked it done. Passing the
 * live binding here is what makes a corrected binding self-heal: the store returns
 * nothing, the fold restarts from 0 through the new scope, and the re-apply is
 * idempotent (LWW put/del). This is the COLD-BOOT counterpart of the mid-session
 * `forceReFold` the rekey rebind sets.
 */
export async function seedCursorFromPg(
  cursor: MergeCursor,
  store: MergeCursorStore,
  applyBinding: string | null,
): Promise<void> {
  const saved = await store.load(applyBinding);
  seedCursorFromPgCache(cursor, saved);
}

/**
 * WI-2105 REV fix — persist a merge cursor's positions to PG. Call STRICTLY
 * AFTER the ops up to those positions have been applied (persist-after-apply):
 * a crash between apply and persist then RE-folds the last batch (idempotent
 * LWW) rather than SKIPPING it — that ordering is the whole correctness argument
 * for PG-cursor (17c98, mr5ymwgw). Thin pass-through over the injected store so
 * the boot `onCursorAdvance` hook and any future caller share one code path.
 *
 * `applyBinding` (EI-18773697830188393) is the pot-home projection scope these ops were
 * folded through; it is stamped alongside the positions so a LATER boot can tell whether
 * this progress is resumable under ITS binding (see `seedCursorFromPg`). Read it LIVE at
 * each call — a mid-session rekey rebind changes the scope, and the re-fold it triggers
 * must persist under the NEW stamp, not the one that was current at boot.
 */
export async function persistCursor(
  positions: ReadonlyMap<string, number>,
  store: MergeCursorStore,
  applyBinding: string | null,
): Promise<void> {
  await store.save(positions, applyBinding);
}

/**
 * Does `env` beat the stored winner? EXACTLY mirrors `lwwPick(prev, env)` (prev wins ties
 * through the final source-key tiebreak's `>=`), so an incremental fold across any
 * pass/chunk boundaries lands on the identical winner set a from-scratch `mergeAdmittedLogs`
 * fold would.
 *
 * EI-1698: step 1 is a SINGLE total order via a DERIVED HLC for every op (its `hlc`, else
 * `encodeHlc({ms: ts, count: 0})`) — comparing the SAME key for every pair is transitive.
 * The previous rule ("HLC when BOTH carry one, ELSE ts") switched basis per pair and was
 * NON-TRANSITIVE under mixed-HLC presence: a no-HLC op whose ts sat BETWEEN two HLC ops
 * formed a winner cycle (X>Z, Z>Y, Y>X), so two peers folding the same ops in different
 * delivery orders diverged on a contended key. This is a HAND-MIRROR of `lwwPick`
 * (projection.ts) and MUST stay byte-for-byte in sync with it — the durable fix is to
 * extract one shared comparator both call (tracked EI-1698 follow-up; SQL ON CONFLICT guards
 * are the third copy, owned separately).
 */
function beatsStored(env: OpEnvelope, prev: WinnerMeta): boolean {
  // Step 1 — causal clock as a single total order: derive an HLC for EVERY op (mirror lwwPick).
  const ke = env.hlc ?? encodeHlc({ ms: env.ts ?? 0, count: 0 });
  const kp = prev.hlc ?? encodeHlc({ ms: prev.ts, count: 0 });
  if (ke > kp) return true;
  if (kp > ke) return false;
  // ── clock tie ── del beats put.
  if (env.type === 'del' && prev.type !== 'del') return true;
  if (prev.type === 'del' && env.type !== 'del') return false;
  // Same type on a tie → higher sourceLogKeyHex wins; prev wins on equality (lwwPick's `sa >= sb`).
  const se = env.sourceLogKeyHex ?? '';
  return se > prev.src;
}

function toMeta(env: OpEnvelope): WinnerMeta {
  return {
    ts: env.ts ?? 0,
    ...(env.hlc ? { hlc: env.hlc } : {}),
    type: env.type as 'put' | 'del',
    src: env.sourceLogKeyHex ?? '',
  };
}

/**
 * WI-4020: record a winner in `cursor.winners` under an approximate-LRU bound
 * (see `DEFAULT_MAX_WINNERS_ENTRIES`). Approximate via `Map`'s insertion-order
 * iteration: a key whose winner actually CHANGES is deleted+re-set so it moves
 * to the MRU (end) position; eviction removes from the LRU (front) end. A key
 * that is merely READ (confirmed stale, winner unchanged — the `continue` at
 * the `beatsStored` gate) does NOT bump recency — only a real winner CHANGE
 * does. This is deliberate, not an approximation shortcut: a row that keeps
 * winning without changing is a settled/quiescent key, exactly the kind
 * safest to evict first, so tracking recency-of-CHANGE (not recency-of-touch)
 * better matches the goal of keeping actively-churning keys hot.
 *
 * `cap <= 0` disables bounding (today's behavior: the winner is set, nothing
 * is ever evicted). `onEvicted` is a best-effort observability hook (same
 * shape as `onCapped`/`onBacklog` elsewhere in this file) — it must never
 * throw out of this function or abort the merge pass over it.
 */
function recordWinner(
  cursor: MergeCursor,
  groupKey: string,
  meta: WinnerMeta,
  cap: number,
  onEvicted?: (evictedCount: number, size: number) => void,
): void {
  if (cursor.winners.has(groupKey)) cursor.winners.delete(groupKey); // move to MRU end
  cursor.winners.set(groupKey, meta);
  if (cap <= 0) return;
  let evicted = 0;
  while (cursor.winners.size > cap) {
    const oldest = cursor.winners.keys().next().value;
    if (oldest === undefined) break; // defensive: size>cap but iterator empty can't happen, but never loop forever
    cursor.winners.delete(oldest);
    evicted++;
  }
  if (evicted > 0) {
    try {
      onEvicted?.(evicted, cursor.winners.size);
    } catch {
      // Observability hook must never abort the merge pass.
    }
  }
}

/**
 * WI-255: how many CONSECUTIVE apply throws on the SAME op before we stop
 * retrying and QUARANTINE it. 3 gives a transient blip a couple of free retries
 * while bounding a poison op's loop.
 */
const MAX_APPLY_THROWS = 3;

/** Op identity for the per-op throw counter — a new op (or a different winner for
 *  the key) gets a fresh retry budget; the same poison op accumulates throws. */
function opIdent(groupKey: string, env: OpEnvelope): string {
  return `${groupKey}\x00${env.ts ?? 0}\x00${env.sourceLogKeyHex ?? ''}\x00${env.type}`;
}

/**
 * WI-3896 (tower outbox/merge wedge — the "papercusp substrate_merge_cursor never
 * establishes" incident): `apply(env)` is an unbounded PG write with NO existing
 * bound — the P-012 doc-comment on `applyRecordingWinner` below already flagged
 * this as a known gap ("the merge pass has no per-op timeout on it the way
 * `readOpBoundedDetailed` does on the read side"). A genuinely wedged write (the
 * live incident: an old iMac device's stale plan-parts, keyed ~ef7a8160, hung
 * forever) freezes `mergeAdmittedLogsIncremental`'s `await applyRecordingWinner(...)`
 * PERMANENTLY — unlike `outbox-drain.ts`'s send-side pass, which already races the
 * whole pass against `DRAIN_PASS_TIMEOUT_MS`, NOTHING bounds this await, so the
 * whole harness's incremental merge (and therefore its PG-persisted merge cursor)
 * simply stops advancing forever, silently.
 *
 * Generous relative to a normal PG write — even under host CPU saturation — so a
 * merely-SLOW write is never mistaken for poison: on timeout the (possibly still
 * in-flight) write is DETACHED, not cancelled, and its eventual completion is
 * harmless (the projection writer is idempotent/LWW-guarded, same at-least-once
 * argument `outbox-drain.ts` already relies on for its own detached zombie passes).
 */
export const MERGE_APPLY_TIMEOUT_MS = 45_000;

/**
 * Thrown when a single `apply(env)` exceeds `MERGE_APPLY_TIMEOUT_MS`. Handled by
 * `applyRecordingWinner`'s EXISTING WI-255 retry/quarantine counter identically to
 * a throwing apply (same `MAX_APPLY_THROWS` budget) — a transient timeout (host
 * load) gets a couple of free retries; a PERSISTENTLY-timing-out (poison) op is
 * quarantined (winner recorded + dropped) exactly like a persistently-throwing one,
 * so ONE unresolvable row can no longer wedge the whole merge loop forever.
 */
export class MergeApplyTimeoutError extends Error {
  constructor(readonly groupKey: string, readonly timeoutMs: number) {
    super(
      `[read-merge] merge-apply TIMEOUT for ${groupKey}: exceeded ${timeoutMs}ms — a hung ` +
        `projection write (WI-3896 class) is being treated as a transient failure (bounded ` +
        `retry → quarantine after ${MAX_APPLY_THROWS} consecutive occurrences).`,
    );
    this.name = 'MergeApplyTimeoutError';
  }
}

/**
 * Race `p` against `timeoutMs`; on expiry throw `MergeApplyTimeoutError(groupKey)`.
 * The (possibly still-pending) `p` is DETACHED on either path — its late
 * resolution/rejection is swallowed so it can never surface as an unhandled
 * rejection or double-count once we've moved on. `timeoutMs <= 0` disables the
 * bound entirely (today's unbounded-await behavior; the STAGE_STALL_LOG_MS
 * observability line from the caller's `logIfStageStalls` wrap still fires).
 */
async function raceApplyTimeout<T>(groupKey: string, p: Promise<T>, timeoutMs: number): Promise<T> {
  if (timeoutMs <= 0) return p;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new MergeApplyTimeoutError(groupKey, timeoutMs)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    p.catch(() => {}); // detach the (possibly zombie) write — never an unhandled rejection
  }
}

/**
 * WI-255 — apply an op that has already passed the `beatsStored` LWW gate, then
 * record it as the winner ONLY if apply returned WITHOUT throwing.
 *
 * The pre-WI-255 code recorded the winner BEFORE apply; an apply that threw
 * (a transient PG blip/deadlock/timeout mid-merge) propagated out, the caller
 * retried, and on the retry `beatsStored(env, env)` is false (strict `>`), so the
 * op was SKIPPED forever — silent DATA LOSS until a rare full re-fold.
 *
 * Now: a TRANSIENT throw propagates with the winner NOT recorded, so the op is
 * re-read + retried next pass and converges once the transient clears. A
 * PERSISTENTLY-throwing (poison) op — e.g. a value PG can never store — is
 * quarantined after MAX_APPLY_THROWS consecutive throws: its winner is recorded
 * (so `beatsStored` stops re-selecting it) and it is dropped with a log, never an
 * infinite retry loop. Winner-recording semantics on the no-throw path are
 * UNCHANGED (apply true OR false both record the winner). Returns true iff apply
 * landed the op.
 *
 * P-012 (fleet-reliability-verification-2026-07-10, named-hop pipeline
 * observability): `apply(env)` is an unbounded PG write (the projection
 * writer) with the SAME hang shape `outbox-drain.ts`'s send-side `append()`
 * had (a wedged connection/lock never resolves). Wrapped with the shared
 * `logIfStageStalls` (formalized out of WI-3619) so a hung merge-apply NAMES
 * ITSELF (scope = source log key, stage = table+key) in the journal at
 * `STAGE_STALL_LOG_MS`, THEN (WI-3896) `raceApplyTimeout` bounds it at
 * `MERGE_APPLY_TIMEOUT_MS` — the per-op timeout `readOpBoundedDetailed` already
 * has on the read side, closing the gap this doc-comment used to flag as
 * missing. A timeout is funneled into the SAME retry/quarantine counter below
 * as a throw, so a persistently-hanging (poison) op converges to quarantine
 * exactly like a persistently-throwing one — see `MergeApplyTimeoutError`.
 */
/**
 * WI-559 / EI-18775450536624845 — is this a STRUCTURAL apply failure: one caused by
 * a row the receiver does not have YET, which resolves itself the moment that row
 * arrives or a repair lands?
 *
 * Today only `23503 foreign_key_violation`. The motivating incident: a joiner whose
 * local Pot handle differed from the owner's announced slug had no FK parent for the
 * federated `pot_members` scope, so EVERY inbound roster op raised 23503. Both of
 * this function's non-existence consequences then fired at once —
 *   1. the throw propagated and ABORTED the whole merge pass, every ~60s, so the log
 *      never advanced (writer at 7944, merged to 0); and
 *   2. after MAX_APPLY_THROWS the op was QUARANTINED — winner recorded, op dropped —
 *      converting a self-healing structural mismatch into PERMANENT data loss
 *      (~20 roster ops lost in 3 minutes on the live rig).
 * The roster stayed empty and the joiner admitted nobody.
 *
 * A structural failure is the OPPOSITE of poison: poison is a value PG can NEVER
 * store, whereas this op is perfectly storable and merely EARLY. Dropping it is the
 * one thing that must not happen, because nothing re-reads it afterwards.
 *
 * Deliberately NARROW. Widening this predicate weakens the poison quarantine that
 * stops a genuinely un-appliable op from wedging the merge loop forever — only add a
 * code that is provably self-healing once the missing referent exists.
 */
function isStructuralApplyFailure(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === '23503';
}

async function applyRecordingWinner(
  cursor: MergeCursor,
  groupKey: string,
  env: OpEnvelope,
  apply: (op: OpEnvelope) => Promise<boolean>,
  scope = 'read-merge',
  applyTimeoutMs: number = MERGE_APPLY_TIMEOUT_MS,
  maxWinnersEntries: number = DEFAULT_MAX_WINNERS_ENTRIES,
  onWinnersEvicted?: (evictedCount: number, size: number) => void,
  /**
   * WI-559: fired when this op is STRUCTURALLY DEFERRED. The caller MUST hold this
   * log's cursor at the deferred position, because positions only ever move forward
   * — advancing past a deferred op loses it just as permanently as quarantining it
   * (not recording a winner is necessary but NOT sufficient; the op also has to be
   * re-READ). Later ops in the pass still apply and record winners, so the re-read
   * next pass is cheap: `beatsStored` dedupes every one of them.
   */
  onStructuralDeferral?: () => void,
): Promise<boolean> {
  let ok: boolean;
  try {
    ok = await raceApplyTimeout(
      groupKey,
      logIfStageStalls(scope, `merge-apply (${groupKey})`, apply(env)),
      applyTimeoutMs,
    );
  } catch (err) {
    // WI-559: a STRUCTURAL failure is neither transient nor poison, and the two
    // existing branches both handle it WRONG — rethrowing aborts the pass (so no
    // LATER op in it can land either), and quarantining drops the op forever.
    // Correct handling is a third outcome: SKIP this op without recording a winner,
    // and let the pass continue. The winner stays unrecorded, so `beatsStored` will
    // re-select the op on a later pass and it lands by itself once the referent
    // exists — no re-fold, no operator action.
    if (isStructuralApplyFailure(err)) {
      // Reuse the existing per-op streak counter purely to RATE-LIMIT the log — a
      // whole-Pot structural mismatch defers every roster op on every pass, which
      // would otherwise flood the journal (the live incident deferred ~20 ops in 3
      // minutes, forever). The counter deliberately never reaches quarantine here;
      // it self-clears on the success path once the referent lands.
      const throws = (cursor.applyThrows ??= new Map());
      const ident = opIdent(groupKey, env);
      const n = (throws.get(ident) ?? 0) + 1;
      throws.set(ident, n);
      if (n === 1 || n % 100 === 0) {
        console.warn(
          `[read-merge] structural apply deferral (${n}×): op ${groupKey} (src=${(env.sourceLogKeyHex ?? '').slice(0, 12)}) ` +
            `references a row this receiver does not have yet — SKIPPED (winner NOT recorded, cursor HELD), the pass ` +
            `CONTINUES, and it re-applies automatically once the referent lands. Not quarantined, not lost: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }
      onStructuralDeferral?.();
      return false;
    }
    const isTimeout = err instanceof MergeApplyTimeoutError;
    const throws = (cursor.applyThrows ??= new Map());
    const ident = opIdent(groupKey, env);
    const n = (throws.get(ident) ?? 0) + 1;
    if (n < MAX_APPLY_THROWS) {
      throws.set(ident, n); // transient — winner NOT recorded → retried next pass
      throw err;
    }
    // Persistently poison (threw OR timed out `MAX_APPLY_THROWS` times running) —
    // quarantine (record winner + drop) so it can't loop/wedge forever.
    throws.delete(ident);
    recordWinner(cursor, groupKey, toMeta(env), maxWinnersEntries, onWinnersEvicted);
    console.error(
      isTimeout
        ? `[read-merge] WI-3896 quarantine: op ${groupKey} (ts=${env.ts ?? 0}, src=${(env.sourceLogKeyHex ?? '').slice(0, 12)}) timed out on apply (>${applyTimeoutMs}ms) ${n}× — this may be LOAD-induced (a legitimately slow write under host CPU pressure — re-check current load before assuming permanent poison) or a genuinely un-resolvable write (e.g. stale/dead-device keymat that will never decrypt/apply); recording winner + dropping to avoid a retry loop:`
        : `[read-merge] WI-255 quarantine: op ${groupKey} (ts=${env.ts ?? 0}, src=${(env.sourceLogKeyHex ?? '').slice(0, 12)}) threw on apply ${n}× — recording winner + dropping to avoid a retry loop:`,
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
  cursor.applyThrows?.delete(opIdent(groupKey, env)); // success clears the throw streak
  recordWinner(cursor, groupKey, toMeta(env), maxWinnersEntries, onWinnersEvicted);
  return ok;
}

/** A log the incremental merge can OPTIONALLY range-prefetch (RemoteLog does;
 *  the own log + in-memory test logs don't). Feature-detected per log. */
interface PrefetchableLog extends AdmittedLog {
  prefetch?(start: number, end: number): void;
}

export interface IncrementalMergeOpts {
  /** Override the apply sink (defaults to `applyHyperbeeOpToPg`). */
  applyImpl?: (op: OpEnvelope) => Promise<boolean>;
  /** Per-op read timeout (ms) — same semantics as MergeOpts.getTimeoutMs. */
  getTimeoutMs?: number;
  /** WI-3896: per-op APPLY timeout (ms) — bounds a single `apply(env)` write so a
   *  hung one can't wedge the whole merge loop forever. Default `MERGE_APPLY_
   *  TIMEOUT_MS`; `<= 0` disables the bound (today's unbounded-await behavior). */
  applyTimeoutMs?: number;
  /**
   * Per-LOG per-PASS read budget (the old `maxOpsPerAuthor` reshaped). A pass
   * advances each log's cursor by at most this many ops; the remainder is
   * picked up by the NEXT pass — so unlike the legacy cap, history beyond the
   * budget is delayed, never lost (EI-91). `<= 0` disables the bound.
   */
  maxOpsPerPass?: number;
  /** Fires once per pass per log that still has backlog beyond this pass. */
  onBacklog?: (keyHex: string, position: number, length: number) => void;
  /**
   * WI-2105 REV fix — fired DURING a pass (at `MERGE_PERSIST_EVERY_OPS` cadence)
   * and after each log that advanced, with the cursor's CURRENT positions, so
   * the caller can persist fold progress to PG. Fired only after the ops up to
   * those positions have been applied (persist-after-apply — each apply above
   * awaited its projection commit), so a crash re-folds the last batch
   * idempotently rather than skipping it. Intra-pass on purpose: a single pass
   * over a large backlog can outlast the 240s bg-host watchdog and never return,
   * so persisting only after the pass returned would capture nothing (the
   * WI-2105 restart loop). Awaited but best-effort — a throw is swallowed by the
   * merge so a failing persist can never abort a pass (the next persist re-writes
   * the latest positions).
   */
  onCursorAdvance?: (positions: ReadonlyMap<string, number>) => Promise<void> | void;
  /**
   * WI-4020: cap on `cursor.winners`' entry count (approximate LRU, evicting
   * quiescent keys first — see `recordWinner`/`DEFAULT_MAX_WINNERS_ENTRIES`).
   * `<= 0` disables the bound (unbounded growth, today's behavior).
   */
  maxWinnersEntries?: number;
  /** Fires (best-effort) whenever a pass evicts `winners` entries under the cap. */
  onWinnersEvicted?: (evictedCount: number, size: number) => void;
  /**
   * WI-2141796: who OWNS this cursor — `"<workspaceId>/<harnessSlug>"`. Used only
   * to disambiguate the read-stall / quarantine log lines.
   *
   * Why it is needed: one log is admitted by MANY harnesses, each folding it
   * through its OWN cursor at its OWN position. Measured 2026-09-02: log
   * `cb54460d98d8` had 39 cursor rows spanning positions 6467..15595. A log line
   * naming only `<keyHex>#<pos>` is therefore ambiguous across all of them, and
   * the failure mode is concrete — the first stall line emitted in production
   * read `cb54460d98d8#7585` while the papercusp cursor was at 14796, and that
   * near-miss invites correlating a number with the wrong harness entirely.
   */
  cursorLabel?: string;
}

export interface IncrementalMergeResult {
  /** Ops that applied (winner changed + apply sink returned true). */
  applied: number;
  /** Ops decoded this pass (the EI-79 cost driver — O(delta), not O(history)). */
  decoded: number;
  /** True when every log's cursor reached its length (no backlog left). */
  caughtUp: boolean;
  /**
   * EI-79 step 3 (correctness escape hatch): a log whose `length` dropped BELOW
   * its cursor position — a truncated / reset / forked log. Its prior ops (incl.
   * any that won their key) may no longer exist, so the standing fold is invalid.
   * When true, NO ops were folded this pass; the caller MUST reset the cursor
   * (`createMergeCursor()`) and re-run for a clean full re-fold. `false` on every
   * normal pass.
   */
  truncated: boolean;
}

/**
 * One INCREMENTAL merge pass: for each log, read only [cursor, bounded-upper),
 * fold each new op against the standing winner state, and apply ONLY the ops
 * that change their key's winner. Replaces the O(total-history) re-decode +
 * re-fold + re-apply that `mergeAdmittedLogs` pays on every changed tick.
 *
 *   - O(delta): a tick after k new ops decodes exactly k ops.
 *   - ts-guarded apply: an op that does not beat the standing winner is never
 *     handed to the projection writers, so PG rows only ever move forward.
 *   - No lost tail (EI-91): the per-pass budget defers, never drops.
 *   - WAN-friendly (EI-92): logs exposing `prefetch` get a fire-and-forget
 *     ranged download for the pass window before the sequential decode.
 *
 * CALLER CONTRACT (boot.ts): the cursor assumes the LOG SET is stable. When
 * the admitted set changes (admit/revoke/channel-2 drop), reset the cursor
 * (`createMergeCursor()`) and re-run — removing a log's contributions
 * requires a fresh fold without it. Cursor entries for logs absent from
 * `logs` are left untouched (the caller resets; this function never guesses).
 *
 * POST-CURSOR-RESET DOUBLE-APPLY SAFETY (audit P-068 — LOAD-BEARING): a reset
 * re-folds every log from index 0 against PG rows that already hold the final
 * state, so every op re-applies. Correctness rests on TWO independent floors:
 *   1. the in-memory winners fold below (an op that doesn't beat the standing
 *      winner is never handed to apply) — empty right after a reset, so
 *   2. EVERY projection writer is PG-level LWW: puts upsert under
 *      `WHERE stored.fed_ts IS NULL OR EXCLUDED.fed_ts >= stored.fed_ts`
 *      (NULL allowed on the STORED side only — the EXCLUDED-side NULL
 *      disjunct was the EI-117 revert hole) and dels are ts-guarded
 *      (`fed_ts <= del.ts`) so a stale del re-applied over a newer put
 *      matches nothing. Own-log ops on CDC-captured tables are skipped
 *      entirely (`TableProjection.skipOwnOps`, EI-117).
 * KNOWN BOUNDED TRANSIENT: deletes leave no PG tombstone, so a reset replay
 * that folds an old put before its winning del re-INSERTs the row until the
 * del re-applies (same pass, or within the backlog's passes when beyond the
 * per-pass budget). The fixpoint always converges. Regression coverage:
 * projections/__tests__/fed-ts-lww-guard.integration.test.ts ("post-cursor-
 * reset double-apply safety") + ei117-replay-revert-guard.integration.test.ts.
 * A NEW projection MUST copy this guard shape or reset replays will clobber.
 *
 * A read that times out / rejects STOPS this pass for that log WITHOUT
 * advancing its cursor (retried next pass) — an op can be delayed, never
 * skipped. A read that resolves `null` (the version gate dropping an
 * unknown-newer op, D-024) advances past it deliberately.
 */
export async function mergeAdmittedLogsIncremental(
  logs: AdmittedLog[],
  cursor: MergeCursor,
  opts?: IncrementalMergeOpts,
): Promise<IncrementalMergeResult> {
  const apply = opts?.applyImpl ?? applyHyperbeeOpToPg;
  const getTimeoutMs = opts?.getTimeoutMs ?? DEFAULT_GET_TIMEOUT_MS;
  const applyTimeoutMs = opts?.applyTimeoutMs ?? MERGE_APPLY_TIMEOUT_MS;
  const budget = opts?.maxOpsPerPass ?? DEFAULT_MAX_OPS_PER_AUTHOR;
  const onCursorAdvance = opts?.onCursorAdvance;
  const maxWinnersEntries = opts?.maxWinnersEntries ?? DEFAULT_MAX_WINNERS_ENTRIES;
  const onWinnersEvicted = opts?.onWinnersEvicted;
  // WI-2141796: prefix for the read-stall / quarantine lines. Without it those
  // lines name a LOG, which many harnesses fold independently — see cursorLabel.
  const cursorTag = opts?.cursorLabel ? `[${opts.cursorLabel}] ` : '';

  let applied = 0;
  let decoded = 0;
  let caughtUp = true;
  let opsSinceYield = 0;
  let opsSincePersist = 0;
  // WI-2344: wall-clock companion to the op counter (see MERGE_YIELD_MAX_MS).
  let lastYieldAt = Date.now();

  // EI-79 step 3: detect a TRUNCATED log (length < its cursor) BEFORE folding.
  // A shrunk log means ops we already counted as winners may be gone, so a
  // forward-only incremental pass can't repair the fold — bail and let the
  // caller reset + re-fold from scratch. Detected up front so we never apply a
  // partial pass on top of a known-invalid fold.
  for (const log of logs) {
    if (log.length < (cursor.positions.get(log.keyHex) ?? 0)) {
      // The caller will normally replace the cursor after this signal. Drop
      // retained late reads so a re-fold cannot consume a stale position.
      cursor.lateReadResults?.clear();
      return { applied: 0, decoded: 0, caughtUp: false, truncated: true };
    }
  }

  for (const log of logs) {
    const from = cursor.positions.get(log.keyHex) ?? 0;
    const upper = budget > 0 ? Math.min(log.length, from + budget) : log.length;
    if (upper <= from) {
      if (log.length > from) caughtUp = false;
      continue;
    }

    // EI-92: ask the peer to stream the whole window now instead of paying a
    // round trip per op below. Feature-detected; fire-and-forget.
    const pf = (log as PrefetchableLog).prefetch;
    if (typeof pf === 'function') {
      try {
        pf.call(log, from, upper);
      } catch {
        /* degraded to sequential fetch — still correct */
      }
    }

    // WI-559 — structural-deferral cursor hold. Cursor positions are MONOTONIC, so
    // not recording a winner is necessary but NOT sufficient to make a deferred op
    // re-appliable: it must also be re-READ, and it never will be if this pass
    // advances past it. Track the FIRST deferred index and clamp every position
    // write for this log to it. Later ops in the pass still apply and record
    // winners, so re-reading them next pass is cheap — `beatsStored` dedupes each
    // one — and the deferred op finally lands by itself once its referent arrives.
    let pos = from;
    let firstDeferredPos = -1;
    const holdCursorHere = (): void => {
      if (firstDeferredPos < 0) firstDeferredPos = pos;
    };
    const effectivePos = (p: number): number =>
      firstDeferredPos >= 0 ? Math.min(p, firstDeferredPos) : p;

    for (; pos < upper; pos++) {
      // EI-81: yield a macrotask every ~1k iterations — counted per pass
      // (the counter carries across logs) so N small logs can't dodge it.
      // WI-2344: OR every MERGE_YIELD_MAX_MS of wall-clock, whichever comes
      // first — bounds a chunk of slow/wide ops (loaded PG, snapshot-op
      // expansion) that would otherwise run long past the op-count trigger
      // and still monopolize the loop long enough to trip the bg-host
      // watchdog's freeze detector.
      if (++opsSinceYield >= MERGE_YIELD_EVERY_OPS || Date.now() - lastYieldAt >= MERGE_YIELD_MAX_MS) {
        opsSinceYield = 0;
        lastYieldAt = Date.now();
        await yieldToEventLoop();
      }
      // WI-2105 REV fix (persist-after-apply): checkpoint the cursor at the
      // persist cadence. ops [from, pos) have all applied (each apply awaited a
      // projection commit), so next-to-read = pos — persisting `pos` never
      // points past a durably-applied op; a crash re-folds [persisted, pos)
      // idempotently (LWW). Intra-pass because a large-backlog pass can outlast
      // the 240s bg-host watchdog and never return.
      if (onCursorAdvance && ++opsSincePersist >= MERGE_PERSIST_EVERY_OPS) {
        opsSincePersist = 0;
        cursor.positions.set(log.keyHex, effectivePos(pos));
        try {
          await onCursorAdvance(cursor.positions);
        } catch {
          // best-effort: a failed persist must never abort the merge pass
        }
      }
      // Distinguish "op resolved (possibly version-dropped)" from "unavailable"
      // (a transient timeout — peer withholding/offline; unbounded retry-via-
      // break, unchanged) from "read-error" (a REJECTED read — e.g. a permanent
      // hypercore/signature verify failure during identity divergence, WI-2003):
      // bounded retry, then dead-letter past it so a single unreadable position
      // can't wedge every subsequent op in this peer's strictly-sequential log
      // forever (the pre-fix behavior — "silent REV fed_event outage class").
      let op: PeerLogOp | null;
      try {
        const readIdent = `${log.keyHex}:${pos}`;
        const lateQueue = cursor.lateReadResults?.get(readIdent);
        const cached = lateQueue?.shift();
        if (lateQueue && lateQueue.length === 0) cursor.lateReadResults?.delete(readIdent);
        const got =
          cached ??
          (await readOpBoundedDetailed(log, pos, getTimeoutMs, (result) => {
            // A late result is useful only while this cursor is still held at
            // the same position. If another attempt already advanced it, drop
            // the stale result rather than applying it at a later position.
            if ((cursor.positions.get(log.keyHex) ?? 0) !== pos) return;
            const queue = cursor.lateReadResults?.get(readIdent) ?? [];
            queue.push(result);
            (cursor.lateReadResults ??= new Map()).set(readIdent, queue);
          }));
        // A cached result (or an immediate fresh result) owns this position;
        // any additional late results for it are stale once the cursor moves.
        if (cached || got.kind !== 'unavailable') cursor.lateReadResults?.delete(readIdent);
        if (got.kind === 'unavailable') {
          // WI-2141796 / P-203: retry from here next pass (UNBOUNDED, because a
          // peer withholding one block is usually transient and dead-lettering
          // it would lose it). D-018 additionally consumes any late result
          // before issuing another read, so a slow-but-served block cannot pin
          // the cursor forever while never-settling reads retain their existing
          // retry behavior.
          const stalls = (cursor.readStalls ??= new Map());
          const n = (stalls.get(readIdent) ?? 0) + 1;
          stalls.set(readIdent, n);
          // Announce on 1, then on each POWER OF TWO, then every 100th. A flat
          // `n === 1 || n % 100 === 0` leaves passes 2..99 silent — and that is
          // precisely the window where a one-pass blip turns into a wedged
          // position. Measured 2026-09-02: papercusp stalled at #15595, emitted
          // its single `1×` line, then went quiet for 7+ minutes while the cursor
          // did not move. Silence there is indistinguishable from recovery, which
          // is the exact failure this warning exists to end. Doubling keeps a
          // persisting stall announcing itself (2×, 4×, 8×…) at a log-bounded
          // rate, so the count a reader sees is evidence of DURATION.
          if (n === 1 || (n & (n - 1)) === 0 || n % 100 === 0) {
            console.warn(
              `[read-merge] ${cursorTag}read stall (${n}×): log ${log.keyHex.slice(0, 12)}#${pos} did not resolve within ` +
                `${getTimeoutMs}ms — cursor HELD at ${pos}, ${Math.max(0, log.length - pos)} op(s) behind it are ` +
                `UNREACHABLE until this position reads. Retrying every pass (not quarantined, not lost). A count ` +
                `that keeps climbing on the SAME position is a wedged log, not a blip: the peer is serving the ` +
                `swarm but not this block. NOTE the cursor ROW is not a witness here — positions persist as one ` +
                `map, so a sibling log advancing re-stamps this row's updated_at while its position stays frozen.`,
            );
            // WI-2141796 — the line above reports only that the read did not
            // FINISH. It cannot say whether the block is UNREADABLE or merely
            // SLOW, and every hypothesis about this outage class has foundered on
            // exactly that gap: a peer-withholding story and a host-saturation
            // story fit the same evidence and imply opposite fixes. So watch the
            // read we just abandoned and report which it turned out to be.
            //
            // Attached only at an announce point, so the number of outstanding
            // observers stays logarithmic in the stall count even for a read that
            // never settles.
            const observedPos = pos;
            const observedAtMs = got.startedAtMs;
            void got.pending.then((resolved) => {
              console.warn(
                `[read-merge] ${cursorTag}late read: log ${log.keyHex.slice(0, 12)}#${observedPos} ` +
                  `${resolved ? 'DID eventually resolve' : 'eventually REJECTED'} ` +
                  `${Date.now() - observedAtMs}ms after the ${getTimeoutMs}ms bound gave up. A resolve means the ` +
                  `block was SLOW, NOT unreadable — it WAS served, just not inside the bound, so the fix belongs ` +
                  `on whatever made the read slow (or on the bound), NOT on the peer. NO late-read line for a ` +
                  `position that keeps stalling means the read never settled at all — the genuinely-unavailable case.`,
              );
            });
          }
          break;
        }
        if (got.kind === 'read-error') {
          const throws = (cursor.readThrows ??= new Map());
          const ident = `${log.keyHex}:${pos}`;
          const n = (throws.get(ident) ?? 0) + 1;
          if (n < MAX_READ_THROWS) {
            throws.set(ident, n); // may still be transient — retry from here next pass
            break;
          }
          // Persistently unreadable/unverifiable at this position — DEAD-LETTER:
          // advance past it instead of wedging the rest of this peer's log forever.
          throws.delete(ident);
          console.error(
            `[read-merge] ${cursorTag}WI-2003 quarantine: unreadable op at ${log.keyHex.slice(0, 12)}#${pos} ` +
              `after ${n} consecutive read failures — advancing past it so the rest of this peer's ` +
              `log can keep folding (this position itself never folds; if this is an identity-` +
              `divergence signature-verify rejection, re-grant/re-emit the underlying wraps so the ` +
              `sender re-publishes under a verifiable identity):`,
            got.err instanceof Error ? got.err.message : String(got.err),
          );
          op = null; // treated like a version-gated drop below — cursor advances past it
        } else {
          cursor.readThrows?.delete(`${log.keyHex}:${pos}`); // success clears any throw streak
          cursor.readStalls?.delete(`${log.keyHex}:${pos}`); // …and any read-stall streak (WI-2141796)
          op = got.op;
        }
      } catch {
        break;
      }
      if (!op) continue; // version-gated drop — advance past it
      decoded++;
      // P-007 (design A): expand a snapshot op into its per-key rows and fold each
      // through the SAME ts-guarded apply path. One decode reconstitutes N keys —
      // exactly the cost win (the joiner's cursor can start AT this op's index and
      // skip the summarized prefix). `continue` advances the cursor past it.
      if (isSnapshotOp(op)) {
        for (const row of snapshotRows(op)) {
          const env = snapshotRowToEnvelope(row, log.keyHex);
          const groupKey = `${env.table}::${env.hbKey}`;
          const prev = cursor.winners.get(groupKey);
          if (prev && !beatsStored(env, prev)) continue; // stale row, never applied
          if (
            await applyRecordingWinner(
              cursor,
              groupKey,
              env,
              apply,
              log.keyHex,
              applyTimeoutMs,
              maxWinnersEntries,
              onWinnersEvicted,
              holdCursorHere,
            )
          )
            applied++;
        }
        continue;
      }
      const env = toEnvelope(op, log.keyHex);
      const groupKey = `${env.table}::${env.hbKey}`;
      const prev = cursor.winners.get(groupKey);
      if (prev && !beatsStored(env, prev)) continue; // ts-guard: stale op, never applied
      if (
        await applyRecordingWinner(
          cursor,
          groupKey,
          env,
          apply,
          log.keyHex,
          applyTimeoutMs,
          maxWinnersEntries,
          onWinnersEvicted,
          holdCursorHere,
        )
      )
        applied++;
    }
    // WI-559: never advance PAST a structurally-deferred op — positions are
    // monotonic, so doing so loses it exactly as permanently as quarantining it.
    cursor.positions.set(log.keyHex, effectivePos(pos));
    // WI-2105 REV fix: persist this log's advanced cursor (persist-after-apply —
    // the pass's applies committed above). Guarded on `pos > from` so an
    // unchanged log doesn't churn PG each 1Hz tick.
    if (onCursorAdvance && pos > from) {
      try {
        await onCursorAdvance(cursor.positions);
      } catch {
        // best-effort: a failed persist must never abort the merge pass
      }
    }
    if (pos < log.length) {
      caughtUp = false;
      try {
        opts?.onBacklog?.(log.keyHex, pos, log.length);
      } catch {
        // observability must never abort the pass
      }
    }
  }

  return { applied, decoded, caughtUp, truncated: false };
}

/**
 * WI-2003: how many CONSECUTIVE read failures (rejected `log.get(i)` — e.g. a
 * hypercore/signature verify failure during identity divergence) at the SAME
 * position before we stop retrying and dead-letter (advance past) it. Mirrors
 * `MAX_APPLY_THROWS` — a couple of free retries in case it's transient (e.g. a
 * race with identity repair landing), bounded so a genuinely-permanent failure
 * can't wedge the rest of this peer's log forever.
 */
const MAX_READ_THROWS = 3;

/** Like readOpBounded, but distinguishes a RESOLVED null (gate drop / out of
 *  range → cursor may advance) from an UNAVAILABLE op (timeout — a transient
 *  peer-offline/not-yet-downloaded condition; cursor must NOT advance, retried
 *  unbounded) from a "read-error" (WI-2003: `log.get(i)` itself REJECTED — e.g.
 *  a permanent signature/verify failure; bounded retry + dead-letter at the
 *  call site, see `MAX_READ_THROWS`). Only the timeout RACE collapses to
 *  `unavailable` — a thrown/rejected `log.get(i)` is surfaced distinctly so the
 *  caller can tell "peer hasn't sent it yet" apart from "this will never read". */
async function readOpBoundedDetailed(
  log: AdmittedLog,
  i: number,
  timeoutMs: number,
  onLateResult?: (result: ReadAttemptResult) => void,
): Promise<
  | { kind: 'op'; op: PeerLogOp | null }
  | {
      kind: 'unavailable';
      pending: Promise<boolean>;
      startedAtMs: number;
    }
  | { kind: 'read-error'; err: unknown }
> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const UNAVAILABLE = Symbol('unavailable');
  const startedAtMs = Date.now();
  // Start the physical read exactly once. The promise resolves to a tagged
  // result instead of rejecting so a late failure is safely consumable by the
  // next pass and cannot become an unhandled rejection.
  const result = Promise.resolve()
    .then(() => log.get(i))
    .then(
      (op) => ({ kind: 'op' as const, op }),
      (err) => ({ kind: 'read-error' as const, err }),
    );
  try {
    if (timeoutMs <= 0) {
      return await result;
    }
    const timeout = new Promise<typeof UNAVAILABLE>((resolve) => {
      timer = setTimeout(() => resolve(UNAVAILABLE), timeoutMs);
      if (typeof (timer as { unref?: () => void }).unref === 'function') {
        (timer as { unref: () => void }).unref();
      }
    });
    const r = await Promise.race([result, timeout]);
    if (r !== UNAVAILABLE) return r;
    // WI-2141796 / P-203 — hand the caller the STILL-PENDING read and when it
    // started. D-018 retains its eventual tagged result by position so a later
    // pass can consume a slow-but-served block before issuing another read.
    // The bound proves only that the read did not FINISH in time; it says nothing
    // about whether the block is UNREADABLE or merely SLOW, and that distinction
    // is the one this outage class has never been able to make. Whether this
    // promise ever settles decides it.
    //
    // Settled to a boolean rather than handed over raw on purpose: the caller
    // abandons this read, so a raw promise that later REJECTS would be an
    // unhandled rejection. `true` = the read did eventually arrive (slow, not
    // unreadable); `false` = it eventually rejected.
    const pending = result.then((r) => {
      try {
        onLateResult?.(r);
      } catch {
        // A diagnostic cache must never turn a late read into a merge failure.
      }
      return r.kind === 'op';
    });
    return { kind: 'unavailable', pending, startedAtMs };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
