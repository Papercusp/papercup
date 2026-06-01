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
 * before passing logs in; we read `[0, length)` as presented. No per-author op
 * cap here either — that is Stage 6.
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

export interface MergeOpts {
  /** Override the apply sink (defaults to `applyHyperbeeOpToPg`). For tests. */
  applyImpl?: (op: OpEnvelope) => Promise<boolean>;
}

/**
 * Map a single-writer `PeerLogOp` to a projection-layer `OpEnvelope`. The
 * writer's `author_pubkey` becomes `writerPubkey` so the clobber-event hook in
 * `applyHyperbeeOpToPg` fires with the right author.
 */
function toEnvelope(op: PeerLogOp): OpEnvelope {
  return {
    type: op.type,
    table: op.table,
    hbKey: op.hbKey,
    value: op.value,
    ts: op.ts,
    schema_version: op.schema_version,
    writerPubkey: op.author_pubkey,
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

  // 1+2. Read every op of every log (skip nulls) and map to OpEnvelope.
  // 3. Fold into per-(table, hbKey) LWW winners as we go.
  const winners = new Map<string, OpEnvelope>();
  for (const log of logs) {
    for (let i = 0; i < log.length; i++) {
      const op = await log.get(i);
      if (!op) continue;
      const env = toEnvelope(op);
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
