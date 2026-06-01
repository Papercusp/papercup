/**
 * Bidirectional PG ↔ Hyperbee projection registry.
 *
 * Plan: papercusp-dogfood-phase5a-hyperbee-plumbing-2026-05-24 P-031.
 *
 * Per-table read/write hooks are registered here; the substrate
 * applies them on Hyperbee ops it receives + invokes them on PG
 * writes that need to fan out to Hyperbee.
 *
 * NOT WIRED YET to the actual operator boot path or PG triggers —
 * this commit ships the interface + registry + LWW helper. Per-table
 * hooks land in follow-up commits (one per HYPERBEE-bucket table)
 * because each table has its own row contract.
 *
 * v5 D-012 — same-key Hyperbee conflicts resolve LWW by `ts` (op
 * timestamp). LWW helper here is pure + testable.
 */

import type { OpEnvelope } from './op-envelope-types';
import { observeMergedOp } from './clobber-events';

/**
 * G1 Provenance context (P-002). Passed to `writeToPg` so each per-table writer
 * can stamp `author_pubkey` + `origin` on the upserted row.
 *
 * `origin` is determined by the apply path (not the writer) because it requires
 * comparing `sourceLogKeyHex` against the own log's `keyHex` — information
 * the writer doesn't hold. The writer just stamps the values it receives.
 */
export interface ProvenanceContext {
  /** The raw hex writer pubkey from the op (maps to `author_pubkey` column). */
  authorPubkey: string;
  /** 'local' | 'remote' — derived from log-source (own vs admitted-remote). */
  origin: 'local' | 'remote';
}

export interface TableProjection<Row> {
  /** Table tag, matching `hyperbee-key-types.HYPERBEE_TABLE_TAGS`. */
  tableTag: string;
  /**
   * Build the Hyperbee key for a given row. Single source of truth
   * for the per-table key shape — composer + parser stay aligned.
   */
  composeKey: (row: Row) => string;
  /** Parse the row out of a Hyperbee value. */
  decodeValue: (raw: unknown) => Row | null;
  /**
   * Write the row into PG (idempotent — must handle re-application).
   *
   * G1 Provenance (P-002): the second arg carries `{ authorPubkey, origin }`
   * so the writer can stamp `author_pubkey` + `origin` on the upserted row.
   * Optional to preserve backward-compat with writers not yet upgraded (they
   * silently ignore the context).
   */
  writeToPg: (row: Row, provenance?: ProvenanceContext) => Promise<void>;
  /** Delete the row from PG (idempotent). */
  deleteFromPg: (key: string) => Promise<void>;
}

const registry = new Map<string, TableProjection<unknown>>();

export function registerProjection<Row>(p: TableProjection<Row>): void {
  registry.set(p.tableTag, p as TableProjection<unknown>);
}

export function getProjection(tableTag: string): TableProjection<unknown> | null {
  return registry.get(tableTag) ?? null;
}

export function _clearRegistryForTests(): void {
  registry.clear();
}

/**
 * A projection-set lookup: `tableTag → projection | null`. The single seam
 * `applyOpVia` dispatches through, so the GLOBAL registry and a PER-HARNESS
 * scoped projection set share one apply implementation (no duplicated
 * put/del/decode/clobber logic). The global path passes the module registry's
 * `getProjection`; a per-harness path passes a lookup bound to that harness's
 * own projection set (see `buildHarnessProjectionApply` in `projections/
 * register-all.ts`).
 */
export type ProjectionLookup = (tableTag: string) => TableProjection<unknown> | null;

/**
 * G1 Provenance (P-002): options for `applyOpVia`. The `ownLogKeyHex` is the
 * hex key of this harness's own writable log (from `ownLog.keyHex` in
 * `boot.ts`). When provided, `applyOpVia` determines `origin` by comparing
 * `op.sourceLogKeyHex === ownLogKeyHex` (log-source approach, D-006). When
 * absent (global registry path / callers that haven't threaded it yet), origin
 * falls back to `writerPubkey`-comparison against `ownWriterPubkey`; if neither
 * is available, origin defaults to `'local'` (safe default — the global-registry
 * path is single-harness legacy; no remote peers write through it).
 */
export interface ApplyOpOpts {
  /**
   * The own log's hex keyHex. When set, `op.sourceLogKeyHex === ownLogKeyHex`
   * → `origin='local'`; any other source → `origin='remote'`.
   */
  ownLogKeyHex?: string;
}

/**
 * Core op-dispatch: resolve `op.table` via `lookup`, then write/delete the row
 * to PG and fire the clobber-event hook. Returns true iff the op was applied
 * (false on unknown table / non-put-del / decode failure / missing key).
 *
 * This is the single source of truth for "apply one op through a projection
 * set" — both `applyHyperbeeOpToPg` (global registry) and a per-harness scoped
 * apply call it with different lookups, so the put/del/decode/clobber logic is
 * NOT duplicated (Model B per-harness projection-apply, D-021 collision fix).
 *
 * G1 Provenance (P-002): when `applyOpts.ownLogKeyHex` is provided, computes
 * `origin` via log-source comparison (`op.sourceLogKeyHex === ownLogKeyHex`
 * → 'local', else 'remote') and passes `ProvenanceContext` to `writeToPg`.
 * Writers that understand provenance stamp `author_pubkey` + `origin` on upsert;
 * legacy writers (no provenance param) continue to work unchanged.
 */
