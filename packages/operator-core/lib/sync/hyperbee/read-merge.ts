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
function toEnvelope(op: PeerLogOp, sourceLogKeyHex: string): OpEnvelope {
  return {
    type: op.type,
    table: op.table,
    hbKey: op.hbKey,
    value: op.value,
    ts: op.ts,
    schema_version: op.schema_version,
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
      const op = await readOpBounded(log, i, getTimeoutMs);
      if (!op) continue;
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
