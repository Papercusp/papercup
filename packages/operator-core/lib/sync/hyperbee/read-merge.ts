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

/** WI-2105 — persist the merge cursor to PG at most every this-many decoded ops
 *  DURING a pass (plus once per log at completion). Coarser than the event-loop
 *  yield cadence so a big fold does ~O(ops/5000) small upserts, not one per
 *  yield; fine-grained enough that a watchdog restart loses at most this many
 *  ops of re-fold (all idempotent). Intra-pass because a single large-backlog
 *  pass can outlast the 240s bg-host watchdog and never return — persisting only
 *  after the pass returned would capture nothing (the WI-2105 REV restart loop). */
export const MERGE_PERSIST_EVERY_OPS = 5000;

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
 * did. `writerPubkey` / `sourceLogKeyHex` come from the snapshot op's source log,
 * so provenance + origin resolution are identical to a normal op from that peer.
 */
function snapshotRowToEnvelope(
  row: SnapshotRow,
  sourceLogKeyHex: string,
  authorPubkey: string,
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
    writerPubkey: authorPubkey,
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
      if (++opsSinceYield >= MERGE_YIELD_EVERY_OPS) {
        opsSinceYield = 0;
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
          const env = snapshotRowToEnvelope(row, log.keyHex, op.author_pubkey);
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
}

export function createMergeCursor(): MergeCursor {
  return { positions: new Map(), winners: new Map(), applyThrows: new Map() };
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
): Promise<boolean> {
  if (coversUpTo < 0 || chunkCount < 1) return false;
  if (coversUpTo + chunkCount > log.length) return false; // set extends past the tail → incomplete
  for (let j = 0; j < chunkCount; j++) {
    const op = await readOpBounded(log, coversUpTo + j, getTimeoutMs);
    if (!op || !isSnapshotOp(op)) return false;
    const p = op.value as SnapshotPayload | undefined;
    if (!p || p.coversUpTo !== coversUpTo) return false;
    if ((p.chunkCount ?? 1) !== chunkCount) return false;
    if ((p.chunkIdx ?? 0) !== j) return false;
  }
  return true;
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
  const len = log.length;
  const floor = maxLookback > 0 ? Math.max(0, len - maxLookback) : 0;
  let i = len - 1;
  while (i >= floor) {
    const op = await readOpBounded(log, i, getTimeoutMs);
    if (!op) return null; // unavailable/withholding tail → give up, fold from 0 (safe)
    if (isSnapshotOp(op)) {
      const p = op.value as SnapshotPayload | undefined;
      const coversUpTo = p?.coversUpTo ?? 0;
      const chunkCount = p?.chunkCount ?? 1;
      if (await verifySnapshotSet(log, coversUpTo, chunkCount, getTimeoutMs)) {
        return { seedIndex: coversUpTo, coversUpTo, chunkCount };
      }
      // Torn/incomplete (or corrupt) set — skip its whole span and look for an
      // earlier complete one. `Math.min` keeps the scan strictly backward even if a
      // corrupt payload reports a coversUpTo ahead of the current index.
      i = Math.min(coversUpTo - 1, i - 1);
      continue;
    }
    i--;
  }
  return null;
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
export interface MergeCursorStore {
  /** All persisted positions for this (workspace, harness): keyHex → next index. */
  load(): Promise<Map<string, number>>;
  /** Upsert the given positions. Best-effort; may throw — the caller isolates it. */
  save(positions: ReadonlyMap<string, number>): Promise<void>;
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
 */
export async function seedCursorFromPg(cursor: MergeCursor, store: MergeCursorStore): Promise<void> {
  const saved = await store.load();
  for (const [keyHex, position] of saved) {
    if (position > 0 && !cursor.positions.has(keyHex)) {
      cursor.positions.set(keyHex, position);
    }
  }
}

/**
 * WI-2105 REV fix — persist a merge cursor's positions to PG. Call STRICTLY
 * AFTER the ops up to those positions have been applied (persist-after-apply):
 * a crash between apply and persist then RE-folds the last batch (idempotent
 * LWW) rather than SKIPPING it — that ordering is the whole correctness argument
 * for PG-cursor (17c98, mr5ymwgw). Thin pass-through over the injected store so
 * the boot `onCursorAdvance` hook and any future caller share one code path.
 */
export async function persistCursor(
  positions: ReadonlyMap<string, number>,
  store: MergeCursorStore,
): Promise<void> {
  await store.save(positions);
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
 * WI-255: how many CONSECUTIVE apply throws on the SAME op before we stop
 * retrying and QUARANTINE it. 3 gives a transient blip a couple of free retries
 * while bounding a poison op's loop.
 */
const MAX_APPLY_THROWS = 3;

/** Op identity for the per-op throw counter — a new op (or a different winner for
 *  the key) gets a fresh retry budget; the same poison op accumulates throws. */
function opIdent(groupKey: string, env: OpEnvelope): string {
  return `${groupKey} ${env.ts ?? 0} ${env.sourceLogKeyHex ?? ''} ${env.type}`;
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
 */
async function applyRecordingWinner(
  cursor: MergeCursor,
  groupKey: string,
  env: OpEnvelope,
  apply: (op: OpEnvelope) => Promise<boolean>,
): Promise<boolean> {
  let ok: boolean;
  try {
    ok = await apply(env);
  } catch (err) {
    const throws = (cursor.applyThrows ??= new Map());
    const ident = opIdent(groupKey, env);
    const n = (throws.get(ident) ?? 0) + 1;
    if (n < MAX_APPLY_THROWS) {
      throws.set(ident, n); // transient — winner NOT recorded → retried next pass
      throw err;
    }
    // Persistently poison — quarantine (record winner + drop) so it can't loop.
    throws.delete(ident);
    cursor.winners.set(groupKey, toMeta(env));
    console.error(
      `[read-merge] WI-255 quarantine: op ${groupKey} (ts=${env.ts ?? 0}, src=${(env.sourceLogKeyHex ?? '').slice(0, 12)}) threw on apply ${n}× — recording winner + dropping to avoid a retry loop:`,
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
  cursor.applyThrows?.delete(opIdent(groupKey, env)); // success clears the throw streak
  cursor.winners.set(groupKey, toMeta(env));
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
  const budget = opts?.maxOpsPerPass ?? DEFAULT_MAX_OPS_PER_AUTHOR;
  const onCursorAdvance = opts?.onCursorAdvance;

  let applied = 0;
  let decoded = 0;
  let caughtUp = true;
  let opsSinceYield = 0;
  let opsSincePersist = 0;

  // EI-79 step 3: detect a TRUNCATED log (length < its cursor) BEFORE folding.
  // A shrunk log means ops we already counted as winners may be gone, so a
  // forward-only incremental pass can't repair the fold — bail and let the
  // caller reset + re-fold from scratch. Detected up front so we never apply a
  // partial pass on top of a known-invalid fold.
  for (const log of logs) {
    if (log.length < (cursor.positions.get(log.keyHex) ?? 0)) {
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

    let pos = from;
    for (; pos < upper; pos++) {
      // EI-81: yield a macrotask every ~1k iterations — counted per pass
      // (the counter carries across logs) so N small logs can't dodge it.
      if (++opsSinceYield >= MERGE_YIELD_EVERY_OPS) {
        opsSinceYield = 0;
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
        cursor.positions.set(log.keyHex, pos);
        try {
          await onCursorAdvance(cursor.positions);
        } catch {
          // best-effort: a failed persist must never abort the merge pass
        }
      }
      // Distinguish "op resolved (possibly version-dropped)" from
      // "unavailable" — only the former may advance the cursor.
      let op: PeerLogOp | null;
      try {
        const got = await readOpBoundedDetailed(log, pos, getTimeoutMs);
        if (got.kind === 'unavailable') break; // retry from here next pass
        op = got.op;
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
          const env = snapshotRowToEnvelope(row, log.keyHex, op.author_pubkey);
          const groupKey = `${env.table}::${env.hbKey}`;
          const prev = cursor.winners.get(groupKey);
          if (prev && !beatsStored(env, prev)) continue; // stale row, never applied
          if (await applyRecordingWinner(cursor, groupKey, env, apply)) applied++;
        }
        continue;
      }
      const env = toEnvelope(op, log.keyHex);
      const groupKey = `${env.table}::${env.hbKey}`;
      const prev = cursor.winners.get(groupKey);
      if (prev && !beatsStored(env, prev)) continue; // ts-guard: stale op, never applied
      if (await applyRecordingWinner(cursor, groupKey, env, apply)) applied++;
    }
    cursor.positions.set(log.keyHex, pos);
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

/** Like readOpBounded, but distinguishes a RESOLVED null (gate drop / out of
 *  range → cursor may advance) from an UNAVAILABLE op (timeout / rejection →
 *  cursor must NOT advance). */
async function readOpBoundedDetailed(
  log: AdmittedLog,
  i: number,
  timeoutMs: number,
): Promise<{ kind: 'op'; op: PeerLogOp | null } | { kind: 'unavailable' }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const UNAVAILABLE = Symbol('unavailable');
  try {
    const get = Promise.resolve(log.get(i)).then((op) => ({ kind: 'op' as const, op }));
    if (timeoutMs <= 0) {
      return await get;
    }
    const timeout = new Promise<typeof UNAVAILABLE>((resolve) => {
      timer = setTimeout(() => resolve(UNAVAILABLE), timeoutMs);
      if (typeof (timer as { unref?: () => void }).unref === 'function') {
        (timer as { unref: () => void }).unref();
      }
    });
    const r = await Promise.race([get, timeout]);
    return r === UNAVAILABLE ? { kind: 'unavailable' } : r;
  } catch {
    return { kind: 'unavailable' };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