export async function applyOpVia(
  lookup: ProjectionLookup,
  op: OpEnvelope,
  applyOpts?: ApplyOpOpts,
): Promise<boolean> {
  if (op.type !== 'put' && op.type !== 'del') return false;
  if (!op.table) return false;
  const p = lookup(op.table);
  if (!p) return false;
  if (op.type === 'del') {
    if (!op.hbKey) return false;
    await p.deleteFromPg(op.hbKey);
    return true;
  }
  const row = p.decodeValue(op.value);
  if (!row) return false;

  // G1 Provenance (P-002): determine origin via log-source when possible.
  // Log-source is the authoritative signal (D-006): an op whose
  // sourceLogKeyHex matches the own log's keyHex was written locally and
  // cannot be forged by a remote peer. Without ownLogKeyHex (legacy /
  // global-registry path) we default to 'local' (safe for single-peer use).
  let provenance: ProvenanceContext | undefined;
  if (op.writerPubkey !== undefined || applyOpts?.ownLogKeyHex !== undefined) {
    const authorPubkey = op.writerPubkey ?? '';
    let origin: 'local' | 'remote' = 'local';
    if (applyOpts?.ownLogKeyHex !== undefined) {
      // Log-source approach (preferred, D-006): compare source log to own log.
      origin =
        op.sourceLogKeyHex !== undefined && op.sourceLogKeyHex === applyOpts.ownLogKeyHex
          ? 'local'
          : 'remote';
    }
    // If ownLogKeyHex is absent but writerPubkey is present, default to 'local'
    // (the global-registry / legacy path never has remote peers; no wrong split).
    provenance = { authorPubkey, origin };
  }

  await p.writeToPg(row, provenance);
  // P-035: clobber-event hook. Fires only when the incoming op has
  // a writerPubkey + the tracker has a recent local write for the
  // same key from a *different* pubkey within the 60s window.
  // No-op when writerPubkey is absent (legacy / un-threaded write).
  if (op.writerPubkey && op.hbKey && typeof op.ts === 'number') {
    observeMergedOp({
      table: op.table,
      hbKey: op.hbKey,
      ts: op.ts,
      pubkey: op.writerPubkey,
    });
  }
  return true;
}

/**
 * Apply one Hyperbee op against the GLOBAL registry. Called by the
 * Hyperbee read loop. Returns true if the op was applied to PG,
 * false if it was dropped (unknown table / decode failed / LWW
 * stale).
 *
 * NOTE (Model B): with 2+ booted harnesses, the global registry is a
 * last-writer-wins collision point — `registerAllHarnessProjections` overwrites
 * by `tableTag`, so this global apply dispatches to whichever harness registered
 * last. Model B's boot path therefore uses a PER-HARNESS scoped apply
 * (`buildHarnessProjectionApply`) instead of this global function. This is kept
 * for any caller that still has a single-harness global view.
 */
export async function applyHyperbeeOpToPg(op: OpEnvelope): Promise<boolean> {
  return applyOpVia((tableTag) => registry.get(tableTag) ?? null, op);
}

/**
 * LWW conflict resolution helper (D-003). Given two ops on the same key,
 * return the one to keep:
 *
 *   1. later `ts` wins;
 *   2. on an exact `ts` tie, `del` beats `put` (safety — a delete that
 *      raced a write at the same instant takes precedence);
 *   3. on a `ts` tie with the SAME type (del/put doesn't decide), the op
 *      with the lexicographically-GREATER `writerPubkey` wins.
 *
 * Step 3 is what makes the fold fully order-independent: the previous
 * "return the first arg" rule was arrival-order-dependent, so two peers
 * folding the same two ops in opposite orders could pick different
 * winners and diverge. Tiebreaking on the (peer-stable) author pubkey
 * yields an identical winner on every peer regardless of fold order.
 * A missing `writerPubkey` is treated as `''` so the comparison is
 * total and stable.
 */
export function lwwPick(a: OpEnvelope, b: OpEnvelope): OpEnvelope {
  const ta = a.ts ?? 0;
  const tb = b.ts ?? 0;
  if (ta > tb) return a;
  if (tb > ta) return b;
  // ── ts tie ──
  // del beats put.
  if (a.type === 'del' && b.type !== 'del') return a;
  if (b.type === 'del' && a.type !== 'del') return b;
  // Same type on a ts tie → deterministic author tiebreak: the higher
  // (lexicographically-greater) writerPubkey wins, identical on every peer
  // regardless of fold order. Undefined pubkey ⇒ '' so the order is total.
  const pa = a.writerPubkey ?? '';
  const pb = b.writerPubkey ?? '';
  if (pa >= pb) return a;
  return b;
}
